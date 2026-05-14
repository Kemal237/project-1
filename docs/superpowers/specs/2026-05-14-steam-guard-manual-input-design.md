# Steam Guard Ручной Ввод Кода — Спецификация дизайна

**Дата:** 2026-05-14  
**Статус:** Одобрен  
**Область:** Поддержка ручного ввода Steam Guard кода (мобильный аутентификатор и email) вместо фатальной ошибки при отсутствии sharedSecret.

---

## 1. Цели

- Когда Steam запрашивает 2FA-код, показывать UI-диалог вместо падения в `error`
- Статус аккаунта переходит в `awaiting_guard` — жёлтый пульсирующий бейдж "Введи код"
- Звуковое + визуальное уведомление при появлении запроса
- Таймер 120 секунд в диалоге — чисто визуальный, по истечении сбрасывается (аккаунт остаётся в `awaiting_guard`)
- Статус `error` показывает иконку ⚠ с tooltip-причиной ошибки

---

## 2. Общая архитектура (поток данных)

```
steam-user → steamGuard событие
  → SteamWorker._handleSteamGuard()
      сохраняет callback, статус → 'awaiting_guard'
      эмитит 'steamGuard' { accountId, domain, lastCodeWrong }
  → WorkerManager слушает
      → webContents.send('worker:steamGuard', payload)
        → renderer: onSteamGuard(cb) срабатывает
          → SteamGuardModal всплывает + звук + мигание title
            → пользователь вводит код → submitCode(accountId, code)
              → ipc 'farm:steamGuardCode'
                → workerManager.provideCode(accountId, code)
                  → worker.provideCode(code)
                    → steam-user callback(code)
                      → логин продолжается → loggedOn
```

**Изменяемые файлы:**
- `src/main/modules/SteamAuth.js`
- `src/main/modules/SteamWorker.js`
- `src/main/modules/WorkerManager.js`
- `src/main/ipc.js`
- `src/preload/index.js`
- `src/renderer/src/pages/Accounts.jsx`

---

## 3. SteamAuth.js

Минимальное изменение — принять опциональный обработчик `onSteamGuard`:

```javascript
export async function login(creds, proxyUrl, { onSteamGuard } = {}) {
  // ...существующая логика...

  // Добавить перед client.login():
  client.on('steamGuard', (domain, callback, lastCodeWrong) => {
    if (onSteamGuard) onSteamGuard(domain, callback, lastCodeWrong)
    // если обработчика нет — steam-user ждёт indefinitely → сработает таймаут 30s
  })
  // ...
}
```

Listener добавляется ДО вызова `client.login()` — гарантирует отсутствие race condition.

---

## 4. SteamWorker.js

**Новое поле:** `_steamGuardCallback = null`

**Изменение `_connect()`** — передаём обработчик в login:
```javascript
const { client, refreshToken } = await login(creds, proxyUrl, {
  onSteamGuard: (d, cb, wrong) => this._handleSteamGuard(d, cb, wrong)
})
```

**Новый метод `_handleSteamGuard(domain, callback, lastCodeWrong)`:**
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
```

**Новый метод `provideCode(code)`:**
```javascript
provideCode(code) {
  if (this._steamGuardCallback) {
    this._steamGuardCallback(code)
    this._steamGuardCallback = null
  }
}
```

**Изменение `stop()`** — добавить очистку callback:
```javascript
stop() {
  this._stopped = true
  this._steamGuardCallback = null  // отменяем ожидание кода
  if (this.client) {
    this.client.logOff()
    this.client.removeAllListeners()
    this.client = null
  }
  this._setStatus('idle')
}
```

---

## 5. WorkerManager.js

**В `start()` — добавить подписку на `steamGuard` событие воркера:**
```javascript
worker.on('steamGuard', (payload) => {
  this.webContents?.send('worker:steamGuard', payload)
})
```

**Новый метод `provideCode(accountId, code)`:**
```javascript
provideCode(accountId, code) {
  const worker = this.workers.get(accountId)
  if (worker) worker.provideCode(code)
}
```

---

## 6. IPC (ipc.js)

Один новый канал:
```javascript
ipcMain.handle('farm:steamGuardCode', (_, accountId, code) =>
  workerManager.provideCode(accountId, code)
)
```

---

## 7. Preload (preload/index.js)

Два новых метода в namespace `farm`:
```javascript
onSteamGuard: (cb) => {
  ipcRenderer.removeAllListeners('worker:steamGuard')
  ipcRenderer.on('worker:steamGuard', (_, d) => cb(d))
},
submitCode: (accountId, code) =>
  ipcRenderer.invoke('farm:steamGuardCode', accountId, code),
