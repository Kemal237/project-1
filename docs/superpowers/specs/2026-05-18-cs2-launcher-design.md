# Phase 3B-1: CS2 Launcher — Design

## Goal

Launch the real CS2 game client inside a Sandboxie sandbox for each bot account, in a tiny window (800×600 windowed) to minimize resource usage. After launch the account reaches the CS2 main menu (lobby). Actual matchmaking (DM, competitive) is out of scope — this phase ends at the lobby screen.

## Scope

**In scope:**
- Sandboxie box creation and configuration per account
- Launch Steam in sandbox with `-login user pass`
- Launch CS2 via Steam `-applaunch 730` with minimal-resource flags
- Poll for `cs2.exe` process to confirm lobby reached
- Status updates: `cs2_launching` → `cs2_lobby`
- Stop: kill sandbox (`Stop.exe /box:...`)
- UI button 🎮 in Accounts table to start/stop CS2 per account
- Stop steam-user protocol session before launching real Steam (session conflict)

**Out of scope:**
- Steam Guard auto-type (first login user handles manually in sandbox window)
- Matchmaking, DM, competitive
- Multiple simultaneous accounts beyond what RAM allows

## Architecture

Two completely independent runtime modes per account:

| Mode | What runs | Status |
|---|---|---|
| Protocol (Phase 2/3A) | `steam-user` node library | `online` / `farming` |
| CS2 Launcher (Phase 3B) | Real Steam + CS2 in Sandboxie | `cs2_launching` / `cs2_lobby` |

When CS2 mode starts → protocol mode is stopped first (Steam allows only one active session per account).

```
[User clicks 🎮 on account row]
  → WorkerManager.stop(accountId)        — stop protocol session
  → CS2Launcher.start(accountId, creds)
      1. Detect Sandboxie path
      2. Detect Steam path (registry → fallback)
      3. Write box config to Sandboxie.ini
      4. spawn: Start.exe /box:CS2Bot_<id> steam.exe -login user pass -silent
      5. Poll tasklist every 2s — wait for steam.exe (timeout 40s)
      6. spawn: Start.exe /box:CS2Bot_<id> steam.exe -applaunch 730 <flags>
      7. Poll tasklist every 2s — wait for cs2.exe (timeout 120s)
  → status: cs2_lobby

[User clicks ■ Stop CS2]
  → CS2Launcher.stop(accountId)
      → Stop.exe /box:CS2Bot_<id>
  → status: idle
```

## CS2 Launch Flags

```
-w 800 -h 600 -windowed   tiny window, no fullscreen
-novid                     skip intro video
-nosound                   no audio
-nojoy                     no joystick input
+fps_max 30                limit framerate
+cl_forcepreload 0         don't preload assets
```

## Sandboxie Box Config

One box per account, appended to `C:\Windows\Sandboxie.ini`:

```ini
[CS2Bot_<id>]
Enabled=y
AutoRecover=n
OpenFilePath=<steamPath>\steamapps
OpenKeyPath=HKLM\Software\Valve
OpenKeyPath=HKCU\Software\Valve
```

`OpenFilePath` on steamapps means CS2 game files are read directly from host (not copied into sandbox), saving 30+ GB of disk space.

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/main/modules/CS2Launcher.js` | **Create** | Sandboxie config, process launch, process monitoring, start/stop |
| `src/main/ipc.js` | **Modify** | Add `launcher:start`, `launcher:stop` IPC handlers |
| `src/preload/index.js` | **Modify** | Expose `window.api.launcher` namespace |
| `src/renderer/src/pages/Accounts.jsx` | **Modify** | Add 🎮 button, `cs2_lobby` status badge |

## Status Values Added

| Status | Badge | Label |
|---|---|---|
| `cs2_launching` | yellow | "Запуск CS2" (already defined) |
| `cs2_lobby` | blue | "В лобби CS2" (new) |

## Steam Guard — First Login

On first launch, Steam may require a Steam Guard code. The user sees the Steam window inside the Sandboxie box and types the code manually. On subsequent launches Steam auto-logs in (session remembered in sandbox). No UI automation needed for this phase.

## Resource Expectations

| Accounts | RAM estimate | Notes |
|---|---|---|
| 1 | ~3.5 GB | CS2 baseline |
| 2 | ~6 GB | Workable on 8 GB VM |
| 3 | ~9 GB | Needs 12 GB VM |
| 5 | ~15 GB | Needs 16 GB VM |
