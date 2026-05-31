# Party Gather (Этап 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Автоматически собирать ботов группы в CS2 Wingman пати по 2 (правило: 2→[2], 3→[2,1], 4→[2,2]) через UI-автоматизацию кнопки «Пригласить» в правой панели CS2.

**Architecture:** PartyManager разбивает аккаунты группы на пары, для каждой пары: лидер нажимает «Пригласить» в правой панели CS2, участник нажимает ✓ в панели «Принять приглашение». Клики — Win32 PostMessage(WM_LBUTTONDOWN) в CLIENT-координатах CS2 окна (640×480), без перемещения курсора пользователя. BotAutomation расширяется методами `getHwndForAccount` + `clickAt`.

**Tech Stack:** Electron main process, Node.js, PowerShell (Win32 User32.dll PostMessage / GetClientRect), `@nut-tree-fork/nut-js` уже установлен, CS2 640×480 windowed.

---

## Файловая структура

| Файл | Изменение |
|------|-----------|
| `src/main/modules/BotAutomation.js` | MODIFY — добавить `_findCs2PidInBox` по boxName, PS-скрипт click, методы `getHwndForAccount`, `clickAt` |
| `src/main/modules/PartyManager.js` | CREATE — оркестрация invite/accept, разбиение на пары |
| `src/main/ipc.js` | MODIFY — добавить `groups:gatherParty` handler |
| `src/preload/index.js` | MODIFY — добавить `groups.gatherParty` + события |
| `src/renderer/src/pages/FarmGroups.jsx` | MODIFY — кнопка «Собрать пати» на карточке группы |

---

## Task 1: Fix `_findCs2PidInBox` + добавить mouse click в BotAutomation

**Files:**
- Modify: `src/main/modules/BotAutomation.js`

### Контекст

Текущая `_findCs2PidInBox` игнорирует `boxName`/`sbPath` и возвращает первый cs2.exe с SbieDll.dll. При двух ботах оба вызова вернут один и тот же PID. Нужно фильтровать по Sandboxie-боксу через `Start.exe /box:<name> /list_pids`.

Mouse click реализован через Win32 `PostMessage(WM_LBUTTONDOWN/UP)` — кнопка нажимается в CLIENT-координатах окна без движения реального курсора.

- [ ] **Step 1: Добавить PS-скрипт шаблон `CLICK_AT_PS` и новый скрипт-файл в `_ensureScripts`**

В `src/main/modules/BotAutomation.js` после строки с `ACTIVATE_PS` (строка ~89), добавить:

```js
// PS-скрипт: PostMessage WM_LBUTTONDOWN + WM_LBUTTONUP в CLIENT-координатах.
// Не двигает реальный курсор. x,y — координаты внутри клиентской области окна.
const CLICK_AT_PS = `
param([long]$Hwnd, [int]$X, [int]$Y)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WinClick {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  public const uint WM_LBUTTONDOWN = 0x0201;
  public const uint WM_LBUTTONUP   = 0x0202;
}
'@
$h = [IntPtr]$Hwnd
if (-not [WinClick]::IsWindow($h)) { Write-Output 'INVALID'; exit }
[WinClick]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 120
$lp = [IntPtr](($Y -shl 16) -bor ($X -band 0xFFFF))
[WinClick]::PostMessage($h, [WinClick]::WM_LBUTTONDOWN, [IntPtr]1, $lp) | Out-Null
Start-Sleep -Milliseconds 80
[WinClick]::PostMessage($h, [WinClick]::WM_LBUTTONUP,   [IntPtr]0, $lp) | Out-Null
Write-Output 'OK'
`.trim()
```

- [ ] **Step 2: Зарегистрировать скрипт в `_ensureScripts`**

В методе `_ensureScripts` (строка ~158–165) добавить строку записи нового скрипта:

```js
_ensureScripts() {
  if (this._scriptsWritten) return
  try {
    mkdirSync(PS_DIR, { recursive: true })
    writeFileSync(join(PS_DIR, 'find-hwnd.ps1'),      HWND_BY_PID_PS, 'utf8')
    writeFileSync(join(PS_DIR, 'activate-window.ps1'), ACTIVATE_PS,   'utf8')
    writeFileSync(join(PS_DIR, 'click-at.ps1'),        CLICK_AT_PS,   'utf8')  // ← NEW
    this._scriptsWritten = true
  } catch (e) {
    console.log('[BotAutomation] _ensureScripts error:', e.message)
  }
}
```

- [ ] **Step 3: Починить `_findCs2PidInBox` — фильтрация по боксу**

