import { execSync, spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, rmSync, readdirSync } from 'fs'
import { join } from 'path'
import { userInfo } from 'os'
import { EventEmitter } from 'events'
import steamConfigPatcher from './SteamConfigPatcher'
import accountManager from './AccountManager'
import gsiServer from './CS2GSIServer'
import settings from './Settings'
import sandboxSteamGuard from './SandboxSteamGuard'
import inputMutex from './InputMutex'

const SANDBOXIE_PATHS = [
  'C:\\Program Files\\Sandboxie',
  'C:\\Program Files\\Sandboxie-Plus',
  'C:\\Program Files (x86)\\Sandboxie',
]

const STEAM_POLL_MS      = 2000
const STEAM_TIMEOUT_MS   = 40_000
const CS2_POLL_MS        = 3000
const CS2_TIMEOUT_MS     = 120_000
const CS2_LOBBY_WAIT_MS  = 90_000  // сколько ждём после появления cs2.exe до статуса "лобби"

const CS2_W = '640'
const CS2_H = '480'

const CS2_FLAGS = [
  '-windowed',
  '-w', CS2_W, '-h', CS2_H,
  '+r_mode_width', CS2_W, '+r_mode_height', CS2_H,
  '-novid',
  '+fps_max', '30',
  '+r_dynamic', '0',
  '+mat_queue_mode', '0',
]

class CS2Launcher extends EventEmitter {
  constructor() {
    super()
    this._active  = new Map()
    this._iniLock = false   // mutex — не пишем INI одновременно из двух аккаунтов
  }

  isRunning(accountId) {
    return this._active.has(accountId)
  }

