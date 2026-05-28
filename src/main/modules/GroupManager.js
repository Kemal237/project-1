import db from './Database'

// Управление фарм-группами: 2-4 аккаунта объединяются в группу для
// координированного запуска CS2 (общий матч/лобби). Один аккаунт может
// быть в нескольких группах — конфликт разруливается на UI-уровне:
// если аккаунт уже запущен в составе одной группы, попытка запустить
// вторую с тем же аккаунтом показывает модалку.
class GroupManager {
  // Возвращает все группы с массивом аккаунтов (со всеми полями нужными
  // для UI карточки — login, proxy, isPrime, hasSharedSecret).
  getAll() {
    const groups = db.all(`SELECT id, name, description, created_at FROM groups ORDER BY id DESC`)
    if (!groups.length) return []
    const ids = groups.map(g => g.id)
    const placeholders = ids.map(() => '?').join(',')
    const links = db.all(`
      SELECT ga.group_id, ga.position,
             a.id, a.login, a.is_prime, a.last_login_at, a.shared_secret_enc,
             a.proxy_id, p.host AS proxy_host, p.port AS proxy_port,
             p.type AS proxy_type, p.is_valid AS proxy_valid
      FROM group_accounts ga
      JOIN accounts a       ON a.id = ga.account_id
      LEFT JOIN proxies p   ON p.id = a.proxy_id
      WHERE ga.group_id IN (${placeholders})
      ORDER BY ga.group_id, ga.position, a.id
    `, ids)
    const byGroup = new Map(ids.map(id => [id, []]))
    for (const r of links) {
      byGroup.get(r.group_id).push({
        id:              r.id,
        login:           r.login,
        isPrime:         !!r.is_prime,
        lastLoginAt:     r.last_login_at,
        hasSharedSecret: !!db.decrypt(r.shared_secret_enc),
        proxy: r.proxy_host ? {
          id: r.proxy_id, host: r.proxy_host, port: r.proxy_port,
          type: r.proxy_type, isValid: !!r.proxy_valid,
        } : null,
      })
    }
    return groups.map(g => ({
      id:          g.id,
      name:        g.name,
      description: g.description || '',
      createdAt:   g.created_at,
      accounts:    byGroup.get(g.id) || [],
    }))
  }

  get(id) {
    return this.getAll().find(g => g.id === id) || null
  }

  // accountIds — массив ID в нужном порядке. Позиция сохраняется (нужна
  // для будущей координации — кто кого убивает в какой последовательности).
  create({ name, description, accountIds }) {
    if (!name || !name.trim()) throw new Error('Имя группы обязательно')
    const ids = Array.isArray(accountIds) ? accountIds.filter(Boolean) : []
    if (ids.length < 2 || ids.length > 4) {
      throw new Error('В группе должно быть от 2 до 4 аккаунтов')
    }
    const r = db.run(
      `INSERT INTO groups (name, description) VALUES (?, ?)`,
      [name.trim(), (description || '').trim() || null]
    )
    const groupId = r.lastInsertRowid
    this._setAccounts(groupId, ids)
    return { id: groupId }
  }

  update(id, { name, description, accountIds }) {
    const existing = db.get('SELECT id FROM groups WHERE id = ?', [id])
    if (!existing) throw new Error('Группа не найдена')
    const fields = [], values = []
    if (name !== undefined) {
      if (!name || !name.trim()) throw new Error('Имя группы обязательно')
      fields.push('name = ?')
      values.push(name.trim())
    }
    if (description !== undefined) {
      fields.push('description = ?')
      values.push((description || '').trim() || null)
    }
    if (fields.length) {
      values.push(id)
      db.run(`UPDATE groups SET ${fields.join(', ')} WHERE id = ?`, values)
    }
    if (accountIds !== undefined) {
      const ids = Array.isArray(accountIds) ? accountIds.filter(Boolean) : []
      if (ids.length < 2 || ids.length > 4) {
        throw new Error('В группе должно быть от 2 до 4 аккаунтов')
      }
      this._setAccounts(id, ids)
    }
  }

  delete(id) {
    // FK ON DELETE CASCADE подчистит group_accounts — но sql.js по умолчанию
    // не включает foreign keys, страхуемся явным удалением связей.
    db.run('DELETE FROM group_accounts WHERE group_id = ?', [id])
    db.run('DELETE FROM groups WHERE id = ?', [id])
  }

  // Полная замена состава группы. Старые связи удаляются, новые вставляются
  // в порядке передачи (position = индекс в массиве).
  _setAccounts(groupId, accountIds) {
    db.run('DELETE FROM group_accounts WHERE group_id = ?', [groupId])
    accountIds.forEach((accountId, idx) => {
      db.run(
        'INSERT OR IGNORE INTO group_accounts (group_id, account_id, position) VALUES (?, ?, ?)',
        [groupId, accountId, idx]
      )
    })
  }
}

export default new GroupManager()
