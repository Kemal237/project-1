# CS2 Lobby Gather — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Собрать всех ботов фарм-группы в одно приватное лобби CS2 по lobby ID (без друзей), одной кнопкой из UI.

**Architecture:** Каждый CS2 запускается с `-netconport <порт>` (TCP-консоль). Панель подключается к консоли бокса, шлёт команды и читает вывод: хост создаёт лобби → читаем lobby ID → остальным шлём `connect_lobby <id>`. Координирует `LobbyManager`, транспорт — `CS2NetConsole`.

**Tech Stack:** Electron main (Node.js), `net` (TCP), Sandboxie (`CS2Bot_<id>` боксы), существующие `CS2Launcher` / `GroupManager` / GSI.

**КРИТИЧНО:** Подход зависит от результатов **Задачи 3 (СПАЙК)**. Если netconport не работает в Sandboxie — после спайка план пересматривается на фолбэк (keybd_event + `-condebug`), описанный в spec. Не реализовывать Задачи 4+ до успешного спайка.

**Spec:** `docs/superpowers/specs/2026-05-30-cs2-lobby-gather-design.md`

---

## Структура файлов

- **Create** `src/main/modules/CS2NetConsole.js` — TCP-клиент к netconsole одного CS2 (connect/send/onLine/close).
- **Create** `src/main/modules/LobbyManager.js` — координатор сбора группы в лобби.
- **Create** `scripts/spike-netconsole.mjs` — одноразовый скрипт спайка (проверка связи + поиск команд).
- **Modify** `src/main/modules/CS2Launcher.js` — добавить `-netconport` во флаги запуска CS2.
- **Modify** `src/main/ipc.js` — хендлер `lobby:gather`.
- **Modify** `src/preload/index.js` — `window.api.lobby.gather`.
- **Modify** `src/renderer/src/pages/FarmGroups.jsx` — кнопка «Собрать в лобби».
- **Modify** `src/renderer/src/pages/TrackingWindow.jsx` — кнопка + статус `in_lobby`.
- **Modify** `src/renderer/src/pages/Accounts.jsx` — бейдж/лейбл статуса `in_lobby`.

---

## Task 1: CS2NetConsole — TCP-клиент к консоли CS2

Модуль инкапсулирует одно TCP-соединение к netconsole CS2: подключение с ретраями, отправка команды (с `\n`), буферизация входящего потока в строки, подписка на строки, закрытие. Source-движок шлёт вывод консоли построчно по TCP — парсим по `\n`.

**Files:**
- Create: `src/main/modules/CS2NetConsole.js`
- Test: `scripts/test-netconsole-parse.mjs` (standalone, без фреймворка — в проекте его нет)

- [ ] **Step 1: Написать failing-тест парсинга строк**

Создать `scripts/test-netconsole-parse.mjs`:

```js
import assert from 'node:assert'
import { _splitLines } from '../src/main/modules/CS2NetConsole.js'

// Буфер может приходить кусками — _splitLines накапливает остаток.
let carry = ''
let out = []
;[carry, out] = _splitLines(carry, 'hello\nwor')
assert.deepStrictEqual(out, ['hello'])
;[carry, out] = _splitLines(carry, 'ld\nfoo\n')
assert.deepStrictEqual(out, ['world', 'foo'])
assert.strictEqual(carry, '')
console.log('OK netconsole parse')
```

- [ ] **Step 2: Запустить — убедиться что падает**

Run: `node scripts/test-netconsole-parse.mjs`
Expected: FAIL — `_splitLines` не экспортирован / модуль не существует.

- [ ] **Step 3: Реализовать CS2NetConsole**

Создать `src/main/modules/CS2NetConsole.js`:

```js
import net from 'node:net'

// Разбивает накопленный буфер + новый кусок на завершённые строки.
// Возвращает [остаток, массивЗавершённыхСтрок]. Экспортируется для теста.
export function _splitLines(carry, chunk) {
  const data = carry + chunk
  const parts = data.split('\n')
  const rest = parts.pop()            // последний кусок без \n — остаётся в буфере
  return [rest, parts.map(s => s.replace(/\r$/, ''))]
}

// Клиент к netconsole одного экземпляра CS2 (порт = NETCON_BASE + accountId).
// Source-движок: TCP-сервер, принимает команды строками, шлёт вывод строками.
export class CS2NetConsole {
  constructor(port) {
    this.port = port
    this.socket = null
    this._carry = ''
    this._lineHandlers = []
  }

  // Подключение с ретраями (CS2 поднимает порт не сразу после старта).
  async connect({ retries = 30, intervalMs = 1000 } = {}) {
    for (let i = 0; i < retries; i++) {
      try {
        await this._tryConnectOnce()
        return true
      } catch {
        await new Promise(r => setTimeout(r, intervalMs))
      }
    }
    return false
  }

  _tryConnectOnce() {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: '127.0.0.1', port: this.port })
      s.once('connect', () => {
        this.socket = s
        s.on('data', (buf) => {
          const [rest, lines] = _splitLines(this._carry, buf.toString('utf8'))
          this._carry = rest
          for (const line of lines) for (const h of this._lineHandlers) h(line)
        })
        s.on('error', () => {})
        resolve()
      })
      s.once('error', (e) => { s.destroy(); reject(e) })
    })
  }

  onLine(handler) { this._lineHandlers.push(handler) }

  send(cmd) {
    if (!this.socket) throw new Error('netconsole not connected')
    this.socket.write(cmd + '\n')
  }

  // Шлёт команду и ждёт первую строку вывода, удовлетворяющую matchFn,
  // в пределах timeoutMs. Возвращает совпавшую строку или null.
  sendAndWait(cmd, matchFn, timeoutMs = 4000) {
    return new Promise((resolve) => {
      let done = false
      const finish = (val) => { if (!done) { done = true; resolve(val) } }
      const handler = (line) => { if (matchFn(line)) finish(line) }
      this._lineHandlers.push(handler)
      this.send(cmd)
      setTimeout(() => finish(null), timeoutMs)
    })
  }

  close() {
    if (this.socket) { try { this.socket.destroy() } catch {} this.socket = null }
    this._lineHandlers = []
  }
}

export const NETCON_BASE = 29100
export const portForAccount = (accountId) => NETCON_BASE + accountId
```

- [ ] **Step 4: Запустить тест — убедиться что проходит**

Run: `node scripts/test-netconsole-parse.mjs`
Expected: PASS — `OK netconsole parse`

- [ ] **Step 5: Commit**

```bash
git add src/main/modules/CS2NetConsole.js scripts/test-netconsole-parse.mjs
git commit -m "feat(lobby): CS2NetConsole — TCP-клиент к консоли CS2"
```

---

## Task 2: Добавить -netconport в запуск CS2

CS2 запускается через `_spawnInBox` с массивом флагов в `CS2Launcher.start`. Добавляем `-netconport <portForAccount(accountId)>` чтобы каждый экземпляр поднял свою TCP-консоль на уникальном порту.

**Files:**
- Modify: `src/main/modules/CS2Launcher.js` (метод `start`, формирование флагов запуска CS2 — строка с `'-applaunch', '730', ...CS2_FLAGS`)

- [ ] **Step 1: Найти место запуска CS2**

Run: `grep -n "applaunch" src/main/modules/CS2Launcher.js`
Expected: строка вида `this._spawnInBox(sbPath, boxName, steamPath, ['-applaunch', '730', ...CS2_FLAGS])`

- [ ] **Step 2: Добавить флаг -netconport**

Импортировать в начале файла рядом с другими импортами:

```js
import { portForAccount } from './CS2NetConsole'
```

Заменить вызов `_spawnInBox` запуска CS2 на:

```js
      this._spawnInBox(sbPath, boxName, steamPath, [
        '-applaunch', '730', ...CS2_FLAGS,
        '-netconport', String(portForAccount(accountId)),
      ])
```

- [ ] **Step 3: Проверка сборки**