  // Возвращает Promise<{ ok, reason? }>. ok=true если CS2 запустился до состояния
  // when CS2 started; ok=false при ошибке (deps not found, sandbox failed и т.п.).
  // useMutex — если true, ввод логина/пароля/Guard сериализуется через глобальный
  // InputMutex. Нужно когда запускаются параллельно 2+ ботов (группа или быстрое
  // нажатие из Accounts page) — клавиатура хоста одна, без mutex события смешаются.
  async start(accountId, creds, onStatus, options = {}) {
    if (this._active.has(accountId)) return
    const { useMutex = false } = options

    try {
      const sbPath = this._findSandboxie()
      if (!sbPath) throw new Error('Sandboxie не найден. Проверь установку.')

      const steamPath = await steamConfigPatcher.detectSteamPath()
      if (!steamPath) throw new Error('Steam не найден. Установи Steam.')

      const cs2Path = await steamConfigPatcher.detectCS2Path(steamPath)
      if (!cs2Path) throw new Error('CS2 не найден. Убедись что игра установлена через Steam.')

      const boxName = `CS2Bot_${accountId}`
      this._active.set(accountId, { boxName, sbPath, steamPath })

      onStatus('cs2_preparing', 'Подготовка бокса Sandboxie...')
      await this._configureSandboxBox(sbPath, boxName, steamPath, cs2Path)

      // Фикс SBIE2308 "Could not create object directory"
      this._cleanBoxState(sbPath, boxName)
      await new Promise(r => setTimeout(r, 800))

      // Чистим cached Steam credentials ТОЛЬКО если в бокс заходит другой логин
      // чем в прошлый раз. Если тот же — переиспользуем кэш (быстрый запуск
      // без повторного Steam Guard каждый раз).
      const lastLoginKey = `box_last_login_${accountId}`
      const lastLogin    = settings.get(lastLoginKey)
      if (lastLogin !== creds.login) {
        console.log(`[CS2Launcher ${accountId}] wipe credentials (was: ${lastLogin || 'none'}, now: ${creds.login})`)
        this._wipeSandboxCredentials(boxName, steamPath)
        settings.set(lastLoginKey, creds.login)
      }

      // Фиксируем текущее кол-во sandboxed-процессов ПЕРЕД запуском.
      // _waitForNewBoxedProcess ждёт count > prevCount — это гарантирует
      // что мы видим НАШУ копию процесса, а не уже запущенные от других аккаунтов.
      const prevSteamCount = this._countBoxedProcesses('steam')

      onStatus('steam_launching', 'Запуск Steam...')
      this._spawnInBox(sbPath, boxName, steamPath, [
        '-login', creds.login, creds.password,
        '-noreactlogin',
      ])

      // Ждём появления нашего sandboxed steam.exe (не хост-Steam и не чужой бокс).
      // На этом этапе статус становится 'steam_loading'.
      await this._waitForNewBoxedProcess('steam', prevSteamCount, STEAM_TIMEOUT_MS, STEAM_POLL_MS,
        () => onStatus('steam_loading', 'Steam загружается...')
      )

      // Запускаем авто-ввод credentials и Steam Guard ПОСЛЕДОВАТЕЛЬНО.
      // Раньше шёл параллельно с _waitForSteamReady → race condition:
      // основной поток ставил 'steam_running' через _waitForSteamReady
      // (по факту появления steamwebhelper.exe, что происходит ДО логина),
      // одновременно tryAutoInput ставил 'steam_login_form' →
      // 'steam_entering_creds' → ... — получалась каша статусов.
      //
      // Теперь авто-ввод полностью отрабатывает (внутри сам шлёт детальные
      // статусы через onStep), и только потом мы переходим к 'steam_running'
      // и запуску CS2. _waitForSteamReady больше не нужен — успех tryAutoInput
      // = Steam залогинен.
      let autoInputResult = null
      try {
        autoInputResult = await sandboxSteamGuard.tryAutoInput(
          accountId, creds.login, creds.password, creds.sharedSecret, onStatus,
          {
            boxName,                                  // строгая фильтрация окон по нашему боксу
            mutex:   useMutex ? inputMutex : null,    // сериализация ввода если параллельно
          }
        )
        console.log(`[CS2Launcher ${accountId}] Steam auto-input result: ${autoInputResult.reason}`)
      } catch (err) {
        console.log(`[CS2Launcher ${accountId}] Steam auto-input error: ${err.message}`)
      }

      // Если авто-ввод не справился — НЕ ставим steam_running сразу, иначе
      // статус подскакивает: error → В Steam → Запуск CS2 — хотя по факту
      // пользователь ещё на форме входа Steam. Вместо этого ждём пока в
      // системе появится sandboxed окно главного UI Steam (size ≥ 1200x700)
      // — это значит юзер залогинился вручную. Timeout 5 минут.
      if (!autoInputResult || !autoInputResult.ok) {
        console.log(`[CS2Launcher ${accountId}] auto-input failed, waiting for manual login (main Steam UI)...`)
        onStatus('awaiting_guard', 'Ожидание ручного входа в Steam...')
        const ok = await sandboxSteamGuard.waitForMainSteamUI(300_000)
        if (!ok) {
          throw new Error('Steam не залогинился за 5 минут (нет главного окна). Проверь авторизацию вручную.')
        }
      } else {
        // Auto-input успешный — Steam точно залогинен. Короткая пауза для
        // того чтобы main UI успел отрисоваться перед запуском CS2.
        await sandboxSteamGuard.waitForMainSteamUI(30_000)
      }

      onStatus('steam_running', 'Steam авторизован')
      await new Promise(r => setTimeout(r, 800))

      // Извлекаем SteamID из sandbox loginusers.vdf и сохраняем в БД для GSI routing.
      // Steam пишет файл с задержкой после логина — пробуем несколько раз.
      this._extractSteamIdWithRetry(accountId, boxName, steamPath, 5, 1000)

      // Фиксируем кол-во sandboxed cs2.exe до запуска
      const prevCs2Count = this._countBoxedProcesses('cs2')

      onStatus('cs2_launching', 'Запуск CS2...')
      this._patchCS2VideoSettings(cs2Path)
      // GSI config файл — один раз, виден всем боксам через OpenFilePath steamapps.
      try { this._writeGsiConfig(cs2Path) } catch (e) {
        console.log('[CS2Launcher] GSI cfg write:', e.message)
      }
      this._spawnInBox(sbPath, boxName, steamPath, [
        '-applaunch', '730', ...CS2_FLAGS,
      ])

      // Ждём появления НАШЕГО sandboxed cs2.exe без жёсткого таймаута.
      // Если CS2 грузится дольше обычного — не падаем в ошибку, обновляем статус
      // и продолжаем ждать пока пользователь не нажмёт «Стоп» или cs2.exe не появится.
      await this._waitForCs2WithSoftTimeout(accountId, prevCs2Count, onStatus)

      // Ждём 90с чтобы CS2 загрузился до лобби
      await new Promise(r => setTimeout(r, CS2_LOBBY_WAIT_MS))
      onStatus('cs2_lobby', 'В лобби CS2')

      // Мониторим: когда sandboxed cs2.exe count опускается ниже prevCs2Count+1 → idle
      this._monitorBoxedProcess(accountId, 'cs2', prevCs2Count + 1, () => onStatus('idle', ''))
    } catch (e) {
      // Если accountId уже удалён из _active — значит stop() вызван пользователем.
      // Не считаем это ошибкой: процессы убиты намеренно, не нужно ставить status=error.
      const stoppedByUser = !this._active.has(accountId)
      this._active.delete(accountId)
      if (stoppedByUser) return
      throw e
    }
  }

