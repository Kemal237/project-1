# Phase 2: SteamAuth + SteamWorker + WorkerManager — План реализации

> **Для агентов:** ОБЯЗАТЕЛЬНЫЙ SUB-SKILL: используй superpowers:subagent-driven-development или superpowers:executing-plans для пошагового выполнения. Шаги используют синтаксис чекбоксов (`- [ ]`).

**Цель:** Реализовать Steam-аутентификацию, управление сессиями аккаунтов и живые статусы в UI.

**Архитектура:** SteamAuth — чистая функция входа (refreshToken → полный логин). SteamWorker — EventEmitter с машиной состояний на каждый аккаунт. WorkerManager — синглтон-оркестратор, транслирует события в renderer через IPC.

**Стек:** steam-user@5.3.0, steam-totp@2.1.2, Node.js EventEmitter, Electron IPC

---

## Карта файлов

| Файл | Действие | Ответственность |
|------|----------|----------------|
| `src/main/modules/SteamAuth.js` | Создать | Логика входа, refreshToken, 2FA |
| `src/main/modules/SteamWorker.js` | Создать | Машина состояний одного аккаунта |
| `src/main/modules/WorkerManager.js` | Создать | Оркестратор + IPC-мост |
| `src/main/ipc.js` | Изменить | Добавить farm: каналы |
| `src/main/index.js` | Изменить | workerManager.init(win.webContents) |
| `src/preload/index.js` | Изменить | Добавить farm: namespace + worker: события |
| `src/renderer/src/pages/Accounts.jsx` | Изменить | Живые статусы + кнопки старт/стоп |

---

## Задача 1: SteamAuth.js

**Файлы:**
- Создать: `src/main/modules/SteamAuth.js`

- [ ] **Шаг 1: Создать файл SteamAuth.js**

```javascript
// src/main/modules/SteamAuth.js
import SteamUser from 'steam-user'
import SteamTotp from 'steam-totp'

// EResult-коды → немедленная остановка, не повторять
export const FATAL_ERESULTS = new Set([
  SteamUser.EResult.Banned,                          // 76
  SteamUser.EResult.InvalidPassword,                 // 5
  SteamUser.EResult.RateLimitExceeded,               // 84
  SteamUser.EResult.AccountLoginDeniedNeedTwoFactor, // 65
  SteamUser.EResult.AccountDisabled,                 // 43
])

// EResult-коды → временная ошибка, можно повторить
export const RETRY_ERESULTS = new Set([
  SteamUser.EResult.TryAnotherCM,      // 92
  SteamUser.EResult.NoConnection,      // 3
  SteamUser.EResult.ServiceUnavailable,// 41
  SteamUser.EResult.LoggedOff,         // 3 (при разрыве)
])

function makeClient(proxyUrl) {
  return new SteamUser({
    dataDirectory: null,
    autoRelogin: false,
    enablePicsCache: false,
    ...(proxyUrl && { socksProxy: proxyUrl }),
  })
}

function waitLoggedOn(client, ms = 30_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(Object.assign(new Error('Login timeout'), { code: 'ERR_LOGIN_TIMEOUT' })),
      ms
    )
    client.once('loggedOn', () => { clearTimeout(t); resolve() })
    client.once('error', err => { clearTimeout(t); reject(err) })
  })
}

/**
 * @param {object} creds - { login, password, sharedSecret, refreshToken }
 * @param {string|null} proxyUrl - 'socks5://user:pass@host:port' или null
 * @returns {Promise<{ client: SteamUser, refreshToken: string|null }>}
 */
export async function login(creds, proxyUrl) {
  if (!proxyUrl) {
    throw Object.assign(new Error('Прокси обязателен'), { code: 'ERR_NO_PROXY' })
  }

  // Попытка через refreshToken (без пароля и 2FA)
  if (creds.refreshToken) {
    const client = makeClient(proxyUrl)
    try {
      client.login({ refreshToken: creds.refreshToken })
      await waitLoggedOn(client)
      return { client, refreshToken: creds.refreshToken }
    } catch {
      client.logOff()
      client.removeAllListeners()
      // Падаем на полный логин ниже
    }
  }

  // Полный логин с паролем и 2FA
  const client = makeClient(proxyUrl)
  let newToken = null
  client.once('refreshToken', t => { newToken = t })

  const twoFactorCode = creds.sharedSecret
    ? SteamTotp.generateAuthCode(creds.sharedSecret)
    : undefined

  client.login({ accountName: creds.login, password: creds.password, twoFactorCode })
  await waitLoggedOn(client)

  return { client, refreshToken: newToken }
}
```

