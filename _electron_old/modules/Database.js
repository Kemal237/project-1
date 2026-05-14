const initSqlJs = require('sql.js')
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { app } = require('electron')

class Database {
  constructor() {
    this._ready = false
    this._key = this._deriveKey()
    this._dbPath = path.join(app.getPath('userData'), 'farm.db')
    this.db = null
  }

  async init() {
    if (this._ready) return
    const SQL = await initSqlJs()
    if (fs.existsSync(this._dbPath)) {
      const data = fs.readFileSync(this._dbPath)
      this.db = new SQL.Database(data)
    } else {
      this.db = new SQL.Database()
    }
    this._migrate()
    this._ready = true
    // Сохраняем БД каждые 30 секунд
    setInterval(() => this._save(), 30000)
  }

  _save() {
    if (!this.db) return
    const data = this.db.export()
    fs.writeFileSync(this._dbPath, Buffer.from(data))
  }

  _deriveKey() {
    const seed = [os.hostname(), os.platform(), os.arch(), 'cs2fp_v1'].join('|')
    return crypto.createHash('sha256').update(seed).digest()
  }

  encrypt(text) {
    if (!text) return null
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv('aes-256-gcm', this._key, iv)
    const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, tag, encrypted]).toString('base64')
  }

  decrypt(data) {
    if (!data) return null
    try {
      const buf = Buffer.from(data, 'base64')
      const iv        = buf.slice(0, 16)
      const tag       = buf.slice(16, 32)
      const encrypted = buf.slice(32)
      const decipher  = crypto.createDecipheriv('aes-256-gcm', this._key, iv)
      decipher.setAuthTag(tag)
      return decipher.update(encrypted).toString('utf8') + decipher.final('utf8')
    } catch { return null }
  }

  // Выполнить SELECT — возвращает массив объектов
  all(sql, params = []) {
    const stmt = this.db.prepare(sql)
    stmt.bind(params)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  }

  // Выполнить SELECT — первая строка
  get(sql, params = []) {
    return this.all(sql, params)[0] || null
  }

  // Выполнить INSERT/UPDATE/DELETE
  run(sql, params = []) {
    this.db.run(sql, params)
    this._save()
    return { lastInsertRowid: this.db.exec('SELECT last_insert_rowid()')[0]?.values[0][0] }
  }

  // Выполнить несколько SQL выражений
  exec(sql) {
    this.db.run(sql)
    this._save()
  }

  _migrate() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS accounts (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        login               TEXT NOT NULL UNIQUE,
        password_enc        TEXT,
        shared_secret_enc   TEXT,
        identity_secret_enc TEXT,
        refresh_token_enc   TEXT,
        proxy_id            INTEGER,
        status              TEXT DEFAULT 'idle',
        xp_progress         INTEGER DEFAULT 0,
        drops_total         INTEGER DEFAULT 0,
        drops_this_week     INTEGER DEFAULT 0,
        last_drop_at        TEXT,
        last_login_at       TEXT,
        is_prime            INTEGER DEFAULT 0,
        is_limited          INTEGER DEFAULT 0,
        warmup_week         INTEGER DEFAULT 0,
        notes               TEXT,
        created_at          TEXT DEFAULT (datetime('now'))
      )
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS proxies (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        host            TEXT NOT NULL,
        port            INTEGER NOT NULL,
        username        TEXT,
        password_enc    TEXT,
        type            TEXT DEFAULT 'socks5',
        is_valid        INTEGER DEFAULT 1,
        last_ip         TEXT,
        last_checked_at TEXT,
        created_at      TEXT DEFAULT (datetime('now'))
      )
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS drops (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id   INTEGER NOT NULL,
        item_name    TEXT NOT NULL,
        item_type    TEXT,
        assetid      TEXT,
        classid      TEXT,
        market_price REAL DEFAULT 0,
        dropped_at   TEXT DEFAULT (datetime('now'))
      )
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      )
    `)

    const defaults = {
      batch_size:        '10',
      min_batch_delay:   '30',
      max_batch_delay:   '90',
      min_login_delay:   '15',
      max_login_delay:   '45',
      session_min_hours: '2',
      session_max_hours: '4',
      license_key:       '',
      license_status:    'inactive',
    }

    for (const [key, value] of Object.entries(defaults)) {
      this.db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, value])
    }

    this._save()
  }
}

module.exports = new Database()
