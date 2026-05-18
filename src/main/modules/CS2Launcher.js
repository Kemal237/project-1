import { execSync, spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { EventEmitter } from 'events'
import steamConfigPatcher from './SteamConfigPatcher'

const SANDBOXIE_PATHS = [
  'C:\\Program Files\\Sandboxie',
  'C:\\Program Files\\Sandboxie-Plus',
  'C:\\Program Files (x86)\\Sandboxie',
]

const STEAM_POLL_MS    = 2000
const STEAM_TIMEOUT_MS = 40_000
const CS2_POLL_MS      = 3000
const CS2_TIMEOUT_MS   = 120_000

// Minimal flags — убраны устаревшие -nosound -nojoy +cl_forcepreload
const CS2_FLAGS = [
  '-windowed', '-w', '800', '-h', '600',
  '-novid',
  '+fps_max', '30',
]

class CS2Launcher extends EventEmitter {
  constructor() {
    super()
    this._active = new Map() // accountId → { boxName, sbPath }
  }

  isRunning(accountId) {
    return this._active.has(accountId)
  }

  async start(accountId, creds, onStatus) {
    if (this._active.has(accountId)) return
    this._active.set(accountId, null) // reserve slot immediately to prevent race

    try {
      const sbPath = this._findSandboxie()
      if (!sbPath) throw new Error('Sandboxie не найден. Проверь установку.')

      const steamPath = await steamConfigPatcher.detectSteamPath()
      if (!steamPath) throw new Error('Steam не найден. Установи Steam.')

      const cs2Path = await steamConfigPatcher.detectCS2Path(steamPath)
      if (!cs2Path) throw new Error('CS2 не найден. Убедись что игра установлена через Steam.')

      const boxName = `CS2Bot_${accountId}`

      onStatus('cs2_launching', 'Настройка бокса Sandboxie...')
      this._configureSandboxBox(sbPath, boxName, steamPath, cs2Path)
      this._active.set(accountId, { boxName, sbPath, steamPath })

      onStatus('cs2_launching', 'Запуск Steam в боксе...')
      this._spawnSteam(sbPath, boxName, steamPath, [
        '-login', creds.login, creds.password,
        '-silent', '-noreactlogin',
      ])

      await this._waitForProcess('steam', STEAM_TIMEOUT_MS, STEAM_POLL_MS)

      // Даём Steam время загрузиться и авторизоваться
      await new Promise(r => setTimeout(r, 5000))

      onStatus('cs2_launching', 'Запуск CS2...')
      this._spawnSteam(sbPath, boxName, steamPath, [
        '-applaunch', '730', ...CS2_FLAGS,
      ])

      await this._waitForProcess('cs2', CS2_TIMEOUT_MS, CS2_POLL_MS, 6000)

      onStatus('cs2_lobby', 'CS2 запущен — в лобби')
    } catch (e) {
      this._active.delete(accountId) // rollback slot reservation on failure
      throw e
    }
  }

  stop(accountId) {
    const entry = this._active.get(accountId)
    if (!entry) return
    try {
      execSync(
        `"${join(entry.sbPath, 'Stop.exe')}" /box:${entry.boxName}`,
        { timeout: 10_000 }
      )
    } catch (e) {
      console.log('[CS2Launcher] Stop.exe error:', e.message)
    }
    this._active.delete(accountId)
  }

  stopAll() {
    for (const id of [...this._active.keys()]) this.stop(id)
  }

  _findSandboxie() {
    for (const p of SANDBOXIE_PATHS) {
      if (existsSync(join(p, 'Start.exe'))) return p
    }
    return null
  }

  _configureSandboxBox(sbPath, boxName, steamPath, cs2Path) {
    const iniPath = 'C:\\Windows\\Sandboxie.ini'
    let ini = ''
    try { ini = readFileSync(iniPath, 'utf16le') } catch {
      try { ini = readFileSync(iniPath, 'utf8') } catch {}
    }

    // Всегда перезаписываем секцию бокса чтобы настройки были актуальны
    const boxHeader = `[${boxName}]`
    if (ini.includes(boxHeader)) {
      ini = ini.replace(new RegExp(`\\[${boxName}\\][^\\[]*`, 's'), '')
    }

    const entry = [
      boxHeader,
      'Enabled=y',
      'AutoRecover=n',
      'MsiInstallerExemptions=y',
      'DropAdminRights=y',
      // Общий доступ к файлам игры (не копируются в бокс)
      `OpenFilePath=${join(steamPath, 'steamapps')}`,
      `OpenFilePath=${join(cs2Path, 'game')}`,
      // Реестр Steam
      'OpenKeyPath=HKLM\\Software\\Valve',
      'OpenKeyPath=HKCU\\Software\\Valve',
      // Named pipes для Steam Service ↔ steam.exe/cs2.exe
      'OpenPipePath=\\Device\\NamedPipe\\*',
      '',
    ].join('\r\n')

    writeFileSync(iniPath, ini + entry, 'utf16le')

    try { execSync(`"${join(sbPath, 'SbieCtrl.exe')}" /reload`, { timeout: 5000 }) } catch {}
  }

  _spawnSteam(sbPath, boxName, steamPath, args) {
    const startExe = join(sbPath, 'Start.exe')
    const steamExe = join(steamPath, 'steam.exe')
    spawn(startExe, [`/box:${boxName}`, steamExe, ...args], {
      detached: true,
      stdio: 'ignore',
    }).unref()
  }

  _spawnExe(sbPath, boxName, exe, args) {
    const startExe = join(sbPath, 'Start.exe')
    spawn(startExe, [`/box:${boxName}`, exe, ...args], {
      detached: true,
      stdio: 'ignore',
    }).unref()
  }

  _waitForProcess(name, timeoutMs, pollMs, stabilityMs = 0) {
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
          if (stabilityMs <= 0) {
            done = true
            return resolve()
          }
          setTimeout(() => {
            if (done) return
            if (isRunning()) {
              done = true
              return resolve()
            }
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
