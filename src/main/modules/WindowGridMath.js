// Чистая математика раскладки окон CS2 по сетке. Без сайд-эффектов и
// без electron-зависимостей — поэтому юнит-тестируется обычным node
// (см. scripts/test-window-grid.mjs). Тайлинг от точки (0,0); реальный
// базовый сдвиг (рабочая область монитора) добавляется в WindowGrid.js.

// Шаг сетки = ВИДИМЫЙ размер окна CS2, чтобы видимые края окон стыковались
// без щели. Полный rect окна (GetWindowRect/SetWindowPos) включает невидимую
// рамку DWM (~8px по бокам/снизу, сверху нет), поэтому шаг меньше полного rect:
//   ширина:  client 640 + рамка, минус невидимые борта → видимый шаг 640
//   высота:  client 480 + title bar ~31 + нижняя рамка, минус невидимая → ~511
// Подтверждено ручным тестом (при 656/519 была вертикальная щель ~16px).
export const DEFAULT_WIN_W = 640
export const DEFAULT_WIN_H = 511
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
