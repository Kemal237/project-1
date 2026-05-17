# Phase 3B-1: CS2 Process Launcher — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Launch real CS2 inside a Sandboxie sandbox per bot account, auto-install Sandboxie from GitHub, handle Steam Guard via UI automation or panel modal, and transition account status to `farming`.

**Architecture:** SandboxieManager auto-installs Sandboxie on first launch, creates sandbox configs, and provides process management. CS2Launcher orchestrates Steam login → Steam Guard → CS2 launch using UIAutomation for code entry. LauncherPool manages slot allocation. SteamWorker gains `startFarming()`/`stopFarming()` methods that drop the protocol session and hand off to CS2Launcher.

**Tech Stack:** Electron + Node.js, `@nut-tree-fork/nut-js` (UI automation), `steam-totp` (already installed), `child_process` (built-in), `winreg` (registry), sql.js (existing DB), React

---

## File Map

| File | Action |
|---|---|
| `src/main/modules/SandboxieManager.js` | Create |
| `src/main/modules/SteamConfigPatcher.js` | Create |
| `src/main/modules/UIAutomation.js` | Create |
| `src/main/modules/CS2Launcher.js` | Create |
| `src/main/modules/LauncherPool.js` | Create |
| `src/main/modules/SteamWorker.js` | Modify — add startFarming/stopFarming |
| `src/main/modules/WorkerManager.js` | Modify — relay farming events |
| `src/main/modules/Database.js` | Modify — add launcher_slots table |
| `src/main/ipc.js` | Modify — new farm:startCS2, sandboxie: handlers |
| `src/preload/index.js` | Modify — new sandboxie namespace |
| `src/renderer/src/pages/Settings.jsx` | Modify — CS2 launch section |
| `src/renderer/src/pages/Accounts.jsx` | Modify — "Запустить CS2" button |
| `src/main/index.js` | Modify — Sandboxie check on startup |

---

## Task 1: Install dependencies

**Files:**
- Modify: `package.json` (via npm)

- [ ] **Step 1: Install @nut-tree-fork/nut-js and winreg**

```bash
npm install @nut-tree-fork/nut-js winreg
```

Expected: both packages appear in `package.json` dependencies. `@nut-tree-fork/nut-js` installs native binaries for Windows.

- [ ] **Step 2: Verify nut-js loads in Node context**

```bash
node -e "const { keyboard } = require('@nut-tree-fork/nut-js'); console.log('nut-js ok')"
```

Expected output: `nut-js ok`

- [ ] **Step 3: Verify winreg loads**

```bash
node -e "const Winreg = require('winreg'); console.log('winreg ok')"
```

Expected output: `winreg ok`

---

## Task 2: Database schema — launcher_slots table

**Files:**
- Modify: `src/main/modules/Database.js`

- [ ] **Step 1: Add launcher_slots table and new settings to _migrate()**

Find the `_migrate()` method. After the settings table creation block, add:

```javascript
    this.db.run(`CREATE TABLE IF NOT EXISTS launcher_slots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      sandbox     TEXT NOT NULL UNIQUE,
      occupied_by INTEGER,
      created_at  TEXT DEFAULT (datetime('now'))
    )`)

    const launcherDefaults = {
      steam_path:        '',
      cs2_path:          '',
      sandboxie_path:    '',
    }
    for (const [k, v] of Object.entries(launcherDefaults))
      this.db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [k, v])
```

- [ ] **Step 2: Run app and verify no errors**

```bash
npm run dev
```

Open DevTools → Console. No SQL errors on startup.

---

## Task 3: SandboxieManager.js — detect + install

**Files:**
- Create: `src/main/modules/SandboxieManager.js`

- [ ] **Step 1: Create the file**

