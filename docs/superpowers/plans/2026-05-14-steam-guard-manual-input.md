# Steam Guard Ручной Ввод — План реализации

> **Для агентов:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development или superpowers:executing-plans. Шаги используют синтаксис чекбоксов (`- [ ]`).

**Цель:** Добавить поддержку ручного ввода Steam Guard кода через UI-диалог вместо фатальной ошибки.

**Архитектура:** SteamWorker перехватывает `steamGuard` событие от steam-user, сохраняет callback, переходит в статус `awaiting_guard` и эмитит событие вверх. WorkerManager транслирует событие в renderer. UI показывает модал с таймером 120с. Код передаётся обратно через IPC → WorkerManager → SteamWorker → steam-user callback.

**Стек:** steam-user (steamGuard event), Electron IPC, React useState/useEffect, Web Audio API

---

## Карта файлов

| Файл | Действие | Что меняем |
|------|----------|-----------|
| `src/main/modules/SteamAuth.js` | Изменить | Принять `{ onSteamGuard }` опцию, добавить listener |
| `src/main/modules/SteamWorker.js` | Изменить | `_steamGuardCallback`, `_handleSteamGuard()`, `provideCode()`, обновить `stop()` и `_connect()` |
| `src/main/modules/WorkerManager.js` | Изменить | Relay `steamGuard` события + метод `provideCode()` |
| `src/main/ipc.js` | Изменить | Канал `farm:steamGuardCode` |
| `src/preload/index.js` | Изменить | `farm.onSteamGuard()`, `farm.submitCode()`, обновить `offAll()` |
| `src/renderer/src/pages/Accounts.jsx` | Изменить | `SteamGuardModal`, статус `awaiting_guard`, ⚠ tooltip, звук |

---

## Задача 1: SteamAuth.js — добавить onSteamGuard callback

**Файлы:**
- Изменить: `src/main/modules/SteamAuth.js`

- [ ] **Шаг 1: Обновить сигнатуру функции login() и добавить steamGuard listener**

Изменить строку 52 — сигнатуру `login()`:

```javascript
export async function login(creds, proxyUrl, { onSteamGuard } = {}) {
```

Добавить listener после строки 73 (`let newToken = null`), перед `try {`:

```javascript
  if (onSteamGuard) {
    client.on('steamGuard', (domain, callback, lastCodeWrong) => {
      onSteamGuard(domain, callback, lastCodeWrong)
    })
  }
```

Итоговый блок полного логина (строки 72–90) после правки:

```javascript
  const client = makeClient(proxyUrl)
  let newToken = null
  client.once('refreshToken', t => { newToken = t })

  if (onSteamGuard) {
    client.on('steamGuard', (domain, callback, lastCodeWrong) => {
      onSteamGuard(domain, callback, lastCodeWrong)
    })
  }

  try {
    const twoFactorCode = creds.sharedSecret
      ? SteamTotp.generateAuthCode(creds.sharedSecret)
      : undefined

    const p = waitLoggedOn(client)
    client.login({ accountName: creds.login, password: creds.password, twoFactorCode })
    await p
  } catch (err) {
    client.logOff()
    client.removeAllListeners()
    throw err
  }

  return { client, refreshToken: newToken }
```

---

## Задача 2: SteamWorker.js — обработка Steam Guard

**Файлы:**
- Изменить: `src/main/modules/SteamWorker.js`

- [ ] **Шаг 1: Добавить `_steamGuardCallback = null` в constructor**

В constructor после `this._stopped = false` добавить:

```javascript
    this._steamGuardCallback = null
```

- [ ] **Шаг 2: Обновить stop() — очищать callback**

Заменить текущий `stop()` (строки 25–33):

```javascript
  stop() {
    this._stopped = true
    this._steamGuardCallback = null
    if (this.client) {
      this.client.logOff()
      this.client.removeAllListeners()
      this.client = null
    }
    this._setStatus('idle')
  }
```

- [ ] **Шаг 3: Обновить _connect() — передавать onSteamGuard в login()**

Заменить строку 46:
```javascript
      const { client, refreshToken } = await login(creds, proxyUrl)
```
На:
```javascript
      const { client, refreshToken } = await login(creds, proxyUrl, {
        onSteamGuard: (d, cb, wrong) => this._handleSteamGuard(d, cb, wrong),
      })
```

