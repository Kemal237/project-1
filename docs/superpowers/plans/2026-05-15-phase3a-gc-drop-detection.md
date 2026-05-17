# Phase 3A: CS2 GC Connection + Drop Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect each farming account to the CS2 Game Coordinator after Steam login to detect drops in real-time and track XP progress, without changing the account status from `online`.

**Architecture:** A new `CS2GCClient` module wraps `node-globaloffensive` and is created by `SteamWorker` immediately after `gamesPlayed([730])` is called. It listens for `itemAcquired` (saves drop to DB, pushes IPC event to UI) and `playerProfile` (saves XP to DB). When the worker stops or disconnects, `CS2GCClient.destroy()` cleans up listeners.

**Tech Stack:** `globaloffensive` (npm package), existing `steam-user`, `AccountManager`, `DropTracker`, Electron IPC, React

---

## File Map

| File | Action |
|---|---|
| `src/main/modules/CS2GCClient.js` | Create — wraps globaloffensive, emits `drop` event |
| `src/main/modules/SteamWorker.js` | Modify — creates/destroys CS2GCClient on online/stop |
| `src/main/modules/WorkerManager.js` | Modify — relays `drop` event to renderer via IPC |
| `src/preload/index.js` | Modify — exposes `farm.onDrop`, adds to `offAll` |
| `src/renderer/src/pages/Accounts.jsx` | Modify — shows toast notification on drop |

---

## Task 1: Install globaloffensive

**Files:**
- Modify: `package.json` (via npm)

- [ ] **Шаг 1: Установить пакет**

```bash
npm install globaloffensive
```

Ожидаемый результат: в `package.json` появится `"globaloffensive": "^2.x.x"` в dependencies, `node_modules/globaloffensive` создан.

- [ ] **Шаг 2: Проверить импорт**

В терминале проверить, что пакет резолвится:

```bash
node -e "require('globaloffensive'); console.log('ok')"
```

Ожидаемый результат: вывод `ok` без ошибок.

---

## Task 2: Create CS2GCClient.js

**Files:**
- Create: `src/main/modules/CS2GCClient.js`

- [ ] **Шаг 1: Создать файл**

Создать `src/main/modules/CS2GCClient.js` со следующим содержимым:

```javascript
import { EventEmitter } from 'events'
import GlobalOffensive from 'globaloffensive'
import accountManager from './AccountManager'
import dropTracker from './DropTracker'

export class CS2GCClient extends EventEmitter {
  constructor(steamClient, accountId) {
    super()
    this._steamClient = steamClient
    this._accountId   = accountId
    this._gc          = null
  }

  connect() {
    this._gc = new GlobalOffensive(this._steamClient)

    this._gc.on('connectedToGC', () => {
      console.log(`[CS2GC ${this._accountId}] connected to GC`)
      const steamid = this._steamClient.steamID?.getSteamID64?.()
      if (steamid) this._gc.requestPlayerProfile(steamid)
    })

    this._gc.on('playerProfile', (profile) => {
      const xp = profile?.ranking?.rank_type_stats?.[0]?.current_xp ?? 0
      console.log(`[CS2GC ${this._accountId}] XP: ${xp}`)
      accountManager.update(this._accountId, { xpProgress: xp })
    })

    this._gc.on('itemAcquired', (item) => {
      console.log(`[CS2GC ${this._accountId}] drop received, def_index:`, item?.def_index)
      const drop = {
        name:    String(item?.def_index ?? 'Unknown'),
        type:    item?.origin != null ? String(item.origin) : null,
        assetid: item?.id     != null ? String(item.id)     : null,
        classid: item?.class_id != null ? String(item.class_id) : null,
        price:   0,
      }
      dropTracker.saveDrop(this._accountId, drop)
      this.emit('drop', drop)
    })

    this._gc.on('disconnectedFromGC', (reason) => {
      console.log(`[CS2GC ${this._accountId}] disconnected from GC, reason: ${reason}`)
    })
  }

  destroy() {
    if (!this._gc) return
    this._gc.removeAllListeners()
    this._gc = null
  }
}
```

- [ ] **Шаг 2: Запустить приложение, убедиться что файл не вызывает ошибок импорта**