```javascript
import { exec, execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import https from 'https'
import fs from 'fs'
import Winreg from 'winreg'
import settings from './Settings'

const execAsync = promisify(exec)

const REGISTRY_KEY = '\\SOFTWARE\\Sandboxie-Plus'
const REGISTRY_KEY_ALT = '\\SOFTWARE\\WOW6432Node\\Sandboxie-Plus'
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/sandboxie-plus/Sandboxie/releases/latest'

class SandboxieManager {
  constructor() {
    this._installPath = null
  }

  // Returns install path or null if not installed
  async detectInstall() {
    const saved = settings.get('sandboxie_path')
    if (saved && existsSync(join(saved, 'Start.exe'))) {
      this._installPath = saved
      return saved
    }

    for (const hive of [Winreg.HKLM, Winreg.HKCU]) {
      for (const key of [REGISTRY_KEY, REGISTRY_KEY_ALT]) {
        try {
          const path = await this._readRegistry(hive, key, 'InstallPath')
          if (path && existsSync(join(path, 'Start.exe'))) {
            this._installPath = path
            settings.set('sandboxie_path', path)
            return path
          }
        } catch {}
      }
    }

    // Common install locations fallback
    const commonPaths = [
      'C:\\Program Files\\Sandboxie-Plus',
      'C:\\Program Files (x86)\\Sandboxie-Plus',
    ]
    for (const p of commonPaths) {
      if (existsSync(join(p, 'Start.exe'))) {
        this._installPath = p
        settings.set('sandboxie_path', p)
        return p
      }
    }

    return null
  }

  _readRegistry(hive, key, name) {
    return new Promise((resolve, reject) => {
      const reg = new Winreg({ hive, key })
      reg.get(name, (err, item) => {
        if (err) reject(err)
        else resolve(item.value)
      })
    })
  }

  // Download latest Sandboxie-Plus from GitHub and install silently
  // onProgress(percent) called during download
  async install(onProgress) {
    const installerPath = join(app.getPath('temp'), 'SandboxiePlusSetup.exe')

    // Fetch latest release metadata
    const releaseInfo = await this._fetchJSON(GITHUB_RELEASES_URL)
    const asset = releaseInfo.assets.find(a =>
      a.name.toLowerCase().includes('x64') && a.name.endsWith('.exe') && !a.name.includes('arm')
    )
    if (!asset) throw new Error('Не удалось найти Sandboxie-Plus x64 installer в релизе')

    // Download
    await this._downloadFile(asset.browser_download_url, installerPath, onProgress)

    // Run silent installer (requires UAC)
    await new Promise((resolve, reject) => {
      const proc = spawn(installerPath, ['/S'], {
        detached: true,
        stdio: 'ignore',
        shell: false,
      })
      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code === 0 || code === 1) resolve()
        else reject(new Error(`Installer exited with code ${code}`))
      })
    })

    // Wait for install to complete (poll registry)
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000))
      const path = await this.detectInstall()
      if (path) return path
    }
    throw new Error('Sandboxie установлен, но путь не найден. Перезапусти панель.')
  }

  _fetchJSON(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'cs2-farm-panel' } }, (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try { resolve(JSON.parse(data)) }
          catch (e) { reject(e) }
        })
      }).on('error', reject)
    })
  }

  _downloadFile(url, dest, onProgress) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest)
      const request = (reqUrl) => {
        https.get(reqUrl, { headers: { 'User-Agent': 'cs2-farm-panel' } }, (res) => {
          if (res.statusCode === 302 || res.statusCode === 301) {
            return request(res.headers.location)
          }
          const total = parseInt(res.headers['content-length'] || '0', 10)
          let received = 0
          res.on('data', chunk => {
            received += chunk.length
            if (total && onProgress) onProgress(Math.round((received / total) * 100))
          })
          res.pipe(file)
          file.on('finish', () => file.close(resolve))
          res.on('error', reject)
        }).on('error', reject)
      }
      request(url)
    })
  }

  // Create sandbox config in Sandboxie.ini
  async createSandbox(sandboxName, steamPath) {
    const iniPath = this._findSandboxieIni()
    let content = existsSync(iniPath) ? readFileSync(iniPath, 'utf8') : ''

    if (content.includes(`[${sandboxName}]`)) return // already exists

    const normalSteamPath = steamPath.replace(/\\/g, '\\\\')
    const entry = `
[${sandboxName}]
Enabled=y
ConfigLevel=10
AutoRecover=n
BlockNetworkFiles=n
NormalFilePath=${steamPath}
NormalFilePath=${steamPath}\\steamapps\\common\\Counter-Strike Global Offensive
`
    writeFileSync(iniPath, content + entry, 'utf8')
    await execAsync(`"${join(this._installPath, 'SbieCtrl.exe')}" /reload`).catch(() => {})
  }

  _findSandboxieIni() {
    const candidates = [
      join(process.env.APPDATA || '', 'Sandboxie', 'Sandboxie.ini'),
      join(process.env.WINDIR || 'C:\\Windows', 'Sandboxie.ini'),
    ]
    for (const p of candidates) {
      if (existsSync(p)) return p
    }
    // Default: create in AppData
    const dir = join(process.env.APPDATA || '', 'Sandboxie')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return join(dir, 'Sandboxie.ini')
  }

  getStartExe() {
    if (!this._installPath) throw new Error('Sandboxie не установлен')
    return join(this._installPath, 'Start.exe')
  }

  getStopExe() {
    if (!this._installPath) throw new Error('Sandboxie не установлен')
    return join(this._installPath, 'Stop.exe')
  }

  async isInstalled() {
    const path = await this.detectInstall()
    return !!path
  }
}

export default new SandboxieManager()
```

- [ ] **Step 2: Start app, verify no import errors**

```bash
npm run dev
```