Run: `npm run build` (или запустить `npm run dev` и убедиться что main собирается без ошибок импорта)
Expected: сборка main без ошибок.

- [ ] **Step 4: Commit**

```bash
git add src/main/modules/CS2Launcher.js
git commit -m "feat(lobby): запуск CS2 с -netconport (уникальный порт на бокс)"
```

---

## Task 3: СПАЙК — проверка netconsole в Sandboxie + поиск команд лобби

**Это ручная проверка (не TDD).** Результаты записываются в spec. Без успеха этой задачи Задачи 4+ НЕ начинать.

**Files:**
- Create: `scripts/spike-netconsole.mjs`
- Modify (по итогам): `docs/superpowers/specs/2026-05-30-cs2-lobby-gather-design.md` (раздел «Открытые вопросы» → «Результаты спайка»)

- [ ] **Step 1: Написать скрипт спайка**

Создать `scripts/spike-netconsole.mjs`:

```js
// Подключается к netconsole запущенного CS2 (порт по accountId), шлёт
// пробные команды и печатает ВЕСЬ вывод консоли. Запуск:
//   node scripts/spike-netconsole.mjs <accountId>
import { CS2NetConsole, portForAccount } from '../src/main/modules/CS2NetConsole.js'

const accountId = Number(process.argv[2] || 1)
const port = portForAccount(accountId)
const con = new CS2NetConsole(port)

console.log(`[spike] connecting to 127.0.0.1:${port} ...`)
const ok = await con.connect({ retries: 10, intervalMs: 1000 })
if (!ok) { console.log('[spike] FAILED to connect — netconport недоступен (Sandboxie?)'); process.exit(1) }
console.log('[spike] CONNECTED')

con.onLine((line) => console.log('  CON>', line))

const probe = async (cmd) => { console.log(`[spike] send: ${cmd}`); con.send(cmd); await new Promise(r => setTimeout(r, 1500)) }

await probe('echo SPIKE_TEST_123')   // подтверждение связи
await probe('status')                // общая инфо, возможно lobby
await probe('help connect_lobby')    // есть ли команда
await probe('cl_lobby_type')         // возможные lobby-конвары
await probe('connect_lobby')         // вывод текущего/usage

console.log('[spike] done — изучи вывод выше')
setTimeout(() => process.exit(0), 2000)
```

- [ ] **Step 2: Запустить CS2 одного бота вручную через панель**

Через панель запусти один аккаунт (кнопка CS2), дождись главного меню CS2. Бокс — `CS2Bot_<id>`, порт — `29100 + <id>`.

- [ ] **Step 3: Запустить спайк-скрипт**

Run: `node scripts/spike-netconsole.mjs <id>`
Expected (успех): печатается `CONNECTED` и строки `CON> ...`, включая эхо `SPIKE_TEST_123`.

**Если НЕ удалось подключиться** (`FAILED to connect`): netconport не пробивается в Sandboxie. Зафиксировать в spec, **остановиться и пересмотреть план на фолбэк (Вариант 2)** — обсудить с пользователем.

- [ ] **Step 4: В работающем CS2 вручную создать приватное лобби и снять lobby ID**

В CS2 хоста: открой режим игры так, чтобы создалась пати/лобби (как делаешь вручную). Затем в спайк-выводе или через `status` найди **lobby ID** (64-бит число). Перепробуй команды из Step 1, цель — найти:
- команду/последовательность **создания приватного лобби**;
- способ **прочитать lobby ID** (строка вывода + регэксп для парсинга);
- что ровно принимает `connect_lobby` (формат аргумента).

- [ ] **Step 5: Записать результаты спайка в spec**

В `docs/superpowers/specs/2026-05-30-cs2-lobby-gather-design.md` заменить раздел «Открытые вопросы» на «Результаты спайка» с конкретикой:
- netconport в Sandboxie: работает / нет;
- команда создания лобби: `<точная команда или "через UI: шаги">`;
- чтение lobby ID: `<команда + пример строки вывода + регэксп>`;
- формат `connect_lobby`: `<пример>`.

- [ ] **Step 6: Commit**

