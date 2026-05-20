# Bot Movement Automation — Design Spec

**Дата:** 2026-05-20
**Фаза:** 3D-1 (Movement Imitation, базовая часть Humanization)
**Статус:** Готов к плану

---

## Цель

Реализовать имитацию движения (WASD) бота внутри запущенной CS2 для одного аккаунта. Это первый шаг на пути к полноценному фарму XP в матчах Wingman на серверах Valve.

**В этот этап входит:**
- Базовое движение через клавиатуру (WASD)
- Два паттерна: квадрат (W→D→S→A) и рандомные направления
- UI-модалка в панели для управления имитацией (старт/стоп)
- Game State Integration (GSI) для надёжной детекции «в матче»
- Новые статусы аккаунта: «Загрузка матча», «В матче»
- SteamID persistence для маршрутизации GSI events

**НЕ входит (вынесено в следующие этапы):**
- Прицеливание мышью (mouse aim)
- Стрельба (LMB clicks)
- Round-robin логика «боты убивают друг друга»
- Поддержка 4 окон одновременно
- Queue Sync на матчмейкинге
- Привязка паттернов к конкретной карте

---

## Архитектура

Новый изолированный модуль `BotAutomation` в main process. Использует библиотеку `@nut-tree-fork/nut-js` для отправки клавиатурного input в окно CS2 через Windows SendInput API. Перед каждым input окно CS2 активируется через SetForegroundWindow.

GSI сервер (`CS2GSIServer.js` — уже написан, но не подключён) активируется при старте панели. CS2 шлёт состояние матча на `http://127.0.0.1:7779/` каждые 0.1–0.5с во время игры. WorkerManager слушает GSI events, маппит их по SteamID на accountId и шлёт статусы в renderer.

```
┌──────────────────────────┐
│   Renderer (React)       │
│                          │
│   ┌────────────────────┐ │
│   │ BotAutomationModal │ │
│   └─────────┬──────────┘ │
│             │ IPC         │
└─────────────┼────────────┘
              │
┌─────────────▼─────────────────────────────────┐
│   Main process                                │
│                                               │
│   ┌─────────────────────┐  ┌────────────────┐ │
│   │  BotAutomation.js   │  │ CS2GSIServer   │ │
│   │  - start/stop       │  │ (HTTP :7779)   │ │
│   │  - findCs2Hwnd      │  └────────┬───────┘ │
│   │  - PatternEngine    │           │ events  │
│   └─────────┬───────────┘           │         │
│             │ SendInput             │         │
│             │ (nut.js)              │         │
│             ▼                       ▼         │
│        ┌─────────┐         ┌──────────────┐  │
│        │ CS2.exe │◄────────│ WorkerManager│  │
│        │(Sandbox)│ GSI POST│ (routing+IPC)│  │
│        └─────────┘         └──────────────┘  │
└───────────────────────────────────────────────┘
```

---

## Компоненты

### `src/main/modules/BotAutomation.js` (новый)

Публичный интерфейс:
- `init(webContents)` — сохраняет `webContents` для отправки IPC events в renderer.
- `start(accountId, pattern)` — запускает имитацию для аккаунта. `pattern` ∈ `'square' | 'random'`. Throws если CS2 не запущена через панель.
- `stop(accountId)` — останавливает имитацию.
- `isRunning(accountId)` — `boolean`.

Внутреннее состояние: `Map<accountId, { hwnd, patternName, loopHandle, actionLog }>`.

`init(webContents)` вызывается из `src/main/index.js` после создания окна (рядом с `workerManager.init(win.webContents)`).