No errors on startup. (Module not yet used, just exists.)

---

## Task 4: SteamConfigPatcher.js

**Files:**
- Create: `src/main/modules/SteamConfigPatcher.js`

- [ ] **Step 1: Create the file**

```javascript
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import settings from './Settings'

class SteamConfigPatcher {
  // Write loginusers.vdf into sandbox virtual filesystem
  // steamPath: e.g. "C:\Program Files (x86)\Steam"
  // sandbox: e.g. "cs2_bot1"
  // creds: { login, steamId64 }
  patchLoginusers(sandbox, steamPath, creds) {
    const sandboxBase = join(
      process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local',
      'Sandbox', sandbox, 'drive'
    )

    // Mirror the Steam config path inside sandbox
    const steamDrive = steamPath.replace(/^([A-Za-z]):/, (_, d) => d.toUpperCase())
    const configDir = join(sandboxBase, steamDrive.replace(':', ''), 'config')

    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })

    const vdfPath = join(configDir, 'loginusers.vdf')
    const steamId = creds.steamId64 || '0'

    const content = `"users"
{
\t"${steamId}"
\t{
\t\t"AccountName"\t\t"${creds.login}"
\t\t"RememberPassword"\t"1"
\t\t"MostRecent"\t\t"1"
\t\t"AllowAutoLogin"\t\t"1"
\t}
}
`
    writeFileSync(vdfPath, content, 'utf8')
    return vdfPath
  }

  // Auto-detect Steam installation path from registry, return default if not found
  async detectSteamPath() {
    const saved = settings.get('steam_path')
    if (saved && existsSync(saved)) return saved

    const candidates = [
      'C:\\Program Files (x86)\\Steam',
      'C:\\Program Files\\Steam',
      join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Steam'),
    ]
    for (const p of candidates) {
      if (existsSync(join(p, 'steam.exe'))) {
        settings.set('steam_path', p)
        return p
      }
    }
    return 'C:\\Program Files (x86)\\Steam'
  }

  async detectCS2Path(steamPath) {
    const saved = settings.get('cs2_path')
    if (saved && existsSync(saved)) return saved

    const candidates = [
      join(steamPath, 'steamapps', 'common', 'Counter-Strike Global Offensive'),
      join(steamPath, 'steamapps', 'common', 'Counter-Strike 2'),
    ]
    for (const p of candidates) {
      if (existsSync(p)) {
        settings.set('cs2_path', p)
        return p
      }
    }
    return null
  }
}

export default new SteamConfigPatcher()
```

---

## Task 5: UIAutomation.js

**Files:**
- Create: `src/main/modules/UIAutomation.js`

- [ ] **Step 1: Create the file**

```javascript
import { keyboard, Key } from '@nut-tree-fork/nut-js'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

// Find window by title substring using PowerShell (Windows only)
async function findWindowByTitle(titleSubstring, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execAsync(
        `powershell -Command "(Get-Process | Where-Object { $_.MainWindowTitle -like '*${titleSubstring}*' } | Select-Object -First 1).MainWindowTitle"`
      )
      const title = stdout.trim()
      if (title && title !== '') return title
    } catch {}
    await new Promise(r => setTimeout(r, 1000))
  }
  return null
}

// Wait for window with given title to appear, then focus it and type text
async function typeIntoWindow(titleSubstring, text, delayBetweenChars = 80) {
  // Focus the window via PowerShell
  await execAsync(`powershell -Command "
    Add-Type -AssemblyName Microsoft.VisualBasic
    $proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*${titleSubstring}*' } | Select-Object -First 1
    if ($proc) { [Microsoft.VisualBasic.Interaction]::AppActivate($proc.Id) }
  "`).catch(() => {})

  await new Promise(r => setTimeout(r, 500))

  // Type each character
  for (const char of text) {
    await keyboard.type(char)
    await new Promise(r => setTimeout(r, delayBetweenChars))
  }
  await keyboard.pressKey(Key.Return)
  await keyboard.releaseKey(Key.Return)
}

// Wait for window to disappear (max timeoutMs)
async function waitWindowGone(titleSubstring, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const win = await findWindowByTitle(titleSubstring, 500)
    if (!win) return true
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}

export const UIAutomation = { findWindowByTitle, typeIntoWindow, waitWindowGone }
```

---

## Task 6: CS2Launcher.js

**Files:**
- Create: `src/main/modules/CS2Launcher.js`

- [ ] **Step 1: Create the file**

```javascript
import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import { promisify } from 'util'
import SteamTotp from 'steam-totp'
import sandboxieManager from './SandboxieManager'
import steamConfigPatcher from './SteamConfigPatcher'
import { UIAutomation } from './UIAutomation'
import accountManager from './AccountManager'

const sleep = ms => new Promise(r => setTimeout(r, ms))

