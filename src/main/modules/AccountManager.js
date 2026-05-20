import db from './Database'

class AccountManager {
  getAll() {
    return db.all(`
      SELECT a.id, a.login, a.proxy_id, a.status, a.xp_progress,
             a.drops_total, a.drops_this_week, a.last_drop_at, a.last_login_at,
             a.is_prime, a.is_limited, a.warmup_week, a.notes, a.created_at,
             a.shared_secret_enc, a.identity_secret_enc, a.steam_id,
             p.host AS proxy_host, p.port AS proxy_port,
             p.username AS proxy_user, p.type AS proxy_type, p.is_valid AS proxy_valid
      FROM accounts a LEFT JOIN proxies p ON a.proxy_id = p.id
      ORDER BY a.created_at DESC
    `).map(r => ({
      id: r.id, login: r.login, status: r.status,
      xpProgress: r.xp_progress, dropsTotal: r.drops_total,
      dropsThisWeek: r.drops_this_week, lastDropAt: r.last_drop_at,
      lastLoginAt: r.last_login_at, isPrime: !!r.is_prime,
      isLimited: !!r.is_limited, warmupWeek: r.warmup_week,
      notes: r.notes, createdAt: r.created_at, steamId: r.steam_id || null,
      hasSharedSecret:   !!db.decrypt(r.shared_secret_enc),
      hasIdentitySecret: !!db.decrypt(r.identity_secret_enc),
      proxy: r.proxy_host ? {
        id: r.proxy_id, host: r.proxy_host, port: r.proxy_port,
        username: r.proxy_user, type: r.proxy_type, isValid: !!r.proxy_valid,
      } : null,
    }))
  }

  add(data) {
    const { login, password, sharedSecret, identitySecret, proxyId, isPrime, notes } = data
    if (!login || !password) throw new Error('login и password обязательны')
    const r = db.run(`
      INSERT INTO accounts (login, password_enc, shared_secret_enc, identity_secret_enc, proxy_id, is_prime, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [login.trim(), db.encrypt(password), db.encrypt(sharedSecret || ''),
        db.encrypt(identitySecret || ''), proxyId || null, isPrime ? 1 : 0, notes || null])
    return { id: r.lastInsertRowid, login: login.trim() }
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
      steamId:        ['steam_id',            v => v ? String(v) : null],
    }
    const fields = [], values = []
    for (const [key, [col, fn]] of Object.entries(map))
      if (data[key] !== undefined) { fields.push(`${col} = ?`); values.push(fn(data[key])) }
    if (!fields.length) return
    values.push(id)
    db.run(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`, values)
  }

  delete(id) {
    db.run('DELETE FROM accounts WHERE id = ?', [id])
    db.run('DELETE FROM drops WHERE account_id = ?', [id])
  }

  resetStatuses() {
    db.run("UPDATE accounts SET status = 'idle' WHERE status != 'idle'")
  }

  resetWeeklyDrops() {
    db.run('UPDATE accounts SET drops_this_week = 0')
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
      } catch (e) { result.failed++; result.errors.push(`${line.slice(0, 30)}: ${e.message}`) }
    }
    return result
  }

  getCredentials(id) {
    const r = db.get('SELECT * FROM accounts WHERE id = ?', [id])
    if (!r) return null
    return {
      id: r.id, login: r.login,
      password:       db.decrypt(r.password_enc),
      sharedSecret:   db.decrypt(r.shared_secret_enc),
      identitySecret: db.decrypt(r.identity_secret_enc),
      refreshToken:   db.decrypt(r.refresh_token_enc),
      proxyId: r.proxy_id, isPrime: !!r.is_prime, warmupWeek: r.warmup_week,
    }
  }

  saveRefreshToken(id, token) {
    db.run(`UPDATE accounts SET refresh_token_enc = ?, last_login_at = datetime('now') WHERE id = ?`,
      [db.encrypt(token), id])
  }

  incrementDrop(id) {
    db.run(`UPDATE accounts SET drops_total = drops_total + 1, drops_this_week = drops_this_week + 1,
            last_drop_at = datetime('now') WHERE id = ?`, [id])
  }

  getBySteamId(steamId64) {
    if (!steamId64) return null
    const r = db.get('SELECT id, login, status FROM accounts WHERE steam_id = ?', [String(steamId64)])
    return r || null
  }
}

export default new AccountManager()