- [ ] **Шаг 2: Закоммитить**

```bash
git add src/main/modules/SteamAuth.js
git commit -m "feat: add SteamAuth module with refreshToken reuse and 2FA support"
```

---

## Задача 2: SteamWorker.js

**Файлы:**
- Создать: `src/main/modules/SteamWorker.js`

- [ ] **Шаг 1: Создать файл SteamWorker.js**

```javascript
// src/main/modules/SteamWorker.js
import { EventEmitter } from 'events'
import { login, FATAL_ERESULTS } from './SteamAuth'
import accountManager from './AccountManager'
import proxyManager from './ProxyManager'

const PRIME_PACKAGE_ID = 54029
const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 80_000]

export class SteamWorker extends EventEmitter {
  constructor(accountId) {
    super()
    this.accountId = accountId
    this.status    = 'idle'
    this.client    = null
    this._retries  = 0
    this._stopped  = false
  }

  async start() {
    this._stopped = false
    this._retries = 0
    await this._connect()
  }

  stop() {
    this._stopped = true
    if (this.client) {
      this.client.logOff()
      this.client.removeAllListeners()
      this.client = null
    }
    this._setStatus('idle')
  }

  // ── Внутренние методы ──────────────────────────────────────

  async _connect() {
    this._setStatus('connecting')

    const creds = accountManager.getCredentials(this.accountId)
    if (!creds) return this._fatal('ERR_NO_ACCOUNT', 'Аккаунт не найден в базе')

    const proxyUrl = proxyManager.getProxyUrl(creds.proxyId)
    if (!proxyUrl) return this._fatal('ERR_NO_PROXY', 'Прокси не назначен — обязателен для защиты')

    try {
      const { client, refreshToken } = await login(creds, proxyUrl)
      this.client = client

      // Сохраняем новый refreshToken если он изменился
      if (refreshToken && refreshToken !== creds.refreshToken) {
        accountManager.saveRefreshToken(this.accountId, refreshToken)
        this.emit('refreshToken', { accountId: this.accountId, token: refreshToken })
      }

      this._retries = 0
      this._setupClientEvents()
    } catch (err) {
      if (this._stopped) return
      if (FATAL_ERESULTS.has(err.eresult)) {
        return this._fatal(err.code || 'ERR_FATAL', err.message)
      }
      this._retry()
    }
  }

  _setupClientEvents() {
    const { client, accountId } = this

    // Проверка Prime-статуса через список лицензий
    client.once('licenses', (licenses) => {
      if (this._stopped) return
      const hasPrime = licenses.some(l => l.package_id === PRIME_PACKAGE_ID)
      accountManager.update(accountId, { isPrime: hasPrime })

      if (!hasPrime) {
        this._setStatus('no_prime', 'Нет Prime-статуса — аккаунт не может получать дропы')
        client.logOff()
        return
      }

      // Помечаем аккаунт как играющий в CS2 (appid 730)
      client.gamesPlayed([730])
      this._setStatus('online')
    })

    // Разрыв соединения
    client.on('loggedOff', (eresult) => {
      if (this._stopped) return
      client.removeAllListeners()
      this.client = null
      FATAL_ERESULTS.has(eresult)
        ? this._fatal('ERR_LOGGED_OFF', `Steam отключил (EResult: ${eresult})`)
        : this._retry()
    })

    // Ошибка соединения
    client.on('error', (err) => {
      if (this._stopped) return
      client.removeAllListeners()
      this.client = null
      FATAL_ERESULTS.has(err.eresult)
        ? this._fatal(err.code || 'ERR_UNKNOWN', err.message)
        : this._retry()
    })
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
    this.emit('statusChange', { accountId: this.accountId, status, message })
  }
}
```