class CS2Launcher extends EventEmitter {
  constructor() {
    super()
    this._running = new Map() // accountId → { sandbox, steamProc }
  }

  // creds: { login, password, sharedSecret, steamId64 }
  async start(accountId, slot, creds) {
    if (this._running.has(accountId)) return

    const steamPath = await steamConfigPatcher.detectSteamPath()
    const cs2Path   = await steamConfigPatcher.detectCS2Path(steamPath)
    if (!cs2Path) throw new Error('CS2 не установлен. Установи через Steam на хосте.')

    const startExe = sandboxieManager.getStartExe()
    const sandbox  = slot.sandbox

    // Ensure sandbox exists
    await sandboxieManager.createSandbox(sandbox, steamPath)

    // Patch loginusers.vdf inside sandbox
    steamConfigPatcher.patchLoginusers(sandbox, steamPath, creds)

    // Launch Steam in sandbox
    console.log(`[CS2Launcher ${accountId}] launching Steam in sandbox: ${sandbox}`)
    const steamProc = spawn(startExe, [`/box:${sandbox}`, `${steamPath}\\steam.exe`, '-login', creds.login, creds.password], {
      detached: true,
      stdio: 'ignore',
    })
    this._running.set(accountId, { sandbox, steamProc })

    // Handle Steam Guard prompt
    await this._handleSteamGuard(accountId, creds)

    // Wait for Steam main window
    console.log(`[CS2Launcher ${accountId}] waiting for Steam main window`)
    const steamReady = await UIAutomation.findWindowByTitle('Steam', 45_000)
    if (!steamReady) throw new Error('Steam не запустился в песочнице за 45 секунд')

    await sleep(3000)

    // Launch CS2
    console.log(`[CS2Launcher ${accountId}] launching CS2`)
    spawn(startExe, [`/box:${sandbox}`, `${steamPath}\\steam.exe`, '-applaunch', '730', '-novid', '-nojoy'], {
      detached: true,
      stdio: 'ignore',
    })

    // Wait for CS2 window
    console.log(`[CS2Launcher ${accountId}] waiting for CS2 window`)
    const cs2Ready = await UIAutomation.findWindowByTitle('Counter-Strike 2', 120_000)
    if (!cs2Ready) throw new Error('CS2 не загрузилась за 120 секунд — проверь установку')

    // Extra delay for main menu to load
    await sleep(10_000)
    console.log(`[CS2Launcher ${accountId}] CS2 ready`)
  }

  async _handleSteamGuard(accountId, creds) {
    // Wait up to 15s for Steam Guard window
    const guardWindow = await UIAutomation.findWindowByTitle('Steam Guard', 15_000)
    if (!guardWindow) return // no guard needed (session remembered)

    if (creds.sharedSecret) {
      // Auto-generate TOTP code
      const code = SteamTotp.generateAuthCode(creds.sharedSecret)
      console.log(`[CS2Launcher ${accountId}] auto-entering Steam Guard code`)
      await UIAutomation.typeIntoWindow('Steam Guard', code)
    } else {
      // Ask user via panel modal
      console.log(`[CS2Launcher ${accountId}] requesting Steam Guard from user`)
      this.emit('steamGuardRequired', { accountId })

      // Wait for user to provide code via provideGuardCode()
      const code = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Steam Guard timeout — пользователь не ввёл код')), 300_000)
        this.once(`guardCode:${accountId}`, (c) => { clearTimeout(timeout); resolve(c) })
      })
      await UIAutomation.typeIntoWindow('Steam Guard', code)
    }

    // Wait for Steam Guard window to close
    await UIAutomation.waitWindowGone('Steam Guard', 15_000)
  }

  provideGuardCode(accountId, code) {
    this.emit(`guardCode:${accountId}`, code)
  }

  async stop(accountId) {
    const entry = this._running.get(accountId)
    if (!entry) return

    const stopExe = sandboxieManager.getStopExe()
    console.log(`[CS2Launcher ${accountId}] stopping sandbox: ${entry.sandbox}`)
    const proc = spawn(stopExe, [`/box:${entry.sandbox}`, '/silent'], { detached: true, stdio: 'ignore' })
    await new Promise(r => proc.on('close', r).on('error', r))

    this._running.delete(accountId)
  }

  isRunning(accountId) {
    return this._running.has(accountId)
  }
}

export default new CS2Launcher()
```

---

## Task 7: LauncherPool.js

**Files:**
- Create: `src/main/modules/LauncherPool.js`

- [ ] **Step 1: Create the file**

```javascript
import db from './Database'