```bash
npm run dev
```

Открыть DevTools → Console. Ошибок `Cannot find module 'globaloffensive'` или синтаксических ошибок быть не должно. Приложение должно загрузиться как обычно.

---

## Task 3: Modify SteamWorker.js

**Files:**
- Modify: `src/main/modules/SteamWorker.js`

Изменения: импорт CS2GCClient, `this._gc = null` в конструкторе, создание GC в `_handleLicenses`, уничтожение в `stop()` и обработчиках `loggedOff`/`error`.

- [ ] **Шаг 1: Заменить содержимое файла целиком**

```javascript
import { EventEmitter } from 'events'
import SteamUser from 'steam-user'
import { login, FATAL_ERESULTS } from './SteamAuth'
import accountManager from './AccountManager'
import proxyManager from './ProxyManager'
import { CS2GCClient } from './CS2GCClient'

const PRIME_PACKAGE_ID = 54029
const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 80_000]

export class SteamWorker extends EventEmitter {
  constructor(accountId) {
    super()
    this.accountId = accountId
    this.status    = 'idle'
    this.client    = null
    this._gc       = null
    this._retries  = 0
    this._stopped  = false
    this._steamGuardCallback = null
  }

  async start() {
    this._stopped = false
    this._retries = 0
    await this._connect()
  }

  stop() {
    this._stopped = true
    this._steamGuardCallback = null
    this._gc?.destroy()
    this._gc = null
    if (this.client) {
      this.client.logOff()
      this.client.removeAllListeners()
      this.client = null
    }
    this._setStatus('idle')
  }

  async _connect() {
    if (this._stopped) return
    this._setStatus('connecting')

    const creds = accountManager.getCredentials(this.accountId)
    if (!creds) return this._fatal('ERR_NO_ACCOUNT', 'Аккаунт не найден в базе')

    const proxyUrl = proxyManager.getProxyUrl(creds.proxyId)
    if (!proxyUrl) return this._fatal('ERR_NO_PROXY', 'Прокси не назначен — обязателен для защиты')

    try {
      const { client, refreshToken } = await login(creds, proxyUrl, {
        onSteamGuard: (d, cb, wrong) => this._handleSteamGuard(d, cb, wrong),
        onLicenses:   (licenses, c)  => this._handleLicenses(c, licenses),
      })
      this.client = client

      if (refreshToken && refreshToken !== creds.refreshToken) {
        accountManager.saveRefreshToken(this.accountId, refreshToken)
        this.emit('refreshToken', { accountId: this.accountId, token: refreshToken })
      }

      this._retries = 0
      console.log(`[SteamWorker ${this.accountId}] logged in as SteamID: ${client.steamID?.getSteamID64?.() ?? client.steamID}`)
      this._setupClientEvents()
    } catch (err) {
      if (this._stopped) return
      console.log(`[SteamWorker ${this.accountId}] login error — eresult:${err.eresult} code:${err.code} msg:${err.message}`)
      if (FATAL_ERESULTS.has(err.eresult)) {
        return this._fatal(err.code || 'ERR_FATAL', err.message)
      }
      if (err.code === 'ERR_LOGIN_TIMEOUT' && this._steamGuardCallback) {
        this._steamGuardCallback = null
        return this._fatal('ERR_STEAM_GUARD_TIMEOUT', 'Время ввода кода Steam Guard истекло (10 мин)')
      }
      this._retry()
    }
  }

  _handleLicenses(client, licenses) {
    if (this._stopped) return
    const { accountId } = this
    const hasPrime = licenses.some(l => l.package_id === PRIME_PACKAGE_ID)
    accountManager.update(accountId, { isPrime: hasPrime })

    if (!hasPrime) {
      this._setStatus('no_prime', 'Нет Prime-статуса — аккаунт не может получать дропы')
      client.removeAllListeners()
      this.client = null
      client.logOff()
      return
    }

    client.setPersona(SteamUser.EPersonaState.Online)
    client.gamesPlayed([730])
    console.log(`[SteamWorker ${accountId}] gamesPlayed(730) called, hasPrime: ${hasPrime}`)
    this._setStatus('online')

    this._gc = new CS2GCClient(this.client, this.accountId)
    this._gc.on('drop', (item) => this.emit('drop', { accountId: this.accountId, item }))
    this._gc.connect()
  }

  _setupClientEvents() {
    const { client } = this

    client.on('loggedOff', (eresult) => {
      if (this._stopped) return
      console.log(`[SteamWorker ${this.accountId}] loggedOff eresult:${eresult}`)
      this._gc?.destroy()
      this._gc = null
      client.removeAllListeners()
      this.client = null
      FATAL_ERESULTS.has(eresult)
        ? this._fatal('ERR_LOGGED_OFF', `Steam отключил (EResult: ${eresult})`)
        : this._retry()
    })

    client.on('error', (err) => {
      if (this._stopped) return
      console.log(`[SteamWorker ${this.accountId}] client error — eresult:${err.eresult} msg:${err.message}`)
      this._gc?.destroy()
      this._gc = null
      client.removeAllListeners()
      this.client = null
      FATAL_ERESULTS.has(err.eresult)
        ? this._fatal(err.code || 'ERR_UNKNOWN', err.message)
        : this._retry()
    })
  }

  _handleSteamGuard(domain, callback, lastCodeWrong) {
    if (this._stopped) return
    this._steamGuardCallback = callback
    const msg = domain
      ? `Введи код из email (${domain})`
      : 'Введи код из мобильного аутентификатора Steam'
    this._setStatus('awaiting_guard', msg)
    this.emit('steamGuard', { accountId: this.accountId, domain, lastCodeWrong })
  }

  provideCode(code) {
    if (this._steamGuardCallback) {
      this._steamGuardCallback(code)
      this._steamGuardCallback = null
    }
  }

  _retry() {
    if (this._stopped) return
    if (this._retries >= BACKOFF_MS.length) {
      return this._fatal('ERR_MAX_RETRIES', 'Превышен лимит попыток реконнекта (5)')
    }
    const delay = BACKOFF_MS[this._retries++]
    this._setStatus('reconnecting', `Реконнект через ${delay / 1000}с (попытка ${this._retries}/${BACKOFF_MS.length})`)
    setTimeout(() => { if (!this._stopped) this._connect() }, delay)
  }

  _fatal(code, message) {
    this._setStatus('error', message)
    this.emit('error', { accountId: this.accountId, code, message })
  }

  _setStatus(status, message) {
    this.status = status
    console.log(`[SteamWorker ${this.accountId}] status: ${status}`, message || '')
    this.emit('statusChange', { accountId: this.accountId, status, message })
  }
}
```

