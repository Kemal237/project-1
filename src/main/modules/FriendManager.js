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
  constructor() {
    // accountId -> callback от steam-user, ждущий код Steam Guard.
    this._guard = new Map()
  }

  // Передаёт код Steam Guard в ожидающую сессию аккаунта (из UI).
  provideCode(accountId, code) {
    const cb = this._guard.get(accountId)
    if (cb) {
      this._guard.delete(accountId)
      console.log(`[FriendManager] provideCode -> account ${accountId}`)
      try { cb(code) } catch (e) { console.log('[FriendManager] provideCode error:', e.message) }
      return true
    }
    console.log(`[FriendManager] provideCode: нет ожидающего колбэка для account ${accountId}`)
    return false
  }

  // Делает всех аккаунтов группы взаимными друзьями.
  // onProgress(accountId, status, message); onGuard(accountId, domain) — запрос кода Steam Guard в UI.
  // Возвращает { ok, friended:[[id,id]], failed:[[id,id]], impossible:[{aId,bId}] } либо { ok:false, error }.
  async ensureGroupFriends(groupId, onProgress = () => {}, onGuard = () => {}) {
    const group = groupManager.get(groupId)
    if (!group || group.accounts.length < 2) {
      return { ok: false, error: 'В группе должно быть минимум 2 аккаунта' }
    }
    const ids = group.accounts.map(a => a.id)
    console.log(`[FriendManager] ensureGroupFriends group ${groupId}, accounts: ${ids.join(',')}`)

    // Конфликт сессий: ни один аккаунт не должен быть в CS2/Farm-сессии.
    const busy = ids.filter(id => cs2Launcher.isRunning(id) || workerManager.workers.has(id))
    if (busy.length) {
      return { ok: false, error: 'Останови CS2/Farm у аккаунтов группы — нужна свободная сессия Steam' }
    }

    // Метаданные (steamId, isLimited) из accountManager.getAll().
    const meta = new Map(accountManager.getAll().map(a => [a.id, a]))
    const accounts = ids.map(id => {
      const m = meta.get(id) || {}
      return { id, steamId: m.steamId || null, isLimited: !!m.isLimited, login: m.login || `#${id}` }
    })

    // Поднять сессии последовательно (проще, щадит rate-limit логина).
    const sessions = new Map()
    for (const acc of accounts) {
      onProgress(acc.id, 'connecting', 'Вход в Steam...')
      console.log(`[FriendManager] login ${acc.login} (id ${acc.id})...`)
      const s = new FriendSession(acc.id)
      try {
        // onSteamGuard: поднимает таймаут логина до 10 минут и даёт UI запросить
        // код Steam Guard. Колбэк сохраняем — provideCode() подаст в него код.
        // Если у аккаунта device-подтверждение на телефоне — login завершится
        // после approve и без кода (колбэк просто не понадобится).
        const sid = await s.connect({
          onSteamGuard: (domain, callback) => {
            console.log(`[FriendManager] steamGuard requested for ${acc.login} (domain=${domain || 'mobile'})`)
            this._guard.set(acc.id, callback)
            onProgress(acc.id, 'awaiting_guard', domain
              ? `Код Steam Guard из email (${domain})`
              : 'Введи код Steam Guard из приложения Steam Mobile')
            onGuard(acc.id, domain || null)
          },
        })
        this._guard.delete(acc.id)
        if (sid) acc.steamId = sid
        sessions.set(acc.id, s)
        console.log(`[FriendManager] ${acc.login} logged in, steamId=${acc.steamId}`)
        onProgress(acc.id, 'connected', 'В сети')
      } catch (e) {
        this._guard.delete(acc.id)
        console.log(`[FriendManager] login FAILED ${acc.login}: ${e.code || ''} ${e.message}`)
        onProgress(acc.id, 'error', e.message || 'Ошибка входа')
      }
    }

    // Пары считаем только по тем, у кого есть steamId и поднялась сессия.
    const usable = accounts.filter(a => a.steamId && sessions.has(a.id))
    const { pairs, impossible } = computeFriendPairs(usable)
    console.log(`[FriendManager] usable=${usable.length}, pairs=${pairs.length}, impossible=${impossible.length}`)

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
      console.log(`[FriendManager] addFriend ${p.firstId}<->${p.secondId}`)

      // non-limited инициирует, затем второй принимает/взаимно.
      const r1 = await first.addFriendBySteamId(p.secondSteamId)
      await new Promise(r => setTimeout(r, 800))
      const r2 = await second.addFriendBySteamId(p.firstSteamId)
      console.log(`[FriendManager] addFriend results: first=${JSON.stringify(r1)} second=${JSON.stringify(r2)}`)

      const ok = await waitFriend(first, p.secondSteamId, 8000)
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
    console.log(`[FriendManager] done. friended=${friended.length} failed=${failed.length} impossible=${impossible.length}`)
    return { ok: failed.length === 0 && impossible.length === 0, friended, failed, impossible }
  }
}

export default new FriendManager()