Заменить текущую реализацию `_findCs2PidInBox` (строки ~247–260) на версию, которая использует `Start.exe /list_pids`:

```js
_findCs2PidInBox(boxName, sbPath) {
  try {
    const listOut = execSync(
      `"${sbPath}\\Start.exe" /box:${boxName} /list_pids`,
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    const boxPids = listOut.split(/\s+/).map(Number).filter(Boolean)
    if (!boxPids.length) return null

    const cs2Out = execSync(
      `powershell -NoProfile -Command "Get-Process cs2 -EA SilentlyContinue | Select-Object -ExpandProperty Id"`,
      { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    if (!cs2Out) return null

    const cs2Pids = cs2Out.split(/\s+/).map(Number).filter(Boolean)
    return cs2Pids.find(pid => boxPids.includes(pid)) || null
  } catch (e) {
    console.log('[BotAutomation] _findCs2PidInBox error:', e.message)
    return null
  }
}
```

- [ ] **Step 4: Добавить публичный метод `getHwndForAccount(accountId)`**

После метода `stopAll` (строка ~153) добавить:

```js
getHwndForAccount(accountId) {
  const entry = cs2Launcher._active.get(accountId)
  if (!entry) return 0
  this._ensureScripts()
  const pid = this._findCs2PidInBox(entry.boxName, entry.sbPath)
  if (!pid) return 0
  return this._findHwndByPid(pid)
}
```

- [ ] **Step 5: Добавить публичный метод `clickAt(hwnd, relX, relY)`**

После `getHwndForAccount` добавить:

```js
// relX, relY — относительные координаты от 0 до 1 в client-пространстве CS2 окна (640×480).
// Использует PostMessage WM_LBUTTONDOWN — не двигает курсор пользователя.
async clickAt(hwnd, relX, relY) {
  if (!hwnd || hwnd === 0) return false
  const CS2_CW = 640, CS2_CH = 480
  const x = Math.round(relX * CS2_CW)
  const y = Math.round(relY * CS2_CH)
  const script = join(PS_DIR, 'click-at.ps1')
  if (!existsSync(script)) this._ensureScripts()
  try {
    const out = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -Hwnd ${hwnd} -X ${x} -Y ${y}`,
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    return out === 'OK'
  } catch (e) {
    console.log('[BotAutomation] clickAt error:', e.message)
    return false
  }
}
```

- [ ] **Step 6: Проверить вручную**

Запустить приложение (`npm run dev` в терминале пользователя), запустить один бот, открыть DevTools (Ctrl+Shift+I) → Console, выполнить:

```js
// В DevTools нет прямого доступа к main — проверяем через IPC вызов automation:status
window.api.automation.status(1)  // замени 1 на accountId бота
// Должно вернуть { running: false } — значит botAutomation инициализирован
```

Затем запустить второй бот. В консоли main process (терминал) должны появиться ДВА РАЗНЫХ PID при логах CS2Launcher для каждого аккаунта.

---

## Task 2: Создать PartyManager.js

**Files:**
- Create: `src/main/modules/PartyManager.js`

### Константы координат CS2 UI (640×480)

Координаты подобраны по скриншотам и **требуют калибровки**. После первого запуска сравни логи `[PartyManager] click` с реальным поведением CS2 и скорректируй значения в `UI_POS`.

```
CS2 правая панель: иконки друзей на правом краю окна
  FRIEND_PANEL: rx=0.966, ry=0.520  → x=618, y=250
CS2 попап «Пригласить» (открывается при клике на иконку друга):
  INVITE_BTN: rx=0.855, ry=0.340   → x=547, y=163
CS2 панель «Принять приглашение» (верхний правый угол у получателя):
  ACCEPT_BTN: rx=0.855, ry=0.167   → x=547, y=80
```

- [ ] **Step 1: Создать файл с базовой структурой**

Создать `src/main/modules/PartyManager.js`:

```js
import accountManager from './AccountManager'
import cs2Launcher    from './CS2Launcher'
import botAutomation  from './BotAutomation'
import workerManager  from './WorkerManager'

// Относительные координаты UI-элементов CS2 при разрешении 640×480.
// Если клик промахивается — скорректируй значения и перезапусти.
const UI_POS = {
  FRIEND_PANEL: { rx: 0.966, ry: 0.520 },  // иконка друга в правой панели
  INVITE_BTN:   { rx: 0.855, ry: 0.340 },  // кнопка «Пригласить» в попапе
  ACCEPT_BTN:   { rx: 0.855, ry: 0.167 },  // ✓ в панели «Принять приглашение»
}