- [ ] **Шаг 2: Запустить и проверить**

```bash
npm run dev
```

Залогинить аккаунт. В терминале (main process) должны появиться строки:
```
[SteamWorker X] status: online
[CS2GC X] connected to GC
[CS2GC X] XP: <число>
```

Если GC не подключается, `connectedToGC` всё равно придёт через несколько секунд после `gamesPlayed` — это нормально, нужно подождать 5–10 секунд.

---

## Task 4: Modify WorkerManager.js

**Files:**
- Modify: `src/main/modules/WorkerManager.js`

Добавить обработчик события `drop` от воркера и передачу в renderer через IPC.

- [ ] **Шаг 1: Заменить содержимое файла целиком**

```javascript
import { SteamWorker } from './SteamWorker'
import accountManager from './AccountManager'

class WorkerManager {
  constructor() {
    this.workers     = new Map()
    this.webContents = null
  }

  init(webContents) {
    this.webContents = webContents
  }

  async start(accountId) {
    if (this.workers.has(accountId)) return

    const worker = new SteamWorker(accountId)

    worker.on('statusChange', (payload) => {
      accountManager.update(payload.accountId, { status: payload.status })
      this.webContents?.send('worker:statusChange', payload)
      if (payload.status === 'error' || payload.status === 'no_prime') {
        this.workers.delete(accountId)
      }
    })

    worker.on('refreshToken', ({ accountId: id, token }) => {
      accountManager.saveRefreshToken(id, token)
    })

    worker.on('error', (payload) => {
      this.webContents?.send('worker:error', payload)
    })

    worker.on('steamGuard', (payload) => {
      console.log('[WorkerManager] steamGuard event received:', payload)
      this.webContents?.send('worker:steamGuard', payload)
    })

    worker.on('drop', (payload) => {
      console.log('[WorkerManager] drop:', payload.accountId, payload.item?.name)
      this.webContents?.send('worker:drop', payload)
    })

    this.workers.set(accountId, worker)
    worker.start().catch(() => {})
  }

  async stop(accountId) {
    const worker = this.workers.get(accountId)
    if (!worker) return
    worker.removeAllListeners()
    worker.stop()
    this.workers.delete(accountId)
  }

  async stopAll() {
    for (const id of [...this.workers.keys()]) {
      await this.stop(id)
    }
  }

  getStatus(accountId) {
    const worker = this.workers.get(accountId)
    return worker ? { status: worker.status } : null
  }

  getAllStatuses() {
    const result = {}
    for (const [id, worker] of this.workers) {
      result[id] = { status: worker.status }
    }
    return result
  }

  provideCode(accountId, code) {
    const worker = this.workers.get(accountId)
    if (worker) worker.provideCode(code)
  }
}

export default new WorkerManager()
```

