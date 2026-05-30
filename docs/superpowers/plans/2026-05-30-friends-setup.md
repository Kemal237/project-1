# Этап 1 — Дружба группы через steam-user: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Кнопкой «Подружить группу» сделать все аккаунты фарм-группы взаимными друзьями Steam — невидимо, через `steam-user` (`addFriend` по steamID64), без UI-автоматизации.

**Architecture:** Чистая логика расчёта пар (`FriendPairs.js`) + лёгкая одноразовая steam-user сессия (`FriendSession.js`, без GC/Prime) + координатор (`FriendManager.js`). IPC `friends:ensureGroup` + preload + кнопка на карточке группы. Дружим только idle-аккаунты (конфликт сессий с запущенным клиентом).

**Tech Stack:** Electron main (Node.js), `steam-user` ^5.3.0, существующие `SteamAuth.login`, `AccountManager`, `ProxyManager`, `GroupManager`, `WorkerManager`, `CS2Launcher`.

**Spec:** `docs/superpowers/specs/2026-05-30-friends-setup-design.md`

**Заметка про тесты:** в проекте нет тест-фреймворка — юнит-тесты это standalone `.mjs`, запускаются `node scripts/test-*.mjs` (Node v24 авто-детектит ESM в `.js`, предупреждение `MODULE_TYPELESS_PACKAGE_JSON` безвредно). Чистую логину тестируем в изоляции; модули с импортом `electron`/`steam-user` юнит-тестами НЕ грузим (только сборкой + ручным тестом).

**Заметка про коммиты:** сообщения на русском с не-ASCII символами — при проблемах с `-m` писать во временный файл и `git commit -F`. Футер: пустая строка + `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Коммитить ЛОКАЛЬНО, без push/release.

---

## Структура файлов

- **Create** `src/main/modules/FriendPairs.js` — чистая `computeFriendPairs(accounts)` (без тяжёлых импортов, юнит-тестируема).
- **Create** `src/main/modules/FriendSession.js` — одноразовая steam-user сессия для операций с друзьями.
- **Create** `src/main/modules/FriendManager.js` — координатор `ensureGroupFriends`.
- **Create** `scripts/test-friend-pairs.mjs` — юнит-тест чистой логики пар.
- **Modify** `src/main/ipc.js` — хендлер `friends:ensureGroup`.
- **Modify** `src/preload/index.js` — `window.api.groups.ensureFriends`.
- **Modify** `src/renderer/src/pages/FarmGroups.jsx` — кнопка «Подружить группу».

---

## Task 1: FriendPairs — чистая логика расчёта пар дружбы

Определяет, какие пары аккаунтов нужно подружить и кто инициирует первым (non-limited отправляет заявку первым, иначе limited-аккаунт не сможет; обе limited → невозможно). Вынесено в отдельный файл без импортов, чтобы тест шёл в чистом node.

**Files:**
- Create: `src/main/modules/FriendPairs.js`
- Test: `scripts/test-friend-pairs.mjs`

- [ ] **Step 1: Написать failing-тест**

Создать `scripts/test-friend-pairs.mjs`:

```js
import assert from 'node:assert'
import { computeFriendPairs } from '../src/main/modules/FriendPairs.js'

// 2 non-limited: одна пара, первым меньший id
let r = computeFriendPairs([
  { id: 5, steamId: '111', isLimited: false },
  { id: 2, steamId: '222', isLimited: false },
])
assert.strictEqual(r.pairs.length, 1)
assert.strictEqual(r.impossible.length, 0)
assert.strictEqual(r.pairs[0].firstId, 2)          // меньший id первым
assert.strictEqual(r.pairs[0].firstSteamId, '222')
assert.strictEqual(r.pairs[0].secondId, 5)

// non-limited + limited: non-limited инициирует первым
r = computeFriendPairs([
  { id: 1, steamId: 'a', isLimited: true },
  { id: 2, steamId: 'b', isLimited: false },
])
assert.strictEqual(r.pairs.length, 1)
assert.strictEqual(r.pairs[0].firstId, 2)          // non-limited первым
assert.strictEqual(r.pairs[0].secondId, 1)

// обе limited: невозможно
r = computeFriendPairs([
  { id: 1, steamId: 'a', isLimited: true },
  { id: 2, steamId: 'b', isLimited: true },
])
assert.strictEqual(r.pairs.length, 0)
assert.strictEqual(r.impossible.length, 1)
assert.deepStrictEqual(r.impossible[0], { aId: 1, bId: 2 })

