import { useEffect, useState } from 'react'
import { Package, RefreshCw } from 'lucide-react'

export default function Drops() {
  const [drops, setDrops] = useState([])
  const [stats, setStats] = useState(null)

  const load = async () => {
    const [d, s] = await Promise.all([window.api.drops.getAll(), window.api.drops.getStats()])
    setDrops(d)
    setStats(s)
  }

  useEffect(() => { load() }, [])

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

      <div className="grid grid-cols-2 gap-4 mb-2">
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
