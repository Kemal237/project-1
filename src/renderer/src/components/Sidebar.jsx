import {
  LayoutDashboard, Users, Layers, Package, Globe, Settings, ChevronRight
} from 'lucide-react'

const NAV = [
  { id: 'dashboard', label: 'Dashboard',  icon: LayoutDashboard },
  { id: 'accounts',  label: 'Аккаунты',   icon: Users },
  { id: 'farm',      label: 'Фарм группы', icon: Layers },
  { id: 'drops',     label: 'Дропы',       icon: Package },
  { id: 'proxies',   label: 'Прокси',      icon: Globe },
]

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

      <div className="px-2 pb-3 border-t border-border pt-3">
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