Внутренние методы:
- `_findCs2Hwnd(accountId)` — берёт `boxName` из `cs2Launcher._active`, вызывает `Start.exe /box:CS2Bot_X /list_pids` (официальный Sandboxie CLI для перечисления PIDs в конкретном боксе), фильтрует по имени `cs2.exe` через `Get-Process`, затем находит HWND по PID через `EnumWindows` + `GetWindowThreadProcessId` (PowerShell + Add-Type). Возвращает HWND или throws.
- `_activateWindow(hwnd)` — надёжная активация sandboxed окна из background process через AttachThreadInput trick (обходит Windows защиту от focus stealing для background-процессов): `AttachThreadInput(ourThread, targetThread, true) → SetForegroundWindow(hwnd) → SetFocus(hwnd) → AttachThreadInput(..., false)`. Реализуется через PowerShell + Add-Type PInvoke.
- `_runLoop(accountId, hwnd, pattern)` — основной цикл: для каждого `{key, durationMs}` из `PatternEngine`:
  1. `_activateWindow(hwnd)` (AttachThreadInput trick)
  2. Маленькая пауза (50ms) на активацию окна
  3. `nut.js keyboard.pressKey(key)`
  4. `await sleep(durationMs)`
  5. `nut.js keyboard.releaseKey(key)`
  6. Эмиссия event `automation:action` в IPC → лог в модалке
  7. Проверка `isRunning(accountId)` и `cs2Launcher.isRunning(accountId)` — если false, выход.
- Loop живёт пока пользователь не нажмёт Stop или CS2 окно не закроется (HWND стал невалидным).

### `PatternEngine` (внутренний класс в BotAutomation.js)

Генераторы действий:
- `*square()` — бесконечная последовательность `W → D → S → A` по 2000ms каждое.
- `*random()` — бесконечная: случайная клавиша из `[w,a,s,d]`, длительность 300–1500ms.

### `src/main/modules/CS2GSIServer.js` (существует, не меняется)

Уже корректно различает три состояния:
- `lobby` — нет map (heartbeat в главном меню)
- `cs2_loading` — map есть, phase не активна (карта грузится)
- `cs2_match` — phase ∈ {warmup, live, intermission, gameover}

Event format: `{ state, info: { map, phase, ct, t, ..., steamid64 } }`.
**Изменение:** Добавить в info `steamid64` из `data.provider.steamid64`, чтобы WorkerManager мог маршрутизировать.

### `src/main/index.js` (изменить)

В `app.whenReady().then(...)` после `setupIPC()` добавить:
```javascript
import gsiServer from './modules/CS2GSIServer'
gsiServer.ensure()
```

### `src/main/modules/CS2Launcher.js` (изменить)

Новый приватный метод `_writeGsiConfig(cs2Path)`:
- Путь: `<cs2Path>/game/csgo/cfg/gamestate_integration_botpanel.cfg`
- Если файл уже существует — не перезаписывать (пользователь мог настроить)
- Содержимое:
```
"Bot Panel GSI v1.0"
{
  "uri" "http://127.0.0.1:7779/"
  "timeout" "5.0"
  "buffer"  "0.1"
  "throttle" "0.5"
  "heartbeat" "30.0"
  "data"
  {
    "provider"            "1"
    "map"                 "1"
    "round"               "1"
    "player_id"           "1"
    "player_state"        "1"
    "player_match_stats"  "1"
  }
}
```
- Вызов в `start()` рядом с `_patchCS2VideoSettings(cs2Path)`.

### `src/main/modules/WorkerManager.js` (изменить)

В `init(webContents)` или отдельном методе подписаться на GSI:
```javascript
gsiServer.on('state', ({ state, info }) => {
  const account = accountManager.getBySteamId(info.steamid64)
  if (!account) return
  const newStatus = state === 'cs2_match'
                  ? 'cs2_in_match'
                  : state === 'cs2_loading'
                  ? 'cs2_match_loading'
                  : 'cs2_lobby'
  accountManager.update(account.id, { status: newStatus })
  webContents.send('worker:statusChange', { accountId: account.id, status: newStatus })
})
```

### `src/main/modules/AccountManager.js` (изменить)

Новый метод:
```javascript
getBySteamId(steamId64) {
  if (!steamId64) return null
  return this._accounts.find(a => a.steam_id === String(steamId64)) || null
}
```

### `src/main/modules/Database.js` (изменить)

Миграция: при `init()` после создания таблицы `accounts` сделать `ALTER TABLE accounts ADD COLUMN steam_id TEXT` (обёрнуть в try/catch — колонка может уже существовать).

