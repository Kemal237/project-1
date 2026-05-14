import db from './Database'

class DropTracker {
  saveDrop(accountId, item) {
    db.run('INSERT INTO drops (account_id, item_name, item_type, assetid, classid, market_price) VALUES (?, ?, ?, ?, ?, ?)',
      [accountId, item.name || 'Unknown', item.type || null, item.assetid || null, item.classid || null, item.price || 0])
    db.run(`UPDATE accounts SET drops_total = drops_total + 1, drops_this_week = drops_this_week + 1,
            last_drop_at = datetime('now') WHERE id = ?`, [accountId])
  }

  getAll(limit = 200) {
    return db.all(`SELECT d.id, d.item_name, d.item_type, d.market_price, d.dropped_at, a.login AS account_login
      FROM drops d JOIN accounts a ON d.account_id = a.id ORDER BY d.dropped_at DESC LIMIT ?`, [limit])
  }

  getByAccount(accountId) {
    return db.all('SELECT * FROM drops WHERE account_id = ? ORDER BY dropped_at DESC', [accountId])
  }

  getStats() {
    const total = db.get('SELECT COUNT(*) AS cnt, SUM(market_price) AS revenue FROM drops') || {}
    const week  = db.get(`SELECT COUNT(*) AS cnt, SUM(market_price) AS revenue FROM drops WHERE dropped_at >= datetime('now', '-7 days')`) || {}
    const byDay = db.all(`SELECT DATE(dropped_at) AS date, COUNT(*) AS count, SUM(market_price) AS revenue
      FROM drops WHERE dropped_at >= datetime('now', '-30 days') GROUP BY DATE(dropped_at) ORDER BY date ASC`)
    const topAccounts = db.all(`SELECT a.login, COUNT(d.id) AS drops, SUM(d.market_price) AS revenue
      FROM drops d JOIN accounts a ON d.account_id = a.id GROUP BY a.id ORDER BY drops DESC LIMIT 10`)
    return {
      total:    { count: total.cnt || 0, revenue: total.revenue || 0 },
      thisWeek: { count: week.cnt || 0,  revenue: week.revenue || 0 },
      byDay, topAccounts,
    }
  }
}

export default new DropTracker()
