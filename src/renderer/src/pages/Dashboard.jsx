import { useEffect, useState } from 'react'
import { Users, Package, TrendingUp, Wifi } from 'lucide-react'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

function StatCard({ icon: Icon, label, value, sub, color = 'blue' }) {
  const colors = {
    blue:   'text-blue-400 bg-blue-400/10',
    green:  'text-green-400 bg-green-400/10',
    yellow: 'text-yellow-400 bg-yellow-400/10',
    purple: 'text-purple-400 bg-purple-400/10',
  }
  return (
    <div className="card flex items-start gap-4">
      <div className={`p-2.5 rounded-lg ${colors[color]}`}>
        <Icon size={20} />
      </div>
      <div>
        <p className="text-text-secondary text-xs mb-1">{label}</p>
        <p className="text-2xl font-bold text-text-primary">{value}</p>
        {sub && <p className="text-xs text-text-muted mt-0.5">{sub}</p>}
      </div>
    </div>
  )
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-bg-card border border-border rounded-md px-3 py-2 text-xs">
      <p className="text-text-secondary mb-1">{label}</p>
      <p className="text-blue-400 font-medium">{payload[0].value} дропов</p>
    </div>
  )
}

const ACTIVE_STATUSES = new Set(['online', 'farming', 'lobby', 'cs2_launching', 'cs2_searching', 'cs2_loading', 'cs2_match', 'connecting', 'reconnecting', 'awaiting_guard'])

export default function Dashboard() {
  const [stats, setStats]       = useState(null)
  const [accounts, setAccounts] = useState([])
  const [workerStatuses, setWorkerStatuses] = useState({})

  useEffect(() => {
    Promise.all([
      window.api.drops.getStats(),
      window.api.accounts.getAll(),
      window.api.farm.statuses(),
    ]).then(([s, a, ws]) => {
      setStats(s)
      setAccounts(a)
      setWorkerStatuses(ws || {})
    })

    window.api.farm.onStatus(({ accountId, status }) => {
      setWorkerStatuses(prev => ({ ...prev, [accountId]: { status } }))
    })
    return () => window.api.farm.offAll()
  }, [])

  const getStatus = (a) => workerStatuses[a.id]?.status ?? a.status
  const online    = accounts.filter(a => ACTIVE_STATUSES.has(getStatus(a))).length
  const total     = accounts.length
  const thisWeek = stats?.thisWeek?.count || 0
  const revenue  = stats?.thisWeek?.revenue?.toFixed(2) || '0.00'

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">Dashboard</h1>
        <p className="text-text-secondary text-sm mt-0.5">Общая статистика фермы</p>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <StatCard icon={Users}      label="Всего аккаунтов"  value={total}         sub={`${online} онлайн`}         color="blue" />
        <StatCard icon={Wifi}       label="Активны сейчас"   value={online}        sub="в процессе фарма"           color="green" />
        <StatCard icon={Package}    label="Дропов за неделю" value={thisWeek}      sub="Care Packages"              color="yellow" />
        <StatCard icon={TrendingUp} label="Доход за неделю"  value={`$${revenue}`} sub="по рыночным ценам"          color="purple" />
      </div>

      <div className="card">
        <p className="text-sm font-medium text-text-primary mb-4">Дропы за 30 дней</p>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={stats?.byDay || []}>
            <defs>
              <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#1f6feb" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#1f6feb" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="date" tick={{ fill: '#7d8590', fontSize: 11 }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fill: '#7d8590', fontSize: 11 }} tickLine={false} axisLine={false} width={30} />
            <Tooltip content={<CustomTooltip />} />
            <Area type="monotone" dataKey="count" stroke="#1f6feb" strokeWidth={2} fill="url(#grad)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="card">
          <p className="text-sm font-medium text-text-primary mb-3">Статус аккаунтов</p>
          <div className="space-y-2">
            {[
              { label: 'Онлайн',        key: 'online',         cls: 'badge-green'  },
              { label: 'Фармит',        key: 'farming',        cls: 'badge-green'  },
              { label: 'В лобби',       key: 'lobby',          cls: 'badge-blue'   },
              { label: 'В матче',       key: 'cs2_match',      cls: 'badge-green'  },
              { label: 'Запуск Steam',  key: 'cs2_launching',  cls: 'badge-yellow' },
              { label: 'Ищет матч',     key: 'cs2_searching',  cls: 'badge-yellow' },
              { label: 'Загрузка...',   key: 'cs2_loading',    cls: 'badge-yellow' },
              { label: 'Подключение',   key: 'connecting',     cls: 'badge-yellow' },
              { label: 'Реконнект',     key: 'reconnecting',   cls: 'badge-yellow' },
              { label: 'Ввод кода',     key: 'awaiting_guard', cls: 'badge-yellow' },
              { label: 'Офлайн',        key: 'idle',           cls: 'badge-gray'   },
              { label: 'Нет Prime',     key: 'no_prime',       cls: 'badge-orange' },
              { label: 'Ошибка',        key: 'error',          cls: 'badge-red'    },
              { label: 'Забанен',       key: 'banned',         cls: 'badge-red'    },
            ].map(({ label, key, cls }) => {
              const count = accounts.filter(a => getStatus(a) === key).length
              if (count === 0) return null
              return (
                <div key={key} className="flex items-center justify-between">
                  <span className="text-text-secondary text-sm">{label}</span>
                  <span className={cls}>{count}</span>
                </div>
              )
            })}
          </div>
        </div>

        <div className="card">
          <p className="text-sm font-medium text-text-primary mb-3">Топ аккаунтов</p>
          <div className="space-y-2">
            {(stats?.topAccounts || []).slice(0, 5).map((a, i) => (
              <div key={i} className="flex items-center justify-between">
                <span className="text-text-secondary text-sm font-mono truncate max-w-[140px]">{a.login}</span>
                <span className="text-green-400 text-sm font-medium">{a.drops} дропов</span>
              </div>
            ))}
            {!stats?.topAccounts?.length && (
              <p className="text-text-muted text-sm">Дропов пока нет</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