class LauncherPool {
  // Returns slot object { id, name, sandbox } or throws if all busy
  async requestSlot(accountId) {
    const slot = db.get(
      "SELECT * FROM launcher_slots WHERE occupied_by IS NULL LIMIT 1"
    )
    if (!slot) throw new Error('Нет свободных слотов запуска. Дождись освобождения или добавь слот в Настройках.')

    db.run('UPDATE launcher_slots SET occupied_by = ? WHERE id = ?', [accountId, slot.id])
    return slot
  }

  releaseSlot(accountId) {
    db.run('UPDATE launcher_slots SET occupied_by = NULL WHERE occupied_by = ?', [accountId])
  }

  getSlots() {
    return db.all('SELECT * FROM launcher_slots ORDER BY id')
  }

  addSlot(name, sandbox) {
    db.run('INSERT INTO launcher_slots (name, sandbox) VALUES (?, ?)', [name, sandbox])
  }

  removeSlot(id) {
    db.run('UPDATE launcher_slots SET occupied_by = NULL WHERE id = ?', [id])
    db.run('DELETE FROM launcher_slots WHERE id = ?', [id])
  }

  // Auto-create default slot on first install
  ensureDefaultSlot() {
    const existing = db.all('SELECT id FROM launcher_slots LIMIT 1')
    if (existing.length === 0) {
      this.addSlot('Слот 1', 'cs2_bot1')
    }
  }
}

export default new LauncherPool()
```

---

## Task 8: SteamWorker.js — startFarming / stopFarming

**Files:**
- Modify: `src/main/modules/SteamWorker.js`

- [ ] **Step 1: Add imports at top**

Find the existing imports block and add:

```javascript
import launcherPool from './LauncherPool'
import cs2Launcher from './CS2Launcher'
```

- [ ] **Step 2: Add startFarming() and stopFarming() methods**

Add these two methods to the `SteamWorker` class, after the `provideCode()` method:

```javascript
  async startFarming() {
    if (this.status !== 'online') throw new Error('Аккаунт должен быть в статусе online перед запуском CS2')

    const creds = accountManager.getCredentials(this.accountId)
    if (!creds) throw new Error('Аккаунт не найден')

    // Drop protocol session — Steam allows only one active session
    this.stop()

    this._setStatus('connecting', 'Запуск CS2...')

    try {
      const slot = await launcherPool.requestSlot(this.accountId)

      cs2Launcher.once('steamGuardRequired', ({ accountId }) => {
        if (accountId === this.accountId) {
          this.emit('sandboxSteamGuard', { accountId: this.accountId })
        }
      })

      await cs2Launcher.start(this.accountId, slot, creds)
      this._setStatus('farming', `CS2 запущен в ${slot.sandbox}`)
    } catch (err) {
      launcherPool.releaseSlot(this.accountId)
      this._setStatus('error', err.message)
      this.emit('error', { accountId: this.accountId, code: 'ERR_FARMING', message: err.message })
    }
  }

  async stopFarming() {
    await cs2Launcher.stop(this.accountId)
    launcherPool.releaseSlot(this.accountId)
    this._setStatus('idle')
  }

  provideSandboxCode(code) {
    cs2Launcher.provideGuardCode(this.accountId, code)
  }
```

- [ ] **Step 3: Add 'farming' to status set check in _setStatus if needed**

Verify `_setStatus` just sets `this.status = status` — no whitelist check. Current code is fine as-is.

---

## Task 9: WorkerManager.js + ipc.js + preload — farming events

**Files:**
- Modify: `src/main/modules/WorkerManager.js`
- Modify: `src/main/ipc.js`
- Modify: `src/preload/index.js`

- [ ] **Step 1: WorkerManager — subscribe to sandboxSteamGuard and expose startFarming/stopFarming**

In `start(accountId)` method, after the existing `worker.on('drop', ...)` block, add:

```javascript
    worker.on('sandboxSteamGuard', (payload) => {
      console.log('[WorkerManager] sandboxSteamGuard:', payload.accountId)
      this.webContents?.send('worker:sandboxSteamGuard', payload)
    })
```

Add two new public methods to `WorkerManager` class:

```javascript
  async startFarming(accountId) {
    const worker = this.workers.get(accountId)
    if (!worker) throw new Error(`Воркер ${accountId} не запущен`)
    await worker.startFarming()
  }

  async stopFarming(accountId) {
    const worker = this.workers.get(accountId)
    if (worker) await worker.stopFarming()
  }

  provideSandboxCode(accountId, code) {
    const worker = this.workers.get(accountId)
    if (worker) worker.provideSandboxCode(code)
  }
