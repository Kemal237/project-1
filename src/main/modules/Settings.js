import db from './Database'

class Settings {
  getAll() {
    return Object.fromEntries(db.all('SELECT key, value FROM settings').map(r => [r.key, r.value]))
  }
  get(key) { return db.get('SELECT value FROM settings WHERE key = ?', [key])?.value ?? null }
  set(key, value) { db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, String(value)]) }
}

export default new Settings()
