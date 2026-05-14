import { EventEmitter } from 'events'
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
  }

  async start() {
    this._stopped = false
    this._retries = 0
    await this._connect()
  }

  stop() {
    this._stopped = true
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
      const { client, refreshToken } = await login(creds, proxyUrl)
      this.client = client

      if (refreshToken && refreshToken !== creds.refreshToken) {
        accountManager.saveRefreshToken(this.accountId, refreshToken)
        this.emit('refreshToken', { accountId: this.accountId, token: refreshToken })
      }

      this._retries = 0
      this._setupClientEvents()
    } catch (err) {
      if (this._stopped) return
      if (FATAL_ERESULTS.has(err.eresult)) {
        return this._fatal(err.code || 'ERR_FATAL', err.message)
      }
      this._retry()
    }
  }

  _setupClientEvents() {
    const { client, accountId } = this

    client.once('licenses', (licenses) => {
      if (this._stopped) return
      const hasPrime = licenses.some(l => l.package_id === PRIME_PACKAGE_ID)
      accountManager.update(accountId, { isPrime: hasPrime })

      if (!hasPrime) {
        this._setStatus('no_prime', 'Нет Prime-статуса — аккаунт не может получать дропы')
        client.removeAllListeners()
        this.client = null
        client.logOff()
        return
      }

      client.gamesPlayed([730])
      this._setStatus('online')
    })

    client.on('loggedOff', (eresult) => {
      if (this._stopped) return
      client.removeAllListeners()
      this.client = null
      FATAL_ERESULTS.has(eresult)
        ? this._fatal('ERR_LOGGED_OFF', `Steam отключил (EResult: ${eresult})`)
        : this._retry()
    })

    client.on('error', (err) => {
      if (this._stopped) return
      client.removeAllListeners()
      this.client = null
      FATAL_ERESULTS.has(err.eresult)
        ? this._fatal(err.code || 'ERR_UNKNOWN', err.message)
        : this._retry()
    })
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
    this.emit('statusChange', { accountId: this.accountId, status, message })
  }
}
