# Фаза 2: SteamAuth + SteamWorker + WorkerManager — Спецификация дизайна

**Дата:** 2026-05-14  
**Статус:** Одобрен  
**Область:** Слой аутентификации Steam и управление сессиями отдельных аккаунтов. CS2 Game Coordinator (GC) и логика фарма XP — это Фаза 3.

---

## 1. Цели

- Аутентификация аккаунтов Steam с повторным использованием `refreshToken` (полный логин как запасной вариант)
- Управление сессиями Steam отдельных аккаунтов как изолированными EventEmitter-воркерами
- Оркестрация воркеров через центральный WorkerManager
- Отправка обновлений статуса в реальном времени в UI через IPC-события
- Обязательный SOCKS5 прокси на каждый аккаунт (нет прокси = не запускаем)
- Автоматическое определение Prime-статуса из Steam-лицензий после входа

---

## 2. Общая архитектура

```
WorkerManager (синглтон)
  ├── Map<accountId, SteamWorker>
  ├── start(id) / stop(id) / stopAll()
  ├── getAllStatuses() → для первичной загрузки UI
  └── подписывается на события воркеров → webContents.send()

SteamWorker extends EventEmitter  (один на аккаунт)
  ├── Состояния: idle → connecting → online → reconnecting → error | no_prime
  ├── События: statusChange, refreshToken, error
  ├── Вызывает SteamAuth.login() для аутентификации
  ├── Устанавливает gamesPlayed([730]) после входа
  ├── Умный реконнект (на основе EResult, экспоненциальная задержка)
  └── Автоматически определяет Prime-статус через событие licenses

SteamAuth  (вспомогательный модуль без состояния)
  ├── login(credentials, proxyUrl) → { client, refreshToken }
  ├── tryRefreshToken(client, token) → bool
  └── fullLogin(client, creds) → refreshToken  (использует steam-totp)
```

**Новые файлы:**
- `src/main/modules/SteamAuth.js`
- `src/main/modules/SteamWorker.js`
- `src/main/modules/WorkerManager.js`

**Изменяемые файлы:**
- `src/main/ipc.js` — добавить каналы `farm:`
- `src/preload/index.js` — добавить каналы `farm:` и события `worker:`
- `src/renderer/src/pages/Accounts.jsx` — живые статусы и кнопки старт/стоп

---

## 3. Модуль SteamAuth

**Ответственность:** Чистая логика аутентификации, без состояния, без побочных эффектов кроме возврата клиента и токена.

**Процесс входа:**
1. Проверить наличие `proxyUrl` — выбросить `ERR_NO_PROXY` если отсутствует
2. Создать клиент `steam-user` с параметрами:
   - `socksProxy`: `{ host, port, userId, password, type: 5 }` — steam-user имеет нативную поддержку SOCKS5, `socks-proxy-agent` здесь НЕ используется (он только для HTTP-клиентов)
   - `dataDirectory`: `null` (никаких файлов на диск)
   - `autoRelogin`: `false` (реконнект управляется в SteamWorker)
3. Если есть `refreshToken` → пробуем `client.login({ refreshToken })`
4. При событии `LoggedOn` → возвращаем `{ client, refreshToken: существующийТокен }`
5. При ошибке с refresh-токеном → переходим к полному логину
6. Полный логин: генерируем 2FA-код через `steam-totp.generateAuthCode(sharedSecret)`, вызываем `client.login({ accountName, password, twoFactorCode })`
7. При событии `LoggedOn` → возвращаем `{ client, refreshToken: новыйТокен }`
8. Таймаут 30 секунд на одну попытку входа → отклоняем с `ERR_LOGIN_TIMEOUT`

**Таблица ошибок (возвращаются как структурированные объекты):**

| EResult от steam-user | Код ошибки | Значение |
|-----------------------|------------|---------|
| `InvalidPassword` | `ERR_INVALID_PASSWORD` | Пароль изменён |
| `Banned` | `ERR_BANNED` | Аккаунт заблокирован |
| `RateLimitExceeded` | `ERR_RATE_LIMIT` | Слишком много попыток входа |
| `AccountLoginDeniedNeedTwoFactor` | `ERR_2FA` | Неверный 2FA-код |
| `TryAnotherCM` | `ERR_TRY_CM` | Временная ошибка — повторить |
| `NoConnection` | `ERR_NO_CONNECTION` | Проблема с сетью — повторить |

---

## 4. Класс SteamWorker

**Машина состояний:**

```
idle
  → connecting  (вызван start())
    → online    (LoggedOn + Prime подтверждён)
    → no_prime  (LoggedOn + нет Prime-лицензии) → останавливается
    → reconnecting (временный разрыв)
      → connecting (повторная попытка)
      → error (превышен лимит попыток)
    → error (фатальный EResult)
  → idle (вызван stop() из любого состояния)
```

**Определение Prime-статуса:**
- Слушаем событие `licenses` от steam-user после входа
- Проверяем наличие `package_id === 54029` (CS:GO Prime Status Upgrade)
- Вызываем `accountManager.update(id, { isPrime: hasPrime })` для синхронизации с БД
- Если нет Prime: отправляем `statusChange({ status: 'no_prime' })`, вызываем `client.logOff()`

**Политика реконнекта (умный, на основе EResult):**

