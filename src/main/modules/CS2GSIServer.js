import http from 'http'
import { EventEmitter } from 'events'

const GSI_PORT = 7779

// Receives CS2 Game State Integration HTTP POSTs and emits normalised state events.
// CS2 sends a heartbeat ~every 30s even in menu (no map data), and live events every 0.1–0.5s in-game.
class CS2GSIServer extends EventEmitter {
  constructor() {
    super()
    this._server = null
  }

  ensure() {
    if (this._server) return
    this._server = http.createServer((req, res) => {
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
    this._server.on('error', e => console.log('[CS2GSI] server error:', e.message))
    this._server.listen(GSI_PORT, '127.0.0.1', () => {
      console.log(`[CS2GSI] listening on 127.0.0.1:${GSI_PORT}`)
    })
  }

  _handle(data) {
    const map    = data?.map
    const round  = data?.round
    const player = data?.player

    let state, info = {}

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
      info  = { map: (map.name || '').replace(/^(?:de|cs|gg|ar|dm)_/, '') }
    }

    this.emit('state', { state, info })
  }

  get port() { return GSI_PORT }
}

export default new CS2GSIServer()
