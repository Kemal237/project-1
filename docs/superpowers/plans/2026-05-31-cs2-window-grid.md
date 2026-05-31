# Сетка-раскладка окон CS2 (ReWindow) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Раскладывать окна запущенных экземпляров CS2 по сетке на экране — окно появляется на своём месте при запуске (`-x/-y`) и может быть переставлено кнопкой (`SetWindowPos`).

**Architecture:** Чистая математика сетки вынесена в `WindowGridMath.js` (без electron-зависимостей, юнит-тестируется как `FriendPairs.js`). Сайд-эффекты (Win32-перемещение, чтение `cs2Launcher._active`, размер экрана) — в `WindowGrid.js`. `CS2Launcher` импортирует только чистую математику для launch-флагов (без циклической зависимости). UI: кнопка на странице FarmGroups + настройки в Settings.

**Tech Stack:** Electron (main process), ES-модули, PowerShell + Win32 `SetWindowPos`/`EnumWindows` (паттерн из `BotAutomation.js`), React (renderer), sql.js settings.

**Spec:** `docs/superpowers/specs/2026-05-31-cs2-window-grid-design.md`

---

## File Structure

**Создаются:**
- `src/main/modules/WindowGridMath.js` — чистые функции `autoCols`, `cellPosition`, `computeGrid`. Без импортов. Юнит-тестируется.
- `scripts/test-window-grid.mjs` — юнит-тесты `WindowGridMath` (паттерн `scripts/test-friend-pairs.mjs`, запуск через `node`).
- `src/main/modules/WindowGrid.js` — `arrange(opts)`: собирает запущенные CS2 из `cs2Launcher._active`, берёт рабочую область монитора, зовёт `computeGrid`, двигает окна через PowerShell.

**Модифицируются:**
- `src/main/modules/CS2Launcher.js` — добавить `-x/-y` к флагам запуска (использует `WindowGridMath` + electron `screen` + `settings`).
- `src/main/ipc.js` — импорт `windowGrid`, регистрация `windows:arrangeGrid`.
- `src/preload/index.js` — `window.api.windows.arrangeGrid`.
- `src/renderer/src/pages/FarmGroups.jsx` — кнопка «Разложить окна» в шапке.
- `src/renderer/src/pages/Settings.jsx` — поле «Столбцы сетки» + тумблер «Авто-раскладка при запуске».

**Почему нет циклической зависимости:** `CS2Launcher` → импортирует `WindowGridMath` (чистый). `WindowGrid` → импортирует `cs2Launcher`. `CS2Launcher` НЕ импортирует `WindowGrid`. Цикла нет.

---

## Task 1: Чистая математика сетки + юнит-тесты

**Files:**
- Create: `src/main/modules/WindowGridMath.js`
- Test: `scripts/test-window-grid.mjs`

- [ ] **Step 1: Написать падающий тест**

Создать `scripts/test-window-grid.mjs`:

