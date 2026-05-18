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

const CS2_FLAGS = [
  '-w', '800', '-h', '600', '-windowed',
  '-novid', '-nosound', '-nojoy',
  '+fps_max', '30',
  '+cl_forcepreload', '0',
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

      const boxName = `CS2Bot_${accountId}`

      onStatus('cs2_launching', 'Настройка бокса Sandboxie...')
      this._configureSandboxBox(sbPath, boxName, steamPath)
      this._active.set(accountId, { boxName, sbPath, steamPath }) // set real entry before status so stop() works

      onStatus('cs2_launching', 'Запуск Steam в боксе...')
      this._spawnInBox(sbPath, boxName, steamPath, [
        '-login', creds.login, creds.password,
        '-silent', '-noreactlogin',
      ])

      await this._waitForProcess('steam', STEAM_TIMEOUT_MS, STEAM_POLL_MS)

      onStatus('cs2_launching', 'Запуск CS2...')
      this._spawnInBox(sbPath, boxName, steamPath, [
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

  _configureSandboxBox(sbPath, boxName, steamPath) {
    const iniPath = 'C:\\Windows\\Sandboxie.ini'
    let ini = ''
    try { ini = readFileSync(iniPath, 'utf16le') } catch {
      try { ini = readFileSync(iniPath, 'utf8') } catch {}
    }

    const alreadyConfigured = ini.includes(`[${boxName}]`)

    if (!alreadyConfigured) {
      const entry = [
        `[${boxName}]`,
        'Enabled=y',
        'AutoRecover=n',
        'MsiInstallerExemptions=y',
        'DropAdminRights=y',
        `OpenFilePath=${join(steamPath, 'steamapps')}`,
        'OpenKeyPath=HKLM\\Software\\Valve',
        'OpenKeyPath=HKCU\\Software\\Valve',
        '',
      ].join('\r\n')

      writeFileSync(iniPath, ini + entry, 'utf16le') // throws on failure — caller handles it
    }

    // Signal Sandboxie service to reload config (always — service may have restarted)
    try { execSync(`"${join(sbPath, 'SbieCtrl.exe')}" /reload`, { timeout: 5000 }) } catch {}
  }

  _spawnInBox(sbPath, boxName, steamPath, args) {
    const startExe = join(sbPath, 'Start.exe')
    const steamExe = join(steamPath, 'steam.exe')
    spawn(startExe, [`/box:${boxName}`, steamExe, ...args], {
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
          // Stability check: verify process is still alive after stabilityMs
          setTimeout(() => {
            if (done) return
            if (isRunning()) {
              done = true
              return resolve()
            }
            // Process died — keep waiting
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
