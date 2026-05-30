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