```js
import assert from 'node:assert'
import { autoCols, cellPosition, computeGrid } from '../src/main/modules/WindowGridMath.js'

// Константы по умолчанию: winW=656, winH=519, gap=0
const DEF = { winW: 656, winH: 519, gap: 0 }

// --- autoCols: ceil(sqrt(n)) ---
assert.strictEqual(autoCols(1), 1, 'autoCols(1)=1')
assert.strictEqual(autoCols(4), 2, 'autoCols(4)=2')
assert.strictEqual(autoCols(6), 3, 'autoCols(6)=3')   // ceil(sqrt(6))=3
assert.strictEqual(autoCols(9), 3, 'autoCols(9)=3')

// --- cellPosition: индекс → координата левого-верхнего угла ---
// cols=2: индекс 0=(0,0), 1=(656,0), 2=(0,519), 3=(656,519)
assert.deepStrictEqual(cellPosition(0, 2, DEF), { x: 0,   y: 0 })
assert.deepStrictEqual(cellPosition(1, 2, DEF), { x: 656, y: 0 })
assert.deepStrictEqual(cellPosition(2, 2, DEF), { x: 0,   y: 519 })
assert.deepStrictEqual(cellPosition(3, 2, DEF), { x: 656, y: 519 })

// gap учитывается
assert.deepStrictEqual(cellPosition(1, 2, { winW: 100, winH: 100, gap: 10 }), { x: 110, y: 0 })

// --- computeGrid: авто-сетка ---
// 4 окна авто → 2×2
assert.deepStrictEqual(
  computeGrid(4, DEF),
  [{ x: 0, y: 0 }, { x: 656, y: 0 }, { x: 0, y: 519 }, { x: 656, y: 519 }],
  'computeGrid(4) = 2x2'
)
// 6 окон авто → cols=3
assert.strictEqual(computeGrid(6, DEF).length, 6)
assert.deepStrictEqual(computeGrid(6, DEF)[3], { x: 0, y: 519 }, '4-я ячейка во втором ряду при cols=3')

// override cols=3 при 4 окнах → 3 в первом ряду, 1 во втором
const g = computeGrid(4, { ...DEF, cols: 3 })
assert.deepStrictEqual(g[2], { x: 1312, y: 0 }, '3-я ячейка в первом ряду')
assert.deepStrictEqual(g[3], { x: 0, y: 519 },  '4-я ячейка во втором ряду')

// 1 окно → [(0,0)]
assert.deepStrictEqual(computeGrid(1, DEF), [{ x: 0, y: 0 }])

// 0 окон → []
assert.deepStrictEqual(computeGrid(0, DEF), [])

console.log('OK: все тесты WindowGridMath прошли')
```

- [ ] **Step 2: Запустить тест — убедиться что падает**

Run: `node scripts/test-window-grid.mjs`
Expected: FAIL — `Cannot find module '.../WindowGridMath.js'` (файл ещё не создан).

- [ ] **Step 3: Реализовать `WindowGridMath.js`**

Создать `src/main/modules/WindowGridMath.js`:

```js
// Чистая математика раскладки окон CS2 по сетке. Без сайд-эффектов и
// без electron-зависимостей — поэтому юнит-тестируется обычным node
// (см. scripts/test-window-grid.mjs). Тайлинг от точки (0,0); реальный
// базовый сдвиг (рабочая область монитора) добавляется в WindowGrid.js.

// Размер окна CS2 с рамкой Windows: client 640×480 + ~8px борта + ~31px title bar.
// Можно скорректировать на этапе ручного теста, если рамка отличается.
export const DEFAULT_WIN_W = 656
export const DEFAULT_WIN_H = 519
export const DEFAULT_GAP   = 0

// Авто-число столбцов: квадратная сетка. 4→2, 6→3, 9→3.
export function autoCols(count) {
  return Math.max(1, Math.ceil(Math.sqrt(count)))
}

// Координата левого-верхнего угла окна в ячейке index (0-based) при заданном cols.
export function cellPosition(index, cols, opts = {}) {
  const winW = opts.winW ?? DEFAULT_WIN_W
  const winH = opts.winH ?? DEFAULT_WIN_H
  const gap  = opts.gap  ?? DEFAULT_GAP
  const col = index % cols
  const row = Math.floor(index / cols)
  return { x: col * (winW + gap), y: row * (winH + gap) }
}

// Координаты для count окон, слева-направо сверху-вниз.
// cols берётся из opts.cols, иначе autoCols(count).
export function computeGrid(count, opts = {}) {
  if (count <= 0) return []
  const cols = opts.cols && opts.cols > 0 ? opts.cols : autoCols(count)
  const out = []
  for (let i = 0; i < count; i++) out.push(cellPosition(i, cols, opts))
  return out
}
```

- [ ] **Step 4: Запустить тест — убедиться что проходит**

Run: `node scripts/test-window-grid.mjs`
Expected: `OK: все тесты WindowGridMath прошли`

- [ ] **Step 5: Коммит**

```bash
git add src/main/modules/WindowGridMath.js scripts/test-window-grid.mjs
git commit -m "feat: add WindowGridMath pure grid layout + unit tests"
```

---

## Task 2: Позиция окна при запуске (`-x/-y`)

**Files:**
- Modify: `src/main/modules/CS2Launcher.js` (импорты + блок флагов запуска около строки 170)

