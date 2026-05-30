import SteamUser from 'steam-user'
import { login } from './SteamAuth'
import accountManager from './AccountManager'
import proxyManager from './ProxyManager'

// Одноразовая steam-user сессия ТОЛЬКО для операций с друзьями.
// Отличия от SteamWorker: без GC/Prime/gamesPlayed, не отключается на non-Prime,
// живёт пока не вызвали close().
export class FriendSession {
  constructor(accountId) {
    this.accountId = accountId
    this.client = null
    this.steamId = null
  }

  // Логинится через общий SteamAuth.login (прокси обязателен, Guard через
  // shared_secret/steam-totp внутри login). Возвращает steamID64.
  async connect({ onSteamGuard } = {}) {
    const creds = accountManager.getCredentials(this.accountId)
    if (!creds) throw Object.assign(new Error('Аккаунт не найден'), { code: 'ERR_NO_ACCOUNT' })
    const proxyUrl = proxyManager.getProxyUrl(creds.proxyId)
    if (!proxyUrl) throw Object.assign(new Error('Прокси не назначен'), { code: 'ERR_NO_PROXY' })

    const { client, refreshToken } = await login(creds, proxyUrl, { onSteamGuard })
    this.client = client
    this.steamId = client.steamID?.getSteamID64?.() || null

    if (refreshToken && refreshToken !== creds.refreshToken) {
      accountManager.saveRefreshToken(this.accountId, refreshToken)
    }
    if (this.steamId) {
      try { accountManager.update(this.accountId, { steamId: this.steamId }) } catch {}
    }
    client.setPersona(SteamUser.EPersonaState.Online)
    return this.steamId
  }

  // Отправляет заявку в друзья ИЛИ принимает встречную (Steam сам различает).
  // Возвращает { ok: true } либо { ok: false, error }.
  addFriendBySteamId(steamId64) {
    return new Promise((resolve) => {
      if (!this.client) return resolve({ ok: false, error: 'сессия не подключена' })
      this.client.addFriend(String(steamId64), (err) => {
        if (err) resolve({ ok: false, error: err.message || String(err) })
        else resolve({ ok: true })
      })
    })
  }

  // Текущее отношение к steamId: EFriendRelationship (Friend=3, None=0, ...).
  getRelationship(steamId64) {
    return this.client?.myFriends?.[String(steamId64)] ?? 0
  }

  close() {
    if (this.client) {
      try { this.client.logOff() } catch {}
      try { this.client.removeAllListeners() } catch {}
      this.client = null
    }
  }
}