### `src/main/modules/SteamWorker.js` (изменить)

В обработчике `loggedOn`:
```javascript
const steamId64 = client.steamID?.getSteamID64?.()
if (steamId64) {
  accountManager.update(this.accountId, { steam_id: steamId64 })
}
```

### `src/main/modules/CS2Launcher.js` (дополнительно)

Новый приватный метод `_extractSteamIdFromSandbox(boxName, steamPath)`:
- После `_waitForSteamReady` парсит `<sandboxSteam>/config/loginusers.vdf`
- Извлекает первый (и единственный — мы вайпаем перед запуском) `"<steamid64>"` ключ
- Сохраняет через `accountManager.update(id, { steam_id })`
- Это покрывает аккаунты которые НЕ делали Farm Start

Метод вызывается в `start()` после `_waitForSteamReady`.

### `src/main/ipc.js` (изменить)

Три новых handler:
```javascript
ipcMain.handle('automation:start',  (_, id, pattern) => botAutomation.start(id, pattern))
ipcMain.handle('automation:stop',   (_, id)          => botAutomation.stop(id))
ipcMain.handle('automation:status', (_, id)          => botAutomation.isRunning(id))
```

### `src/preload/index.js` (изменить)

```javascript
automation: {
  start:  (id, pattern) => ipcRenderer.invoke('automation:start', id, pattern),
  stop:   (id)          => ipcRenderer.invoke('automation:stop', id),
  status: (id)          => ipcRenderer.invoke('automation:status', id),
  onAction: (cb) => {
    ipcRenderer.removeAllListeners('automation:action')
    ipcRenderer.on('automation:action', (_, d) => cb(d))
  },
  offAction: () => ipcRenderer.removeAllListeners('automation:action'),
},
```

### `src/renderer/src/pages/Accounts.jsx` (изменить)

1. Добавить иконку `<Bot>` (lucide-react) в строке аккаунта рядом с Launch CS2. Активна **только если** `status === 'cs2_in_match'`. По клику открывает `BotAutomationModal` для этого `accountId`.

2. Новый компонент `BotAutomationModal`:
   - Состояние: `pattern` ∈ `'square' | 'random'`, `isRunning` (boolean), `actionLog` (array, max 10).
   - Подписка на `window.api.automation.onAction` для обновления лога.
   - При `mount` запросить текущий статус через `automation.status(id)`.
   - При `unmount` — `offAction()`.
   - Закрытие модалки **НЕ** останавливает имитацию (как Launch CS2).

3. Расширить `STATUS_BADGE` / `STATUS_LABEL`:
   - `cs2_match_loading` — жёлтый badge, label «Загрузка матча»
   - `cs2_in_match` — зелёный badge, label «В матче»

4. Расширить `ACTIVE_STATUSES` и `CS2_ACTIVE`: оба новых статуса добавить в обе коллекции.

### `package.json` (изменить)

`@nut-tree-fork/nut-js` уже установлен (^4.2.6). Изменения:

1. Добавить в `asarUnpack` распаковку native binding (иначе `.node` файл нельзя загрузить из asar архива в production):
```json
"asarUnpack": [
  "**/node_modules/sql.js/dist/*.wasm",
  "**/node_modules/@nut-tree-fork/**/*.node",
  "**/node_modules/@nut-tree-fork/libnut-win32/build/Release/**"
]
```

2. Добавить `postinstall` скрипт для rebuild native modules под Electron version:
```json
"scripts": {
  "postinstall": "electron-builder install-app-deps"
}
```

3. Убедиться что `electron-builder` доступен в devDependencies (уже есть).

**Note:** native binding собран под Node.js версию, в которой шёл `npm install`. Electron имеет свою V8 → нужен rebuild. PoC task в плане проверяет работоспособность в Electron environment.

---

## Потоки данных

