import assert from 'node:assert'
import { _splitLines } from '../src/main/modules/CS2NetConsole.js'

// Buffer may arrive in chunks — _splitLines accumulates the remainder.
let carry = ''
let out = []
;[carry, out] = _splitLines(carry, 'hello\nwor')
assert.deepStrictEqual(out, ['hello'])
;[carry, out] = _splitLines(carry, 'ld\nfoo\n')
assert.deepStrictEqual(out, ['world', 'foo'])
assert.strictEqual(carry, '')
console.log('OK netconsole parse')