- [ ] **Шаг 2: Закоммитить**

```bash
git add src/main/modules/SteamWorker.js
git commit -m "feat: add SteamWorker with state machine, Prime detection, smart reconnect"
```

---

## Задача 3: WorkerManager.js

**Файлы:**
- Создать: `src/main/modules/WorkerManager.js`

- [ ] **Шаг 1: Создать файл WorkerManager.js**

```javascript
// src/main/modules/WorkerManager.js
import { SteamWorker } from './SteamWorker'
import accountManager from './AccountManager'

class WorkerManager {
  constructor() {
    this.workers    = new Map() // accountId → SteamWorker
    this.webContents = null
  }

  // Вызывается один раз в main/index.js после createWindow()
  init(webContents) {
    this.webContents = webContents
  }

  async start(accountId) {
    if (this.workers.has(accountId)) return // уже запущен

    const worker = new SteamWorker(accountId)

    worker.on('statusChange', (payload) => {
      accountManager.update(payload.accountId, { status: payload.status })
      this.webContents?.send('worker:statusChange', payload)
    })

    worker.on('refreshToken', ({ accountId: id, token }) => {
      accountManager.saveRefreshToken(id, token)
    })

    worker.on('error', (payload) => {
      this.webContents?.send('worker:error', payload)
    })

    this.workers.set(accountId, worker)

    // start() не бросает — ошибки идут через событие 'error'
    worker.start().catch(() => {})
  }

  async stop(accountId) {
    const worker = this.workers.get(accountId)
    if (!worker) return
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
}

export default new WorkerManager()
```

- [ ] **Шаг 2: Закоммитить**

```bash
git add src/main/modules/WorkerManager.js
git commit -m "feat: add WorkerManager orchestrator with IPC event bridge"
```

---

## Задача 4: Подключение IPC

**Файлы:**
- Изменить: `src/main/ipc.js`
- Изменить: `src/main/index.js`
- Изменить: `src/preload/index.js`

- [ ] **Шаг 1: Обновить src/main/ipc.js**

Добавить импорт и 4 новых обработчика. Итоговый файл:

```javascript
// src/main/ipc.js
import { ipcMain } from 'electron'
import accountManager from './modules/AccountManager'
import proxyManager   from './modules/ProxyManager'
import settings       from './modules/Settings'
import dropTracker    from './modules/DropTracker'
import workerManager  from './modules/WorkerManager'

export function setupIPC() {
  ipcMain.handle('accounts:getAll',    ()           => accountManager.getAll())
  ipcMain.handle('accounts:add',       (_, d)       => accountManager.add(d))
  ipcMain.handle('accounts:update',    (_, id, d)   => accountManager.update(id, d))
  ipcMain.handle('accounts:delete',    (_, id)      => accountManager.delete(id))
  ipcMain.handle('accounts:import',    (_, text)    => accountManager.importFromText(text))

  ipcMain.handle('proxies:getAll',     ()           => proxyManager.getAll())
  ipcMain.handle('proxies:add',        (_, d)       => proxyManager.add(d))
  ipcMain.handle('proxies:delete',     (_, id)      => proxyManager.delete(id))
  ipcMain.handle('proxies:validate',   (_, d)       => proxyManager.validate(d))
  ipcMain.handle('proxies:assign',     (_, pid, aid)=> proxyManager.assign(pid, aid))

  ipcMain.handle('settings:get',       ()           => settings.getAll())
  ipcMain.handle('settings:set',       (_, k, v)    => settings.set(k, v))

  ipcMain.handle('drops:getAll',       ()           => dropTracker.getAll())
  ipcMain.handle('drops:getByAccount', (_, id)      => dropTracker.getByAccount(id))
  ipcMain.handle('drops:getStats',     ()           => dropTracker.getStats())

  ipcMain.handle('farm:start',    (_, id) => workerManager.start(id))
  ipcMain.handle('farm:stop',     (_, id) => workerManager.stop(id))
  ipcMain.handle('farm:stopAll',  ()      => workerManager.stopAll())
  ipcMain.handle('farm:statuses', ()      => workerManager.getAllStatuses())
}
```

