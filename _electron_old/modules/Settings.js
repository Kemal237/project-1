const db = require('./Database')

class Settings {
  getAll() {
    const rows = db.all('SELECT key, value FROM settings')
    return Object.fromEntries(rows.map(r => [r.key, r.value]))
  }

  get(key) {
    const row = db.get('SELECT value FROM settings WHERE key = ?', [key])
    return row?.value ?? null
  }

  set(key, value) {
    db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, String(value)])
  }
}

module.exports = new Settings()