// 3 аккаунта non-limited: 3 пары (полный граф)
r = computeFriendPairs([
  { id: 1, steamId: 'a', isLimited: false },
  { id: 2, steamId: 'b', isLimited: false },
  { id: 3, steamId: 'c', isLimited: false },
])
assert.strictEqual(r.pairs.length, 3)

console.log('OK friend pairs')
```

- [ ] **Step 2: Запустить — убедиться что падает**

Run: `node scripts/test-friend-pairs.mjs`
Expected: FAIL — модуль/функция не существует.

- [ ] **Step 3: Реализовать FriendPairs.js**

Создать `src/main/modules/FriendPairs.js`:

```js
// Чистая логика: какие пары аккаунтов надо подружить и кто инициирует первым.
// accounts: [{ id, steamId, isLimited }]. Каждый аккаунт ДОЛЖЕН иметь steamId
// (фильтрация по отсутствию steamId — на стороне FriendManager).
//
// Правило: limited-аккаунт не может ОТПРАВИТЬ заявку, поэтому в паре первым
// инициирует non-limited; если оба non-limited — первым меньший id (детерминизм);
// если оба limited — пара невозможна.
export function computeFriendPairs(accounts) {
  const pairs = []
  const impossible = []
  for (let i = 0; i < accounts.length; i++) {
    for (let j = i + 1; j < accounts.length; j++) {
      const a = accounts[i], b = accounts[j]
      if (a.isLimited && b.isLimited) {
        impossible.push({ aId: a.id, bId: b.id })
        continue
      }
      let first = a, second = b
      if (a.isLimited && !b.isLimited) { first = b; second = a }
      else if (!a.isLimited && !b.isLimited && b.id < a.id) { first = b; second = a }
      pairs.push({
        firstId: first.id, firstSteamId: first.steamId,
        secondId: second.id, secondSteamId: second.steamId,
      })
    }
  }
  return { pairs, impossible }
}
```

- [ ] **Step 4: Запустить тест — убедиться что проходит**

Run: `node scripts/test-friend-pairs.mjs`
Expected: PASS — `OK friend pairs`

- [ ] **Step 5: Commit**

```bash
git add src/main/modules/FriendPairs.js scripts/test-friend-pairs.mjs
git commit -m "feat(friends): FriendPairs — расчёт пар дружбы (non-limited инициирует первым)"
```

---

## Task 2: FriendSession — одноразовая steam-user сессия для друзей

Лёгкая сессия одного аккаунта: логин через существующий `SteamAuth.login` (прокси+Guard), `addFriend` по steamID64, чтение отношения, закрытие. НЕ трогает GC/Prime/gamesPlayed (в отличие от `SteamWorker`, который отключает non-Prime).

**Files:**
- Create: `src/main/modules/FriendSession.js`

- [ ] **Step 1: Реализовать FriendSession.js**

Создать `src/main/modules/FriendSession.js`:

```js
import SteamUser from 'steam-user'
import { login } from './SteamAuth'
import accountManager from './AccountManager'
import proxyManager from './ProxyManager'

// Одноразовая steam-user сессия ТОЛЬКО для операций с друзьями.
// Отличия от SteamWorker: без GC/Prime/gamesPlayed, не отключается на non-Prime,
// живёт пока не вызвали close().
export class FriendSession {
  constructor(accountId) {
    this.accountId = accountId
    this.client = null
    this.steamId = null
  }

  // Логинится через общий SteamAuth.login (прокси обязателен, Guard через
  // shared_secret/steam-totp внутри login). Возвращает steamID64.
  async connect({ onSteamGuard } = {}) {
    const creds = accountManager.getCredentials(this.accountId)
    if (!creds) throw Object.assign(new Error('Аккаунт не найден'), { code: 'ERR_NO_ACCOUNT' })
    const proxyUrl = proxyManager.getProxyUrl(creds.proxyId)
    if (!proxyUrl) throw Object.assign(new Error('Прокси не назначен'), { code: 'ERR_NO_PROXY' })

    const { client, refreshToken } = await login(creds, proxyUrl, { onSteamGuard })
    this.client = client
    this.steamId = client.steamID?.getSteamID64?.() || null

    if (refreshToken && refreshToken !== creds.refreshToken) {
      accountManager.saveRefreshToken(this.accountId, refreshToken)
    }
    if (this.steamId) {
      try { accountManager.update(this.accountId, { steamId: this.steamId }) } catch {}
    }
    client.setPersona(SteamUser.EPersonaState.Online)
    return this.steamId
  }

