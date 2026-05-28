import initSqlJs from 'sql.js'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { hostname, platform, arch } from 'os'
import { app } from 'electron'

function sqlWasmPath(file) {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist', file)
  }
  return join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', file)
}

class Database {
  constructor() {
    this._key   = this._deriveKey()
    this._dbPath = null
    this.db     = null
  }

  async init() {
    this._dbPath = join(app.getPath('userData'), 'farm.db')
    const SQL = await initSqlJs({ locateFile: sqlWasmPath })

    this.db = existsSync(this._dbPath)
      ? new SQL.Database(readFileSync(this._dbPath))
      : new SQL.Database()

    this._migrate()
    setInterval(() => this._save(), 30000)
  }

  _save() {
    if (!this.db) return
    writeFileSync(this._dbPath, Buffer.from(this.db.export()))
  }

  _deriveKey() {
    return createHash('sha256')
      .update([hostname(), platform(), arch(), 'cs2fp_v1'].join('|'))
      .digest()
  }

  encrypt(text) {
    if (!text) return null
    const iv      = randomBytes(16)
    const cipher  = createCipheriv('aes-256-gcm', this._key, iv)
    const enc     = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()])
    const tag     = cipher.getAuthTag()
    return Buffer.concat([iv, tag, enc]).toString('base64')
  }

  decrypt(data) {
    if (!data) return null
    try {
      const buf     = Buffer.from(data, 'base64')
      const iv      = buf.slice(0, 16)
      const tag     = buf.slice(16, 32)
      const enc     = buf.slice(32)
      const decipher = createDecipheriv('aes-256-gcm', this._key, iv)
      decipher.setAuthTag(tag)
      return decipher.update(enc).toString('utf8') + decipher.final('utf8')
    } catch { return null }
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql)
    stmt.bind(params)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  }

  get(sql, params = []) {
    return this.all(sql, params)[0] || null
  }

  run(sql, params = []) {
    this.db.run(sql, params)
    this._save()
    const r = this.db.exec('SELECT last_insert_rowid()')
    return { lastInsertRowid: r[0]?.values[0][0] }
  }

  _migrate() {
    this.db.run(`CREATE TABLE IF NOT EXISTS accounts (
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
    )`)

    this.db.run(`CREATE TABLE IF NOT EXISTS proxies (
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
    )`)

    this.db.run(`CREATE TABLE IF NOT EXISTS drops (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id   INTEGER NOT NULL,
      item_name    TEXT NOT NULL,
      item_type    TEXT,
      assetid      TEXT,
      classid      TEXT,
      market_price REAL DEFAULT 0,
      dropped_at   TEXT DEFAULT (datetime('now'))
    )`)

    this.db.run(`CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    )`)

    const defaults = {
      batch_size: '10', min_batch_delay: '30', max_batch_delay: '90',
      min_login_delay: '15', max_login_delay: '45',
      session_min_hours: '2', session_max_hours: '4',
      license_key: '', license_status: 'inactive',
    }
    for (const [k, v] of Object.entries(defaults))
      this.db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [k, v])

    // Phase 3B-1: Windows User Accounts isolation — one-shot migration
    const migrated = this.get("SELECT value FROM settings WHERE key='migrated_to_user_accounts'")
    if (!migrated) {
      // Wipe старых данных (пользователь дал согласие при переходе на User Accounts)
      this.db.run('DELETE FROM accounts')
      this.db.run('DELETE FROM drops')
      this.db.run('DROP TABLE IF EXISTS launcher_slots')
      this.db.run("DELETE FROM settings WHERE key='sandboxie_path'")
      this.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('migrated_to_user_accounts', 'true')")
    }

    // Добавить колонки для Windows User Account (идемпотентно)
    const cols = this.all('PRAGMA table_info(accounts)').map(c => c.name)
    if (!cols.includes('windows_user'))
      this.db.run('ALTER TABLE accounts ADD COLUMN windows_user TEXT')
    if (!cols.includes('windows_password_enc'))
      this.db.run('ALTER TABLE accounts ADD COLUMN windows_password_enc TEXT')
    if (!cols.includes('steam_id'))
      this.db.run('ALTER TABLE accounts ADD COLUMN steam_id TEXT')

    const launcherDefaults = { steam_path: '', cs2_path: '' }
    for (const [k, v] of Object.entries(launcherDefaults))
      this.db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [k, v])

    // Phase 3B-2: фарм-группы. Группа — 2-4 аккаунта для координированного
    // запуска CS2 (общее лобби, синхронные действия).
    // group_accounts — many-to-many: один аккаунт может быть в нескольких
    // группах, но при запуске одной группы UI блокирует запуск второй с тем
    // же аккаунтом (он уже занят).
    this.db.run(`CREATE TABLE IF NOT EXISTS groups (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      description TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    )`)
    this.db.run(`CREATE TABLE IF NOT EXISTS group_accounts (
      group_id   INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      position   INTEGER DEFAULT 0,
      PRIMARY KEY (group_id, account_id),
      FOREIGN KEY (group_id)   REFERENCES groups(id)   ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    )`)

    this._save()
  }
}

export default new Database()