---

## Task 5: Modify preload/index.js

**Files:**
- Modify: `src/preload/index.js`

Добавить `onDrop` в namespace `farm` и `worker:drop` в `offAll`.

- [ ] **Шаг 1: Заменить содержимое файла целиком**

```javascript
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  accounts: {
    getAll:       ()           => ipcRenderer.invoke('accounts:getAll'),
    add:          (d)          => ipcRenderer.invoke('accounts:add', d),
    update:       (id, d)      => ipcRenderer.invoke('accounts:update', id, d),
    delete:       (id)         => ipcRenderer.invoke('accounts:delete', id),
    import:       (text)       => ipcRenderer.invoke('accounts:import', text),
  },
  proxies: {
    getAll:       ()           => ipcRenderer.invoke('proxies:getAll'),
    add:          (d)          => ipcRenderer.invoke('proxies:add', d),
    delete:       (id)         => ipcRenderer.invoke('proxies:delete', id),
    validate:     (d)          => ipcRenderer.invoke('proxies:validate', d),
    assign:       (pid, aid)   => ipcRenderer.invoke('proxies:assign', pid, aid),
  },
  settings: {
    get:          ()           => ipcRenderer.invoke('settings:get'),
    set:          (k, v)       => ipcRenderer.invoke('settings:set', k, v),
  },
  drops: {
    getAll:       ()           => ipcRenderer.invoke('drops:getAll'),
    getByAccount: (id)         => ipcRenderer.invoke('drops:getByAccount', id),
    getStats:     ()           => ipcRenderer.invoke('drops:getStats'),
  },
  farm: {
    start:    (id) => ipcRenderer.invoke('farm:start', id),
    stop:     (id) => ipcRenderer.invoke('farm:stop', id),
    stopAll:  ()   => ipcRenderer.invoke('farm:stopAll'),
    statuses: ()   => ipcRenderer.invoke('farm:statuses'),
    onStatus: (cb) => {
      ipcRenderer.removeAllListeners('worker:statusChange')
      ipcRenderer.on('worker:statusChange', (_, d) => cb(d))
    },
    onError: (cb) => {
      ipcRenderer.removeAllListeners('worker:error')
      ipcRenderer.on('worker:error', (_, d) => cb(d))
    },
    onSteamGuard: (cb) => {
      ipcRenderer.removeAllListeners('worker:steamGuard')
      ipcRenderer.on('worker:steamGuard', (_, d) => cb(d))
    },
    onDrop: (cb) => {
      ipcRenderer.removeAllListeners('worker:drop')
      ipcRenderer.on('worker:drop', (_, d) => cb(d))
    },
    submitCode: (accountId, code) =>
      ipcRenderer.invoke('farm:steamGuardCode', accountId, code),
    offAll: () => {
      ipcRenderer.removeAllListeners('worker:statusChange')
      ipcRenderer.removeAllListeners('worker:error')
      ipcRenderer.removeAllListeners('worker:steamGuard')
      ipcRenderer.removeAllListeners('worker:drop')
    },
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close:    () => ipcRenderer.send('window:close'),
  },
})
```