```bash
git add scripts/spike-netconsole.mjs docs/superpowers/specs/2026-05-30-cs2-lobby-gather-design.md
git commit -m "spike(lobby): проверка netconsole в Sandboxie + команды лобби (результаты в spec)"
```

**ЧЕКПОИНТ:** показать результаты спайка пользователю. Если netconport не работает или команда создания лобби только через UI — скорректировать Задачи 4–6 по факту (возможно, добавить UI-навигацию хоста через keybd_event). Дальнейшие задачи используют КОНКРЕТНЫЕ команды из spec.

---

## Task 4: LobbyManager — координатор сбора группы

Использует подтверждённые спайком команды. Константы команд берутся из результатов Задачи 3 (ниже — плейсхолдеры `LOBBY_CREATE_CMD`, `LOBBY_ID_REGEX`, заполняются по spec перед реализацией).

**Files:**
- Create: `src/main/modules/LobbyManager.js`
- Test: `scripts/test-lobby-parse.mjs`

- [ ] **Step 1: Написать failing-тест парсинга lobby ID**

Создать `scripts/test-lobby-parse.mjs` (регэксп заменить на подтверждённый в спайке):

```js
import assert from 'node:assert'
import { parseLobbyId } from '../src/main/modules/LobbyManager.js'

// Пример строки из спайка (ЗАМЕНИТЬ на реальный формат из spec):
const line = 'Lobby ID: 109775240999999999'
assert.strictEqual(parseLobbyId(line), '109775240999999999')
assert.strictEqual(parseLobbyId('no id here'), null)
console.log('OK lobby parse')
```

- [ ] **Step 2: Запустить тест — убедиться что падает**

Run: `node scripts/test-lobby-parse.mjs`
Expected: FAIL — `parseLobbyId` не существует.

- [ ] **Step 3: Реализовать LobbyManager**

Создать `src/main/modules/LobbyManager.js`. **Команды/регэксп ниже заменить на подтверждённые в spec (Задача 3).**

```js
import { CS2NetConsole, portForAccount } from './CS2NetConsole'
import groupManager from './GroupManager'

// ЗАПОЛНИТЬ по результатам спайка (Задача 3):
const LOBBY_CREATE_CMD = '<команда создания приватного лобби>'
const LOBBY_ID_QUERY_CMD = 'status'
const LOBBY_ID_REGEX = /Lobby ID:\s*(\d{17,})/   // подтвердить формат в спайке

export function parseLobbyId(line) {
  const m = LOBBY_ID_REGEX.exec(line || '')
  return m ? m[1] : null
}

class LobbyManager {
  // Собирает всех ботов группы в одно лобби. onStatus(accountId, status, msg).
  // Возвращает { ok, lobbyId?, error? }.
  async gatherGroup(groupId, onStatus = () => {}) {
    const group = groupManager.get(groupId)
    if (!group || group.accounts.length < 2) {
      return { ok: false, error: 'В группе должно быть минимум 2 аккаунта' }
    }
    const [host, ...rest] = group.accounts

    // 1. Хост: подключиться к консоли, создать лобби, прочитать ID
    const hostCon = new CS2NetConsole(portForAccount(host.id))
    if (!await hostCon.connect()) {
      onStatus(host.id, 'error', 'Нет связи с консолью CS2')
      return { ok: false, error: `Хост ${host.login}: нет связи с консолью` }
    }
    hostCon.send(LOBBY_CREATE_CMD)
    await new Promise(r => setTimeout(r, 2500))
    const idLine = await hostCon.sendAndWait(LOBBY_ID_QUERY_CMD, l => !!parseLobbyId(l), 5000)
    const lobbyId = parseLobbyId(idLine || '')
    if (!lobbyId) {
      hostCon.close()
      onStatus(host.id, 'error', 'Не удалось прочитать lobby ID')
      return { ok: false, error: 'Не удалось прочитать lobby ID у хоста' }
    }
    onStatus(host.id, 'in_lobby', `Лобби создано (${lobbyId})`)

    // 2. Остальные: connect_lobby <id>
    for (const a of rest) {
      const con = new CS2NetConsole(portForAccount(a.id))
      if (!await con.connect()) {
        onStatus(a.id, 'error', 'Нет связи с консолью CS2')
        continue
      }
      con.send(`connect_lobby ${lobbyId}`)
      onStatus(a.id, 'in_lobby', 'Подключение к лобби хоста')
      con.close()
    }
    hostCon.close()
    return { ok: true, lobbyId }
  }
}

export default new LobbyManager()
```

