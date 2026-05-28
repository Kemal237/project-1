import { useState } from 'react'
import {
  LayoutDashboard, Users, Layers, Package, Globe, Settings, ChevronRight,
  Zap, Loader, CheckCircle
} from 'lucide-react'

const NAV = [
  { id: 'dashboard', label: 'Dashboard',  icon: LayoutDashboard },
  { id: 'accounts',  label: 'Аккаунты',   icon: Users },
  { id: 'farm',      label: 'Фарм группы', icon: Layers },
  { id: 'drops',     label: 'Дропы',       icon: Package },
  { id: 'proxies',   label: 'Прокси',      icon: Globe },
]

// Кнопка экстренной остановки — убивает все процессы Steam/CS2 в Sandboxie.
// Раньше жила в Настройках, но это аварийный action и удобнее иметь её всегда
// под рукой в сайдбаре (а не идти на отдельную страницу).
function KillAllButton() {
  const [killing, setKilling] = useState(false)
  const [done,    setDone]    = useState(false)

  const killAll = async () => {
    if (killing) return
    setKilling(true)
    setDone(false)
    await window.api.sandboxie.killAll()
    setKilling(false)
    setDone(true)
    setTimeout(() => setDone(false), 3000)
  }

  return (
    <button
      onClick={killAll}
      disabled={killing}
      title="Убить все процессы Steam и CS2 в боксах Sandboxie"
      className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium
                 text-red-400 hover:bg-red-500/10 hover:text-red-300
                 transition-colors duration-100 disabled:opacity-50"
    >
      {killing
        ? <Loader size={16} className="shrink-0 animate-spin" />
        : done
          ? <CheckCircle size={16} className="shrink-0 text-green-400" />
          : <Zap size={16} className="shrink-0" />}
      <span className="flex-1 text-left">
        {killing ? 'Останавливаю...' : done ? 'Остановлено' : 'Принудительная остановка'}
      </span>
    </button>
  )
}

export default function Sidebar({ active, onNavigate }) {
  return (
    <aside className="w-52 bg-bg-secondary border-r border-border flex flex-col shrink-0">
      <nav className="flex-1 py-3 space-y-0.5 px-2">
        {NAV.map(({ id, label, icon: Icon }) => {
          const isActive = active === id
          return (
            <button
              key={id}
              onClick={() => onNavigate(id)}
              className={`
                w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium
                transition-colors duration-100 group
                ${isActive
                  ? 'bg-accent-blue/15 text-blue-400'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'}
              `}
            >
              <Icon size={16} className="shrink-0" />
              <span className="flex-1 text-left">{label}</span>
              {isActive && <ChevronRight size={12} className="text-blue-400" />}
            </button>
          )
        })}
      </nav>

      <div className="px-2 pb-3 border-t border-border pt-3 space-y-0.5">
        <KillAllButton />
        <button
          onClick={() => onNavigate('settings')}
          className={`
            w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium
            transition-colors duration-100
            ${active === 'settings'
              ? 'bg-accent-blue/15 text-blue-400'
              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'}
          `}
        >
          <Settings size={16} />
          <span>Настройки</span>
        </button>
      </div>
    </aside>
  )
}