const POPUP_OPEN_MS   = 700   // ждём после клика на иконку друга пока откроется попап
const INVITE_SEND_MS  = 2500  // ждём пока приглашение дойдёт до получателя
const ACCEPT_DONE_MS  = 3000  // ждём подтверждения принятия

class PartyManager {
  // Собирает аккаунты группы в пати по 2.
  // Правило разбиения: 2→[[a,b]], 3→[[a,b],[c]], 4→[[a,b],[c,d]]
  async gatherGroup(groupId) {
    const { GroupManager } = await import('./GroupManager.js')
    const groupManager = (await import('./GroupManager.js')).default
    const group = groupManager.get(groupId)
    if (!group) return { ok: false, error: 'Группа не найдена' }

    const accounts = group.accounts
    if (accounts.length < 2) return { ok: false, error: 'Нужно минимум 2 аккаунта для пати' }

    const pairs = this._splitIntoPairs(accounts)
    this._emit('start', { groupId, pairs: pairs.map(p => p.map(a => a.id)) })

    const results = []
    for (const pair of pairs) {
      if (pair.length === 1) {
        results.push({ leaderId: pair[0].id, memberId: null, ok: true, solo: true })
        continue
      }
      const [leader, member] = pair
      this._emit('pair', { leaderId: leader.id, memberId: member.id, status: 'gathering' })
      try {
        await this._gatherPair(leader.id, member.id)
        results.push({ leaderId: leader.id, memberId: member.id, ok: true })
        this._emit('pair', { leaderId: leader.id, memberId: member.id, status: 'done' })
      } catch (e) {
        results.push({ leaderId: leader.id, memberId: member.id, ok: false, error: e.message })
        this._emit('pair', { leaderId: leader.id, memberId: member.id, status: 'error', error: e.message })
      }
    }

    const allOk = results.every(r => r.ok)
    this._emit('done', { groupId, allOk, results })
    return { ok: allOk, results }
  }

  _splitIntoPairs(accounts) {
    const pairs = []
    for (let i = 0; i < accounts.length; i += 2) {
      pairs.push(accounts.slice(i, i + 2))
    }
    return pairs
  }

  async _gatherPair(leaderId, memberId) {
    await this._requireLobbyStatus(leaderId)
    await this._requireLobbyStatus(memberId)

    const leaderHwnd = botAutomation.getHwndForAccount(leaderId)
    if (!leaderHwnd) throw new Error(`Нет HWND для лидера #${leaderId}`)
    const memberHwnd = botAutomation.getHwndForAccount(memberId)
    if (!memberHwnd) throw new Error(`Нет HWND для участника #${memberId}`)

    console.log(`[PartyManager] pair ${leaderId}→${memberId}: click friend panel`)
    await botAutomation.clickAt(leaderHwnd, UI_POS.FRIEND_PANEL.rx, UI_POS.FRIEND_PANEL.ry)
    await this._sleep(POPUP_OPEN_MS)

    console.log(`[PartyManager] pair ${leaderId}→${memberId}: click invite btn`)
    await botAutomation.clickAt(leaderHwnd, UI_POS.INVITE_BTN.rx, UI_POS.INVITE_BTN.ry)
    await this._sleep(INVITE_SEND_MS)

    console.log(`[PartyManager] pair ${leaderId}→${memberId}: click accept btn on member`)
    await botAutomation.clickAt(memberHwnd, UI_POS.ACCEPT_BTN.rx, UI_POS.ACCEPT_BTN.ry)
    await this._sleep(ACCEPT_DONE_MS)

    console.log(`[PartyManager] pair ${leaderId}→${memberId}: done`)
  }

  async _requireLobbyStatus(accountId) {
    const status = accountManager.getStatus(accountId)
    if (status !== 'cs2_lobby') {
      throw new Error(`Аккаунт #${accountId} не в cs2_lobby (статус: ${status})`)
    }
  }

  _emit(type, payload) {
    workerManager.send('party:progress', { type, ...payload })
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
  }
}

