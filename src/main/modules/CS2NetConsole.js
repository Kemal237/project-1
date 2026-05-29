import net from 'node:net'

// Splits accumulated buffer + new chunk into completed lines.
// Returns [remainder, arrayOfCompletedLines]. Exported for the test.
export function _splitLines(carry, chunk) {
  const data = carry + chunk
  const parts = data.split('\n')
  const rest = parts.pop()            // last piece without \n — stays in buffer
  return [rest, parts.map(s => s.replace(/\r$/, ''))]
}

// Client to the netconsole of one CS2 instance (port = NETCON_BASE + accountId).
// Source engine: TCP server, accepts commands as lines, sends output as lines.
export class CS2NetConsole {
  constructor(port) {
    this.port = port
    this.socket = null
    this._carry = ''
    this._lineHandlers = []
  }

  // Connect with retries (CS2 opens the port not immediately after start).
  async connect({ retries = 30, intervalMs = 1000 } = {}) {
    for (let i = 0; i < retries; i++) {
      try {
        await this._tryConnectOnce()
        return true
      } catch {
        await new Promise(r => setTimeout(r, intervalMs))
      }
    }
    return false
  }

  _tryConnectOnce() {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: '127.0.0.1', port: this.port })
      s.once('connect', () => {
        this.socket = s
        s.on('data', (buf) => {
          const [rest, lines] = _splitLines(this._carry, buf.toString('utf8'))
          this._carry = rest
          for (const line of lines) for (const h of this._lineHandlers) h(line)
        })
        s.on('error', () => {})
        resolve()
      })
      s.once('error', (e) => { s.destroy(); reject(e) })
    })
  }

  onLine(handler) { this._lineHandlers.push(handler) }

  send(cmd) {
    if (!this.socket) throw new Error('netconsole not connected')
    this.socket.write(cmd + '\n')
  }

  // Sends a command and waits for the first output line satisfying matchFn,
  // within timeoutMs. Returns the matched line or null.
  sendAndWait(cmd, matchFn, timeoutMs = 4000) {
    return new Promise((resolve) => {
      let done = false
      const finish = (val) => { if (!done) { done = true; resolve(val) } }
      const handler = (line) => { if (matchFn(line)) finish(line) }
      this._lineHandlers.push(handler)
      this.send(cmd)
      setTimeout(() => finish(null), timeoutMs)
    })
  }

  close() {
    if (this.socket) { try { this.socket.destroy() } catch {} this.socket = null }
    this._lineHandlers = []
  }
}

export const NETCON_BASE = 29100
export const portForAccount = (accountId) => NETCON_BASE + accountId
