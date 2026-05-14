const https = require('https')
const { SocksProxyAgent } = require('socks-proxy-agent')
const db = require('./Database')

class ProxyManager {

  getAll() {
    const rows = db.all(`
      SELECT p.id, p.host, p.port, p.username, p.type,
             p.is_valid, p.last_ip, p.last_checked_at, p.created_at,
             COUNT(a.id) AS accounts_count
      FROM proxies p
      LEFT JOIN accounts a ON a.proxy_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `)

    return rows.map(r => ({
      id:            r.id,
      host:          r.host,
      port:          r.port,
      username:      r.username,
      type:          r.type,
      isValid:       !!r.is_valid,
      lastIp:        r.last_ip,
      lastCheckedAt: r.last_checked_at,
      accountsCount: r.accounts_count,
      createdAt:     r.created_at,
    }))
  }

  add(data) {
    const { host, port, username, password, type = 'socks5' } = data
    if (!host || !port) throw new Error('host и port обязательны')

    const result = db.run(`
      INSERT INTO proxies (host, port, username, password_enc, type)
      VALUES (?, ?, ?, ?, ?)
    `, [host.trim(), parseInt(port), username || null, db.encrypt(password || ''), type])

    return { id: result.lastInsertRowid }
  }

  delete(id) {
    db.run('UPDATE accounts SET proxy_id = NULL WHERE proxy_id = ?', [id])
    db.run('DELETE FROM proxies WHERE id = ?', [id])
  }

  assign(proxyId, accountId) {
    db.run('UPDATE accounts SET proxy_id = ? WHERE id = ?', [proxyId || null, accountId])
  }

  async validate(data) {
    const { host, port, username, password, type = 'socks5' } = data

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ valid: false, error: 'Timeout (8s)' }), 8000)

      try {
        const auth = username ? `${username}:${password}@` : ''
        const agent = new SocksProxyAgent(`${type}://${auth}${host}:${port}`)

        const req = https.request({
          hostname: 'api.ipify.org',
          path: '/?format=json',
          method: 'GET',
          agent,
          timeout: 7000,
        }, (res) => {
          let body = ''
          res.on('data', d => body += d)
          res.on('end', () => {
            clearTimeout(timer)
            try {
              const { ip } = JSON.parse(body)
              resolve({ valid: true, ip })
            } catch {
              resolve({ valid: false, error: 'Неверный ответ' })
            }
          })
        })

        req.on('error', e => { clearTimeout(timer); resolve({ valid: false, error: e.message }) })
        req.on('timeout', () => { req.destroy(); resolve({ valid: false, error: 'Timeout' }) })
        req.end()
      } catch (e) {
        clearTimeout(timer)
        resolve({ valid: false, error: e.message })
      }
    })
  }

  getProxyUrl(proxyId) {
    if (!proxyId) return null
    const row = db.get('SELECT * FROM proxies WHERE id = ?', [proxyId])
    if (!row) return null
    const pass = db.decrypt(row.password_enc)
    const auth = row.username ? `${row.username}:${pass}@` : ''
    return `${row.type}://${auth}${row.host}:${row.port}`
  }
}

module.exports = new ProxyManager()