export default new PartyManager()
```

- [ ] **Step 2: Проверить импорт GroupManager**

Запустить `node -e "import('./src/main/modules/GroupManager.js').then(m => console.log(Object.keys(m)))"` в директории `d:/project 1/`. Если файл существует и экспортирует default — убедиться что импорт совместим. Если GroupManager.js экспортирует по-другому, скорректировать строку импорта в `gatherGroup`.

Проверить:
```powershell
Get-Content "d:\project 1\src\main\modules\GroupManager.js" | Select-Object -Last 5
```
Должно показать `export default groupManager` или аналог.

- [ ] **Step 3: Исправить импорт GroupManager (если нужно)**

Если GroupManager.js использует `export default`, заменить динамический импорт на статический в начале файла:

```js
import groupManager from './GroupManager'
```

И убрать строки `const { GroupManager } = await import(...)` и `const groupManager = ...` из метода `gatherGroup`.

---

## Task 3: IPC handler и Preload

**Files:**
- Modify: `src/main/ipc.js`
- Modify: `src/preload/index.js`

- [ ] **Step 1: Добавить импорт PartyManager в ipc.js**

В `src/main/ipc.js` в секции импортов (после строки `import friendManager from './modules/FriendManager'`, строка ~16) добавить:

```js
import partyManager   from './modules/PartyManager'
```

- [ ] **Step 2: Добавить IPC handler groups:gatherParty**

В `src/main/ipc.js` после блока `friends:steamGuardCode` (после строки ~103) добавить:

```js
ipcMain.handle('groups:gatherParty', async (_, groupId) => {
  try {
    return await partyManager.gatherGroup(groupId)
  } catch (e) {
    return { ok: false, error: e.message }
  }
})
```

- [ ] **Step 3: Добавить в preload `groups.gatherParty` + события**

В `src/preload/index.js` в объекте `groups` (после строки `offFriendsSteamGuard: ...`, строка ~49) добавить:

```js
gatherParty: (id) => ipcRenderer.invoke('groups:gatherParty', id),
onPartyProgress: (cb) => {
  ipcRenderer.removeAllListeners('party:progress')
  ipcRenderer.on('party:progress', (_, d) => cb(d))
},
offPartyProgress: () => ipcRenderer.removeAllListeners('party:progress'),
```

- [ ] **Step 4: Убедиться что `workerManager` экспортирует `send`**

В `src/main/modules/WorkerManager.js` метод `send` должен быть публичным (не `_send`). Проверить:
```powershell
Select-String -Pattern "send\(" "d:\project 1\src\main\modules\WorkerManager.js" | Select-Object -First 3
```
Ожидается: `send(channel, payload) {` — публичный метод. Если нет — переименовать `_send` → `send` во всех местах WorkerManager.js.

---

## Task 4: UI кнопка «Собрать пати» в FarmGroups.jsx

**Files:**
- Modify: `src/renderer/src/pages/FarmGroups.jsx`

- [ ] **Step 1: Добавить импорт иконки**

В `src/renderer/src/pages/FarmGroups.jsx` найти строку с импортами lucide (содержит `UserPlus`, `Loader` и т.д.) и добавить `Users` в список:

```js
// было: import { ..., UserPlus, Loader, ... } from 'lucide-react'
// стало — добавить Users:
import { ..., UserPlus, Users, Loader, ... } from 'lucide-react'
```

- [ ] **Step 2: Добавить состояние gathering в компонент GroupCard**

Найти в `GroupCard` функции (примерно строка ~220–300) объявление состояний `friending` и добавить рядом:

```js
const [gathering, setGathering] = useState(false)
```

- [ ] **Step 3: Добавить пропс `onGather` в сигнатуру GroupCard**

Найти строку объявления функции GroupCard (примерно строка ~210–230):
```js
function GroupCard({ group, onStart, onStop, onTrack, onEdit, onDelete, onFriend, ... })
```
Добавить `onGather` в список пропсов.

- [ ] **Step 4: Добавить кнопку «Собрать пати» в разметку GroupCard**

После кнопки `UserPlus` («Подружить», строка ~285–293) добавить новую кнопку:

```jsx
<button
  className="btn-ghost p-1.5"
  title="Собрать ботов в пати (Wingman)"
  onClick={() => onGather(group)}
  disabled={gathering}
>
  {gathering
    ? <Loader size={13} className="animate-spin text-orange-400" />
    : <Users size={13} className="text-orange-400" />}
</button>
```

- [ ] **Step 5: Добавить обработчик onGather в родительском компоненте FarmGroups**

Найти в FarmGroups функцию `handleFriend` (обработчик кнопки «Подружить», строка ~520–555) и добавить рядом:

```js
const handleGather = async (group) => {
  setNotice(null)
  // Подписываемся на прогресс
  window.api.groups.onPartyProgress((d) => {
    if (d.type === 'pair') {
      const msg = d.status === 'done'
        ? `Пара ${d.leaderId}+${d.memberId}: готово ✓`
        : d.status === 'error'
          ? `Пара ${d.leaderId}+${d.memberId}: ошибка — ${d.error}`
          : `Собираем пару ${d.leaderId}+${d.memberId}...`
      setNotice(msg)
    }
  })
  try {
    const r = await window.api.groups.gatherParty(group.id)
    if (r?.ok) {
      setNotice(`Группа «${group.name}»: все пати собраны ✓`)
    } else {
      setNotice(`Ошибка: ${r?.error || 'неизвестно'}`)
    }
  } catch (e) {
    setNotice(`Ошибка: ${e.message}`)
  } finally {
    window.api.groups.offPartyProgress()
  }
}
```

- [ ] **Step 6: Передать onGather в GroupCard**

Найти в FarmGroups все места где рендерится `<GroupCard ... />` (строка ~480–510) и добавить пропс:

```jsx
<GroupCard
  ...
  onGather={handleGather}
/>
```

- [ ] **Step 7: Связать state `gathering` с вызовом onGather**

В `GroupCard`, оберни вызов `onGather` в управление состоянием:

```js
// Обработчик клика по кнопке «Собрать пати»
const handleGatherClick = async () => {
  setGathering(true)
  try {
    await onGather(group)
  } finally {
    setGathering(false)
  }
}
```

Кнопку обновить: `onClick={() => handleGatherClick()}`.

---

## Task 5: Калибровка координат и тест

**Это не код — это пошаговый тест. Запускается вручную.**

- [ ] **Step 1: Запустить dev-панель и запустить 2 бота из одной группы**

В терминале пользователя:
```
npm run dev
```
Открыть FarmGroups → группа с 2 аккаунтами → кнопка «Запустить».
Подождать пока оба бота перейдут в статус `cs2_lobby` (видно в интерфейсе).

- [ ] **Step 2: Нажать «Собрать пати»**

Нажать новую кнопку `Users` на карточке группы.
В консоли main process должны появиться логи:
```
[PartyManager] pair X→Y: click friend panel
[PartyManager] pair X→Y: click invite btn
[PartyManager] pair X→Y: click accept btn on member
[PartyManager] pair X→Y: done
```

- [ ] **Step 3: Проверить результат в CS2**

Проверить что бот B показывает панель «Принять приглашение» (должна появиться после 2.5с), затем кнопка ✓ должна быть нажата автоматически.

Ожидаемый результат: оба бота в одном лобби Wingman.

- [ ] **Step 4: Калибровка при промахе**

Если клик промахивается (попап не открылся или «Пригласить» не нажалась):

Определить правильные координаты вручную:
1. Открой CS2 бота в отдельном окне
2. Наведи мышь на нужный элемент
3. Нажми `Win+R → mspy` или используй PowerShell для чтения координат курсора:
   ```powershell
   Add-Type -Assembly System.Windows.Forms
   [System.Windows.Forms.Cursor]::Position
   ```
4. Запомни `X, Y` в SCREEN пространстве
5. Получи CLIENT origin окна CS2:
   ```powershell
   # Замени $hwnd на реальный HWND из логов [BotAutomation]
   $hwnd = 12345678
   Add-Type @'
   using System; using System.Runtime.InteropServices;
   public struct POINT { public int X, Y; }
   public static class H { [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p); }
   '@
   $pt = New-Object POINT; $pt.X = 0; $pt.Y = 0
   [H]::ClientToScreen([IntPtr]$hwnd, [ref]$pt) | Out-Null
   Write-Output "$($pt.X) $($pt.Y)"
   ```
6. relX = (screenX - clientOriginX) / 640; relY = (screenY - clientOriginY) / 480
7. Обнови `UI_POS` в `PartyManager.js`

---

## Self-Review

**Spec coverage:**
- ✅ Разбиение на пары [2,1,4→пары] — `_splitIntoPairs`
- ✅ Invite Bot A → Bot B — клики через `clickAt`
- ✅ Accept Bot B — клик через `clickAt`
- ✅ UI кнопка с loading state
- ✅ Progress events — `party:progress`
- ✅ Fix `_findCs2PidInBox` для мульти-бота

**Placeholder scan:** нет TBD/TODO в коде задач.

**Type consistency:** `UI_POS.FRIEND_PANEL.rx/ry`, `UI_POS.INVITE_BTN.rx/ry`, `UI_POS.ACCEPT_BTN.rx/ry` используются одинаково в Task 2 Step 1. `botAutomation.clickAt(hwnd, rx, ry)` совпадает с Task 1 Step 5. `workerManager.send('party:progress', ...)` совпадает с Task 3 Step 4.
