import { SteamWorker } from './SteamWorker'
import accountManager from './AccountManager'
import gsiServer from './CS2GSIServer'

class WorkerManager {
  constructor() {
    this.workers     = new Map()
    this.webContents = null
    this._gsiBound   = false
  }

  init(webContents) {
    this.webContents = webContents
    this._bindGsi()
  }

  _bindGsi() {
    if (this._gsiBound) return
    this._gsiBound = true

    // GSI имеет ПРИОРИТЕТ ниже launch-sequence статусов. Перетираем только
    // когда аккаунт уже в одном из "стабильных" CS2-состояний — иначе GSI heartbeat
    // от уже запущенной игры может затереть промежуточные шаги запуска
    // (steam_launching → steam_loading → steam_running → cs2_launching).
    const GSI_OVERRIDABLE = new Set(['cs2_lobby', 'cs2_match_loading', 'cs2_in_match'])

    gsiServer.on('state', ({ state, info }) => {
      const steamId = info?.steamId64
      if (!steamId) return
      const account = accountManager.getBySteamId(steamId)
      if (!account) return

      let newStatus
      if (state === 'cs2_match') newStatus = 'cs2_in_match'
      else if (state === 'cs2_loading') newStatus = 'cs2_match_loading'
      else if (state === 'lobby') newStatus = 'cs2_lobby'
      else return

      if (!GSI_OVERRIDABLE.has(account.status)) return  // launch sequence идёт — не трогаем
      if (account.status === newStatus) return          // нет изменений — не флудим IPC

      accountManager.update(account.id, { status: newStatus })
      this.webContents?.send('worker:statusChange', {
        accountId: account.id,
        status:    newStatus,
        gsiInfo:   info,
      })
    })
  }

  async start(accountId) {
    if (this.workers.has(accountId)) return

    const worker = new SteamWorker(accountId)

    worker.on('statusChange', (payload) => {
      accountManager.update(payload.accountId, { status: payload.status })
      this.webContents?.send('worker:statusChange', payload)
      if (payload.status === 'error' || payload.status === 'no_prime') {
        this.workers.delete(accountId)
      }
    })

    worker.on('refreshToken', ({ accountId: id, token }) => {
      accountManager.saveRefreshToken(id, token)
    })

    worker.on('error', (payload) => {
      this.webContents?.send('worker:error', payload)
    })

    worker.on('steamGuard', (payload) => {
      console.log('[WorkerManager] steamGuard:', payload.accountId)
      this.webContents?.send('worker:steamGuard', payload)
    })

    worker.on('drop', (payload) => {
      console.log('[WorkerManager] drop:', payload.accountId, payload.item?.name)
      this.webContents?.send('worker:drop', payload)
    })

    worker.on('xpUpdate', (payload) => {
      this.webContents?.send('worker:xpUpdate', payload)
    })

    this.workers.set(accountId, worker)
    worker.start().catch(() => {})
  }

  async stop(accountId) {
    const worker = this.workers.get(accountId)
    if (!worker) return
    worker.removeAllListeners()
    worker.stop()
    this.workers.delete(accountId)
  }

  async stopAll() {
    for (const id of [...this.workers.keys()]) {
      await this.stop(id)
    }
  }

  getStatus(accountId) {
    const worker = this.workers.get(accountId)
    return worker ? { status: worker.status } : null
  }

  getAllStatuses() {
    const result = {}
    for (const [id, worker] of this.workers) {
      result[id] = { status: worker.status }
    }
    return result
  }

  provideCode(accountId, code) {
    const worker = this.workers.get(accountId)
    if (worker) worker.provideCode(code)
  }
}

export default new WorkerManager()
