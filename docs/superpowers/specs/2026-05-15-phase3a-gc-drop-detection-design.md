# Phase 3A: CS2 GC Connection + Drop Detection — Design

## Goal

Connect each farming account to the CS2 Game Coordinator (GC) after Steam login to enable real-time drop detection and XP progress tracking. Phase 3A is purely observational — it does not change the account status to `farming` (reserved for Phase 3B when actual XP farming via game client is implemented).

## Architecture

`CS2GCClient` is a new module that wraps `node-globaloffensive`. It is created by `SteamWorker` after the account goes `online` (Prime confirmed, `gamesPlayed([730])` called). It receives the existing `steam-user` client instance and connects to the GC over the same Steam connection.

```
SteamWorker
  └─ status: online (Prime confirmed, gamesPlayed active)
       └─ creates CS2GCClient(steamClient, accountId)
            └─ node-globaloffensive
                 ├─ itemAcquired  → DropTracker.saveDrop() + IPC push to renderer
                 └─ playerProfile → AccountManager.update({ xpProgress })
```

When the worker stops (any reason), `CS2GCClient.destroy()` is called before the steam client disconnects.

## Status Logic

| Status | Meaning | Phase |
|---|---|---|
| `online` | Logged in, GC connected, monitoring stats | 3A |
| `farming` | CS2 game client running, XP being earned in a real match | 3B |

In Phase 3A the account status remains `online` at all times. The GC connection is invisible to the user — it runs silently in the background.

## Tech Stack

- `node-globaloffensive` — CS2 GC protocol implementation (new dependency)
- Existing: `steam-user`, `AccountManager`, `DropTracker`, IPC push via `workerManager.webContents`

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/main/modules/CS2GCClient.js` | Create | Wrap node-globaloffensive, handle GC events |
| `src/main/modules/SteamWorker.js` | Modify | Create/destroy CS2GCClient on online/stop |
| `src/main/modules/WorkerManager.js` | Modify | Relay `worker:drop` IPC event to renderer |
| `src/main/ipc.js` | No change | — |
| `src/preload/index.js` | Modify | Expose `farm.onDrop` / include in `offAll` |
| `src/renderer/src/pages/Accounts.jsx` | Modify | Toast notification on drop |

## CS2GCClient Details

### Constructor

```javascript
export class CS2GCClient {
  constructor(steamClient, accountId)
  // steamClient: logged-in SteamUser instance
  // accountId: number, used when emitting events to DropTracker / AccountManager
}
```

### Public API

```javascript
connect()   // creates GlobalOffensive instance, registers listeners
destroy()   // removes all listeners, nulls gc instance
```

### GC Events Handled

| GC Event | Action |
|---|---|
| `connectedToGC` | Call `gc.requestPlayerProfile(steamid)` to get XP |
| `playerProfile` | Call `AccountManager.update(accountId, { xpProgress: profile.ranking?.rank_type_stats?.[0]?.current_xp })` |
| `itemAcquired` | Call `DropTracker.saveDrop(accountId, item)`, emit `drop` event |
| `disconnectedFromGC` | Log only — GC reconnects automatically when still in-game |

### Lifecycle in SteamWorker

```javascript
// _handleLicenses → hasPrime → gamesPlayed([730]) → _setStatus('online')
this._gc = new CS2GCClient(this.client, this.accountId)
this._gc.on('drop', (item) => this.emit('drop', { accountId: this.accountId, item }))
this._gc.connect()

// stop()
this._gc?.destroy()
this._gc = null
```

## IPC Drop Notification

When a drop is detected:
1. `CS2GCClient` emits `drop` event
2. `SteamWorker` re-emits as `drop` with `{ accountId, item }`
3. `WorkerManager` relays via `webContents.send('worker:drop', payload)`
4. Preload exposes `farm.onDrop(cb)` + included in `farm.offAll()`
5. `Accounts.jsx` shows a brief toast notification with item name

## XP Progress

- Fetched once on GC connect via `requestPlayerProfile`
- Stored in `accounts.xp_progress` (field already exists in DB schema)
- Updated in DB via `AccountManager.update()`
- UI XP progress bar in Accounts table already renders this field — it will populate with real data automatically
- No real-time IPC push for XP (only on GC connect). Re-fetched on next restart.

## Error Handling

- GC connection failure: log only, do not change account status, do not stop worker
- `itemAcquired` with unknown item format: log and skip (do not crash)
- `destroy()` called before `connect()`: no-op (guard against null gc)

## What Phase 3A Does NOT Do

- Does not change status to `farming` (Phase 3B)
- Does not launch CS2 game client (Phase 3B)
- Does not track XP changes over time in real-time (only on GC connect)
- Does not implement lobby creation (Phase 3B)
