import { BrowserWindow } from 'electron'
import { SteamWorker } from './SteamWorker'
import accountManager from './AccountManager'
import gsiServer from './CS2GSIServer'
import cs2Launcher from './CS2Launcher'

const EVENT_LOG_LIMIT = 300

class WorkerManager {
  constructor() {
    this.workers     = new Map()
    this.webContents = null
    this._gsiBound   = false
    this._eventLog   = new Map() // accountId → [{type, accountId, ts, ...}]
  }

  init(webContents) {
    this.webContents = webContents
    this._bindGsi()
  }

  // Рассылает событие во ВСЕ открытые BrowserWindow (главное окно,
  // tracking-окна групп, automation-окна). Без этого tracking-окно с другим
  // webContents не получает статусы — main отправлял только в this.webContents.
  send(channel, payload) {
    const id = payload?.accountId
    if (id != null) {
      if (channel === 'worker:statusChange') {
        this._logEvent(id, 'status', { status: payload.status, message: payload.message })
      } else if (channel === 'worker:error') {
        this._logEvent(id, 'error', { message: payload.message })
      } else if (channel === 'worker:drop') {
        this._logEvent(id, 'drop', { item: payload.item })
      }
    }
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload)
    }
  }

  _logEvent(accountId, type, data) {
    if (!this._eventLog.has(accountId)) this._eventLog.set(accountId, [])
    const log = this._eventLog.get(accountId)
    log.push({ type, accountId, ts: Date.now(), ...data })
    if (log.length > EVENT_LOG_LIMIT) log.splice(0, log.length - EVENT_LOG_LIMIT)
  }

  getEventLog(accountIds) {
    const result = []
    for (const id of accountIds) {
      const log = this._eventLog.get(id)
      if (log) result.push(...log)
    }
    return result.sort((a, b) => a.ts - b.ts)
  }

  _bindGsi() {
    if (this._gsiBound) return
    this._gsiBound = true

    // GSI имеет ПРИОРИТЕТ ниже launch-sequence статусов. Перетираем только
    // когда аккаунт уже в одном из "стабильных" CS2-состояний — иначе GSI heartbeat
    // от уже запущенной игры может затереть промежуточные шаги запуска
    // (steam_launching → steam_loading → steam_running → cs2_launching).
    // cs2_loading тоже overridable — если GSI говорит lobby/match, CS2 точно прошла
    // загрузку (даже если наш hardcoded wait ещё идёт). Реальное состояние > таймера.
    const GSI_OVERRIDABLE = new Set(['cs2_lobby', 'cs2_match_loading', 'cs2_in_match', 'cs2_loading'])

    let _debugCount = 0
    gsiServer.on('state', ({ state, info }) => {
      _debugCount++
      const steamId = info?.steamId64

      if (!steamId) {
        if (_debugCount <= 3) console.log('[WorkerManager GSI] skip: no steamId64 in payload')
        return
      }
      let account = accountManager.getBySteamId(steamId)
      if (!account) {
        // Fallback: если запущен ровно один CS2 через Launch CS2, GSI event от него.
        // Автомаппинг — связываем steamId с этим аккаунтом и сохраняем в БД.
        const activeIds = [...cs2Launcher._active.keys()]
        if (activeIds.length === 1) {
          const id = activeIds[0]
          accountManager.update(id, { steamId })
          account = accountManager.getAll().find(a => a.id === id)
          console.log(`[WorkerManager GSI] auto-mapped steamId=${steamId} -> accountId=${id} (${account?.login})`)
        } else {
          if (_debugCount <= 5) console.log(`[WorkerManager GSI] skip: no account for steamId=${steamId} (active Launch CS2 count: ${activeIds.length}, need exactly 1 for auto-mapping)`)
          return
        }
      }
      if (!account) return

      let newStatus
      if (state === 'cs2_match') newStatus = 'cs2_in_match'
      else if (state === 'cs2_loading') newStatus = 'cs2_match_loading'
      else if (state === 'lobby') newStatus = 'cs2_lobby'
      else return

      if (!GSI_OVERRIDABLE.has(account.status)) {
        if (_debugCount <= 10) console.log(`[WorkerManager GSI] skip: account ${account.id} in launch-sequence (status=${account.status}, would-be ${newStatus})`)
        return
      }
      if (account.status === newStatus) return

      console.log(`[WorkerManager GSI] account ${account.id} (${account.login}) status: ${account.status} -> ${newStatus}`)
      accountManager.update(account.id, { status: newStatus })
      this.send('worker:statusChange', {
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
      this.send('worker:statusChange', payload)
      if (payload.status === 'error' || payload.status === 'no_prime') {
        this.workers.delete(accountId)
      }
    })

    worker.on('refreshToken', ({ accountId: id, token }) => {
      accountManager.saveRefreshToken(id, token)
    })

    worker.on('error', (payload) => {
      this.send('worker:error', payload)
    })

    worker.on('steamGuard', (payload) => {
      console.log('[WorkerManager] steamGuard:', payload.accountId)
      this.send('worker:steamGuard', payload)
    })

    worker.on('drop', (payload) => {
      console.log('[WorkerManager] drop:', payload.accountId, payload.item?.name)
      this.send('worker:drop', payload)
    })

    worker.on('xpUpdate', (payload) => {
      this.send('worker:xpUpdate', payload)
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
    for (const account of accountManager.getAll()) {
      result[account.id] = { status: account.status }
    }
    return result
  }

  provideCode(accountId, code) {
    const worker = this.workers.get(accountId)
    if (worker) worker.provideCode(code)
  }

  async ensureSynced(accountId, sendStatus) {
    const account = accountManager.getAll().find(a => a.id === accountId)
    if (!account) return
    if (!account.needsSync && account.personaName) return

    sendStatus('syncing', 'Синхронизация данных аккаунта...')

    await new Promise((resolve, reject) => {
      const worker = new SteamWorker(accountId)
      let settled = false

      const settle = (err) => {
        if (settled) return
        settled = true
        clearInterval(poll)
        clearTimeout(timer)
        worker.removeAllListeners()
        worker.stop()
        if (err) reject(err)
        else resolve()
      }

      // Опрашиваем БД — когда needs_sync станет 0, синк завершён
      const poll = setInterval(() => {
        const a = accountManager.getAll().find(a => a.id === accountId)
        if (a && !a.needsSync && a.personaName) settle()
      }, 500)

      const timer = setTimeout(() => settle(new Error('Синхронизация: превышен таймаут (2 мин)')), 120_000)

      worker.on('statusChange', ({ status, message }) => {
        if (status === 'no_prime') settle(new Error(message || 'Нет Prime-статуса'))
      })
      worker.on('error', ({ message }) => settle(new Error(message)))

      worker.start().catch(settle)
    })
  }

  getGcClient(accountId) {
    return this.workers.get(accountId)?._gc || null
  }

  getSteamId32(accountId) {
    const worker = this.workers.get(accountId)
    const sid64  = worker?.client?.steamID?.getSteamID64?.()
    if (!sid64) return null
    return Number(BigInt(sid64) - BigInt('76561197960265728'))
  }
}

export default new WorkerManager()
