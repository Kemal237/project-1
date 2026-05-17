# CS2 Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Launch CS2 inside a Sandboxie sandbox (tiny 800×600 window) per bot account, reaching the CS2 main menu, with start/stop controls in the Accounts UI.

**Architecture:** `CS2Launcher.js` is a standalone module independent of SteamWorker. On start it stops the protocol session, configures a Sandboxie box, spawns Steam+CS2, and polls `tasklist` until `cs2.exe` appears. Stop kills the box with `Stop.exe`.

**Tech Stack:** Node.js `child_process` (spawn/execSync), PowerShell `tasklist`, Sandboxie `Start.exe`/`Stop.exe`, existing `SteamConfigPatcher` for Steam path detection, `steam-totp` (already installed).

---

### Task 1: CS2Launcher.js — Core Module

**Files:**
- Create: `src/main/modules/CS2Launcher.js`

- [ ] **Step 1: Create CS2Launcher.js**

```javascript
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

    const sbPath = this._findSandboxie()
    if (!sbPath) throw new Error('Sandboxie не найден. Проверь установку.')

    const steamPath = await steamConfigPatcher.detectSteamPath()
    if (!steamPath) throw new Error('Steam не найден. Установи Steam.')

    const boxName = `CS2Bot_${accountId}`

    onStatus('cs2_launching', 'Настройка бокса Sandboxie...')
    this._configureSandboxBox(boxName, steamPath)

    this._active.set(accountId, { boxName, sbPath, steamPath })

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

    await this._waitForProcess('cs2', CS2_TIMEOUT_MS, CS2_POLL_MS)

    onStatus('cs2_lobby', 'CS2 запущен — в лобби')
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

  // ─── private ──────────────────────────────────────────────

  _findSandboxie() {
    for (const p of SANDBOXIE_PATHS) {
      if (existsSync(join(p, 'Start.exe'))) return p
    }
    return null
  }

  _configureSandboxBox(boxName, steamPath) {
    const iniPath = 'C:\\Windows\\Sandboxie.ini'
    let ini = ''
    try { ini = readFileSync(iniPath, 'utf16le') } catch {
      try { ini = readFileSync(iniPath, 'utf8') } catch {}
    }

    if (ini.includes(`[${boxName}]`)) return // already configured

    const entry = [
      `[${boxName}]`,
      'Enabled=y',
      'AutoRecover=n',
      `OpenFilePath=${join(steamPath, 'steamapps')}`,
      'OpenKeyPath=HKLM\\Software\\Valve',
      'OpenKeyPath=HKCU\\Software\\Valve',
      '',
    ].join('\r\n')

    try {
      writeFileSync(iniPath, ini + entry, 'utf16le')
    } catch (e) {
      console.log('[CS2Launcher] Cannot write Sandboxie.ini:', e.message)
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

  _waitForProcess(name, timeoutMs, pollMs) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const check = () => {
        try {
          const out = execSync(
            `tasklist /FI "IMAGENAME eq ${name}.exe" /NH`,
            { encoding: 'utf8', timeout: 5000 }
          )
          if (out.toLowerCase().includes(`${name}.exe`)) return resolve()
        } catch {}
        if (Date.now() > deadline) {
          return reject(new Error(`Timeout: ${name}.exe не запустился за ${timeoutMs / 1000}с`))
        }
        setTimeout(check, pollMs)
      }
      check()
    })
  }
}

export default new CS2Launcher()
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd "d:\project 1" && npm run build`
Expected: `✓ built in ...` with no errors.

- [ ] **Step 3: Commit**

```
git add src/main/modules/CS2Launcher.js
git commit -m "feat: CS2Launcher — запуск CS2 в Sandboxie"
```

---

### Task 2: IPC Handlers

**Files:**
- Modify: `src/main/ipc.js`

- [ ] **Step 1: Add import and handlers to ipc.js**

At the top of `src/main/ipc.js`, add after existing imports:
```javascript
import cs2Launcher   from './modules/CS2Launcher'
```

Inside `setupIPC()`, add after the `farm:steamGuardCode` handler:
```javascript
  ipcMain.handle('launcher:start', async (_, accountId) => {
    const creds = accountManager.getCredentials(accountId)
    if (!creds) return { ok: false, error: 'Аккаунт не найден' }

    // Stop protocol session first (session conflict)
    await workerManager.stop(accountId)
    accountManager.update(accountId, { status: 'cs2_launching' })

    const send = (status, message) => {
      accountManager.update(accountId, { status })
      workerManager.webContents?.send('worker:statusChange', { accountId, status, message })
    }

    cs2Launcher.start(accountId, creds, send).catch(err => {
      send('error', err.message)
      cs2Launcher.stop(accountId)
    })

    return { ok: true }
  })

  ipcMain.handle('launcher:stop', async (_, accountId) => {
    cs2Launcher.stop(accountId)
    accountManager.update(accountId, { status: 'idle' })
    workerManager.webContents?.send('worker:statusChange', { accountId, status: 'idle' })
    return { ok: true }
  })
```