```

`offAll()` — добавить очистку нового канала:
```javascript
offAll: () => {
  ipcRenderer.removeAllListeners('worker:statusChange')
  ipcRenderer.removeAllListeners('worker:error')
  ipcRenderer.removeAllListeners('worker:steamGuard')
},
```

---

## 8. UI — Accounts.jsx

### Новый статус `awaiting_guard`

```javascript
STATUS_BADGE:    { awaiting_guard: 'badge-yellow animate-pulse' }
STATUS_LABEL:    { awaiting_guard: 'Введи код' }
ACTIVE_STATUSES: добавить 'awaiting_guard'
```

### Иконка ⚠ + Tooltip для статуса `error`

В строке таблицы рядом с бейджем статуса:
```jsx
{status === 'error' && workerStatuses[a.id]?.message && (
  <span
    title={workerStatuses[a.id].message}
    className="text-red-400 cursor-help ml-1 text-base"
  >
    ⚠
  </span>
)}
```

### Состояние для Steam Guard

```javascript
const [steamGuardRequest, setSteamGuardRequest] = useState(null)
// { accountId, domain, lastCodeWrong, login }
```

В `useEffect` — подписка:
```javascript
window.api.farm.onSteamGuard(({ accountId, domain, lastCodeWrong }) => {
  const account = accounts.find(a => a.id === accountId)
  setSteamGuardRequest({ accountId, domain, lastCodeWrong, login: account?.login })
  // звуковое уведомление
  new Audio(BEEP_DATA_URL).play().catch(() => {})
  // мигание title
  document.title = '🔔 Введи Steam Guard код!'
  setTimeout(() => { document.title = 'CS2 Farm Panel' }, 5000)
})
```

### SteamGuardModal компонент

- Показывает логин аккаунта и тип кода:
  - `domain = null` → "Открой Steam на телефоне и введи код"
  - `domain = 'gmail.com'` → "Введи код из email gmail.com"
- `lastCodeWrong = true` → красное предупреждение "Неверный код, попробуй снова"
- Поле ввода — только цифры, максимум 5-7 символов (Steam Guard коды бывают разной длины)
- Кнопка "Подтвердить" → `window.api.farm.submitCode(accountId, code)`
- Обратный отсчёт 120с — при достижении 0 сбрасывается на 120 (не закрывает диалог)
- При сабмите кода: `setSteamGuardRequest(null)` — закрываем диалог

---

## 9. Звуковое уведомление

Короткий beep через base64 WAV встроенный в код (не нужен внешний файл):
```javascript
// Короткий 440Hz beep, 0.3 секунды, генерируется через Web Audio API при инициализации:
// const ctx = new AudioContext(); const osc = ctx.createOscillator(); ...
// Либо встроенный base64 WAV — генерируется один раз в константу BEEP_DATA_URL при загрузке страницы
```

Если браузер блокирует автовоспроизведение — `.catch(() => {})` игнорирует ошибку.

---

## 10. Вне области

- Push-уведомления ОС (Notification API) — можно добавить в будущем
- Множественные одновременные Steam Guard запросы — показываем модал для первого, остальные становятся в очередь через `setSteamGuardRequest` (последний выигрывает, предыдущий уже в `awaiting_guard`)
