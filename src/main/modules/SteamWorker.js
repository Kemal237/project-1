import { EventEmitter } from 'events'
import SteamUser from 'steam-user'
import { login, FATAL_ERESULTS } from './SteamAuth'
import accountManager from './AccountManager'
import proxyManager from './ProxyManager'

const PRIME_PACKAGE_ID = 54029
const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 80_000]

export class SteamWorker extends EventEmitter {
  constructor(accountId) {
    super()
    this.accountId = accountId
    this.status    = 'idle'
    this.client    = null
    this._retries  = 0
    this._stopped  = false
    this._steamGuardCallback = null
  }

  async start() {
    this._stopped = false
    this._retries = 0
    await this._connect()
  }

  stop() {
    this._stopped = true
    this._steamGuardCallback = null
    if (this.client) {
      this.client.logOff()
      this.client.removeAllListeners()
      this.client = null
    }
    this._setStatus('idle')
  }

  async _connect() {
    if (this._stopped) return
    this._setStatus('connecting')

    const creds = accountManager.getCredentials(this.accountId)
    if (!creds) return this._fatal('ERR_NO_ACCOUNT', 'Аккаунт не найден в базе')

    const proxyUrl = proxyManager.getProxyUrl(creds.proxyId)
    if (!proxyUrl) return this._fatal('ERR_NO_PROXY', 'Прокси не назначен — обязателен для защиты')

    try {
      const { client, refreshToken } = await login(creds, proxyUrl, {
        onSteamGuard: (d, cb, wrong) => this._handleSteamGuard(d, cb, wrong),
        onLicenses:   (licenses, c)  => this._handleLicenses(c, licenses),
      })
      this.client = client

      if (refreshToken && refreshToken !== creds.refreshToken) {
        accountManager.saveRefreshToken(this.accountId, refreshToken)
        this.emit('refreshToken', { accountId: this.accountId, token: refreshToken })
      }

      this._retries = 0
      console.log(`[SteamWorker ${this.accountId}] logged in as SteamID: ${client.steamID?.getSteamID64?.() ?? client.steamID}`)
      this._setupClientEvents()
    } catch (err) {
      if (this._stopped) return
      console.log(`[SteamWorker ${this.accountId}] login error — eresult:${err.eresult} code:${err.code} msg:${err.message}`)
      if (FATAL_ERESULTS.has(err.eresult)) {
        return this._fatal(err.code || 'ERR_FATAL', err.message)
      }
      // Таймаут ожидания Steam Guard — не реконнектиться, показать ошибку
      if (err.code === 'ERR_LOGIN_TIMEOUT' && this._steamGuardCallback) {
        this._steamGuardCallback = null
        return this._fatal('ERR_STEAM_GUARD_TIMEOUT', 'Время ввода кода Steam Guard истекло (10 мин)')
      }
      this._retry()
    }
  }

  _handleLicenses(client, licenses) {
    if (this._stopped) return
    const { accountId } = this
    const hasPrime = licenses.some(l => l.package_id === PRIME_PACKAGE_ID)
    accountManager.update(accountId, { isPrime: hasPrime })

    if (!hasPrime) {
      this._setStatus('no_prime', 'Нет Prime-статуса — аккаунт не может получать дропы')
      client.removeAllListeners()
      this.client = null
      client.logOff()
      return
    }

    client.setPersona(SteamUser.EPersonaState.Online)
    client.gamesPlayed([730])
    console.log(`[SteamWorker ${accountId}] gamesPlayed(730) called, hasPrime: ${hasPrime}`)
    this._setStatus('online')
  }

  _setupClientEvents() {
    const { client } = this

    client.on('loggedOff', (eresult) => {
      if (this._stopped) return
      console.log(`[SteamWorker ${this.accountId}] loggedOff eresult:${eresult}`)
      client.removeAllListeners()
      this.client = null
      FATAL_ERESULTS.has(eresult)
        ? this._fatal('ERR_LOGGED_OFF', `Steam отключил (EResult: ${eresult})`)
        : this._retry()
    })

    client.on('error', (err) => {
      if (this._stopped) return
      console.log(`[SteamWorker ${this.accountId}] client error — eresult:${err.eresult} msg:${err.message}`)
      client.removeAllListeners()
      this.client = null
      FATAL_ERESULTS.has(err.eresult)
        ? this._fatal(err.code || 'ERR_UNKNOWN', err.message)
        : this._retry()
    })
  }

  _handleSteamGuard(domain, callback, lastCodeWrong) {
    if (this._stopped) return
    this._steamGuardCallback = callback
    const msg = domain
      ? `Введи код из email (${domain})`
      : 'Введи код из мобильного аутентификатора Steam'
    this._setStatus('awaiting_guard', msg)
    this.emit('steamGuard', { accountId: this.accountId, domain, lastCodeWrong })
  }

  provideCode(code) {
    if (this._steamGuardCallback) {
      this._steamGuardCallback(code)
      this._steamGuardCallback = null
    }
  }

  _retry() {
    if (this._stopped) return
    if (this._retries >= BACKOFF_MS.length) {
      return this._fatal('ERR_MAX_RETRIES', 'Превышен лимит попыток реконнекта (5)')
    }
    const delay = BACKOFF_MS[this._retries++]
    this._setStatus('reconnecting', `Реконнект через ${delay / 1000}с (попытка ${this._retries}/${BACKOFF_MS.length})`)
    setTimeout(() => { if (!this._stopped) this._connect() }, delay)
  }

  _fatal(code, message) {
    this._setStatus('error', message)
    this.emit('error', { accountId: this.accountId, code, message })
  }

  _setStatus(status, message) {
    this.status = status
    console.log(`[SteamWorker ${this.accountId}] status: ${status}`, message || '')
    this.emit('statusChange', { accountId: this.accountId, status, message })
  }
}
