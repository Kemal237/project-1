import { useEffect, useState } from 'react'
import { Package, RefreshCw } from 'lucide-react'

export default function Drops() {
  const [drops, setDrops]       = useState([])
  const [stats, setStats]       = useState(null)
  const [accounts, setAccounts] = useState([])

  const load = async () => {
    const [d, s, a] = await Promise.all([
      window.api.drops.getAll(),
      window.api.drops.getStats(),
      window.api.accounts.getAll(),
    ])
    setDrops(d)
    setStats(s)
    setAccounts(a)
  }

  useEffect(() => { load() }, [])

  // Sort accounts by total drops desc, then by login
  const sortedAccounts = [...accounts].sort((a, b) =>
    (b.dropsTotal || 0) - (a.dropsTotal || 0) || a.login.localeCompare(b.login)
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Дропы</h1>
          <p className="text-text-secondary text-sm mt-0.5">
            Всего: {stats?.total?.count || 0} · Доход: ${stats?.total?.revenue?.toFixed(2) || '0.00'}
          </p>
        </div>
        <button className="btn-ghost" onClick={load}><RefreshCw size={14} /></button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="card">
          <p className="text-text-muted text-xs mb-1">За эту неделю</p>
          <p className="text-2xl font-bold text-green-400">{stats?.thisWeek?.count || 0}</p>
          <p className="text-text-muted text-xs">${stats?.thisWeek?.revenue?.toFixed(2) || '0.00'}</p>
        </div>
        <div className="card">
          <p className="text-text-muted text-xs mb-1">Всего за всё время</p>
          <p className="text-2xl font-bold text-text-primary">{stats?.total?.count || 0}</p>
          <p className="text-text-muted text-xs">${stats?.total?.revenue?.toFixed(2) || '0.00'}</p>
        </div>
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <p className="text-sm font-medium text-text-primary">Статистика по аккаунтам</p>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-text-muted text-xs">
              <th className="px-4 py-3 text-left">Логин</th>
              <th className="px-4 py-3 text-right">За неделю</th>
              <th className="px-4 py-3 text-right">Всего</th>
              <th className="px-4 py-3 text-right">Последний дроп</th>
            </tr>
          </thead>
          <tbody>
            {sortedAccounts.map(a => (
              <tr key={a.id} className="border-b border-border/50 hover:bg-bg-hover/50 transition-colors">
                <td className="px-4 py-3 font-mono text-text-primary">{a.login}</td>
                <td className="px-4 py-3 text-right font-medium text-green-400">{a.dropsThisWeek || 0}</td>
                <td className="px-4 py-3 text-right text-text-secondary">{a.dropsTotal || 0}</td>
                <td className="px-4 py-3 text-right text-text-muted text-xs">
                  {a.lastDropAt ? new Date(a.lastDropAt).toLocaleString('ru') : '—'}
                </td>
              </tr>
            ))}
            {sortedAccounts.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-text-muted">
                  Аккаунтов нет
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <p className="text-sm font-medium text-text-primary">История дропов</p>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-text-muted text-xs">
              <th className="px-4 py-3 text-left">Предмет</th>
              <th className="px-4 py-3 text-left">Аккаунт</th>
              <th className="px-4 py-3 text-left">Тип</th>
              <th className="px-4 py-3 text-right">Цена</th>
              <th className="px-4 py-3 text-right">Дата</th>
            </tr>
          </thead>
          <tbody>
            {drops.map(d => (
              <tr key={d.id} className="border-b border-border/50 hover:bg-bg-hover/50 transition-colors">
                <td className="px-4 py-3 text-text-primary flex items-center gap-2">
                  <Package size={14} className="text-yellow-400 shrink-0" />
                  {d.item_name}
                </td>
                <td className="px-4 py-3 font-mono text-text-secondary text-xs">{d.account_login}</td>
                <td className="px-4 py-3">
                  <span className="badge-gray">{d.item_type || 'Case'}</span>
                </td>
                <td className="px-4 py-3 text-right text-green-400 font-medium">
                  {d.market_price > 0 ? `$${d.market_price.toFixed(2)}` : '—'}
                </td>
                <td className="px-4 py-3 text-right text-text-muted text-xs">
                  {new Date(d.dropped_at).toLocaleString('ru')}
                </td>
              </tr>
            ))}
            {drops.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-text-muted">
                  Дропов пока нет
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