- [ ] **Шаг 4: Добавить методы _handleSteamGuard() и provideCode()**

Добавить после метода `_setupClientEvents()` (после строки 102), перед `_retry()`:

```javascript
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
```

---

## Задача 3: WorkerManager.js — relay + provideCode

**Файлы:**
- Изменить: `src/main/modules/WorkerManager.js`

- [ ] **Шаг 1: Добавить подписку на steamGuard событие в start()**

После блока `worker.on('error', ...)` (после строки 35), перед `this.workers.set(...)` добавить:

```javascript
    worker.on('steamGuard', (payload) => {
      this.webContents?.send('worker:steamGuard', payload)
    })
```

- [ ] **Шаг 2: Добавить метод provideCode()**

После метода `getAllStatuses()` добавить:

```javascript
  provideCode(accountId, code) {
    const worker = this.workers.get(accountId)
    if (worker) worker.provideCode(code)
  }
```

---

## Задача 4: IPC + Preload

**Файлы:**
- Изменить: `src/main/ipc.js`
- Изменить: `src/preload/index.js`

- [ ] **Шаг 1: Добавить канал farm:steamGuardCode в ipc.js**

После строки `ipcMain.handle('farm:statuses', ...)` добавить:

```javascript
  ipcMain.handle('farm:steamGuardCode', (_, accountId, code) =>
    workerManager.provideCode(accountId, code)
  )
```

- [ ] **Шаг 2: Обновить preload/index.js — добавить onSteamGuard, submitCode, обновить offAll**

В namespace `farm` добавить два метода после `onError`:

```javascript
    onSteamGuard: (cb) => {
      ipcRenderer.removeAllListeners('worker:steamGuard')
      ipcRenderer.on('worker:steamGuard', (_, d) => cb(d))
    },
    submitCode: (accountId, code) =>
      ipcRenderer.invoke('farm:steamGuardCode', accountId, code),
```

Обновить `offAll` — добавить очистку нового канала:

```javascript
    offAll: () => {
      ipcRenderer.removeAllListeners('worker:statusChange')
      ipcRenderer.removeAllListeners('worker:error')
      ipcRenderer.removeAllListeners('worker:steamGuard')
    },
```

---

## Задача 5: Accounts.jsx — UI

**Файлы:**
- Изменить: `src/renderer/src/pages/Accounts.jsx`

- [ ] **Шаг 1: Добавить статус awaiting_guard и вспомогательную функцию звука**

В `STATUS_BADGE` добавить:
```javascript
  awaiting_guard: 'badge-yellow',
```

В `STATUS_LABEL` добавить:
```javascript
  awaiting_guard: 'Введи код',
```

В `ACTIVE_STATUSES` добавить `'awaiting_guard'`:
```javascript
const ACTIVE_STATUSES = new Set(['online', 'connecting', 'reconnecting', 'farming', 'awaiting_guard'])
```

Добавить функцию звука перед компонентом `AddAccountModal`:
```javascript
function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.3, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.3)
  } catch {}
}
```

- [ ] **Шаг 2: Добавить компонент SteamGuardModal**

Добавить после функции `playBeep`, перед `AddAccountModal`:

```javascript
function SteamGuardModal({ request, onSubmit, onClose }) {
  const [code, setCode] = useState('')
  const [timeLeft, setTimeLeft] = useState(120)

  useEffect(() => {
    setTimeLeft(120)
    setCode('')
  }, [request?.accountId])

  useEffect(() => {
    const id = setInterval(() => {
      setTimeLeft(t => (t <= 1 ? 120 : t - 1))
    }, 1000)
    return () => clearInterval(id)
  }, [])

  const submit = () => {
    if (!code.trim()) return
    onSubmit(request.accountId, code.trim())
    setCode('')
  }

  const handleKey = (e) => {
    if (e.key === 'Enter') submit()
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-bg-card border border-border rounded-xl w-[400px] p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-text-primary">Steam Guard</h2>
          <span className="text-sm text-text-muted">{timeLeft}с</span>
        </div>

        <div className="text-sm text-text-secondary">
          <span className="font-mono text-text-primary">{request.login}</span>
          <p className="mt-1 text-text-muted">
            {request.domain
              ? `Введи код из письма на ${request.domain}`
              : 'Открой Steam на телефоне и введи код аутентификатора'}
          </p>
        </div>

        {request.lastCodeWrong && (
          <p className="text-xs text-red-400 bg-red-400/10 rounded px-3 py-2">
            Неверный код — попробуй снова
          </p>
        )}

        <input
          className="input text-center font-mono tracking-widest text-lg"
          placeholder="XXXXX"
          value={code}
          onChange={e => setCode(e.target.value.toUpperCase())}
          onKeyDown={handleKey}
          maxLength={7}
          autoFocus
        />

        <div className="flex gap-2 justify-end">
          <button className="btn-ghost" onClick={onClose}>Скрыть</button>
          <button className="btn-primary" onClick={submit} disabled={!code.trim()}>
            Подтвердить
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Шаг 3: Добавить состояние Steam Guard в компонент Accounts**

В `export default function Accounts()` добавить новое состояние после `workerStatuses`:

```javascript
  const [steamGuardRequest, setSteamGuardRequest] = useState(null)
  // { accountId, domain, lastCodeWrong }
  // login берётся из accounts.find() при рендере