Цель: при запуске CS2 добавить `-x N -y N`, чтобы окно появилось в своей ячейке. Слот-индекс = число уже запущенных CS2 (`_active` записи с `cs2Pid`). Столбцы — из настройки `window_grid_cols` (если задана), иначе дефолт 2. Если настройка `window_grid_autoarrange` явно `'false'` — флаги не добавляются.

- [ ] **Step 1: Добавить импорты в `CS2Launcher.js`**

`settings` УЖЕ импортирован в `CS2Launcher.js` (строка 9: `import settings from './Settings'`) — НЕ дублировать. Добавить только два импорта (рядом с другими, после строки 11 `import inputMutex from './InputMutex'`):

```js
import { screen } from 'electron'
import { computeGrid } from './WindowGridMath'
```

- [ ] **Step 2: Добавить приватный метод вычисления launch-позиции**

Внутри класса `CS2Launcher` (рядом с другими приватными методами, например перед `_writeGsiConfig`) добавить:

```js
  // Вычисляет -x/-y launch-флаги для окна запускающегося бота, чтобы оно
  // появилось в своей ячейке сетки. Слот = число уже запущенных CS2
  // (записи _active с cs2Pid). Столбцы: настройка window_grid_cols или дефолт 2.
  // Возвращает [] если авто-раскладка выключена.
  _gridLaunchFlags() {
    if (settings.get('window_grid_autoarrange') === 'false') return []

    const slotIndex = [...this._active.values()].filter(e => e.cs2Pid).length
    const colsRaw   = parseInt(settings.get('window_grid_cols'), 10)
    const cols      = Number.isInteger(colsRaw) && colsRaw > 0 ? colsRaw : 2

    const cells = computeGrid(slotIndex + 1, { cols })
    const cell  = cells[slotIndex]
    if (!cell) return []

    let baseX = 0, baseY = 0
    try {
      const wa = screen.getPrimaryDisplay().workArea
      baseX = wa.x; baseY = wa.y
    } catch {}

    return ['-x', String(baseX + cell.x), '-y', String(baseY + cell.y)]
  }
```

- [ ] **Step 3: Применить флаги в точке запуска CS2**

Найти блок (около строки 170):

```js
      this._spawnInBox(sbPath, boxName, steamPath, [
        '-applaunch', '730', ...CS2_FLAGS,
      ])
```

Заменить на:

```js
      const gridFlags = this._gridLaunchFlags()
      console.log(`[CS2Launcher ${accountId}] grid launch flags: ${gridFlags.join(' ') || '(none)'}`)
      this._spawnInBox(sbPath, boxName, steamPath, [
        '-applaunch', '730', ...CS2_FLAGS, ...gridFlags,
      ])
```

- [ ] **Step 4: Проверка сборки main-процесса**

Run: `npm run build`
Expected: сборка проходит без ошибок импорта/синтаксиса (electron-vite собирает main).

Если `npm run build` отсутствует/долгий — минимум проверить синтаксис: `node --check src/main/modules/CS2Launcher.js` (Expected: без вывода = OK).

- [ ] **Step 5: Ручной тест (с реальной CS2)**

1. Запустить панель в dev: `npm run dev`.
2. Запустить первого бота через панель → окно CS2 должно появиться в левом-верхнем углу (слот 0).
3. Запустить второго бота → окно появляется правее (слот 1, x≈656).
4. Убедиться: окна **не прыгают** после появления (позиция задана сразу).

Ожидаемо: в консоли строки `grid launch flags: -x 0 -y 0`, `-x 656 -y 0` и т.д.

- [ ] **Step 6: Коммит**

```bash
git add src/main/modules/CS2Launcher.js
git commit -m "feat: position CS2 window in grid cell at launch via -x/-y flags"
```

---

## Task 3: Кнопка «Разложить окна» + PowerShell SetWindowPos

**Files:**
- Create: `src/main/modules/WindowGrid.js`
- Modify: `src/main/ipc.js` (импорт + хендлер)
- Modify: `src/preload/index.js` (`window.api.windows.arrangeGrid`)
- Modify: `src/renderer/src/pages/FarmGroups.jsx` (кнопка)

