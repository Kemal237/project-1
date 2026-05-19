import { execSync, spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { EventEmitter } from 'events'
import steamConfigPatcher from './SteamConfigPatcher'

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

  async start(accountId, creds, onStatus) {
    if (this._active.has(accountId)) return

    try {
      const sbPath = this._findSandboxie()
      if (!sbPath) throw new Error('Sandboxie не найден. Проверь установку.')

      const steamPath = await steamConfigPatcher.detectSteamPath()
      if (!steamPath) throw new Error('Steam не найден. Установи Steam.')

      const cs2Path = await steamConfigPatcher.detectCS2Path(steamPath)
      if (!cs2Path) throw new Error('CS2 не найден. Убедись что игра установлена через Steam.')

      const boxName = `CS2Bot_${accountId}`
      this._active.set(accountId, { boxName, sbPath, steamPath })

      onStatus('cs2_launching', 'Настройка бокса Sandboxie...')
      await this._configureSandboxBox(sbPath, boxName, steamPath, cs2Path)

      // Фикс SBIE2308 "Could not create object directory" — чистим kernel-объекты
      // от прошлых сессий бокса (даже если процессов нет). Без этого первый запуск
      // после ребута/переустановки/смены версии Sandboxie может упасть с C0000024.
      this._cleanBoxState(sbPath, boxName)
      await new Promise(r => setTimeout(r, 800))

      onStatus('cs2_launching', 'Запуск Steam в боксе...')
      this._spawnInBox(sbPath, boxName, steamPath, [
        '-login', creds.login, creds.password,
        '-noreactlogin',
      ])

      await this._waitForProcess('steam', STEAM_TIMEOUT_MS, STEAM_POLL_MS)

      onStatus('cs2_launching', 'Запуск CS2...')
      this._patchCS2VideoSettings(cs2Path)
      this._spawnInBox(sbPath, boxName, steamPath, [
        '-applaunch', '730', ...CS2_FLAGS,
      ])

      // Ждём появления cs2.exe → переключаем на "Загрузка"
      await this._waitForProcess('cs2', CS2_TIMEOUT_MS, CS2_POLL_MS, 0,
        () => onStatus('cs2_loading', 'CS2 загружается...')
      )

      // Ждём пока CS2 загрузит интро и дойдёт до главного меню
      await this._waitForProcess('cs2', CS2_LOBBY_WAIT_MS + 10_000, CS2_POLL_MS, CS2_LOBBY_WAIT_MS)

      onStatus('cs2_lobby', 'CS2 запущен — в лобби')

      // Мониторим cs2.exe — когда закрывается, сбрасываем статус
      this._monitorProcess(accountId, 'cs2', () => onStatus('idle', ''))
    } catch (e) {
      this._active.delete(accountId)
      throw e
    }
  }

  // Чистит kernel-объекты бокса (object directories, мьютексы, события).
  // Решает SBIE2308 C0000024 (STATUS_OBJECT_TYPE_MISMATCH) — ошибку
  // которая возникает когда от прошлой сессии осталась object directory
  // того же имени но другого типа (или с другими permissions).
  _cleanBoxState(sbPath, boxName) {
    try {
      execSync(`"${join(sbPath, 'Stop.exe')}" /box:${boxName}`, { timeout: 10_000, stdio: 'pipe' })
    } catch {}
    try {
      execSync(`"${join(sbPath, 'Start.exe')}" /box:${boxName} /terminate`, { timeout: 10_000, stdio: 'pipe' })
    } catch {}
  }

  stop(accountId) {
    const entry = this._active.get(accountId)
    this._active.delete(accountId)
    if (!entry) return
    try {
      execSync(
        `"${join(entry.sbPath, 'Stop.exe')}" /box:${entry.boxName}`,
        { timeout: 15_000 }
      )
    } catch {
      // Stop.exe не сработал — принудительно через Start.exe /terminate
      try {
        execSync(
          `"${join(entry.sbPath, 'Start.exe')}" /box:${entry.boxName} /terminate`,
          { timeout: 10_000 }
        )
      } catch (e2) {
        console.log('[CS2Launcher] Sandbox termination failed:', e2.message)
      }
    }
  }

  stopAll() {
    for (const id of [...this._active.keys()]) this.stop(id)
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
        { encoding: 'utf8', timeout: 5000 }
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
      { timeout: 60_000 }
    )
    await new Promise(r => setTimeout(r, 3000)) // ждём пока служба полностью поднимется
  }

  // Вызывается при старте панели — создаёт боксы для всех аккаунтов.
  async setupBoxes(accountIds, steamPath, cs2Path) {
    const sbPath = this._findSandboxie()
    if (!sbPath) return

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

    // set перезаписывает single-value; append добавляет в multi-value (skips если уже есть)
    const ops = [
      ['set',    'Enabled',                'y'],
      ['set',    'AutoRecover',            'n'],
      ['set',    'MsiInstallerExemptions', 'y'],
      ['append', 'OpenFilePath',           steamAppsPath],
      ['append', 'OpenFilePath',           csgoPath],
      ['append', 'OpenKeyPath',            'HKLM\\Software\\Valve'],
      ['append', 'OpenKeyPath',            'HKCU\\Software\\Valve'],
      ['append', 'OpenPipePath',           '\\Device\\NamedPipe\\*'],
    ]

    for (const id of accountIds) {
      const boxName = `CS2Bot_${id}`
      for (const [cmd, key, value] of ops) {
        try {
          execSync(`"${sbieIni}" ${cmd} "${boxName}" ${key} "${value}"`, {
            timeout: 10_000,
            stdio: 'pipe',
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
        'OpenKeyPath=HKCU\\Software\\Valve',
        'OpenPipePath=\\Device\\NamedPipe\\*',
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

  _monitorProcess(accountId, name, onExit) {
    const check = () => {
      if (!this._active.has(accountId)) return // stop() уже вызван
      try {
        const out = execSync(
          `tasklist /FI "IMAGENAME eq ${name}.exe" /NH`,
          { encoding: 'utf8', timeout: 5000 }
        )
        if (out.toLowerCase().includes(`${name}.exe`)) {
          setTimeout(check, 5000)
        } else {
          this._active.delete(accountId)
          onExit()
        }
      } catch {
        setTimeout(check, 5000)
      }
    }
    setTimeout(check, 5000)
  }

  _waitForProcess(name, timeoutMs, pollMs, stabilityMs = 0, onFound = null) {
    const isRunning = () => {
      try {
        const out = execSync(
          `tasklist /FI "IMAGENAME eq ${name}.exe" /NH`,
          { encoding: 'utf8', timeout: 5000 }
        )
        return out.toLowerCase().includes(`${name}.exe`)
      } catch { return false }
    }

    return new Promise((resolve, reject) => {
      let done = false
      const deadline = Date.now() + timeoutMs

      const check = () => {
        if (done) return
        if (isRunning()) {
          onFound?.()  // уведомляем о первом обнаружении процесса
          onFound = null // вызываем только один раз
          if (stabilityMs <= 0) {
            done = true
            return resolve()
          }
          setTimeout(() => {
            if (done) return
            if (isRunning()) { done = true; return resolve() }
            if (Date.now() > deadline) {
              done = true
              return reject(new Error(`Timeout: ${name}.exe не запустился за ${timeoutMs / 1000}с`))
            }
            setTimeout(check, pollMs)
          }, stabilityMs)
          return
        }
        if (Date.now() > deadline) {
          done = true
          return reject(new Error(`Timeout: ${name}.exe не запустился за ${timeoutMs / 1000}с`))
        }
        setTimeout(check, pollMs)
      }
      check()
    })
  }
}

export default new CS2Launcher()
