import { execSync, spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
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

  async _configureSandboxBox(sbPath, boxName, steamPath, cs2Path) {
    // Ждём если другой аккаунт сейчас пишет INI
    while (this._iniLock) await new Promise(r => setTimeout(r, 200))
    this._iniLock = true

    try {
      const iniPath = 'C:\\Windows\\Sandboxie.ini'
      let ini = ''
      try { ini = readFileSync(iniPath, 'utf16le') } catch {
        try { ini = readFileSync(iniPath, 'utf8') } catch {}
      }

      if (!ini.includes(`[${boxName}]`)) {
        const entry = [
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

        try {
          writeFileSync(iniPath, ini.trimEnd() + '\r\n\r\n' + entry, 'utf16le')
        } catch (e) {
          if (e.code === 'EPERM') {
            throw new Error(
              'Sandboxie бокс не настроен. Запусти панель от имени администратора ' +
              'один раз чтобы создать конфигурацию.'
            )
          }
          throw e
        }

        try { execSync(`"${join(sbPath, 'SbieCtrl.exe')}" /reload`, { timeout: 5000 }) } catch {}
        // Ждём пока Sandboxie сервис обработает новую конфигурацию
        await new Promise(r => setTimeout(r, 3000))
      }
    } finally {
      this._iniLock = false
    }
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
