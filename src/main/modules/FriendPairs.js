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
