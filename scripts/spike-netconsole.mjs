// SPIKE: подключается к netconsole запущенного CS2 (порт = 29100 + accountId),
// печатает ВЕСЬ вывод консоли в реальном времени и шлёт пробные команды.
// Цель: (1) проверить, пробивает ли Sandboxie netconport; (2) найти команды
// создания приватного лобби и чтения lobby ID.
//
// Запуск:  node scripts/spike-netconsole.mjs [accountId]
//   - с аргументом: цепляется к порту 29100 + accountId
//   - без аргумента: сканирует 29101..29130 и цепляется к первому открытому
//
// Скрипт работает ~3 минуты и НЕ закрывается сам сразу — пока он висит,
// вручную в CS2: открой «Играть» → создай приватное лобби / пати. Любой
// вывод консоли (включая строки с lobby ID) будет напечатан здесь как "CON>".
// Нажми Ctrl+C, когда закончишь.

import net from 'node:net'
import { CS2NetConsole, portForAccount, NETCON_BASE } from '../src/main/modules/CS2NetConsole.js'

// Быстрая проверка: открыт ли TCP-порт (есть кто слушает).
const probePort = (port, timeoutMs = 400) => new Promise((resolve) => {
  const s = net.createConnection({ host: '127.0.0.1', port })
  const done = (ok) => { try { s.destroy() } catch {} resolve(ok) }
  s.once('connect', () => done(true))
  s.once('error', () => done(false))
  setTimeout(() => done(false), timeoutMs)
})

const argId = process.argv[2] ? Number(process.argv[2]) : null
let port = argId != null ? portForAccount(argId) : null

if (port == null) {
  console.log(`[spike] accountId не задан — сканирую порты ${NETCON_BASE + 1}..${NETCON_BASE + 30} ...`)
  for (let id = 1; id <= 30; id++) {
    const p = portForAccount(id)
    if (await probePort(p)) { port = p; console.log(`[spike] найден открытый порт ${p} (accountId=${id})`); break }
  }
  if (port == null) {
    console.log('[spike] FAILED — ни один netconport (29101..29130) не открыт.')
    console.log('[spike] Причины: CS2 не запущен из dev-сборки с -netconport / Sandboxie блокирует сеть до бокса.')
    console.log('[spike] => зафиксировать в spec и переключаться на Вариант 2 (keybd_event + -condebug).')
    process.exit(1)
  }
}

const con = new CS2NetConsole(port)
console.log(`[spike] connecting to 127.0.0.1:${port} ...`)
const ok = await con.connect({ retries: 10, intervalMs: 1000 })
if (!ok) {
  console.log('[spike] FAILED to connect — netconport недоступен.')
  console.log('[spike] Причины: CS2 не запущен / запущен без -netconport / Sandboxie блокирует сеть до порта бокса.')
  console.log('[spike] => зафиксировать в spec и переключаться на Вариант 2 (keybd_event + -condebug).')
  process.exit(1)
}
console.log('[spike] CONNECTED ✓  (Sandboxie netconport пробивается)')
console.log('[spike] Всё, что печатает консоль CS2, появится ниже как "CON>".')
console.log('[spike] Теперь вручную в игре создай приватное лобби и смотри на вывод.\n')

// Печатаем каждую строку вывода консоли. Подсвечиваем потенциальные lobby ID
// (длинные 17+ значные числа — формат SteamID/lobbyID 64-бит).
con.onLine((line) => {
  const hasBigId = /\b\d{16,}\b/.test(line)
  console.log(`${hasBigId ? '★ ' : '  '}CON> ${line}`)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const probe = async (cmd, waitMs = 1500) => {
  console.log(`\n[spike] send: ${cmd}`)
  try { con.send(cmd) } catch (e) { console.log('[spike] send error:', e.message) }
  await sleep(waitMs)
}

// Стартовые пробы: подтверждение связи + поиск lobby-команд/конваров.
await probe('echo SPIKE_TEST_123')   // подтверждение двусторонней связи
await probe('status')                // общий статус, иногда содержит lobby
await probe('help connect_lobby')    // существует ли команда connect_lobby
await probe('find lobby')            // поиск всех конваров/команд со словом lobby
await probe('connect_lobby')         // usage / текущее значение

console.log('\n[spike] Стартовые пробы отправлены. Теперь СОЗДАЙ ЛОББИ В ИГРЕ вручную.')
console.log('[spike] Скрипт будет слать "status" каждые 10с (ловим lobby ID) ещё ~3 минуты.')
console.log('[spike] Ctrl+C чтобы выйти.\n')

// Периодически опрашиваем status — после создания лобби его ID может там всплыть.
for (let i = 0; i < 18; i++) {
  await sleep(10000)
  await probe('status', 800)
}

console.log('\n[spike] done — изучи вывод выше (строки со ★ содержат большие ID).')
con.close()
process.exit(0)