| EResult | Действие |
|---------|----------|
| `LoggedOff`, `NoConnection`, `TryAnotherCM`, `ServiceUnavailable` | Реконнект с экспоненциальной задержкой |
| `Banned`, `InvalidPassword`, `RateLimitExceeded`, `AccountLoginDeniedNeedTwoFactor` | Немедленная остановка, статус `error` |

**Расписание задержек реконнекта:** 5с → 10с → 20с → 40с → 80с (максимум 5 попыток), затем статус `error`.

**Отправляемые события:**
```javascript
'statusChange'  // { accountId, status, message? }
'refreshToken'  // { accountId, token }
'error'         // { accountId, code, message }
```

**После успешного входа:**
1. Слушаем `licenses` → проверка Prime + обновление БД
2. `client.gamesPlayed([730])` — аккаунт отображается как играющий в CS2
3. Отправляем `statusChange({ status: 'online' })`
4. Сохраняем `refreshToken` через `accountManager.saveRefreshToken(id, token)`

---

## 5. WorkerManager

**Ответственность:** Управление жизненным циклом всех экземпляров SteamWorker + IPC-мост к renderer.

```javascript
class WorkerManager {
  workers = new Map()          // accountId (число) → SteamWorker
  webContents = null           // устанавливается в init()

  init(webContents)            // вызывается один раз в main/index.js после createWindow(), передаём win.webContents
  async start(accountId)       // создаём и запускаем воркер
  async stop(accountId)        // останавливаем и удаляем воркер
  async stopAll()              // останавливаем все воркеры
  getStatus(accountId)         // { status, message } | null
  getAllStatuses()              // { [accountId]: { status, message } }
}
```

**Трансляция событий в renderer:**
```javascript
// WorkerManager подписывается на каждый воркер:
worker.on('statusChange', (payload) => {
  this.webContents.send('worker:statusChange', payload)
  accountManager.update(payload.accountId, { status: payload.status })
})
worker.on('refreshToken', ({ accountId, token }) => {
  accountManager.saveRefreshToken(accountId, token)
})
worker.on('error', (payload) => {
  this.webContents.send('worker:error', payload)
})
```

---

## 6. IPC-каналы

**Новые каналы ipcMain.handle:**
```javascript
'farm:start'     // (_, accountId) → workerManager.start(accountId)
'farm:stop'      // (_, accountId) → workerManager.stop(accountId)
'farm:stopAll'   // ()             → workerManager.stopAll()
'farm:statuses'  // ()             → workerManager.getAllStatuses()
```

**Новые push-события ipcMain → renderer:**
```javascript
'worker:statusChange'  // { accountId, status, message? }
'worker:error'         // { accountId, code, message }
```

**Дополнения в preload (window.api):**
```javascript
farm: {
  start:     (id) => ipcRenderer.invoke('farm:start', id),
  stop:      (id) => ipcRenderer.invoke('farm:stop', id),
  stopAll:   ()   => ipcRenderer.invoke('farm:stopAll'),
  statuses:  ()   => ipcRenderer.invoke('farm:statuses'),
  onStatus:  (cb) => ipcRenderer.on('worker:statusChange', (_, d) => cb(d)),
  onError:   (cb) => ipcRenderer.on('worker:error', (_, d) => cb(d)),
}
```

---

## 7. Изменения UI (Accounts.jsx)

**Бейдж статуса для каждого аккаунта:**

| Статус | Цвет | Метка |
|--------|-------|-------|
| `idle` | Серый | ОФЛАЙН |
| `connecting` | Жёлтый | ПОДКЛЮЧЕНИЕ... |
| `reconnecting` | Жёлтый | РЕКОННЕКТ... |
| `online` | Зелёный | ОНЛАЙН |
| `no_prime` | Оранжевый | НЕТ ПРАЙМ |
| `error` | Красный | ОШИБКА |

**Действия для каждого аккаунта:**
- `idle` → кнопка **Старт**
- `online` / `connecting` / `reconnecting` → кнопка **Стоп**
- `no_prime` / `error` → только статус, без кнопки
- Аккаунты без Prime: бейдж `НЕТ ПРАЙМ` заменяет кнопку старта

**Глобальные действия (вверху страницы Accounts):**
- **Запустить все** — запускает все аккаунты с `isPrime = true` и назначенным прокси
- **Остановить все** — вызывает `farm:stopAll`

---

## 8. Зависимости

Все уже в `package.json`, новых не нужно:
- `steam-user@^5.3.0`
- `steam-totp@^2.1.2`
- `socks-proxy-agent@^8.0.3`

---

## 9. Вне области (Фаза 3)

- Подключение к CS2 Game Coordinator (GC) — без запуска CS2.exe, чисто протокол
- Создание приватного лобби 5v5: 10 аккаунтов одного батча = 1 лобби (5 vs 5)
- Гуманизация движений через цепь Маркова (strafe/forward/rotate/crouch/idle/jump + стрельба)
- Мониторинг состояния лобби: счёт, kill/death каждого бота, статус матча (таб в игре)
- Расчёт XP за матч: XP за убийства + бонус за победу + completion bonus → отображение в UI
- Определение rank-up и получения Care Package из события GC ItemAcquired
- Планировщик батч-фарма (10 аккаунтов за раз, случайные задержки 30–90 мин между батчами)
