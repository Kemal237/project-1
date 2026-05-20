import http from 'http'
import { EventEmitter } from 'events'

const GSI_PORT_START = 7779
const GSI_PORT_END   = 7790

// Receives CS2 Game State Integration HTTP POSTs and emits normalised state events.
// CS2 sends a heartbeat ~every 30s even in menu (no map data), and live events every 0.1–0.5s in-game.
// Port fallback: пытаемся 7779…7790, реальный записываем в this._port для GSI cfg файла.
class CS2GSIServer extends EventEmitter {
  constructor() {
    super()
    this._server = null
    this._port   = null
  }

  ensure() {
    if (this._server) return Promise.resolve(this._port)
    return new Promise((resolve, reject) => {
      const tryPort = (port) => {
        if (port > GSI_PORT_END) {
          reject(new Error(`Все GSI порты ${GSI_PORT_START}–${GSI_PORT_END} заняты`))
          return
        }
        const server = http.createServer((req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(200)
            res.end()
            return
          }
          let body = ''
          req.on('data', c => { body += c })
          req.on('end', () => {
            res.writeHead(200)
            res.end('ok')
            try { this._handle(JSON.parse(body)) } catch {}
          })
        })
        server.once('error', (e) => {
          if (e.code === 'EADDRINUSE') {
            tryPort(port + 1)
          } else {
            console.log('[CS2GSI] server error:', e.message)
            reject(e)
          }
        })
        server.listen(port, '127.0.0.1', () => {
          this._server = server
          this._port   = port
          console.log(`[CS2GSI] listening on 127.0.0.1:${port}`)
          resolve(port)
        })
      }
      tryPort(GSI_PORT_START)
    })
  }

  _handle(data) {
    const map      = data?.map
    const round    = data?.round
    const player   = data?.player
    const provider = data?.provider
    const steamId64 = provider?.steamid64 || provider?.steamid || null

    let state, info = { steamId64 }

    if (!map?.name) {
      // Heartbeat with no map — CS2 is in main menu / lobby
      state = 'lobby'
    } else if (
      map.phase === 'warmup' ||
      map.phase === 'live'   ||
      map.phase === 'intermission' ||
      map.phase === 'gameover'
    ) {
      state = 'cs2_match'
      info  = {
        steamId64,
        map:        (map.name || '').replace(/^(?:de|cs|gg|ar|dm)_/, ''),
        phase:      map.phase,
        ct:         map.team_ct?.score ?? 0,
        t:          map.team_t?.score  ?? 0,
        roundPhase: round?.phase ?? '',
        kills:      player?.match_stats?.kills  ?? 0,
        deaths:     player?.match_stats?.deaths ?? 0,
        assists:    player?.match_stats?.assists ?? 0,
      }
    } else {
      // Map name present but game phase isn't live yet → loading/connecting
      state = 'cs2_loading'
      info  = { steamId64, map: (map.name || '').replace(/^(?:de|cs|gg|ar|dm)_/, '') }
    }

    this.emit('state', { state, info })
  }

  get port() { return this._port }
}

export default new CS2GSIServer()