  // Чистит kernel-объекты бокса (object directories, мьютексы, события).
  // Решает SBIE2308 C0000024 (STATUS_OBJECT_TYPE_MISMATCH) — ошибку
  // которая возникает когда от прошлой сессии осталась object directory
  // того же имени но другого типа (или с другими permissions).
  _cleanBoxState(sbPath, boxName) {
    try {
      execSync(`"${join(sbPath, 'Stop.exe')}" /box:${boxName}`, { timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {}
    try {
      execSync(`"${join(sbPath, 'Start.exe')}" /box:${boxName} /terminate`, { timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {}
  }

  // Ждёт пока Steam реально готов к запуску CS2.
  // СИГНАЛ: запуск sandboxed steamwebhelper.exe — Steam создаёт этот процесс
  // ПОСЛЕ полного логина и инициализации UI. Это надёжный indicator готовности
  // (в отличие от userdata/ которая остаётся от прошлой сессии и появляется мгновенно).
  // При timeout (Steam Guard ожидает код и т.п.) просто продолжаем — CS2 и так запустится.
  _waitForSteamReady(boxName, steamPath, timeoutMs) {
    return new Promise(resolve => {
      const deadline = Date.now() + timeoutMs
      const startTime = Date.now()
      const check = () => {
        // Минимум 3 секунды от старта Steam — даём ему запустить процесс
        if (Date.now() - startTime >= 3000) {
          const count = this._countBoxedProcesses('steamwebhelper')
          if (count > 0) return resolve()
        }
        if (Date.now() >= deadline) return resolve()  // timeout → продолжаем
        setTimeout(check, 1500)
      }
      check()
    })
  }

  // Удаляет cached Steam credentials из песочной папки бокса.
  // Без этого Steam при повторном запуске использует loginusers.vdf + ssfn*
  // от прошлой сессии (когда бокс мог быть запущен с другим аккаунтом),
  // и игнорирует флаг -login.
  // Sandboxie по умолчанию хранит файлы в C:\Sandbox\<user>\<box>\drive\C\...
  _wipeSandboxCredentials(boxName, steamPath) {
    const username = userInfo().username
    // Конвертируем хостовый путь Steam в путь внутри песочницы:
    // "C:\Program Files (x86)\Steam" → "C:\Sandbox\<user>\<box>\drive\C\Program Files (x86)\Steam"
    const driveLetter = steamPath[0]
    const restPath    = steamPath.slice(2) // убираем "C:" чтобы оставить "\Program Files (x86)\Steam"
    const sandboxSteam = `C:\\Sandbox\\${username}\\${boxName}\\drive\\${driveLetter}${restPath}`

    if (!existsSync(sandboxSteam)) return  // бокс ещё не запускался — нечего чистить

    const filesToDelete = [
      join(sandboxSteam, 'config', 'loginusers.vdf'),
      join(sandboxSteam, 'config', 'config.vdf'),
    ]
    for (const f of filesToDelete) {
      try { rmSync(f, { force: true }) } catch {}
    }

    // ssfn* — Steam Guard токены, имя содержит hex-suffix
    try {
      for (const f of readdirSync(sandboxSteam)) {
        if (f.toLowerCase().startsWith('ssfn')) {
          try { rmSync(join(sandboxSteam, f), { force: true }) } catch {}
        }
      }
    } catch {}
  }

  stop(accountId) {
    const entry = this._active.get(accountId)
    this._active.delete(accountId)
    if (!entry) return
    try {
      execSync(
        `"${join(entry.sbPath, 'Stop.exe')}" /box:${entry.boxName}`,
        { timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] }
      )
    } catch {
      // Stop.exe не сработал — принудительно через Start.exe /terminate
      try {
        execSync(
          `"${join(entry.sbPath, 'Start.exe')}" /box:${entry.boxName} /terminate`,
          { timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }
        )
      } catch (e2) {
        console.log('[CS2Launcher] Sandbox termination failed:', e2.message)
      }
    }
  }

  stopAll() {
    for (const id of [...this._active.keys()]) this.stop(id)
  }

  // Парсит loginusers.vdf из sandbox-папки Steam после успешного логина
  // и сохраняет SteamID64 в БД (для маршрутизации GSI events по SteamID).
  // Steam VDF format: { "users" { "<steamid64>" { ... } } }
  //
  // Sandboxie может перенаправлять путь по-разному (case-sensitivity, user\current\ префикс,
  // и т.п.). Поэтому делаем рекурсивный поиск loginusers.vdf по всему sandbox-дереву бокса.
  _extractAndSaveSteamId(accountId, boxName, steamPath) {
    const username   = userInfo().username
    const boxRoot    = `C:\\Sandbox\\${username}\\${boxName}`

    if (!existsSync(boxRoot)) {
      console.log(`[CS2Launcher ${accountId}] sandbox root NOT FOUND: ${boxRoot}`)
      return
    }

    const vdfPath = this._findFileRecursive(boxRoot, 'loginusers.vdf', 6)
    if (!vdfPath) {
      console.log(`[CS2Launcher ${accountId}] loginusers.vdf NOT FOUND anywhere in ${boxRoot}`)
      return
    }

    const content = readFileSync(vdfPath, 'utf8')
    const m = content.match(/"(7656\d{13})"/)
    if (!m) {
      console.log(`[CS2Launcher ${accountId}] SteamID64 NOT FOUND in ${vdfPath}`)
      return
    }

    const steamId64 = m[1]
    accountManager.update(accountId, { steamId: steamId64 })
    console.log(`[CS2Launcher ${accountId}] saved steamId=${steamId64} from ${vdfPath}`)
  }

  // Рекурсивный поиск файла по имени с ограничением глубины (защита от symlink-петель).
  _findFileRecursive(dir, fileName, maxDepth) {
    if (maxDepth <= 0) return null
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const e of entries) {
        const full = join(dir, e.name)
        if (e.isDirectory()) {
          const found = this._findFileRecursive(full, fileName, maxDepth - 1)
          if (found) return found
        } else if (e.name.toLowerCase() === fileName.toLowerCase()) {
          return full
        }
      }
    } catch {}
    return null
  }

  // Повторяет попытки извлечь SteamID — Steam пишет loginusers.vdf с задержкой
  // после логина (1-5 секунд). Работает в фоне, не блокирует запуск CS2.
  async _extractSteamIdWithRetry(accountId, boxName, steamPath, attempts, intervalMs) {
    for (let i = 0; i < attempts; i++) {
      try {
        const account = accountManager.getBySteamId && null  // (use update path via DB)
        this._extractAndSaveSteamId(accountId, boxName, steamPath)
        // Проверим что сохранилось
        const all = accountManager.getAll()
        const a = all.find(x => x.id === accountId)
        if (a?.steamId) return  // успех
      } catch (e) {
        console.log(`[CS2Launcher ${accountId}] extract retry ${i + 1}:`, e.message)
      }
      await new Promise(r => setTimeout(r, intervalMs))
    }
    console.log(`[CS2Launcher ${accountId}] steamId NOT extracted after ${attempts} attempts (fallback: auto-mapping via GSI will be used when single CS2 is running)`)
  }

  // Пишет GSI config файл в CS2 cfg-папку. CS2 шлёт state на uri при каждом
  // обновлении (heartbeat 30с в меню, 0.1-0.5с в игре). Один файл виден всем
  // боксам через OpenFilePath steamapps. Не перезаписывает существующий файл —
  // пользователь мог настроить вручную.
  _writeGsiConfig(cs2Path) {
    const cfgDir  = join(cs2Path, 'game', 'csgo', 'cfg')
    const cfgFile = join(cfgDir, 'gamestate_integration_botpanel.cfg')

    if (existsSync(cfgFile)) return  // уже есть — не трогаем

    const port = gsiServer.port || 7779
    const content =
`"Bot Panel GSI v1.0"
{
\t"uri"       "http://127.0.0.1:${port}/"
\t"timeout"   "5.0"
\t"buffer"    "0.1"
\t"throttle"  "0.5"
\t"heartbeat" "30.0"
\t"data"
\t{
\t\t"provider"            "1"
\t\t"map"                 "1"
\t\t"round"               "1"
\t\t"player_id"           "1"
\t\t"player_state"        "1"
\t\t"player_match_stats"  "1"
\t}
}
`
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(cfgFile, content, 'utf8')
    console.log(`[CS2Launcher] GSI cfg written: ${cfgFile} (port ${port})`)
  }

  _patchCS2VideoSettings(cs2Path) {
    const cfgDir = join(cs2Path, 'game', 'csgo', 'cfg')
    const videoTxt = join(cfgDir, 'video.txt')

    const setKey = (content, key, value) => {
      const re = new RegExp(`("${key.replace('.', '\\.')}"+\\s+)"[^"]*"`)
      if (re.test(content)) return content.replace(re, `$1"${value}"`)
      return content.replace(/(\})\s*$/, `\t"${key}"\t\t"${value}"\n$1\n`)
    }

    let content = ''
    try { content = readFileSync(videoTxt, 'utf8') } catch {
      content = '"Video_Settings"\n{\n}\n'
    }

    content = setKey(content, 'setting.fullscreen',        '0')
    content = setKey(content, 'setting.defaultres',        CS2_W)
    content = setKey(content, 'setting.defaultresheight',  CS2_H)
    content = setKey(content, 'setting.nowindowborder',    '0')

    try {
      mkdirSync(cfgDir, { recursive: true })
      writeFileSync(videoTxt, content, 'utf8')
    } catch (e) {
      console.log('[CS2Launcher] video.txt patch failed:', e.message)
    }
  }

  _findSandboxie() {
    for (const p of SANDBOXIE_PATHS) {
      if (existsSync(join(p, 'Start.exe'))) return p
    }
    return null
  }

  // Проверяет, нужен ли перезапуск SbieSvc:
  // если Sandboxie.ini изменён ПОСЛЕ запуска службы → служба не знает о новых боксах.
  _isSandboxieServiceStale() {
    try {
      const iniMtime = statSync('C:\\Windows\\Sandboxie.ini').mtimeMs
      const out = execSync(
        `powershell -NoProfile -Command "(Get-Process SbieSvc -ErrorAction SilentlyContinue).StartTime.ToFileTime()"`,
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim()
      if (!out) return true  // служба не запущена → нужно поднять
      // Windows FileTime: 100-ns тики с 1601-01-01 UTC. Конвертируем в ms с 1970-01-01.
      const startMs = Number((BigInt(out) - 116444736000000000n) / 10000n)
      return iniMtime > startMs + 1000  // +1с допуска на разницу часов
    } catch { return true }
  }

  // Перезапускает SbieSvc через elevated PowerShell. Бросает если UAC отклонён
  // ИЛИ если служба не смогла перезапуститься (exit code != 0 из elevated процесса).
  async _restartSbieSvc() {
    // -PassThru + проверка ExitCode даёт нам узнать упала ли элевированная операция
    execSync(
      `powershell -NoProfile -Command "$p = Start-Process powershell -ArgumentList '-NoProfile','-WindowStyle','Hidden','-Command','try { Stop-Service SbieSvc -Force -ErrorAction Stop; Start-Sleep -Milliseconds 500; Start-Service SbieSvc -ErrorAction Stop; exit 0 } catch { exit 1 }' -Verb RunAs -Wait -PassThru; exit $p.ExitCode"`,
      { timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    await new Promise(r => setTimeout(r, 3000)) // ждём пока служба полностью поднимется
  }

  // Вызывается при старте панели — создаёт боксы для всех аккаунтов.
  // options.wipeFirst=true → сначала полностью удаляет все CS2Bot_* боксы
  // (конфиг + sandbox-файлы), потом создаёт заново. Используется для одноразовой
  // миграции на чистый конфиг при апгрейде версии.
  async setupBoxes(accountIds, steamPath, cs2Path, options = {}) {
    const sbPath = this._findSandboxie()
    if (!sbPath) return

    if (options.wipeFirst) {
      await this._wipeAllBotBoxes(sbPath)
    }

    // Основной путь: SbieIni.exe — официальный CLI, который изменяет конфиг
    // через службу и автоматически вызывает API_RELOAD_CONF. Не требует UAC
    // (служба уже работает), служба сразу знает о новом боксе.
    if (this._setupBoxesViaSbieIni(sbPath, accountIds, steamPath, cs2Path)) return

    // Fallback: прямая запись в Sandboxie.ini + перезапуск службы через UAC.
    try { this._writeBoxesToIni(accountIds, steamPath, cs2Path) } catch (e) {
      console.log('[CS2Launcher] setupBoxes write:', e.message)
      return
    }
    if (!this._isSandboxieServiceStale()) return
    try {
      await this._restartSbieSvc()
    } catch (e) {
      console.log('[CS2Launcher] setupBoxes restart failed:', e.message)
    }
  }

  // Полностью удаляет ВСЕ CS2Bot_* боксы (Sandboxie.ini секции + файлы песочниц).
  // После этого setupBoxes пересоздаст их заново с актуальным конфигом.
  // Используется для миграции на чистый конфиг (старые боксы могли иметь
  // унаследованные настройки которые мешают работе).
  async _wipeAllBotBoxes(sbPath) {
    const iniPath = 'C:\\Windows\\Sandboxie.ini'

    // 1. Найти все CS2Bot_* секции в Sandboxie.ini
    let content = '', encoding = 'utf16le'
    try {
      const raw = readFileSync(iniPath)
      const hasBOM = raw.length >= 2 && raw[0] === 0xFF && raw[1] === 0xFE
      encoding = hasBOM ? 'utf16le' : 'utf8'
      content = raw.toString(encoding)
      if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1)
    } catch {}

    const boxNames = [...content.matchAll(/^\[(CS2Bot_[^\]]+)\]/gm)].map(m => m[1])

    // 2. Остановить и удалить каждый бокс
    for (const box of boxNames) {
      try {
        execSync(`"${join(sbPath, 'Stop.exe')}" /box:${box}`, { timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {}
      try {
        execSync(`"${join(sbPath, 'Start.exe')}" /box:${box} /terminate`, { timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {}
    }

    // 3. Удалить секции из INI напрямую (надёжнее чем SbieIni delete_section
    //    которая может быть недоступна в старых версиях Sandboxie Classic)
    let newContent = content
    for (const box of boxNames) {
      // Удаляем секцию [Box] и все её строки до следующей секции или конца файла
      const re = new RegExp(`^\\[${box}\\][^\\[]*`, 'gm')
      newContent = newContent.replace(re, '')
    }
    newContent = newContent.replace(/\n{3,}/g, '\n\n').trimEnd() + '\r\n'

    try {
      if (encoding === 'utf16le') {
        const bom = Buffer.from([0xFF, 0xFE])
        writeFileSync(iniPath, Buffer.concat([bom, Buffer.from(newContent, 'utf16le')]))
      } else {
        writeFileSync(iniPath, newContent, encoding)
      }
    } catch (e) {
      console.log('[CS2Launcher] _wipeAllBotBoxes INI write:', e.message)
    }

    // 4. Удалить sandbox-файлы (C:\Sandbox\<user>\CS2Bot_*\)
    const sandboxBase = `C:\\Sandbox\\${userInfo().username}`
    if (existsSync(sandboxBase)) {
      for (const dir of readdirSync(sandboxBase)) {
        if (dir.startsWith('CS2Bot_')) {
          try { rmSync(join(sandboxBase, dir), { recursive: true, force: true }) } catch {}
        }
      }
    }

    // 5. Перезапустить SbieSvc чтобы перечитал INI (UAC prompt)
    if (this._isSandboxieServiceStale()) {
      try { await this._restartSbieSvc() } catch {}
    }
  }

  // Per-launch проверка: гарантирует что бокс существует И служба о нём знает.
  async _configureSandboxBox(sbPath, boxName, steamPath, cs2Path) {
    while (this._iniLock) await new Promise(r => setTimeout(r, 200))
    this._iniLock = true
    try {
      const id = boxName.replace('CS2Bot_', '')

      // Основной путь: SbieIni.exe. После него служба сразу знает о боксе.
      if (this._setupBoxesViaSbieIni(sbPath, [id], steamPath, cs2Path)) return

      // Fallback: прямая запись + перезапуск службы.
      this._writeBoxesToIni([id], steamPath, cs2Path)
      if (!this._isSandboxieServiceStale()) return
      try {
        await this._restartSbieSvc()
      } catch {
        throw new Error('Не удалось перезапустить службу Sandboxie. Разреши запрос администратора при следующей попытке.')
      }
    } finally {
      this._iniLock = false
    }
  }

  // Использует SbieIni.exe — официальный путь Sandboxie для изменения конфига.
  // SbieIni шлёт IPC в SbieSvc, который записывает INI и вызывает API_RELOAD_CONF.
  // Возвращает true если SbieIni доступен и все операции прошли успешно.
  _setupBoxesViaSbieIni(sbPath, accountIds, steamPath, cs2Path) {
    const sbieIni = join(sbPath, 'SbieIni.exe')
    if (!existsSync(sbieIni)) return false

    const steamAppsPath = join(steamPath, 'steamapps')
    const csgoPath      = join(cs2Path,   'game')
    const loginusersVdf = join(steamPath, 'config', 'loginusers.vdf')
    const configVdf     = join(steamPath, 'config', 'config.vdf')
    const ssfnGlob      = join(steamPath, 'ssfn*')

    // Legacy cleanup: удаляем старый OpenKeyPath HKCU\Software\Valve из боксов
    // прошлых версий панели (давал прямой доступ к реестру креденшалов хоста).
    const cleanups = [
      ['delete', 'OpenKeyPath', 'HKCU\\Software\\Valve'],
    ]

    // set перезаписывает single-value; append добавляет в multi-value (skips если уже есть).
    // ВАЖНО:
    // - OpenKeyPath HKCU\Software\Valve УБРАН — давал boxed Steam прямой
    //   доступ к реестру хоста с AutoLoginUser/RememberPassword.
    // - ClosedFilePath блокирует cached login файлы хоста.
    // - ClosedIpcPath блокирует Global\STEAM_* объекты чтобы boxed Steam
    //   не общался с host Steam через named objects.
    const ops = [
      ['set',    'Enabled',                'y'],
      ['set',    'AutoRecover',            'n'],
      ['set',    'MsiInstallerExemptions', 'y'],
      ['append', 'OpenFilePath',           steamAppsPath],
      ['append', 'OpenFilePath',           csgoPath],
      ['append', 'OpenKeyPath',            'HKLM\\Software\\Valve'],
      ['append', 'OpenPipePath',           '\\Device\\NamedPipe\\*'],
      ['append', 'ClosedFilePath',         loginusersVdf],
      ['append', 'ClosedFilePath',         configVdf],
      ['append', 'ClosedFilePath',         ssfnGlob],
      ['append', 'ClosedIpcPath',          '\\BaseNamedObjects\\STEAM_*'],
      ['append', 'ClosedIpcPath',          '\\BaseNamedObjects\\Steam*'],
      ['append', 'ClosedIpcPath',          '*\\STEAM_BROADCAST*'],
    ]

    for (const id of accountIds) {
      const boxName = `CS2Bot_${id}`

      // Идемпотентный подход: set/append всегда, без delete_section.
      // - set Enabled y → no-op если уже y
      // - append OpenFilePath "..." → skip если значение уже в multi-value
      // Это НЕ пересоздание бокса — sandbox файлы (loginusers.vdf и т.п.) остаются.
      // Гарантирует что все необходимые ключи присутствуют (в т.ч. MsiInstallerExemptions
      // нужный для Steam Client Service — без него SBIE2331 Access Denied).
      for (const [cmd, key, value] of ops) {
        try {
          execSync(`"${sbieIni}" ${cmd} "${boxName}" ${key} "${value}"`, {
            timeout: 10_000,
            stdio: ['ignore', 'pipe', 'ignore'],
          })
        } catch (e) {
          console.log(`[CS2Launcher] SbieIni ${cmd} ${boxName} ${key}: ${e.message}`)
          return false
        }
      }
    }
    return true
  }

  // Читает INI, добавляет отсутствующие боксы, записывает обратно.
  // Возвращает { added: bool } — были ли добавлены новые боксы.
  _writeBoxesToIni(accountIds, steamPath, cs2Path) {
    const iniPath = 'C:\\Windows\\Sandboxie.ini'
    let ini = '', encoding = 'utf16le'
    try {
      const raw = readFileSync(iniPath)
      const hasBOM = raw.length >= 2 && raw[0] === 0xFF && raw[1] === 0xFE
      encoding = hasBOM ? 'utf16le' : 'utf8'
      ini = raw.toString(encoding)
      if (ini.charCodeAt(0) === 0xFEFF) ini = ini.slice(1)
    } catch {}

    let content = ini, added = false
    for (const id of accountIds) {
      const boxName = `CS2Bot_${id}`
      if (content.includes(`[${boxName}]`)) continue
      content = content.trimEnd() + '\r\n\r\n' + [
        `[${boxName}]`,
        'Enabled=y',
        'AutoRecover=n',
        'MsiInstallerExemptions=y',
        `OpenFilePath=${join(steamPath, 'steamapps')}`,
        `OpenFilePath=${join(cs2Path, 'game')}`,
        'OpenKeyPath=HKLM\\Software\\Valve',
        'OpenPipePath=\\Device\\NamedPipe\\*',
        `ClosedFilePath=${join(steamPath, 'config', 'loginusers.vdf')}`,
        `ClosedFilePath=${join(steamPath, 'config', 'config.vdf')}`,
        `ClosedFilePath=${join(steamPath, 'ssfn*')}`,
        '',
      ].join('\r\n')
      added = true
    }

    if (added) {
      try {
        if (encoding === 'utf16le') {
          const bom = Buffer.from([0xFF, 0xFE])
          writeFileSync(iniPath, Buffer.concat([bom, Buffer.from(content, 'utf16le')]))
        } else {
          writeFileSync(iniPath, content, 'utf8')
        }
      } catch (e) {
        if (e.code === 'EPERM') throw new Error('Нет прав на запись Sandboxie.ini. Запусти панель от имени администратора.')
        throw e
      }
    }

    return { added }
  }

  _spawnInBox(sbPath, boxName, steamPath, args) {
    const startExe = join(sbPath, 'Start.exe')
    const steamExe = join(steamPath, 'steam.exe')
    spawn(startExe, [`/box:${boxName}`, steamExe, ...args], {
      detached: true,
      stdio: 'ignore',
    }).unref()
  }

  // Считает ТОЛЬКО sandboxed процессы (имеют SbieDll.dll в памяти).
  // Ключевое отличие от tasklist: хост-процессы (host Steam, host CS2) не считаются.
  _countBoxedProcesses(name) {
    try {
      const out = execSync(
        `powershell -NoProfile -Command "(Get-Process ${name} -EA SilentlyContinue | Where-Object { try { $_.Modules.ModuleName -contains 'SbieDll.dll' } catch { $false } }).Count"`,
        { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }
      )
      return parseInt(out.trim(), 10) || 0
    } catch { return 0 }
  }

  // Ждёт пока количество sandboxed-процессов превысит prevCount.
  // Решает "детектирование не того аккаунта": если cs2.exe аккаунта 1 уже запущен
  // (count=1), мы ждём count=2 чтобы знать что запустился именно наш.
  _waitForNewBoxedProcess(name, prevCount, timeoutMs, pollMs, onDetected = null) {
    return new Promise((resolve, reject) => {
      let done = false
      let detected = false
      const deadline = Date.now() + timeoutMs

      const check = () => {
        if (done) return
        const count = this._countBoxedProcesses(name)
        if (count > prevCount) {
          if (!detected) {
            detected = true
            onDetected?.()
          }
          done = true
          return resolve()
        }
        if (Date.now() > deadline) {
          done = true
          return reject(new Error(`Timeout: sandboxed ${name}.exe не появился за ${timeoutMs / 1000}с`))
        }
        setTimeout(check, pollMs)
      }
      check()
    })
  }

  // Ждёт появления sandboxed cs2.exe без жёсткого таймаута.
  // Через 90с — обновляет статус «CS2 ещё грузится...» чтобы пользователь не думал что завис.
  // Через 3 мин — предупреждает что процесс идёт очень долго.
  // Если аккаунт удалён из _active (пользователь нажал Стоп) — тихо выходим.
  _waitForCs2WithSoftTimeout(accountId, prevCount, onStatus) {
    return new Promise(resolve => {
      let detected = false

      const check = () => {
        if (!this._active.has(accountId)) { resolve(); return }
        const count = this._countBoxedProcesses('cs2')
        if (count > prevCount) {
          if (!detected) {
            detected = true
            onStatus('cs2_loading', 'CS2 загружается...')
          }
          resolve()
          return
        }
        setTimeout(check, CS2_POLL_MS)
      }

      // Информационные обновления статуса при долгом запуске (не ошибка)
      setTimeout(() => {
        if (!detected && this._active.has(accountId)) {
          onStatus('cs2_launching', 'CS2 ещё запускается...')
        }
      }, 90_000)

      setTimeout(() => {
        if (!detected && this._active.has(accountId)) {
          onStatus('cs2_launching', 'CS2 запускается долго — подождите или нажмите «Стоп»')
        }
      }, 3 * 60_000)

      check()
    })
  }

  // Мониторит cs2.exe конкретного аккаунта: когда count sandboxed-cs2
  // опускается ниже launchedCount → наш CS2 закрылся → idle.
  // launchedCount = кол-во sandboxed cs2.exe в момент когда наш стартовал.
  _monitorBoxedProcess(accountId, name, launchedCount, onExit) {
    const check = () => {
      if (!this._active.has(accountId)) return
      const count = this._countBoxedProcesses(name)
      if (count < launchedCount) {
        this._active.delete(accountId)
        onExit()
      } else {
        setTimeout(check, 5000)
      }
    }
    setTimeout(check, 5000)
  }
}

export default new CS2Launcher()