- [ ] **Шаг 2: Обновить src/main/index.js**

Добавить импорт workerManager и вызов init() после createWindow(). Итоговый файл:

```javascript
// src/main/index.js
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { setupIPC } from './ipc'
import db from './modules/Database'
import workerManager from './modules/WorkerManager'

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 1100,
    minHeight: 680,
    frame: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
    ?.replace('localhost', '127.0.0.1')

  if (devUrl) {
    const tryLoad = (attempts) => {
      win.loadURL(devUrl).catch(() => {
        if (attempts > 0) setTimeout(() => tryLoad(attempts - 1), 500)
      })
    }
    setTimeout(() => tryLoad(20), 1000)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  return win
}

app.whenReady().then(async () => {
  await db.init()
  const win = createWindow()
  workerManager.init(win.webContents)
  ipcMain.on('window:minimize', () => win.minimize())
  ipcMain.on('window:maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize())
  ipcMain.on('window:close',    () => win.close())
  setupIPC()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

- [ ] **Шаг 3: Обновить src/preload/index.js**

Добавить namespace `farm` и исправить whitelist событий. Итоговый файл:

```javascript
// src/preload/index.js
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
    onStatus: (cb) => ipcRenderer.on('worker:statusChange', (_, d) => cb(d)),
    onError:  (cb) => ipcRenderer.on('worker:error',        (_, d) => cb(d)),
    offAll:   ()   => {
      ipcRenderer.removeAllListeners('worker:statusChange')
      ipcRenderer.removeAllListeners('worker:error')
    },
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close:    () => ipcRenderer.send('window:close'),
  },
})
```

- [ ] **Шаг 4: Закоммитить**

```bash
git add src/main/ipc.js src/main/index.js src/preload/index.js
git commit -m "feat: wire up farm IPC channels and WorkerManager init"
```

---

## Задача 5: Обновить Accounts.jsx

**Файлы:**
- Изменить: `src/renderer/src/pages/Accounts.jsx`

- [ ] **Шаг 1: Обновить статусы и добавить логику воркеров**

Полностью заменить содержимое файла:

```jsx
// src/renderer/src/pages/Accounts.jsx
import { useEffect, useState, useCallback } from 'react'
import { Plus, Upload, Trash2, RefreshCw, Shield, ShieldOff, Search, Play, Square } from 'lucide-react'

const STATUS_BADGE = {
  online:       'badge-green',
  farming:      'badge-green',
  connecting:   'badge-yellow',
  reconnecting: 'badge-yellow',
  idle:         'badge-gray',
  no_prime:     'badge-orange',
  banned:       'badge-red',
  error:        'badge-red',
  warmup:       'badge-yellow',
}

const STATUS_LABEL = {
  online:       'Онлайн',
  farming:      'Фармит',
  connecting:   'Подключение...',
  reconnecting: 'Реконнект...',
  idle:         'Офлайн',
  no_prime:     'Нет Prime',
  banned:       'Забанен',
  error:        'Ошибка',
  warmup:       'Прогрев',
}

const ACTIVE_STATUSES = new Set(['online', 'connecting', 'reconnecting', 'farming'])