- [ ] **Step 4: Запустить тест — убедиться что проходит**

Run: `node scripts/test-lobby-parse.mjs`
Expected: PASS — `OK lobby parse`

- [ ] **Step 5: Commit**

```bash
git add src/main/modules/LobbyManager.js scripts/test-lobby-parse.mjs
git commit -m "feat(lobby): LobbyManager — сбор группы в одно лобби по lobby ID"
```

---

## Task 5: IPC + preload — lobby:gather

**Files:**
- Modify: `src/main/ipc.js` (рядом с хендлерами `groups:*`)
- Modify: `src/preload/index.js` (объект `groups` или новый `lobby`)

- [ ] **Step 1: Добавить импорт и хендлер в ipc.js**

В начале `src/main/ipc.js` рядом с другими импортами:

```js
import lobbyManager from './modules/LobbyManager'
```

Рядом с хендлерами `groups:*` добавить:

```js
  ipcMain.handle('lobby:gather', async (_, groupId) => {
    const send = (accountId, status, message) => {
      accountManager.update(accountId, { status })
      workerManager.send('worker:statusChange', { accountId, status, message })
    }
    try {
      return await lobbyManager.gatherGroup(groupId, send)
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
```

- [ ] **Step 2: Добавить в preload**

В `src/preload/index.js` в объект `groups` добавить строку:

```js
    gather:        (id)         => ipcRenderer.invoke('lobby:gather', id),
```

- [ ] **Step 3: Проверка сборки**

Run: `npm run dev` — убедиться что main/preload собираются без ошибок, в DevTools `window.api.groups.gather` существует.
Expected: без ошибок импорта.

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc.js src/preload/index.js
git commit -m "feat(lobby): IPC lobby:gather + preload"
```

---

## Task 6: UI — кнопка «Собрать в лобби» + статус in_lobby

**Files:**
- Modify: `src/renderer/src/pages/TrackingWindow.jsx` (статус `in_lobby` в STATUS_BADGE/STATUS_LABEL + кнопка в шапке)
- Modify: `src/renderer/src/pages/Accounts.jsx` (STATUS_BADGE/STATUS_LABEL: `in_lobby`)
- Modify: `src/renderer/src/pages/FarmGroups.jsx` (кнопка на карточке группы)

- [ ] **Step 1: Добавить статус in_lobby в TrackingWindow**

В `src/renderer/src/pages/TrackingWindow.jsx`:
- в `STATUS_BADGE` добавить: `in_lobby: 'badge-blue',`
- в `STATUS_LABEL` добавить: `in_lobby: 'В общем лобби',`

- [ ] **Step 2: Добавить статус in_lobby в Accounts**

В `src/renderer/src/pages/Accounts.jsx`:
- в `STATUS_BADGE` добавить: `in_lobby: 'badge-blue',`
- в `STATUS_LABEL` добавить: `in_lobby: 'В общем лобби',`

- [ ] **Step 3: Кнопка «Собрать в лобби» в TrackingWindow**

В шапке группы `TrackingWindow.jsx` (блок Header, рядом со счётчиками) добавить кнопку. Импортировать иконку `Users` из lucide-react. Добавить состояние и обработчик в компоненте:

```jsx
  const [gathering, setGathering] = useState(false)
  const handleGather = async () => {
    setGathering(true)
    setNotice('')
    try {
      const r = await window.api.groups.gather(Number(groupId))
      if (!r?.ok) setNotice(r?.error || 'Не удалось собрать лобби')
    } finally {
      setGathering(false)
    }
  }
