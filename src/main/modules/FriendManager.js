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