function AddAccountModal({ proxies, onSave, onClose }) {
  const [form, setForm] = useState({ login: '', password: '', sharedSecret: '', identitySecret: '', proxyId: '', isPrime: true, notes: '' })

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const save = async () => {
    if (!form.login || !form.password) return
    await window.api.accounts.add({ ...form, proxyId: form.proxyId || null })
    onSave()
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-bg-card border border-border rounded-xl w-[440px] p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-text-primary mb-5">Добавить аккаунт</h2>
        <div className="space-y-3">
          <div>
            <label className="label">Логин *</label>
            <input className="input" value={form.login} onChange={e => set('login', e.target.value)} placeholder="steam_login" />
          </div>
          <div>
            <label className="label">Пароль *</label>
            <input className="input" type="password" value={form.password} onChange={e => set('password', e.target.value)} placeholder="••••••••" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Shared Secret</label>
              <input className="input font-mono text-xs" value={form.sharedSecret} onChange={e => set('sharedSecret', e.target.value)} placeholder="2FA Secret" />
            </div>
            <div>
              <label className="label">Identity Secret</label>
              <input className="input font-mono text-xs" value={form.identitySecret} onChange={e => set('identitySecret', e.target.value)} placeholder="Trade Secret" />
            </div>
          </div>
          <div>
            <label className="label">Прокси</label>
            <select className="input" value={form.proxyId} onChange={e => set('proxyId', e.target.value)}>
              <option value="">Без прокси</option>
              {proxies.map(p => (
                <option key={p.id} value={p.id}>{p.host}:{p.port}</option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.isPrime} onChange={e => set('isPrime', e.target.checked)} className="rounded" />
            <span className="text-sm text-text-secondary">Prime статус</span>
          </label>
          <div>
            <label className="label">Заметки</label>
            <input className="input" value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Необязательно" />
          </div>
        </div>
        <div className="flex gap-2 mt-5 justify-end">
          <button className="btn-ghost" onClick={onClose}>Отмена</button>
          <button className="btn-primary" onClick={save}>Добавить</button>
        </div>
      </div>
    </div>
  )
}

function ImportModal({ onSave, onClose }) {
  const [text, setText] = useState('')
  const [result, setResult] = useState(null)

  const doImport = async () => {
    const r = await window.api.accounts.import(text)
    setResult(r)
    if (r.success > 0) onSave()
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-bg-card border border-border rounded-xl w-[500px] p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-text-primary mb-2">Массовый импорт</h2>
        <p className="text-text-muted text-xs mb-4">Формат: <span className="font-mono text-text-secondary">login:password:shared_secret:identity_secret</span></p>
        <textarea
          className="input h-48 resize-none font-mono text-xs"
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={"account1:pass1:secret1:\naccount2:pass2:secret2:"}
        />
        {result && (
          <div className="mt-3 text-xs space-y-1">
            <p className="text-green-400">✓ Импортировано: {result.success}</p>
            {result.failed > 0 && <p className="text-red-400">✗ Ошибок: {result.failed}</p>}
          </div>
        )}
        <div className="flex gap-2 mt-4 justify-end">
          <button className="btn-ghost" onClick={onClose}>Закрыть</button>
          <button className="btn-primary" onClick={doImport} disabled={!text.trim()}>Импортировать</button>
        </div>
      </div>
    </div>
  )
}

export default function Accounts() {
  const [accounts, setAccounts]           = useState([])
  const [proxies, setProxies]             = useState([])
  const [search, setSearch]               = useState('')
  const [modal, setModal]                 = useState(null)
  const [selected, setSelected]           = useState(new Set())
  const [workerStatuses, setWorkerStatuses] = useState({}) // { [accountId]: { status, message } }

  const load = useCallback(async () => {
    const [a, p] = await Promise.all([window.api.accounts.getAll(), window.api.proxies.getAll()])
    setAccounts(a)
    setProxies(p)
  }, [])

  useEffect(() => {
    load()

    // Загружаем текущие статусы воркеров
    window.api.farm.statuses().then(s => setWorkerStatuses(s || {}))

    // Подписываемся на живые обновления
    window.api.farm.onStatus(({ accountId, status, message }) => {
      setWorkerStatuses(prev => ({ ...prev, [accountId]: { status, message } }))
    })
    window.api.farm.onError(({ accountId, message }) => {
      setWorkerStatuses(prev => ({ ...prev, [accountId]: { status: 'error', message } }))
    })

    return () => window.api.farm.offAll()
  }, [load])

  const getStatus = (account) => {
    const ws = workerStatuses[account.id]
    return ws ? ws.status : account.status
  }

  const isActive = (account) => ACTIVE_STATUSES.has(getStatus(account))

  const handleStart = async (id) => {
    await window.api.farm.start(id)
  }

  const handleStop = async (id) => {
    await window.api.farm.stop(id)
  }

  const handleStartAll = async () => {
    const eligible = accounts.filter(a => a.isPrime && a.proxy && !isActive(a))
    for (const a of eligible) await window.api.farm.start(a.id)
  }

  const handleStopAll = async () => {
    await window.api.farm.stopAll()
  }

  const filtered = accounts.filter(a =>
    a.login.toLowerCase().includes(search.toLowerCase())
  )

  const toggleSelect = (id) => setSelected(s => {
    const n = new Set(s)
    n.has(id) ? n.delete(id) : n.add(id)
    return n
  })

  const deleteSelected = async () => {
    for (const id of selected) await window.api.accounts.delete(id)
    setSelected(new Set())
    load()
  }

  const activeCount = accounts.filter(a => isActive(a)).length

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Аккаунты</h1>
          <p className="text-text-secondary text-sm mt-0.5">
            {accounts.length} аккаунтов
            {activeCount > 0 && <span className="text-green-400 ml-2">· {activeCount} активных</span>}
          </p>
        </div>
        <div className="flex gap-2">
          {selected.size > 0 && (
            <button className="btn-danger" onClick={deleteSelected}>
              <Trash2 size={14} /> Удалить ({selected.size})
            </button>
          )}
          <button className="btn-ghost" onClick={handleStopAll}>
            <Square size={14} /> Стоп все
          </button>
          <button className="btn-primary" onClick={handleStartAll}>
            <Play size={14} /> Старт все
          </button>
          <button className="btn-ghost" onClick={() => setModal('import')}>
            <Upload size={14} /> Импорт
          </button>
          <button className="btn-ghost" onClick={load}>
            <RefreshCw size={14} />
          </button>
          <button className="btn-primary" onClick={() => setModal('add')}>
            <Plus size={14} /> Добавить
          </button>
        </div>
      </div>

      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          className="input pl-9"
          placeholder="Поиск по логину..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-text-muted text-xs">
              <th className="px-4 py-3 text-left w-8">
                <input
                  type="checkbox"
                  onChange={e => setSelected(e.target.checked ? new Set(filtered.map(a => a.id)) : new Set())}
                  checked={selected.size === filtered.length && filtered.length > 0}
                />
              </th>
              <th className="px-4 py-3 text-left">Логин</th>
              <th className="px-4 py-3 text-left">Статус</th>
              <th className="px-4 py-3 text-left">Prime</th>
              <th className="px-4 py-3 text-left">Прокси</th>
              <th className="px-4 py-3 text-right">XP</th>
              <th className="px-4 py-3 text-right">Дропов / неделя</th>
              <th className="px-4 py-3 text-right">Всего дропов</th>
              <th className="px-4 py-3 text-right">Последний дроп</th>
              <th className="px-4 py-3 text-right w-24"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(a => {
              const status  = getStatus(a)
              const active  = ACTIVE_STATUSES.has(status)
              const noPrime = status === 'no_prime' || !a.isPrime
              return (
                <tr key={a.id} className="border-b border-border/50 hover:bg-bg-hover/50 transition-colors">
                  <td className="px-4 py-3">
                    <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleSelect(a.id)} />
                  </td>
                  <td className="px-4 py-3 font-mono text-text-primary">{a.login}</td>
                  <td className="px-4 py-3">
                    <span className={STATUS_BADGE[status] || 'badge-gray'}>
                      {STATUS_LABEL[status] || status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {a.isPrime
                      ? <Shield size={14} className="text-yellow-400" />
                      : <ShieldOff size={14} className="text-text-muted" />}
                  </td>
                  <td className="px-4 py-3 text-text-secondary font-mono text-xs">
                    {a.proxy ? `${a.proxy.host}:${a.proxy.port}` : <span className="text-text-muted">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right text-text-secondary">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-1.5 bg-bg-hover rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.min((a.xpProgress / 5000) * 100, 100)}%` }} />
                      </div>
                      <span className="text-xs text-text-muted w-12 text-right">{a.xpProgress}/5000</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-green-400">{a.dropsThisWeek}</td>
                  <td className="px-4 py-3 text-right text-text-secondary">{a.dropsTotal}</td>
                  <td className="px-4 py-3 text-right text-text-muted text-xs">
                    {a.lastDropAt ? new Date(a.lastDropAt).toLocaleDateString('ru') : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {!noPrime && (
                        active
                          ? <button className="btn-ghost p-1.5" title="Остановить" onClick={() => handleStop(a.id)}>
                              <Square size={13} className="text-red-400" />
                            </button>
                          : <button className="btn-ghost p-1.5" title="Запустить" onClick={() => handleStart(a.id)}>
                              <Play size={13} className="text-green-400" />
                            </button>
                      )}
                      <button
                        className="btn-ghost p-1.5"
                        onClick={async () => { await window.api.accounts.delete(a.id); load() }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-12 text-center text-text-muted">
                  {search ? 'Ничего не найдено' : 'Аккаунтов нет. Добавьте первый.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modal === 'add'    && <AddAccountModal proxies={proxies} onSave={() => { load(); setModal(null) }} onClose={() => setModal(null)} />}
      {modal === 'import' && <ImportModal onSave={load} onClose={() => setModal(null)} />}
    </div>
  )
}
```

- [ ] **Шаг 2: Добавить стиль `badge-orange` в index.css**

Открыть `src/renderer/src/index.css`, найти блок с `.badge-red` и добавить после него:

```css
.badge-orange {
  @apply inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-500/15 text-orange-400;
}
```

- [ ] **Шаг 3: Закоммитить**

```bash
git add src/renderer/src/pages/Accounts.jsx src/renderer/src/index.css
git commit -m "feat: add live worker status badges and start/stop controls to Accounts page"
```

---

## Задача 6: Проверка работоспособности

- [ ] **Шаг 1: Запустить приложение**

```bash
npm run dev
```

Ожидаемый результат: окно открывается, страница Accounts загружается без ошибок в консоли.

- [ ] **Шаг 2: Проверить без аккаунтов**

Открыть DevTools (Ctrl+Shift+I) → Console. Ошибок быть не должно. Кнопки "Старт все" и "Стоп все" видны вверху.

- [ ] **Шаг 3: Добавить тестовый аккаунт и нажать Старт**

Добавить аккаунт через кнопку "Добавить". Назначить прокси. Нажать кнопку ▶ в строке аккаунта.

Ожидаемый результат в UI: статус меняется `Офлайн` → `Подключение...` → `Онлайн` (если аккаунт валидный и прокси работает).

- [ ] **Шаг 4: Проверить без прокси**

Добавить аккаунт без прокси. Нажать Старт.

Ожидаемый результат: статус `Ошибка`, в DevTools Console — `ERR_NO_PROXY`.

- [ ] **Шаг 5: Проверить кнопку Стоп**

Нажать ■ для активного аккаунта.

Ожидаемый результат: статус возвращается в `Офлайн`.