  // Отправляет заявку в друзья ИЛИ принимает встречную (Steam сам различает).
  // Возвращает { ok: true } либо { ok: false, error }.
  addFriendBySteamId(steamId64) {
    return new Promise((resolve) => {
      if (!this.client) return resolve({ ok: false, error: 'сессия не подключена' })
      this.client.addFriend(String(steamId64), (err) => {
        if (err) resolve({ ok: false, error: err.message || String(err) })
        else resolve({ ok: true })
      })
    })
  }

  // Текущее отношение к steamId: EFriendRelationship (Friend=3, None=0, ...).
  getRelationship(steamId64) {
    return this.client?.myFriends?.[String(steamId64)] ?? 0
  }

  close() {
    if (this.client) {
      try { this.client.logOff() } catch {}
      try { this.client.removeAllListeners() } catch {}
      this.client = null
    }
  }
}
```

- [ ] **Step 2: Проверка сборки**

Run: `npm run build`
Expected: main собирается без ошибок (нет ошибок импорта `./SteamAuth`, `steam-user`). Возможные несвязанные warning'и — ок.

- [ ] **Step 3: Commit**

```bash
git add src/main/modules/FriendSession.js
git commit -m "feat(friends): FriendSession — лёгкая steam-user сессия для добавления в друзья"
```

---

## Task 3: FriendManager — координатор дружбы группы

Поднимает сессии аккаунтов группы, считает пары через `computeFriendPairs`, шлёт `addFriend`, ждёт статуса Friend, репортит прогресс, гасит сессии. Проверяет, что все аккаунты idle (конфликт сессий).

**Files:**
- Create: `src/main/modules/FriendManager.js`

- [ ] **Step 1: Реализовать FriendManager.js**

Создать `src/main/modules/FriendManager.js`:

```js
import SteamUser from 'steam-user'
import groupManager from './GroupManager'
import accountManager from './AccountManager'
import cs2Launcher from './CS2Launcher'
import workerManager from './WorkerManager'
import { FriendSession } from './FriendSession'
import { computeFriendPairs } from './FriendPairs'

const FRIEND = SteamUser.EFriendRelationship.Friend  // 3

// Ждёт, пока отношение к steamId станет Friend (до timeoutMs). Возвращает bool.
function waitFriend(session, steamId64, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now()
    const tick = () => {
      if (session.getRelationship(steamId64) === FRIEND) return resolve(true)
      if (Date.now() - start > timeoutMs) return resolve(false)
      setTimeout(tick, 500)
    }
    tick()
  })
}

class FriendManager {
  // Делает всех аккаунтов группы взаимными друзьями. onProgress(accountId, status, message).
  // Возвращает { ok, friended:[[id,id]], failed:[[id,id]], impossible:[{aId,bId}] } либо { ok:false, error }.
  async ensureGroupFriends(groupId, onProgress = () => {}) {
    const group = groupManager.get(groupId)
    if (!group || group.accounts.length < 2) {
      return { ok: false, error: 'В группе должно быть минимум 2 аккаунта' }
    }
    const ids = group.accounts.map(a => a.id)

    // Конфликт сессий: ни один аккаунт не должен быть в CS2/Farm-сессии.
    const busy = ids.filter(id => cs2Launcher.isRunning(id) || workerManager.workers.has(id))
    if (busy.length) {
      return { ok: false, error: 'Останови CS2/Farm у аккаунтов группы — нужна свободная сессия Steam' }
    }

    // Метаданные (steamId, isLimited) из accountManager.getAll().
    const meta = new Map(accountManager.getAll().map(a => [a.id, a]))
    const accounts = ids.map(id => {
      const m = meta.get(id) || {}
      return { id, steamId: m.steamId || null, isLimited: !!m.isLimited }
    })

    // Поднять сессии последовательно (проще, щадит rate-limit логина).
    const sessions = new Map()
    for (const acc of accounts) {
      onProgress(acc.id, 'connecting', 'Вход в Steam...')
      const s = new FriendSession(acc.id)
      try {
        const sid = await s.connect()
        if (sid) acc.steamId = sid
        sessions.set(acc.id, s)
        onProgress(acc.id, 'connected', 'В сети')
      } catch (e) {
        onProgress(acc.id, 'error', e.message || 'Ошибка входа')
      }
    }

    // Пары считаем только по тем, у кого есть steamId и поднялась сессия.
    const usable = accounts.filter(a => a.steamId && sessions.has(a.id))
    const { pairs, impossible } = computeFriendPairs(usable)

    for (const { aId, bId } of impossible) {
      onProgress(aId, 'error', 'Оба аккаунта limited — дружба невозможна')
      onProgress(bId, 'error', 'Оба аккаунта limited — дружба невозможна')
    }

    const friended = []
    const failed = []
    for (const p of pairs) {
      const first = sessions.get(p.firstId)
      const second = sessions.get(p.secondId)
      onProgress(p.firstId, 'friending', 'Добавление в друзья...')

      // non-limited инициирует, затем второй принимает/взаимно.
      await first.addFriendBySteamId(p.secondSteamId)
      await new Promise(r => setTimeout(r, 800))
      await second.addFriendBySteamId(p.firstSteamId)

      const ok = await waitFriend(first, p.secondSteamId, 6000)
      if (ok) {
        onProgress(p.firstId, 'friended', 'Друзья')
        onProgress(p.secondId, 'friended', 'Друзья')
        friended.push([p.firstId, p.secondId])
      } else {
        onProgress(p.firstId, 'error', 'Не удалось подружить пару (таймаут)')
        failed.push([p.firstId, p.secondId])
      }
    }

    for (const s of sessions.values()) s.close()
    return { ok: failed.length === 0 && impossible.length === 0, friended, failed, impossible }
  }
}

