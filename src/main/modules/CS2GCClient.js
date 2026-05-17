import { EventEmitter } from 'events'
import GlobalOffensive from 'globaloffensive'
import accountManager from './AccountManager'
import dropTracker from './DropTracker'

export class CS2GCClient extends EventEmitter {
  constructor(steamClient, accountId) {
    super()
    this._steamClient = steamClient
    this._accountId   = accountId
    this._gc          = null
  }

  connect() {
    if (this._gc) return
    this._gc = new GlobalOffensive(this._steamClient)

    this._gc.on('connectedToGC', () => {
      console.log(`[CS2GC ${this._accountId}] connected to GC`)
      const steamid = this._steamClient.steamID
      if (steamid) this._gc.requestPlayersProfile(steamid)
    })

    this._gc.on('playersProfile', (profile) => {
      const rawXp = profile?.player_cur_xp ?? 327680000
      const xp    = Math.max(0, rawXp - 327680000)
      const level = profile?.player_level ?? 0
      console.log(`[CS2GC ${this._accountId}] XP: ${xp}/5000, level: ${level}`)
      accountManager.update(this._accountId, { xpProgress: xp })
      this.emit('xpUpdate', { xp, level })
    })

    this._gc.on('itemAcquired', (item) => {
      try {
        console.log(`[CS2GC ${this._accountId}] drop received, def_index:`, item?.def_index)
        const drop = {
          name:    String(item?.def_index ?? 'Unknown'),
          type:    item?.origin    != null ? String(item.origin)    : null,
          assetid: item?.id        != null ? String(item.id)        : null,
          classid: item?.class_id  != null ? String(item.class_id)  : null,
          price:   0,
        }
        dropTracker.saveDrop(this._accountId, drop)
        this.emit('drop', drop)
      } catch (err) {
        console.log(`[CS2GC ${this._accountId}] itemAcquired error:`, err.message)
      }
    })

    this._gc.on('disconnectedFromGC', (reason) => {
      console.log(`[CS2GC ${this._accountId}] disconnected from GC, reason: ${reason}`)
    })
  }

  destroy() {
    if (!this._gc) return
    this._gc.removeAllListeners()
    this._gc = null
    this.removeAllListeners()
  }
}