```

- [ ] **Step 2: ipc.js — add new handlers**

Add imports at top of ipc.js:

```javascript
import sandboxieManager from './modules/SandboxieManager'
import launcherPool from './modules/LauncherPool'
import steamConfigPatcher from './modules/SteamConfigPatcher'
```

Add new handlers inside `setupIPC()`:

```javascript
  ipcMain.handle('farm:startCS2', async (_, id) => workerManager.startFarming(id))
  ipcMain.handle('farm:stopCS2',  async (_, id) => workerManager.stopFarming(id))
  ipcMain.handle('farm:sandboxGuardCode', (_, id, code) => workerManager.provideSandboxCode(id, code))

  ipcMain.handle('sandboxie:status', async () => ({
    installed: await sandboxieManager.isInstalled(),
    path: sandboxieManager._installPath,
  }))
  ipcMain.handle('sandboxie:install', async () => {
    return sandboxieManager.install((pct) => {
      workerManager.webContents?.send('sandboxie:installProgress', pct)
    })
  })
  ipcMain.handle('sandboxie:slots',      () => launcherPool.getSlots())
  ipcMain.handle('sandboxie:addSlot',    (_, name, sandbox) => launcherPool.addSlot(name, sandbox))
  ipcMain.handle('sandboxie:removeSlot', (_, id) => launcherPool.removeSlot(id))
  ipcMain.handle('sandboxie:detectPaths', async () => ({
    steamPath: await steamConfigPatcher.detectSteamPath(),
    cs2Path:   await steamConfigPatcher.detectCS2Path(await steamConfigPatcher.detectSteamPath()),
  }))
```

- [ ] **Step 3: preload/index.js — add sandboxie namespace**

Add to the existing `contextBridge.exposeInMainWorld('api', { ... })` object, after the `farm` block:

```javascript
  sandboxie: {
    status:      ()               => ipcRenderer.invoke('sandboxie:status'),
    install:     ()               => ipcRenderer.invoke('sandboxie:install'),
    slots:       ()               => ipcRenderer.invoke('sandboxie:slots'),
    addSlot:     (name, sandbox)  => ipcRenderer.invoke('sandboxie:addSlot', name, sandbox),
    removeSlot:  (id)             => ipcRenderer.invoke('sandboxie:removeSlot', id),
    detectPaths: ()               => ipcRenderer.invoke('sandboxie:detectPaths'),
    onInstallProgress: (cb) => {
      ipcRenderer.removeAllListeners('sandboxie:installProgress')
      ipcRenderer.on('sandboxie:installProgress', (_, pct) => cb(pct))
    },
  },
```

Also update `farm` namespace — add:
```javascript
    startCS2:        (id)         => ipcRenderer.invoke('farm:startCS2', id),
    stopCS2:         (id)         => ipcRenderer.invoke('farm:stopCS2', id),
    sandboxGuardCode:(id, code)   => ipcRenderer.invoke('farm:sandboxGuardCode', id, code),
    onSandboxGuard:  (cb) => {
      ipcRenderer.removeAllListeners('worker:sandboxSteamGuard')
      ipcRenderer.on('worker:sandboxSteamGuard', (_, d) => cb(d))
    },
```

And add `worker:sandboxSteamGuard` to `offAll`:
```javascript
      ipcRenderer.removeAllListeners('worker:sandboxSteamGuard')
```

---

## Task 10: Settings.jsx — CS2 Launch section

**Files:**
- Modify: `src/renderer/src/pages/Settings.jsx`

- [ ] **Step 1: Add new state and imports**

Replace the opening of Settings.jsx with:

```jsx
import { useEffect, useState, useCallback } from 'react'
import { Save, Key, Monitor, Plus, Trash2, CheckCircle, XCircle, Download } from 'lucide-react'