Цель: кнопка пересчитывает идеальную сетку под фактическое число запущенных окон и двигает живые окна через `SetWindowPos` (размер сохраняется).

- [ ] **Step 1: Создать `WindowGrid.js`**

Создать `src/main/modules/WindowGrid.js`:

```js
import { execSync } from 'child_process'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { screen } from 'electron'
import cs2Launcher from './CS2Launcher'
import settings from './Settings'
import { computeGrid } from './WindowGridMath'

// Раскладывает уже запущенные окна CS2 по сетке через Win32 SetWindowPos.
// Размер окон сохраняется (SWP_NOSIZE) — двигаем только позицию.
// Чистая математика сетки — в WindowGridMath.js.

const PS_DIR = join(tmpdir(), 'cs2farmpanel-ps')

// PS-скрипт: принимает "pid:x:y;pid:x:y;...", находит окно каждого PID
// через EnumWindows и двигает его SetWindowPos(SWP_NOSIZE|SWP_NOZORDER).
// Выводит число перемещённых окон.
const ARRANGE_PS = `
param([string]$Moves)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WinGrid {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint flags);
  public static IntPtr Find(uint targetPid) {
    IntPtr found = IntPtr.Zero;
    EnumProc cb = delegate(IntPtr h, IntPtr l) {
      uint pid = 0; GetWindowThreadProcessId(h, out pid);
      if (pid == targetPid && IsWindowVisible(h) && GetWindowTextLength(h) > 0) { found = h; return false; }
      return true;
    };
    EnumWindows(cb, IntPtr.Zero);
    return found;
  }
}
'@
$SWP = 0x0001 -bor 0x0004  # SWP_NOSIZE | SWP_NOZORDER
$moved = 0
foreach ($m in $Moves.Split(';')) {
  if (-not $m) { continue }
  $p = $m.Split(':')
  $h = [WinGrid]::Find([uint32]$p[0])
  if ($h -ne [IntPtr]::Zero) {
    [WinGrid]::SetWindowPos($h, [IntPtr]::Zero, [int]$p[1], [int]$p[2], 0, 0, $SWP) | Out-Null
    $moved++
  }
}
Write-Output $moved
`.trim()

class WindowGrid {
  constructor() {
    this._scriptWritten = false
  }

  _ensureScript() {
    if (this._scriptWritten) return
    try {
      mkdirSync(PS_DIR, { recursive: true })
      writeFileSync(join(PS_DIR, 'arrange-windows.ps1'), ARRANGE_PS, 'utf8')
      this._scriptWritten = true
    } catch (e) {
      console.log('[WindowGrid] _ensureScript error:', e.message)
    }
  }

  // Раскладывает все запущенные окна CS2 по сетке.
  // opts.cols — ручной override числа столбцов (иначе авто).
  arrange(opts = {}) {
    const running = [...cs2Launcher._active.values()].filter(e => e.cs2Pid)
    if (!running.length) return { moved: 0 }

    let baseX = 0, baseY = 0
    try {
      const wa = screen.getPrimaryDisplay().workArea
      baseX = wa.x; baseY = wa.y
    } catch {}

    const colsRaw = parseInt(opts.cols, 10)
    const gridOpts = Number.isInteger(colsRaw) && colsRaw > 0 ? { cols: colsRaw } : {}
    const cells = computeGrid(running.length, gridOpts)

    const moves = running
      .map((e, i) => `${e.cs2Pid}:${baseX + cells[i].x}:${baseY + cells[i].y}`)
      .join(';')

    this._ensureScript()
    const script = join(PS_DIR, 'arrange-windows.ps1')
    try {
      const out = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -Moves "${moves}"`,
        { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim()
      const moved = parseInt(out, 10) || 0
      console.log(`[WindowGrid] arranged ${moved}/${running.length} windows`)
      return { moved }
    } catch (e) {
      console.log('[WindowGrid] arrange error:', e.message)
      return { moved: 0, error: e.message }
    }
  }
}

