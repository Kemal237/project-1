import { SteamWorker } from './SteamWorker'
import accountManager from './AccountManager'

class WorkerManager {
  constructor() {
    this.workers     = new Map()
    this.webContents = null
  }

  init(webContents) {
    this.webContents = webContents
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