- [ ] **Step 2: Build to verify**

Run: `npm run build`
Expected: `✓ built` with no errors.

- [ ] **Step 3: Commit**

```
git add src/main/ipc.js
git commit -m "feat: IPC launcher:start / launcher:stop"
```

---

### Task 3: Preload API

**Files:**
- Modify: `src/preload/index.js`

- [ ] **Step 1: Add launcher namespace to preload**

In `src/preload/index.js`, add inside the `contextBridge.exposeInMainWorld('api', { ... })` object, after the `farm` block:

```javascript
  launcher: {
    start: (accountId) => ipcRenderer.invoke('launcher:start', accountId),
    stop:  (accountId) => ipcRenderer.invoke('launcher:stop',  accountId),
  },
```

- [ ] **Step 2: Build and commit**

Run: `npm run build`
Expected: `✓ built`

```
git add src/preload/index.js
git commit -m "feat: preload launcher API"
```

---

### Task 4: Accounts UI — 🎮 Button and cs2_lobby Status

**Files:**
- Modify: `src/renderer/src/pages/Accounts.jsx`

- [ ] **Step 1: Add cs2_lobby to STATUS maps**

In `src/renderer/src/pages/Accounts.jsx`, find the `STATUS_BADGE` and `STATUS_LABEL` objects and add:

```javascript
const STATUS_BADGE = {
  // ... existing entries ...
  cs2_lobby: 'badge-blue',   // ← add this
}

const STATUS_LABEL = {
  // ... existing entries ...
  cs2_lobby: 'Лобби CS2',   // ← add this
}
```

Also add `cs2_lobby` to `CS2_STATUSES`:
```javascript
const CS2_STATUSES = new Set([
  'farming', 'lobby', 'cs2_launching', 'cs2_searching',
  'cs2_loading', 'cs2_match',
  'cs2_lobby',   // ← add this
])
```

- [ ] **Step 2: Add Gamepad2 icon import**

In the imports line at the top of `Accounts.jsx`, add `Gamepad2` to the lucide-react import:
```javascript
import { Plus, Upload, Trash2, RefreshCw, Loader, ShieldCheck, ShieldOff, Shield,
         Search, Play, Square, Package, Pencil, Smartphone, ArrowLeftRight,
         Gamepad2 } from 'lucide-react'
```

- [ ] **Step 3: Add handler functions**

After `handleSteamGuardClose`, add:
```javascript
  const CS2_ACTIVE = new Set(['cs2_launching', 'cs2_lobby'])

  const handleStartCS2 = async (id) => {
    await window.api.launcher.start(id)
  }

  const handleStopCS2 = async (id) => {
    await window.api.launcher.stop(id)
  }
```

- [ ] **Step 4: Add 🎮 button to action buttons in each row**

Find the row action buttons section inside `filtered.map(a => ...)`:

```javascript
                    <div className="flex items-center justify-end gap-1">
                      {!noPrime && (
                        active
                          ? <button className="btn-ghost p-1.5" title="Отключить" onClick={() => handleStop(a.id)}>
                              <Square size={13} className="text-red-400" />
                            </button>
                          : <button className="btn-ghost p-1.5" title="Подключить" onClick={() => handleStart(a.id)}>
                              <Play size={13} className="text-green-400" />
                            </button>
                      )}
```

Also disable the regular Play button when CS2 is active. Find the Play button and add `disabled`:
```javascript
                          : <button className="btn-ghost p-1.5" title="Подключить"
                              onClick={() => handleStart(a.id)}
                              disabled={CS2_ACTIVE.has(status)}>
                              <Play size={13} className={CS2_ACTIVE.has(status) ? 'text-text-muted opacity-40' : 'text-green-400'} />
                            </button>
```

Add the 🎮 button after the Play/Square block (before the Pencil button):
```javascript
                      {CS2_ACTIVE.has(status) ? (
                        <button className="btn-ghost p-1.5" title="Остановить CS2"
                          onClick={() => handleStopCS2(a.id)}>
                          <Gamepad2 size={13} className="text-red-400" />
                        </button>
                      ) : (
                        <button className="btn-ghost p-1.5" title="Запустить CS2"
                          onClick={() => handleStartCS2(a.id)}
                          disabled={active}>
                          <Gamepad2 size={13} className={active ? 'text-text-muted opacity-40' : 'text-blue-400'} />
                        </button>
                      )}
```

- [ ] **Step 5: Build and verify**

Run: `npm run build`
Expected: `✓ built` with no errors.

- [ ] **Step 6: Commit**

```
git add src/renderer/src/pages/Accounts.jsx
git commit -m "feat: кнопка запуска CS2 в таблице аккаунтов"
```

---

### Task 5: Push and Release

**Files:** None (git operations only)

- [ ] **Step 1: Push and tag**

```
git push origin main
npm version patch
git push --tags
```

Expected: новый тег отправлен, GitHub Actions запускает сборку.

- [ ] **Step 2: Verify build output**

Run: `npm run build`
Expected: `✓ built` — все 3 бандла без ошибок.