export default new WindowGrid()
```

- [ ] **Step 2: Зарегистрировать IPC-хендлер в `ipc.js`**

В `src/main/ipc.js` добавить импорт рядом с другими модулями (после строки 17 `import partyManager from './modules/PartyManager'`):

```js
import windowGrid from './modules/WindowGrid'
```

Рядом с другими хендлерами (например после `automation:status`, ~строка 327) добавить:

```js
  ipcMain.handle('windows:arrangeGrid', (_, opts = {}) => windowGrid.arrange(opts))
```

- [ ] **Step 3: Экспонировать в preload**

В `src/preload/index.js` добавить новый раздел (после `automation: {...}`, перед `dialog: {...}`):

```js
  windows: {
    arrangeGrid: (opts) => ipcRenderer.invoke('windows:arrangeGrid', opts),
  },
```

- [ ] **Step 4: Добавить кнопку в `FarmGroups.jsx`**

В `src/renderer/src/pages/FarmGroups.jsx`, в шапке (блок около строки 623, где кнопка «Создать группу»), обернуть кнопки в группу и добавить «Разложить окна». Найти:

```jsx
        <button
          className="btn-primary transition-all active:scale-95"
          onClick={() => setEditing({ initial: null })}
        >
          <Plus size={14} /> Создать группу
        </button>
```

Заменить на:

```jsx
        <div className="flex items-center gap-2">
          <button
            className="btn-ghost transition-all active:scale-95"
            onClick={async () => {
              const r = await window.api.windows.arrangeGrid({})
              setNotice(r?.moved
                ? `Разложено окон: ${r.moved}`
                : 'Нет запущенных окон CS2')
              setTimeout(() => setNotice(''), 2500)
            }}
            title="Разложить окна CS2 по сетке"
          >
            <LayoutGrid size={14} /> Разложить окна
          </button>
          <button
            className="btn-primary transition-all active:scale-95"
            onClick={() => setEditing({ initial: null })}
          >
            <Plus size={14} /> Создать группу
          </button>
        </div>
```

Добавить `LayoutGrid` в импорт иконок lucide-react в начале файла (найти строку `import { ... } from 'lucide-react'` и добавить `LayoutGrid` в список).

Примечание: `notice` — строка (`const [notice, setNotice] = useState('')`, строка ~455), тост-уведомление рендерится в `{notice && (...)}` около строки 704. Паттерн: `setNotice('текст')` + `setTimeout(() => setNotice(''), N)` для автоочистки — как в onClick выше.

- [ ] **Step 5: Проверка сборки**

Run: `npm run build`
Expected: сборка main + renderer без ошибок.

- [ ] **Step 6: Ручной тест**

1. `npm run dev`.
2. Запустить 2–4 бота.
3. Вручную перетащить окна в кучу/внахлёст.
4. Нажать «Разложить окна» → окна встают в идеальную сетку (2 бота → 2×1, 4 → 2×2).
5. Уведомление показывает число разложенных окон.
6. Нажать кнопку без запущенных ботов → «Нет запущенных окон CS2».

- [ ] **Step 7: Коммит**

```bash
git add src/main/modules/WindowGrid.js src/main/ipc.js src/preload/index.js src/renderer/src/pages/FarmGroups.jsx
git commit -m "feat: add 'arrange windows' button with Win32 SetWindowPos grid layout"
```

---

## Task 4: Настройки — столбцы + тумблер авто-раскладки

**Files:**
- Modify: `src/renderer/src/pages/Settings.jsx` (новая карточка настроек)

Цель: дать пользователю задать число столбцов (override) и включить/выключить авто-раскладку при запуске. Ключи настроек: `window_grid_cols` (строка-число или пусто = авто), `window_grid_autoarrange` (`'false'` = выключено; любое другое/отсутствие = включено).

- [ ] **Step 1: Добавить карточку «Раскладка окон» в `Settings.jsx`**

В `src/renderer/src/pages/Settings.jsx`, в основном компоненте `Settings()` (использует `s`, `set`, `save`), добавить новую карточку после карточки «Сессия CS2» (после её закрывающего `</div>`, около строки 361):

```jsx
      <div className="card space-y-4">
        <p className="text-sm font-medium text-text-primary border-b border-border pb-3">Раскладка окон CS2</p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Столбцов в сетке</label>
            <input className="input" type="number" min="1" max="10"
              placeholder="Авто"
              value={s.window_grid_cols || ''}
              onChange={e => set('window_grid_cols', e.target.value)} />
            <p className="text-text-muted text-xs mt-1">Пусто = авто (√n). При запуске по умолчанию 2.</p>
          </div>
          <div>
            <label className="label">Авто-раскладка при запуске</label>
            <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
              <input type="checkbox"
                checked={s.window_grid_autoarrange !== 'false'}
                onChange={e => set('window_grid_autoarrange', e.target.checked ? 'true' : 'false')} />
              <span className="text-sm text-text-secondary">
                Открывать окно CS2 сразу в своей ячейке
              </span>
            </label>
          </div>
        </div>
      </div>
