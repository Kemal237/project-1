const db = require('./Database')

class AccountManager {

  getAll() {
    const rows = db.all(`
      SELECT
        a.id, a.login, a.proxy_id, a.status, a.xp_progress,
        a.drops_total, a.drops_this_week, a.last_drop_at,
        a.last_login_at, a.is_prime, a.is_limited,
        a.warmup_week, a.notes, a.created_at,
        p.host AS proxy_host, p.port AS proxy_port,
        p.username AS proxy_user, p.type AS proxy_type,
        p.is_valid AS proxy_valid
      FROM accounts a
      LEFT JOIN proxies p ON a.proxy_id = p.id
      ORDER BY a.created_at DESC
    `)

    return rows.map(r => ({
      id:            r.id,
      login:         r.login,
      status:        r.status,
      xpProgress:    r.xp_progress,
      dropsTotal:    r.drops_total,
      dropsThisWeek: r.drops_this_week,
      lastDropAt:    r.last_drop_at,
      lastLoginAt:   r.last_login_at,
      isPrime:       !!r.is_prime,
      isLimited:     !!r.is_limited,
      warmupWeek:    r.warmup_week,
      notes:         r.notes,
      createdAt:     r.created_at,
      proxy: r.proxy_host ? {
        id:       r.proxy_id,
        host:     r.proxy_host,
        port:     r.proxy_port,
        username: r.proxy_user,
        type:     r.proxy_type,
        isValid:  !!r.proxy_valid,
      } : null,
    }))
  }

  add(data) {
    const { login, password, sharedSecret, identitySecret, proxyId, isPrime, notes } = data
    if (!login || !password) throw new Error('login и password обязательны')

    const result = db.run(`
      INSERT INTO accounts
        (login, password_enc, shared_secret_enc, identity_secret_enc, proxy_id, is_prime, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      login.trim(),
      db.encrypt(password),
      db.encrypt(sharedSecret || ''),
      db.encrypt(identitySecret || ''),
      proxyId || null,
      isPrime ? 1 : 0,
      notes || null,
    ])

    return { id: result.lastInsertRowid, login: login.trim() }
  }

  update(id, data) {
    const map = {
      password:       ['password_enc',        v => db.encrypt(v)],
      sharedSecret:   ['shared_secret_enc',   v => db.encrypt(v)],
      identitySecret: ['identity_secret_enc', v => db.encrypt(v)],
      refreshToken:   ['refresh_token_enc',   v => db.encrypt(v)],
      proxyId:        ['proxy_id',            v => v],
      status:         ['status',              v => v],
      xpProgress:     ['xp_progress',         v => v],
      dropsTotal:     ['drops_total',         v => v],
      dropsThisWeek:  ['drops_this_week',     v => v],
      lastDropAt:     ['last_drop_at',        v => v],
      lastLoginAt:    ['last_login_at',       v => v],
      isPrime:        ['is_prime',            v => v ? 1 : 0],
      isLimited:      ['is_limited',          v => v ? 1 : 0],
      warmupWeek:     ['warmup_week',         v => v],
      notes:          ['notes',               v => v],
    }

    const fields = []
    const values = []

    for (const [key, [col, transform]] of Object.entries(map)) {
      if (data[key] !== undefined) {
        fields.push(`${col} = ?`)
        values.push(transform(data[key]))
      }
    }

    if (!fields.length) return
    values.push(id)
    db.run(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`, values)
  }

  delete(id) {
    db.run('DELETE FROM accounts WHERE id = ?', [id])
  }

  importFromText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    const result = { success: 0, failed: 0, errors: [] }

    for (const line of lines) {
      try {
        const [login, password, sharedSecret = '', identitySecret = ''] = line.split(':')
        if (!login || !password) throw new Error('Нужны минимум login:password')
        this.add({ login, password, sharedSecret, identitySecret })
        result.success++
      } catch (e) {
        result.failed++
        result.errors.push(`${line.slice(0, 30)}: ${e.message}`)
      }
    }

    return result
  }

  getCredentials(id) {
    const row = db.get('SELECT * FROM accounts WHERE id = ?', [id])
    if (!row) return null
    return {
      id:             row.id,
      login:          row.login,
      password:       db.decrypt(row.password_enc),
      sharedSecret:   db.decrypt(row.shared_secret_enc),
      identitySecret: db.decrypt(row.identity_secret_enc),
      refreshToken:   db.decrypt(row.refresh_token_enc),
      proxyId:        row.proxy_id,
      isPrime:        !!row.is_prime,
      warmupWeek:     row.warmup_week,
    }
  }

  saveRefreshToken(id, token) {
    db.run(
      `UPDATE accounts SET refresh_token_enc = ?, last_login_at = datetime('now') WHERE id = ?`,
      [db.encrypt(token), id]
    )
  }

  incrementDrop(id) {
    db.run(`
      UPDATE accounts
      SET drops_total = drops_total + 1,
          drops_this_week = drops_this_week + 1,
          last_drop_at = datetime('now')
      WHERE id = ?
    `, [id])
  }

  resetWeeklyDrops() {
    db.run('UPDATE accounts SET drops_this_week = 0, xp_progress = 0')
  }
}

module.exports = new AccountManager()