export default function Settings() {
  const [s, setS]             = useState({})
  const [saved, setSaved]     = useState(false)
  const [sbStatus, setSbStatus] = useState(null)   // { installed, path }
  const [slots, setSlots]     = useState([])
  const [installing, setInstalling] = useState(false)
  const [installPct, setInstallPct] = useState(0)
  const [paths, setPaths]     = useState({ steamPath: '', cs2Path: '' })
  const [newSlot, setNewSlot] = useState({ name: '', sandbox: '' })

  const loadLauncherData = useCallback(async () => {
    const [status, slotsData, detectedPaths] = await Promise.all([
      window.api.sandboxie.status(),
      window.api.sandboxie.slots(),
      window.api.sandboxie.detectPaths(),
    ])
    setSbStatus(status)
    setSlots(slotsData)
    setPaths(detectedPaths)
  }, [])

  useEffect(() => {
    window.api.settings.get().then(setS)
    loadLauncherData()
    window.api.sandboxie.onInstallProgress(pct => setInstallPct(pct))
  }, [loadLauncherData])
```

- [ ] **Step 2: Add install handler and slot management**

Add these handler functions inside the component (before the return):

```jsx
  const set = (k, v) => setS(prev => ({ ...prev, [k]: v }))

  const save = async () => {
    for (const [k, v] of Object.entries(s)) await window.api.settings.set(k, v)
    if (paths.steamPath) await window.api.settings.set('steam_path', paths.steamPath)
    if (paths.cs2Path) await window.api.settings.set('cs2_path', paths.cs2Path)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const installSandboxie = async () => {
    setInstalling(true)
    setInstallPct(0)
    try {
      await window.api.sandboxie.install()
      await loadLauncherData()
    } catch (e) {
      alert(`Ошибка установки: ${e.message}`)
    } finally {
      setInstalling(false)
    }
  }

  const addSlot = async () => {
    if (!newSlot.name || !newSlot.sandbox) return
    await window.api.sandboxie.addSlot(newSlot.name, newSlot.sandbox)
    setNewSlot({ name: '', sandbox: '' })
    await loadLauncherData()
  }

  const removeSlot = async (id) => {
    await window.api.sandboxie.removeSlot(id)
    await loadLauncherData()
  }
```

- [ ] **Step 3: Add CS2 Launch section to JSX**

Add this new card section BEFORE the existing License card (before the `<div className="card space-y-4">` containing `<Key>`):

```jsx
      <div className="card space-y-4">
        <p className="text-sm font-medium text-text-primary border-b border-border pb-3 flex items-center gap-2">
          <Monitor size={14} /> Запуск CS2
        </p>

        {/* Sandboxie status */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-text-secondary">Sandboxie-Plus</p>
            <p className="text-xs text-text-muted">Требуется для изоляции аккаунтов</p>
          </div>
          {sbStatus?.installed ? (
            <div className="flex items-center gap-2 text-green-400 text-xs">
              <CheckCircle size={14} /> Установлен
            </div>
          ) : (
            <button className="btn-primary text-xs" onClick={installSandboxie} disabled={installing}>
              {installing ? (
                <><Download size={12} /> Скачивание {installPct}%</>
              ) : (
                <><Download size={12} /> Установить</>
              )}
            </button>
          )}
        </div>

        {/* Steam + CS2 paths */}
        <div className="space-y-3">
          <div>
            <label className="label">Путь к Steam</label>
            <input className="input font-mono text-xs"
              value={paths.steamPath || ''}
              onChange={e => setPaths(p => ({ ...p, steamPath: e.target.value }))}
              placeholder="C:\Program Files (x86)\Steam" />
          </div>
          <div>
            <label className="label">Путь к CS2</label>
            <input className="input font-mono text-xs"
              value={paths.cs2Path || ''}
              onChange={e => setPaths(p => ({ ...p, cs2Path: e.target.value }))}
              placeholder="Автоопределение..." />
            {!paths.cs2Path && (
              <p className="text-xs text-red-400 mt-1">CS2 не найден. Установи через Steam.</p>
            )}
          </div>
        </div>

        {/* Launcher slots */}
        <div>
          <p className="text-xs text-text-muted mb-2">Слоты запуска</p>
          <div className="space-y-2">
            {slots.map(slot => (
              <div key={slot.id} className="flex items-center justify-between bg-bg-hover rounded-lg px-3 py-2">
                <div>
                  <p className="text-sm text-text-primary">{slot.name}</p>
                  <p className="text-xs text-text-muted font-mono">{slot.sandbox}</p>
                </div>
                <div className="flex items-center gap-2">
                  {slot.occupied_by
                    ? <span className="badge-green text-xs">Занят</span>
                    : <span className="badge-gray text-xs">Свободен</span>}
                  <button className="btn-ghost p-1.5" onClick={() => removeSlot(slot.id)}>
                    <Trash2 size={12} className="text-red-400" />
                  </button>
                </div>
              </div>
            ))}
            <div className="flex gap-2 mt-2">
              <input className="input text-sm" placeholder="Имя слота" value={newSlot.name}
                onChange={e => setNewSlot(p => ({ ...p, name: e.target.value }))} />
              <input className="input text-sm font-mono" placeholder="sandbox_name" value={newSlot.sandbox}
                onChange={e => setNewSlot(p => ({ ...p, sandbox: e.target.value }))} />
              <button className="btn-ghost" onClick={addSlot}><Plus size={14} /></button>
            </div>
          </div>
        </div>
      </div>
```

---

## Task 11: Accounts.jsx — "Запустить CS2" button + sandbox SteamGuard

**Files:**
- Modify: `src/renderer/src/pages/Accounts.jsx`

- [ ] **Step 1: Add Gamepad icon to imports**

```jsx
import { Plus, Upload, Trash2, RefreshCw, ShieldCheck, ShieldOff, Shield, Search, Play, Square, Package, Gamepad2 } from 'lucide-react'
```

- [ ] **Step 2: Add sandboxGuardRequest state and useEffect subscription**

Find `const [dropToast, setDropToast] = useState(null)` and add after it:

```jsx
  const [sandboxGuardRequest, setSandboxGuardRequest] = useState(null)
```

In the `useEffect`, after `window.api.farm.onXpUpdate(...)` block, add:

```jsx
    window.api.farm.onSandboxGuard(({ accountId }) => {
      setSandboxGuardRequest({ accountId })
      playBeep()
    })
```

Add `worker:sandboxSteamGuard` cleanup: it's already included in `offAll` from Task 9.

- [ ] **Step 3: Add handleStartCS2 and handleStopCS2 handlers**

Add after existing `handleStop`:

```jsx
  const handleStartCS2 = async (id) => {
    await window.api.farm.startCS2(id)
  }

  const handleStopCS2 = async (id) => {
    await window.api.farm.stopCS2(id)
  }

  const handleSandboxGuardSubmit = async (accountId, code) => {
    await window.api.farm.sandboxGuardCode(accountId, code)
    setSandboxGuardRequest(null)
  }
```

- [ ] **Step 4: Add "Запустить CS2" button in the actions cell**

Find the actions `<td>` in the table row (where Play/Square buttons are). Replace it with:

```jsx
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {!noPrime && (
                        active
                          ? <>
                              <button className="btn-ghost p-1.5" title="Остановить наблюдение" onClick={() => handleStop(a.id)}>
                                <Square size={13} className="text-red-400" />
                              </button>
                              {status !== 'farming' && (
                                <button className="btn-ghost p-1.5" title="Запустить CS2" onClick={() => handleStartCS2(a.id)}>
                                  <Gamepad2 size={13} className="text-blue-400" />
                                </button>
                              )}
                              {status === 'farming' && (
                                <button className="btn-ghost p-1.5" title="Остановить CS2" onClick={() => handleStopCS2(a.id)}>
                                  <Square size={13} className="text-orange-400" />
                                </button>
                              )}
                            </>
                          : <button className="btn-ghost p-1.5" title="Запустить наблюдение" onClick={() => handleStart(a.id)}>
                              <Play size={13} className="text-green-400" />
                            </button>
                      )}
                      <button className="btn-ghost p-1.5"
                        onClick={async () => { await window.api.accounts.delete(a.id); load() }}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
```

- [ ] **Step 5: Add SandboxGuard modal at bottom of JSX**

After the existing `{steamGuardRequest && <SteamGuardModal .../>}` block, add:

```jsx
      {sandboxGuardRequest && (
        <SteamGuardModal
          request={{
            accountId: sandboxGuardRequest.accountId,
            domain: null,
            lastCodeWrong: false,
            login: accounts.find(a => a.id === sandboxGuardRequest.accountId)?.login ?? `#${sandboxGuardRequest.accountId}`,
          }}
          onSubmit={(accountId, code) => handleSandboxGuardSubmit(accountId, code)}
          onClose={() => setSandboxGuardRequest(null)}
        />
      )}
```

---

## Task 12: main/index.js — auto Sandboxie check + default slot

**Files:**
- Modify: `src/main/index.js`

- [ ] **Step 1: Add imports**

```javascript
import sandboxieManager from './modules/SandboxieManager'
import launcherPool from './modules/LauncherPool'
```

- [ ] **Step 2: Add startup checks after existing resetStatuses() call**

```javascript
  accountManager.resetStatuses()
  launcherPool.ensureDefaultSlot()

  // Detect Sandboxie in background — result shown in Settings UI
  sandboxieManager.detectInstall().catch(() => {})
```

---

## Task 13: Manual Verification

- [ ] **Step 1: Run app, open Settings**

```bash
npm run dev
```

Navigate to Настройки → Запуск CS2. Verify:
- Sandboxie status shows Installed/Not Installed correctly
- Steam path detected automatically
- CS2 path detected or shows red warning
- Default slot "Слот 1" appears

- [ ] **Step 2: Install Sandboxie (if not installed)**

Click "Установить" in Settings. Verify progress bar appears, UAC prompt shows, Sandboxie installs.

- [ ] **Step 3: Start an account in Наблюдение mode**

Click ▶ for an account → status goes to `online`. Then click 🎮 "Запустить CS2".

Expected in terminal:
```
[CS2Launcher X] launching Steam in sandbox: cs2_bot1
[CS2Launcher X] waiting for Steam main window
[CS2Launcher X] launching CS2
[CS2Launcher X] waiting for CS2 window
[CS2Launcher X] CS2 ready
```

Account status → `farming` (green).

- [ ] **Step 4: Verify Steam Guard modal (account without shared_secret)**

For an account without shared_secret, during CS2 launch the panel should show the SandboxGuard modal for code entry.

- [ ] **Step 5: Stop farming**

Click Stop CS2 button. CS2 and Steam in sandbox close. Status returns to `idle`.