### Поток статусов
```
CS2 в Sandboxie ─POST JSON─► CS2GSIServer :7779
                                 │
                                 │ emit 'state' { state, info }
                                 ▼
                            WorkerManager
                                 │
                                 │ accountManager.getBySteamId(info.steamid64)
                                 │ → accountId
                                 │
                                 │ map state → 'cs2_lobby' | 'cs2_match_loading' | 'cs2_in_match'
                                 │
                                 ▼
                  accountManager.update(id, { status })
                  webContents.send('worker:statusChange', ...)
                                 │
                                 ▼
                          Renderer (Accounts.jsx)
                                 │
                                 │ кнопка Bot активна if cs2_in_match
                                 ▼
                          [User кликает]
```

### Поток имитации
```
User: модалка → выбор pattern → Start
         │
         │ IPC: automation:start(id, pattern)
         ▼
BotAutomation.start(id, pattern)
         │
         │ findCs2Hwnd(id) → HWND
         │
         │ запускает _runLoop в setTimeout chain
         ▼
Loop:
  ├─ SetForegroundWindow(hwnd)
  ├─ keyboard.pressKey(key)
  ├─ sleep(durationMs)
  ├─ keyboard.releaseKey(key)
  ├─ webContents.send('automation:action', { id, key, durationMs })
  └─ повторить
         │
         ▼
User: Stop кнопка → IPC automation:stop(id) → флаг isRunning=false → loop выходит
```

---

## Обработка ошибок

| Сценарий | Поведение |
|---------|-----------|
| CS2 окно не найдено по PID | `start()` throws → модалка показывает ошибку |
| CS2 закрылся во время имитации | Каждая итерация loop проверяет `cs2Launcher.isRunning(accountId)`. Если false → `stop()` + IPC event `automation:action { error: 'cs2-closed' }`. Статус аккаунта возвращается к `idle` через существующий `_monitorBoxedProcess` в CS2Launcher. |
| `nut.js` не установлен / native binding missing | `start()` throws при первом обращении к keyboard API |
| Аккаунт не имеет `steam_id` в БД | GSI events не маршрутизируются → статус остаётся `cs2_lobby` → кнопка имитации неактивна. Пользователь должен один раз сделать Farm Start чтобы SteamWorker сохранил steam_id. (Документируем как known limitation для существующих аккаунтов.) |
| Пользователь закрыл модалку | Имитация продолжает работать |
| Перезапуск панели | Имитация останавливается (state не персистится — runtime фича) |

---

## Тестирование

Только manual testing (нет автотестов для GUI/input automation):

1. **Pre-test:** запустить CS2 через панель → подождать что аккаунт хотя бы раз делал Farm Start (для сохранения `steam_id`).
2. **Status тест:** статус аккаунта в Accounts становится `cs2_lobby` когда CS2 в главном меню. В Sandboxie окне CS2 запустить Practice with bots на любой карте → статус меняется на `cs2_match_loading`, затем на `cs2_in_match`.
3. **Кнопка имитации:** появляется (становится активной) только при `cs2_in_match`. До этого — disabled или скрыта.
4. **Square pattern:** кликнуть Bot → выбрать «Квадрат» → Старт. Смотреть в CS2 окно: персонаж движется W (2с) → D (2с) → S (2с) → A (2с) → цикл. В модалке появляется лог действий.
5. **Random pattern:** Stop → переключить на «Рандом» → Старт. Персонаж движется случайно, длительности разные.
6. **Закрытие модалки:** закрыть модалку с активной имитацией → имитация продолжается (можно проверить открыв заново — статус «Активна»).
7. **Stop:** нажать Stop → персонаж останавливается, статус «Остановлена».
8. **Edge case 1:** во время активной имитации закрыть CS2 → панель автоматически останавливает имитацию, статус возвращается к `idle`.
9. **Edge case 2:** запустить CS2 → войти в главное меню (не в матч) → попытаться открыть модалку (кнопка должна быть disabled). Если как-то открылась → попытка Start: ошибка «CS2 не в матче» (на всякий случай double-check на стороне main).

---

## Принципы

