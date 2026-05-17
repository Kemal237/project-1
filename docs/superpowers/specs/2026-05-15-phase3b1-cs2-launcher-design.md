# Phase 3B-1: CS2 Process Launcher — Design

## Goal

Add the foundational ability to launch the real CS2 game client per bot account, in an isolated Sandboxie sandbox, without disrupting the user's main Steam session. After launch, the account status changes to `farming` and CS2 sits at the main menu. Actual XP farming (movement, lobbies, drops) is out of scope and reserved for Phase 3B-2/3/4.

## Architecture

The panel does not care whether it runs on a personal PC or a rented VPS — both work identically. Sandboxie is required for both targets. Each bot account is launched inside a Sandboxie sandbox so its Steam session is isolated from the host (and from other bots).

**Two independent operational modes per account:**

| Button | Action | Target status |
|---|---|---|
| ▶ Наблюдение | Phase 2/3A: protocol-only via `steam-user`, tracks Prime/XP/drops via GC | `online` |
| 🎮 Запустить CS2 | Phase 3B: launches real CS2 in sandbox | `farming` |

**Critical session conflict:** Steam allows only one active session per account. When `farming` starts, the protocol session (`steam-user`) is disconnected first; the real Steam in the sandbox takes over. When `farming` stops, the protocol session may be reconnected.

## Data Flow

```
[User clicks "Запустить CS2" on online account]
  → SteamWorker.stop()                                       (drops protocol session)
  → CS2GCClient.destroy()
  → LauncherPool.requestSlot(accountId)
        → returns slot with sandbox name (e.g. cs2_bot1)
  → CS2Launcher.start(accountId, slot)
        1. SteamConfigPatcher.write(slot.sandbox, account)   (sets username in loginusers.vdf)
        2. spawn: Start.exe /box:cs2_bot1 steam.exe -login user pass
        3. Wait Steam process inside sandbox to appear (5-30s)
        4. Detect Steam Guard window if appears
              → if shared_secret present: generate TOTP, type via UI automation
              → else: open SteamGuardModal in panel, user types, panel auto-types into Steam
        5. Wait Steam main window (logged in)
        6. spawn: Start.exe /box:cs2_bot1 steam.exe -applaunch 730
        7. Wait cs2.exe process inside sandbox + window "Counter-Strike 2" (30-90s)
  → status 'farming'

[User clicks "Стоп"]
  → CS2Launcher.stop(accountId)
        → spawn: Stop.exe /box:cs2_bot1 (kills everything in sandbox)
  → LauncherPool.releaseSlot(accountId)
  → status 'idle'
```

## Tech Stack

- `@nut-tree/nut-js` — UI automation (typing into Steam Guard window) — **new dependency, ~10 MB native**
- `steam-totp` — generates Steam Guard codes (already installed)
- `child_process` (Node built-in) — process spawning
- `winreg` (or shell-based registry query) — detect Sandboxie installation
- `fs` — write `loginusers.vdf`, `Sandboxie.ini`
- Existing: `steam-user`, `globaloffensive`, IPC, React

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/main/modules/SandboxieManager.js` | Create | Detect Sandboxie install, download from GitHub, run installer, create/update sandbox configs |
| `src/main/modules/SteamConfigPatcher.js` | Create | Write `loginusers.vdf` inside a sandbox before Steam launch |
| `src/main/modules/CS2Launcher.js` | Create | Orchestrate launch sequence: Steam → wait → CS2 → wait, plus stop |
| `src/main/modules/UIAutomation.js` | Create | Find Steam Guard window, type code, find Steam main window |
| `src/main/modules/LauncherPool.js` | Create | Manage slot allocation (MVP = 1 slot, designed for N) |
| `src/main/modules/SteamWorker.js` | Modify | Add `startFarming()` / `stopFarming()` methods, status `farming` transitions |
| `src/main/modules/Database.js` | Modify | Add `launcher_slots` table, `cs2_path` setting |
| `src/main/modules/WorkerManager.js` | Modify | Relay new `farmingStarted` / `farmingStopped` IPC events |
| `src/main/ipc.js` | Modify | New handlers: `farm:startCS2`, `farm:stopCS2`, `sandboxie:install`, `sandboxie:status` |
| `src/preload/index.js` | Modify | Expose new namespaces |
| `src/renderer/src/pages/Accounts.jsx` | Modify | Second button "Запустить CS2" + reuse `SteamGuardModal` for sandbox login |
| `src/renderer/src/pages/Settings.jsx` | Modify | New section "Запуск CS2" with Sandboxie status, Steam path, slots |

## Module Details

### SandboxieManager

Detects Sandboxie via registry key `HKLM\SOFTWARE\Sandboxie\InstallPath`. If absent, downloads latest `Sandboxie-Plus_x64.exe` from GitHub releases API (`https://api.github.com/repos/sandboxie-plus/Sandboxie/releases/latest`) and runs it with `/S` flag for silent install. Reports progress via IPC.

For sandbox creation, writes to `Sandboxie.ini` (typically `%WINDIR%\Sandboxie.ini`):

```ini
[cs2_bot1]
Enabled=y
ConfigLevel=10
AutoRecover=n
BlockNetworkFiles=n
NormalFilePath=C:\Program Files (x86)\Steam\
NormalFilePath=C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\
OpenFilePath=%LOCAL APPDATA%\Sandbox\cs2_bot1\Steam\config\
```

Triggers Sandboxie reload via `SbieSvc` API or `SbieCtrl.exe /reload`.

### SteamConfigPatcher