---

## Task 6: Add drop toast to Accounts.jsx

**Files:**
- Modify: `src/renderer/src/pages/Accounts.jsx`

Добавить toast-уведомление когда приходит дроп. Показывается 4 секунды в правом нижнем углу.

- [ ] **Шаг 1: Добавить `Package` в импорт lucide-react**

Найти строку:
```javascript
import { Plus, Upload, Trash2, RefreshCw, Shield, ShieldOff, Search, Play, Square, AlertTriangle } from 'lucide-react'
```

Заменить на:
```javascript
import { Plus, Upload, Trash2, RefreshCw, Shield, ShieldOff, Search, Play, Square, AlertTriangle, Package } from 'lucide-react'
```

- [ ] **Шаг 2: Добавить состояние `dropToast`**

Найти в компоненте `Accounts` блок с объявлением состояний:
```javascript
const [workerStatuses, setWorkerStatuses] = useState({})
```

Добавить после него:
```javascript
const [dropToast, setDropToast] = useState(null) // { login, itemName }
```

- [ ] **Шаг 3: Подписаться на onDrop в useEffect**

Найти в `useEffect` блок где подписываемся на события:
```javascript
    window.api.farm.onSteamGuard((payload) => {
```

Добавить после `onSteamGuard` блока (перед `return () => window.api.farm.offAll()`):
```javascript
    window.api.farm.onDrop(({ accountId, item }) => {
      const acc = accounts.find(a => a.id === accountId)
      const login = acc?.login ?? `#${accountId}`
      setDropToast({ login, itemName: item.name })
      setTimeout(() => setDropToast(null), 4000)
    })
```

- [ ] **Шаг 4: Добавить toast в JSX**

Найти последний закрывающий `</div>` компонента (перед финальным `return` закрытием):
```javascript
      {modal === 'add'    && <AddAccountModal ...
      {modal === 'import' && <ImportModal ...
    </div>
  )
}
```

Добавить toast перед последним `</div>`:
```javascript
      {dropToast && (
        <div className="fixed bottom-6 right-6 bg-bg-card border border-green-500/40 rounded-xl px-4 py-3 shadow-xl z-50 flex items-center gap-3 animate-pulse">
          <Package size={16} className="text-green-400 shrink-0" />
          <div>
            <p className="text-xs text-text-muted">{dropToast.login}</p>
            <p className="text-sm font-medium text-green-400">Дроп получен: {dropToast.itemName}</p>
          </div>
        </div>
      )}
```

- [ ] **Шаг 5: Запустить и убедиться что компиляция прошла**

```bash
npm run dev
```

Открыть DevTools → Console. Ошибок JSX/импорта быть не должно.

---

## Task 7: Ручная проверка

- [ ] **Шаг 1: Проверить GC соединение**

Запустить аккаунт с Prime. В терминале (main process stdout) в течение 10–15 секунд после статуса `online` должны появиться:

```
[CS2GC <id>] connected to GC
[CS2GC <id>] XP: <число>
```

Если `XP: 0` — значит профиль получен, но XP пока 0 (аккаунт новый или структура данных отличается). Это нормально на этапе 3A.

- [ ] **Шаг 2: Проверить XP в БД**

После подключения GC открыть DevTools → Console renderer и выполнить:

```javascript
window.api.accounts.getAll().then(a => console.log(a.map(x => ({ login: x.login, xp: x.xpProgress }))))
```

Ожидаемый результат: массив объектов, у активного аккаунта `xp` не равен null (может быть 0).

- [ ] **Шаг 3: Проверить что статус аккаунта остаётся `online` (не `farming`)**

В UI таблица аккаунтов — статус должен оставаться `Онлайн` (зелёный badge). Не должно быть никакого нового статуса из-за GC.

- [ ] **Шаг 4: Проверить что стоп работает корректно**

Нажать Stop для активного аккаунта. В терминале не должно быть необработанных ошибок от GC. Статус возвращается в `Офлайн`.