- **YAGNI:** только то что нужно для движения. Mouse aim, стрельба, multi-window — следующие этапы.
- **Изоляция:** `BotAutomation` ничего не знает про GSI/UI. `CS2GSIServer` ничего не знает про BotAutomation. WorkerManager — единственная точка маршрутизации GSI events.
- **Reuse:** `CS2GSIServer.js` уже написан, просто подключаем.
- **Безопасность:** SendInput через nut.js используется множеством легитимных приложений (стрим-оверлеи, доступность), VAC не детектит сам по себе.
- **Honest failure:** если GSI не работает (например пользователь стёр cfg-файл), статусы матча не обновляются и кнопка имитации остаётся неактивной — фича просто не работает, но ничего не ломается.

---

## Известные ограничения

1. **Существующие аккаунты:** для аккаунтов которые НИ РАЗУ не запускались (ни через Farm Start, ни через Launch CS2) — `steam_id` отсутствует. После любого запуска (Farm Start через SteamWorker или Launch CS2 через парсинг loginusers.vdf) — сохраняется автоматически.
2. **Только одно окно:** на этом этапе модалка работает с одним аккаунтом за раз. Multi-window (4 окна одновременно) — следующий этап.
3. **Pattern hardcoded:** длительности 2000ms / 300-1500ms захардкожены в PatternEngine. Настраиваемость через UI — если позже окажется нужным.
4. **GSI порт 7779 fallback:** если занят — сервер пытается 7780, 7781, … до 7790. Используемый порт записывается в GSI cfg файл. Если все 12 портов заняты — fail с понятной ошибкой.

---

## Критические технические риски и mitigations

Это раздел для имплементатора. Каждый пункт ОБЯЗАН быть покрыт в плане до начала основной реализации.

| # | Риск | Mitigation в плане |
|---|------|-------------------|
| 1 | nut.js native binding собран под Node.js, не Electron — runtime crash при загрузке в main process | **PoC Task в начале плана:** добавить `postinstall: electron-builder install-app-deps`, запустить, попробовать `keyboard.pressKey('w')` в dev режиме Electron. Без PoC pass — остальной план не имеет смысла. |
| 2 | `.node` нативный файл в asar архиве не загружается из production builds | Добавить `**/node_modules/@nut-tree-fork/**/*.node` в `asarUnpack` package.json. Проверить production билд + установку из NSIS. |
| 3 | `SetForegroundWindow` блокируется Windows когда вызывается из background процесса (защита от focus stealing) | Использовать AttachThreadInput trick через PowerShell + Add-Type PInvoke. Это стандартный, проверенный workaround. Альтернатива: `keybd_event` без активации — не работает для CS2 (Raw Input). |
| 4 | `_countBoxedProcesses` через SbieDll.dll filter не различает боксы — 4 cs2.exe из разных боксов выглядят одинаково | Использовать `Start.exe /box:CS2Bot_X /list_pids` — официальный Sandboxie CLI. Возвращает PIDs только из указанного бокса. Не зависит от env-переменных или WMI. |
| 5 | `steam_id` не сохранён для аккаунтов которые сразу делали Launch CS2 без Farm Start | Парсинг `loginusers.vdf` из sandbox после `_waitForSteamReady` в CS2Launcher.start(). Покрывает оба flow (Farm Start через SteamWorker уже работает + Launch CS2 через vdf parsing). |
| 6 | GSI HTTP сервер на 127.0.0.1:7779 — порт может быть занят (другая утилита, прошлая сессия CS2GSI tools) | Fallback на 7780-7790. При `ensure()` пробуем порты по очереди, используемый записываем в `gsiServer.port`, отдаём в `_writeGsiConfig` для правильного URI. |
| 7 | Sandboxie теоретически может блокировать loopback network (если кто-то поставил `BlockNetwork=y` глобально) | Дополнительный диагностический PoC: с CS2 в Sandbox сделать `curl http://127.0.0.1:7779/test`. Документируем — если не работает, пользователь меняет конфиг Sandboxie. |
| 8 | nut.js `keyboard.pressKey('w')` шлёт virtual-key code, но CS2 ожидает scan-code через Raw Input | nut.js 4.2.x шлёт `KEYEVENTF_SCANCODE` через SendInput — это совместимо с Raw Input. PoC проверяет в реальной CS2. Если не работает — fallback на самописный SendInput с явным scan-code через node-ffi-napi. |