```

- [ ] **Шаг 4: Подписаться на onSteamGuard в useEffect**

В существующем `useEffect` после `window.api.farm.onError(...)` добавить:

```javascript
    window.api.farm.onSteamGuard(({ accountId, domain, lastCodeWrong }) => {
      setSteamGuardRequest({ accountId, domain, lastCodeWrong })
      playBeep()
      const prevTitle = document.title
      document.title = '🔔 Введи Steam Guard код!'
      setTimeout(() => { document.title = prevTitle }, 5000)
    })
```

- [ ] **Шаг 5: Добавить ⚠ tooltip для статуса error в строке таблицы**

В JSX строки таблицы найти блок `<td className="px-4 py-3">` со статусом (колонка Статус) и заменить:

```jsx
                  <td className="px-4 py-3">
                    <span className={STATUS_BADGE[status] || 'badge-gray'}>
                      {STATUS_LABEL[status] || status}
                    </span>
                  </td>
```

На:

```jsx
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <span className={STATUS_BADGE[status] || 'badge-gray'}>
                        {STATUS_LABEL[status] || status}
                      </span>
                      {status === 'error' && workerStatuses[a.id]?.message && (
                        <span
                          title={workerStatuses[a.id].message}
                          className="text-red-400 cursor-help text-base leading-none"
                        >
                          ⚠
                        </span>
                      )}
                    </div>
                  </td>
```

- [ ] **Шаг 6: Добавить обработчики submit/close и рендер SteamGuardModal**

Добавить функции после `handleStopAll`:

```javascript
  const handleSteamGuardSubmit = async (accountId, code) => {
    await window.api.farm.submitCode(accountId, code)
    setSteamGuardRequest(null)
  }

  const handleSteamGuardClose = () => setSteamGuardRequest(null)
```

В конце JSX перед закрывающим `</div>`, после модалов `add` и `import`, добавить:

```jsx
      {steamGuardRequest && (
        <SteamGuardModal
          request={{
            ...steamGuardRequest,
            login: accounts.find(a => a.id === steamGuardRequest.accountId)?.login ?? String(steamGuardRequest.accountId),
          }}
          onSubmit={handleSteamGuardSubmit}
          onClose={handleSteamGuardClose}
        />
      )}
```

---

## Задача 6: Проверка работоспособности

- [ ] **Шаг 1: Запустить приложение**

```
npm run dev
```

Ожидаемый результат: приложение открывается без ошибок в консоли.

- [ ] **Шаг 2: Добавить аккаунт без sharedSecret и нажать Старт**

Добавить аккаунт только с логином и паролем (без shared secret), назначить прокси, нажать ▶.

Ожидаемый результат: статус меняется `Офлайн` → `Подключение...` → бейдж `Введи код` (жёлтый), модал Steam Guard всплывает, звук воспроизводится, title страницы мигает.

- [ ] **Шаг 3: Ввести код из телефона и нажать Подтвердить**

Ввести актуальный код Steam Guard, нажать "Подтвердить".

Ожидаемый результат: модал закрывается, статус переходит в `Онлайн` (или `Нет Prime`).

- [ ] **Шаг 4: Проверить ошибку с причиной**

Добавить аккаунт с заведомо неверным паролем и прокси, нажать Старт.

Ожидаемый результат: бейдж `ОШИБКА` (красный) + иконка ⚠ рядом. При наведении на ⚠ — tooltip с причиной ошибки.