```

- [ ] **Step 2: Проверка сборки**

Run: `npm run build`
Expected: renderer собирается без ошибок.

- [ ] **Step 3: Ручной тест**

1. `npm run dev` → Настройки.
2. Поставить «Столбцов в сетке» = 3, нажать «Сохранить настройки».
3. Запустить 4 бота → окна в раскладке 3 в ряд, 4-е во втором ряду.
4. Снять галку «Авто-раскладка при запуске», сохранить, перезапустить бота → окно появляется в позиции по умолчанию Windows (флаги -x/-y не добавляются; в логе `grid launch flags: (none)`).
5. Кнопка «Разложить окна» при пустом поле столбцов → авто-сетка; при заданном поле и переданном override — соответствующая.

Примечание: кнопка «Разложить окна» (Task 3) сейчас вызывает `arrangeGrid({})` без cols. Если нужно, чтобы кнопка тоже учитывала настройку столбцов — это отдельное улучшение; в рамках этого плана кнопка использует авто, поле столбцов влияет на launch-флаги. (YAGNI — не расширяем без запроса.)

- [ ] **Step 4: Коммит**

```bash
git add src/renderer/src/pages/Settings.jsx
git commit -m "feat: add window grid settings (columns override + auto-arrange toggle)"
```

---

## Самопроверка плана (выполнена при написании)

**Покрытие спека:**
- ✅ `computeGrid` чистая функция + юнит-тесты → Task 1
- ✅ `-x/-y` при запуске, слот по числу запущенных, cols из настройки/дефолт 2 → Task 2
- ✅ Кнопка + `SetWindowPos` (SWP_NOSIZE), один PS-спавн, `pid:x:y` → Task 3
- ✅ Авто-сетка `ceil(sqrt(n))` + ручной override → Task 1 (математика) + Task 4 (UI)
- ✅ Настройки: столбцы + тумблер авто-раскладки → Task 4
- ✅ Основной монитор через `screen.getPrimaryDisplay().workArea` → Task 2, Task 3
- ✅ Размер 640×480 не меняется (SWP_NOSIZE) → Task 3
- ✅ Обработка ошибок: нет окон → `{moved:0}`; HWND не найден → пропуск; PS-ошибка → лог, не падаем → Task 3

**Согласованность имён:** `computeGrid(count, opts)`, `cellPosition(index, cols, opts)`, `autoCols(count)`, `WindowGrid.arrange(opts)`, ключи `window_grid_cols`/`window_grid_autoarrange`, IPC `windows:arrangeGrid`, `window.api.windows.arrangeGrid` — единообразны во всех задачах.

**Примечание о расхождении со спеком:** спек упоминал `WindowGrid.computeGrid` и `slotForLaunch` как методы одного модуля и сигнатуру `computeGrid(count, screenW, screenH, opts)`. План разделил на `WindowGridMath.js` (чистый, для тестируемости и устранения цикла зависимостей) и `WindowGrid.js` (сайд-эффекты), убрал неиспользуемые `screenW/screenH` из чистой функции (базовый сдвиг монитора добавляется в `WindowGrid.arrange`/`CS2Launcher._gridLaunchFlags`). Логика идентична замыслу спека.