```

Кнопка (в шапке, перед счётчиками). Активна когда все боты «в Steam/готовы» (`steam_running`, `cs2_lobby`, `in_lobby`):

```jsx
  const READY_FOR_LOBBY = new Set(['steam_running', 'cs2_lobby', 'in_lobby'])
  const allReady = group.accounts.length >= 2 &&
    group.accounts.every(a => READY_FOR_LOBBY.has(getStatus(a)))
```

```jsx
          <button
            onClick={handleGather}
            disabled={!allReady || gathering}
            title={allReady ? 'Собрать всех ботов в одно лобби' : 'Все боты должны быть в главном меню CS2'}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium
                       bg-blue-600/20 text-blue-300 hover:bg-blue-600/30 transition-colors
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {gathering ? <Loader size={12} className="animate-spin" /> : <Users size={12} />}
            {gathering ? 'Сбор...' : 'Собрать в лобби'}
          </button>
```

- [ ] **Step 4: Кнопка «Собрать в лобби» на карточке группы FarmGroups**

В `GroupCard` (`FarmGroups.jsx`) рядом с кнопками действий добавить кнопку, вызывающую переданный `onGather(group)`. В родителе реализовать `onGather`:

```jsx
  const handleGather = async (group) => {
    const r = await window.api.groups.gather(group.id)
    setNotice(r?.ok ? `Лобби собрано (${r.lobbyId})` : (r?.error || 'Ошибка сбора лобби'))
  }
```

Передать `onGather={handleGather}` в `<GroupCard>`. В `GroupCard` добавить кнопку (иконка `Users`):

```jsx
          <button className="btn-ghost p-1.5" title="Собрать в лобби" onClick={() => onGather(group)}>
            <Users size={13} className="text-blue-400" />
          </button>
```

(импортировать `Users` из lucide-react в FarmGroups.jsx)

- [ ] **Step 5: Проверка сборки renderer**

Run: `npm run dev`
Expected: renderer собирается, кнопки видны, статус `in_lobby` отображается синим бейджем.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/pages/TrackingWindow.jsx src/renderer/src/pages/Accounts.jsx src/renderer/src/pages/FarmGroups.jsx
git commit -m "feat(lobby): кнопка Собрать в лобби + статус in_lobby"
```

---

## Task 7: Ручной интеграционный тест

- [ ] **Step 1: Запустить группу из 2 ботов**

Через раздел «Группы» запусти группу. Дождись, пока оба бота в главном меню CS2 (статус `В Steam`/готов).

- [ ] **Step 2: Нажать «Собрать в лобби»**

В окне отслеживания нажми «Собрать в лобби».
Expected:
- Хост создаёт лобби, статус `in_lobby` («В общем лобби»).
- Второй бот получает `connect_lobby <id>` и заходит в лобби хоста.
- Визуально в CS2 оба в одном лобби.

- [ ] **Step 3: Зафиксировать результат**

Если оба в одном лобби — фича работает. Если нет — собрать вывод netconsole (через спайк-скрипт) и скорректировать команды в `LobbyManager`.

---

## Self-Review (выполнено при написании плана)

- **Покрытие spec:** netconsole-транспорт (Task 1), -netconport (Task 2), спайк/проверка (Task 3), координатор сбора (Task 4), IPC/preload (Task 5), UI + статус in_lobby (Task 6), тест (Task 7). ✓
- **Зависимость от спайка:** Задачи 4+ явно используют команды из результатов Task 3; до спайка не реализуются. Команды-плейсхолдеры в Task 4 помечены как «заполнить по spec» — это сознательное следствие неизвестных, разрешаемых спайком (не скрытый placeholder).
- **Согласованность типов:** `portForAccount`, `NETCON_BASE`, `CS2NetConsole.{connect,send,sendAndWait,onLine,close}`, `parseLobbyId`, `lobbyManager.gatherGroup`, `window.api.groups.gather` — имена согласованы между задачами.
- **Обработка ошибок:** нет связи с консолью / нет lobby ID / бот не зашёл — покрыто в LobbyManager и UI-notice.
