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