Writes `loginusers.vdf` inside the sandbox's virtual filesystem path (e.g. `%LOCAL APPDATA%\Sandbox\cs2_bot1\drive\C\Program Files (x86)\Steam\config\loginusers.vdf`). Format:

```vdf
"users"
{
    "76561198XXXXXXXXX"
    {
        "AccountName"      "bot_login"
        "RememberPassword" "1"
        "MostRecent"       "1"
        "AllowAutoLogin"   "1"
    }
}
```

This pre-fills the username so Steam GUI shows the password prompt directly without account selection.

### CS2Launcher

Public API:
```javascript
class CS2Launcher {
  async start(accountId, slot, creds)   // returns when CS2 main menu visible
  async stop(accountId)                  // kills sandbox
}
```

Launch sequence handles each step with timeouts and surfaces errors via events. Uses `UIAutomation` for the Steam Guard step.

### UIAutomation

Wraps `@nut-tree/nut-js`:
```javascript
class UIAutomation {
  async findWindow(titleRegex, timeoutMs)
  async typeIntoWindow(window, text)
  async waitWindowGone(window, timeoutMs)
}
```

Used to detect Steam Guard prompt window (title: "Steam Guard") and type the TOTP code.

### LauncherPool

MVP: single slot. API designed for future N slots:

```javascript
class LauncherPool {
  async requestSlot(accountId)     // returns slot or throws if all busy
  async releaseSlot(accountId)
  getSlots()                        // current state
}
```

Stored in DB table `launcher_slots`:
```sql
CREATE TABLE launcher_slots (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,        -- 'Slot 1'
  sandbox     TEXT NOT NULL,        -- 'cs2_bot1'
  occupied_by INTEGER,              -- accountId or NULL
  FOREIGN KEY (occupied_by) REFERENCES accounts(id)
)
```

### SteamWorker changes

Add two new methods that integrate with the existing state machine:

```javascript
async startFarming() {
  // Must be in 'online' status
  this.stop()                                       // drop protocol session
  const creds = accountManager.getCredentials(this.accountId)
  const slot  = await launcherPool.requestSlot(this.accountId)
  await cs2Launcher.start(this.accountId, slot, creds)
  this._setStatus('farming')
}

async stopFarming() {
  await cs2Launcher.stop(this.accountId)
  await launcherPool.releaseSlot(this.accountId)
  this._setStatus('idle')
}
```

## UI Changes

### Accounts page

New button next to existing "Старт":

```
[▶ Наблюдение]  [🎮 Запустить CS2]  [🗑]
```

`Запустить CS2` is enabled only when account is in `online` status (so we know Prime is confirmed and creds are valid).

For accounts without `shared_secret`, when CS2 launch needs Steam Guard input, the existing `SteamGuardModal` reopens — same component as Phase 2, just triggered from a different IPC source (`worker:sandboxSteamGuard`).

### Settings page

New section "Запуск CS2":

- **Sandboxie status:** ✅ Installed (v1.13.4) / ❌ Not installed [Install]
- **Steam path:** auto-detected from registry, editable, [Browse]
- **CS2 path:** auto-detected from Steam library, editable, [Browse]
- **Launcher slots:** list of slots, [+ Add Slot] (MVP: 1 slot)

## Auto-Install Flow

On first panel launch:

1. Check registry for Sandboxie
2. If absent, show modal: "Sandboxie required for farming. Install?"
3. On accept: `SandboxieManager.install()`
   - Fetch latest release URL from GitHub API
   - Download installer (~30 MB) with progress bar
   - Spawn installer with `/S` flag (UAC prompt appears)
   - Poll for installation completion (registry check every 2s)
4. After install: auto-create default sandbox `cs2_bot1`
5. Save default slot in DB

If GitHub API fails (no internet): retry 3× with backoff, then show error.

## Error Handling

| Error | Reaction |
|---|---|
| Sandboxie not installed | Modal prompt to install |
| GitHub download failed | 3× retry, then error message with manual install link |
| Steam path invalid | Settings field highlighted red, farming disabled |
| CS2 not installed in Steam | Error: "Установите CS2 через Steam один раз на хосте" |
| `loginusers.vdf` write failed | Error with sandbox path |
| Steam Guard code wrong | 1× retry (clock drift), then `farming` → `error` status |
| Steam Guard window not found in 60s | `error` status, message "Steam не запустился в песочнице" |
| CS2 not ready in 120s | `error` status, message "CS2 не загрузилась — проверь установку" |
| Account already logged in elsewhere | LogOff in-sandbox → 1× retry |
| Sandbox doesn't exist | Auto-create on first farming attempt |
| All slots busy | Account waits in queue, status `idle` with message "Ожидает свободного слота" |

## What Phase 3B-1 Does NOT Do

- Does not create CS2 lobbies (Phase 3B-2)
- Does not control player movement / anti-AFK (Phase 3B-3)
- Does not auto-pick Care Package items (Phase 3B-4)
- Does not run multiple parallel slots (MVP = 1 slot, but `LauncherPool` API ready for N)
- Does not actually earn XP — CS2 sits at main menu
- Does not handle CS2 updates (assumes CS2 already installed and up-to-date)
- Does not validate Sandboxie sandbox isolation manually (trusts Sandboxie config)

## Status Logic Update

| Status | Meaning | Phase |
|---|---|---|
| `online` | Logged in via protocol, GC monitoring | 3A |
| `farming` | CS2 process running in sandbox, at main menu | 3B-1 |
| `idle` | Nothing running for this account | — |

`online` and `farming` are mutually exclusive (same Steam session conflict).