export default new FriendManager()
```

- [ ] **Step 2: Проверка сборки**

Run: `npm run build`
Expected: main собирается без ошибок импорта.

- [ ] **Step 3: Commit**

```bash
git add src/main/modules/FriendManager.js
git commit -m "feat(friends): FriendManager — сделать аккаунты группы взаимными друзьями"
```

---

## Task 4: IPC + preload — friends:ensureGroup

**Files:**
- Modify: `src/main/ipc.js`
- Modify: `src/preload/index.js`

- [ ] **Step 1: Импорт и хендлер в ipc.js**

В `src/main/ipc.js` рядом с другими импортами модулей (после строки `import groupManager from './modules/GroupManager'`) добавить:

```js
import friendManager     from './modules/FriendManager'
```

Рядом с хендлерами `groups:*` (после `ipcMain.handle('groups:delete', ...)`) добавить:

```js
  ipcMain.handle('friends:ensureGroup', async (_, groupId) => {
    const onProgress = (accountId, status, message) =>
      workerManager.send('friends:progress', { accountId, status, message })
    try {
      return await friendManager.ensureGroupFriends(groupId, onProgress)
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
```

- [ ] **Step 2: Добавить в preload**

В `src/preload/index.js` в объект `groups` (после строки `stop: (id) => ipcRenderer.invoke('groups:stop', id),`) добавить:

```js
    ensureFriends: (id)         => ipcRenderer.invoke('friends:ensureGroup', id),
```

- [ ] **Step 3: Проверка сборки**

Run: `npm run build`
Expected: main и preload собираются без ошибок.

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc.js src/preload/index.js
git commit -m "feat(friends): IPC friends:ensureGroup + preload groups.ensureFriends"
```

---

## Task 5: UI — кнопка «Подружить группу» на карточке группы

**Files:**
- Modify: `src/renderer/src/pages/FarmGroups.jsx`

- [ ] **Step 1: Импортировать иконку UserPlus**

В `src/renderer/src/pages/FarmGroups.jsx` в строке импорта из `lucide-react` (строка 3) добавить `UserPlus`:

```js
import { Plus, Layers, Play, Pencil, Trash2, Search, Shield, ShieldCheck, ShieldOff, AlertTriangle, Loader, Square, Eye, UserPlus } from 'lucide-react'
```

- [ ] **Step 2: Добавить проп и кнопку в GroupCard**

В сигнатуре `function GroupCard({ group, onLaunch, onTrack, onEdit, onDelete, isRunning })` добавить `onFriend, friending`:

```js
function GroupCard({ group, onLaunch, onTrack, onEdit, onDelete, onFriend, friending, isRunning }) {
```

В блоке кнопок действий (после кнопки «Отслеживать» с иконкой `Eye`, перед кнопкой «Редактировать») вставить:

```jsx
          <button
            className="btn-ghost p-1.5"
            title="Подружить аккаунты группы (Steam, в фоне)"
            onClick={() => onFriend(group)}
            disabled={friending}
          >
            {friending
              ? <Loader size={13} className="animate-spin text-blue-400" />
              : <UserPlus size={13} className="text-blue-400" />}
          </button>
```

- [ ] **Step 3: Добавить состояние и обработчик в родителе**

В компоненте страницы (там же где `const [notice, setNotice] = useState('')`) добавить состояние:

```js
  const [friendingId, setFriendingId] = useState(null)
```

Рядом с `handleTrack` добавить обработчик:

```js
  // Невидимо дружит аккаунты группы через steam-user (требует idle-аккаунты).
  const handleFriend = async (group) => {
    setFriendingId(group.id)
    setNotice(`Дружим аккаунты группы «${group.name}» — это займёт время...`)
    try {
      const r = await window.api.groups.ensureFriends(group.id)
      if (r?.ok) {
        setNotice(`Группа «${group.name}»: все аккаунты подружены ✓`)
      } else if (r?.error) {
        setNotice(r.error)
      } else {
        const bad = (r?.failed?.length || 0) + (r?.impossible?.length || 0)
        setNotice(`Группа «${group.name}»: подружены не все (${bad} пар с проблемой)`)
      }
    } finally {
      setFriendingId(null)
      setTimeout(() => setNotice(''), 5000)
    }
  }
```

- [ ] **Step 4: Передать пропсы в GroupCard**

В рендере списка (`<GroupCard ... />`, после `onDelete={(group) => setDeleting(group)}`) добавить:

```jsx
              onFriend={handleFriend}
              friending={friendingId === g.id}
```

- [ ] **Step 5: Проверка сборки renderer**

Run: `npm run build`
Expected: renderer собирается, кнопка с иконкой UserPlus видна на карточке группы.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/pages/FarmGroups.jsx
git commit -m "feat(friends): кнопка «Подружить группу» на карточке группы"
```

---

## Task 6: Ручной интеграционный тест

**Это ручная проверка (нужен пользователь).** Запускается dev-панель ПОЛЬЗОВАТЕЛЕМ в своём терминале (`npm run dev` — у мейн-агента `ELECTRON_RUN_AS_NODE` ломает запуск electron).

- [ ] **Step 1: Подготовка**

Группа из 2 аккаунтов, у обоих назначен прокси, оба **НЕ запущены** в CS2 и не в Farm-сессии (idle). Желательно знать, ограничен ли хотя бы один (поле `is_limited`).

- [ ] **Step 2: Нажать «Подружить группу»**

На карточке группы нажать кнопку с иконкой UserPlus.
Expected:
- Кнопка крутится (Loader), notice «Дружим аккаунты группы...».
- Через время notice «все аккаунты подружены ✓».

- [ ] **Step 3: Проверить в Steam**

Открыть Steam любого из аккаунтов (или steamcommunity профиль) → убедиться, что аккаунты теперь в друзьях друг у друга.

- [ ] **Step 4: Проверить кейсы ошибок**

- Запустить один аккаунт в CS2, снова нажать «Подружить» → ожидать notice про «останови CS2/Farm».
- (Если есть данные) пара из двух limited → ожидать сообщение про «оба limited».

- [ ] **Step 5: Зафиксировать результат / открытые вопросы спека**

Записать, подтвердилось ли: (а) `addFriend` обеими сторонами достаточно для мгновенной дружбы non-limited; (б) поведение limited-аккаунта. При расхождении — скорректировать `FriendManager` (например, явный приём через `setFriendRelationship`).

---

## Self-Review (выполнено при написании плана)

- **Покрытие spec:** FriendSession (Task 2), FriendManager + алгоритм + конфликт сессий + limited-логика (Task 1, 3), IPC/preload (Task 4), UI кнопка (Task 5), юнит на пары + ручной тест (Task 1, 6). ✓
- **Изоляция тестов:** чистая логика в `FriendPairs.js` без импортов electron/steam-user → тест идёт в node. Модули с тяжёлыми импортами проверяются сборкой + ручным тестом. ✓
- **Согласованность имён:** `computeFriendPairs`→`{pairs:[{firstId,firstSteamId,secondId,secondSteamId}],impossible:[{aId,bId}]}`; `FriendSession.{connect,addFriendBySteamId,getRelationship,close}`; `FriendManager.ensureGroupFriends`; `friends:ensureGroup`; `window.api.groups.ensureFriends`; `friends:progress`. Совпадают между задачами. ✓
- **Обработка ошибок:** нет аккаунта/прокси/steamId, конфликт сессий, оба limited, таймаут дружбы — покрыто. ✓
- **Открытые вопросы:** поведение limited и достаточность двойного addFriend — проверяются в Task 6, заложен фолбэк (setFriendRelationship). ✓
