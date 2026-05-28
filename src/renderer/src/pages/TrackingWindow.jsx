import { useEffect, useState, useCallback, useRef } from 'react'
import { Shield, ShieldCheck, ShieldOff, Loader, Crosshair, Skull, Trophy, Map as MapIcon, Minus, X, Eye, Activity } from 'lucide-react'

// Отдельное окно отслеживания группы. Открывается через
// window.api.groups.openTracking(groupId) — main process создаёт BrowserWindow
// с hash `#/tracking/<groupId>`. Окно подвижное, поверх можно работать в CS2.
//
// Layout:
//   ┌────────────────────────────────────────────────────────────┐
//   │ TitleBar (drag + min/close)                                │
//   ├────────────────────────────────────────────────────────────┤
//   │ Header: имя группы + счётчики (всего/активны/в матче)      │
//   ├──────────────────────┬───────────────────┬─────────────────┤
//   │ КОЛОНКА 1            │ КОЛОНКА 2         │ КОЛОНКА 3       │
//   │ Статусы и инфо       │ Счёт в матче      │ Мини-карта      │
//   │ о аккаунтах          │ (по каждому боту) │                 │
//   ├──────────────────────┴───────────────────┴─────────────────┤
//   │ ЛОГ событий (статусы, действия, киллы/смерти, и т.д.)      │
//   └────────────────────────────────────────────────────────────┘

const STATUS_BADGE = {
  online: 'badge-green', farming: 'badge-green', lobby: 'badge-blue',
  steam_launching: 'badge-yellow', steam_loading: 'badge-yellow',
  steam_login_form: 'badge-yellow', steam_entering_creds: 'badge-yellow',
  steam_creds_submitted: 'badge-yellow', steam_entering_guard: 'badge-yellow',
  steam_logged_in: 'badge-green', steam_running: 'badge-blue',
  cs2_preparing: 'badge-yellow', cs2_launching: 'badge-yellow',
  cs2_searching: 'badge-yellow', cs2_loading: 'badge-yellow',
  cs2_match_loading: 'badge-yellow', cs2_match: 'badge-green',
  cs2_in_match: 'badge-green', cs2_lobby: 'badge-blue',
  awaiting_guard: 'badge-yellow', queued: 'badge-yellow',
  idle: 'badge-gray', error: 'badge-red', no_prime: 'badge-orange',
}

const STATUS_LABEL = {
  online: 'Онлайн', farming: 'Фармит', lobby: 'В лобби',
  steam_launching: 'Запуск Steam', steam_loading: 'Steam загружается',
  steam_login_form: 'Окно входа Steam', steam_entering_creds: 'Ввод логина',
  steam_creds_submitted: 'Ждёт Steam Guard', steam_entering_guard: 'Ввод Guard',
  steam_logged_in: 'Steam вход выполнен', steam_running: 'В Steam',
  cs2_preparing: 'Подготовка', cs2_launching: 'Запуск CS2',
  cs2_searching: 'Ищет матч', cs2_loading: 'CS2 загружается',
  cs2_match_loading: 'Загрузка матча', cs2_match: 'В матче',
  cs2_in_match: 'В матче', cs2_lobby: 'В лобби',
  awaiting_guard: 'Введи Guard', queued: 'В очереди',
  idle: 'Офлайн', error: 'Ошибка', no_prime: 'Нет Prime',
}

const MATCH_STATUSES = new Set(['cs2_match', 'cs2_in_match'])
const MAX_LOG_ENTRIES = 200

function PrimeIcon({ account }) {
  if (!account.lastLoginAt) return <Shield size={13} className="text-text-muted" />
  if (account.isPrime) return <ShieldCheck size={13} className="text-blue-400" />
  return <ShieldOff size={13} className="text-red-400" />
}

// Точка статуса прокси — те же стили что в Accounts.jsx:
// зелёная = валидный, красная = invalid, серая = прокси не привязан.
function ProxyDot({ proxy }) {
  if (!proxy) {
    return (
      <span
        className="w-1.5 h-1.5 rounded-full bg-text-muted/40 shrink-0"
        title="Без прокси"
      />
    )
  }
  return (
    <span
      className={`w-1.5 h-1.5 rounded-full shrink-0 ${proxy.isValid ? 'bg-green-400' : 'bg-red-400'}`}
      title={proxy.isValid ? 'Прокси работает' : 'Прокси не работает'}
    />
  )
}

// КОЛОНКА 1: строка одного аккаунта со статусом и базовой информацией.
function AccountInfoRow({ account, status }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-bg-card border border-border rounded-md">
      <PrimeIcon account={account} />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-sm text-text-primary truncate">{account.login}</div>
        <div className="flex items-center gap-1.5 text-[10px] text-text-muted font-mono truncate">
          <ProxyDot proxy={account.proxy} />
          {account.proxy ? `${account.proxy.host}:${account.proxy.port}` : 'без прокси'}
        </div>
      </div>
      <span className={`${STATUS_BADGE[status] || 'badge-gray'} shrink-0 text-[10px]`}>
        {STATUS_LABEL[status] || status}
      </span>
    </div>
  )
}

// КОЛОНКА 2: одна строка статистики матча для бота. Параллельна AccountInfoRow.
function MatchStatRow({ account, status, stats }) {
  const inMatch = MATCH_STATUSES.has(status)
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-bg-card border border-border rounded-md min-h-[52px]">
      <span className="font-mono text-xs text-text-muted truncate w-20 shrink-0">
        {account.login}
      </span>
      {inMatch && stats ? (
        <div className="flex items-center gap-3 text-xs flex-1 justify-end">
          <span className="flex items-center gap-1 text-green-400" title="Киллы">
            <Crosshair size={12} /> {stats.kills ?? 0}
          </span>
          <span className="flex items-center gap-1 text-red-400" title="Смерти">
            <Skull size={12} /> {stats.deaths ?? 0}
          </span>
          <span className="flex items-center gap-1 text-blue-400" title="Ассисты">
            <Activity size={12} /> {stats.assists ?? 0}
          </span>
          {stats.score && (
            <span
              className="flex items-center gap-1 text-yellow-400 font-mono ml-1"
              title="Счёт CT:T"
            >
              <Trophy size={12} /> {stats.score.ct}:{stats.score.t}
            </span>
          )}
        </div>
      ) : (
        <span className="ml-auto text-[11px] text-text-muted">не в матче</span>
      )}
    </div>
  )
}

// Лог событий: статусы, действия, киллы/смерти. Прокручивается, новые сверху.
function EventLog({ entries }) {
  const scrollRef = useRef(null)
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [entries.length])

  if (entries.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-text-muted text-xs">
        Лог пуст. События появятся при запуске группы.
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto font-mono text-[11px] space-y-0.5 p-1">
      {entries.map((e, i) => (
        <div key={i} className="flex gap-2 px-2 py-1 hover:bg-bg-hover/30 rounded">
          <span className="text-text-muted shrink-0">{e.time}</span>
          <span className="text-blue-400 shrink-0 w-20 truncate">{e.login}</span>
          <span className={`shrink-0 w-14 text-[10px] ${
            e.kind === 'error'  ? 'text-red-400'    :
            e.kind === 'match'  ? 'text-yellow-400' :
            e.kind === 'status' ? 'text-text-muted' : 'text-text-secondary'
          }`}>
            {e.kind}
          </span>
          <span className="text-text-secondary flex-1 truncate">{e.text}</span>
        </div>
      ))}
    </div>
  )
}

function ColumnHeader({ icon: Icon, title, subtitle }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-bg-secondary/40">
      <Icon size={13} className="text-purple-400" />
      <div className="min-w-0">
        <div className="text-xs font-semibold text-text-primary uppercase tracking-wider">{title}</div>
        {subtitle && <div className="text-[10px] text-text-muted">{subtitle}</div>}
      </div>
    </div>
  )
}

export default function TrackingWindow({ groupId }) {
  const [group, setGroup]               = useState(null)
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState('')
  const [workerStatuses, setStatuses]   = useState({})
  const [matchStats, setMatchStats]     = useState({}) // accountId → { kills, deaths, assists, score }
  const [logEntries, setLogEntries]     = useState([])

  // Чтобы handler onStatus имел свежий список аккаунтов группы и не
  // ловил лишних — храним в ref id-шники аккаунтов группы.
  const groupAccountIdsRef = useRef(new Set())

  const appendLog = useCallback((accountId, kind, text) => {
    const acc = groupAccountIdsRef.current
    if (!acc.has(accountId)) return
    const time = new Date().toLocaleTimeString('ru-RU', { hour12: false })
    setLogEntries(prev => {
      const next = [
        { time, accountId, login: `#${accountId}`, kind, text },
        ...prev,
      ]
      return next.slice(0, MAX_LOG_ENTRIES)
    })
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    const g = await window.api.groups.get(Number(groupId))
    if (!g) {
      setError('Группа не найдена. Возможно, она была удалена.')
      setLoading(false)
      return
    }
    setGroup(g)
    groupAccountIdsRef.current = new Set(g.accounts.map(a => a.id))
    setLoading(false)
  }, [groupId])

  useEffect(() => {
    load()
    window.api.farm.statuses().then(s => setStatuses(s || {}))

    window.api.farm.onStatus(({ accountId, status, message }) => {
      setStatuses(prev => ({ ...prev, [accountId]: { status, message } }))
      const label = STATUS_LABEL[status] || status
      appendLog(accountId, 'status', message ? `${label} — ${message}` : label)
    })
    window.api.farm.onError(({ accountId, message }) => {
      setStatuses(prev => ({ ...prev, [accountId]: { status: 'error', message } }))
      appendLog(accountId, 'error', message || 'ошибка')
    })
    window.api.farm.onDrop(({ accountId, item }) => {
      appendLog(accountId, 'drop', `дроп: ${item?.name || 'предмет'}`)
    })

    return () => window.api.farm.offAll()
  }, [load, appendLog])

  // Обновляем логин в логах когда group загрузилась (заменяем "#id" на реальный логин).
  useEffect(() => {
    if (!group) return
    const byId = new Map(group.accounts.map(a => [a.id, a.login]))
    setLogEntries(prev => prev.map(e => ({
      ...e,
      login: byId.get(e.accountId) || e.login,
    })))
  }, [group])

  const getStatus = (account) =>
    workerStatuses[account.id]?.status ?? account.status ?? 'idle'

  if (loading) {
    return (
      <div className="flex flex-col h-screen bg-bg-primary text-text-primary">
        <TrackingTitleBar title="Загрузка..." />
        <div className="flex-1 flex items-center justify-center">
          <Loader size={20} className="animate-spin text-text-muted" />
        </div>
      </div>
    )
  }

  if (error || !group) {
    return (
      <div className="flex flex-col h-screen bg-bg-primary text-text-primary">
        <TrackingTitleBar title="Ошибка" />
        <div className="flex-1 flex items-center justify-center p-6 text-center">
          <p className="text-sm text-red-400">{error || 'Не удалось загрузить группу'}</p>
        </div>
      </div>
    )
  }

  const activeBots = group.accounts.filter(a => {
    const s = getStatus(a)
    return s !== 'idle' && s !== 'error'
  }).length
  const inMatchBots = group.accounts.filter(a => MATCH_STATUSES.has(getStatus(a))).length

  return (
    <div className="flex flex-col h-screen bg-bg-primary text-text-primary overflow-hidden">
      <TrackingTitleBar title={`Отслеживание · ${group.name}`} />

      {/* Header группы */}
      <div className="px-4 py-2 border-b border-border bg-bg-secondary/30 shrink-0">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-sm font-semibold truncate">{group.name}</h1>
            {group.description && (
              <p className="text-[11px] text-text-muted truncate">{group.description}</p>
            )}
          </div>
          <div className="flex gap-4 text-xs text-text-muted shrink-0">
            <span>Аккаунтов: <span className="text-text-primary font-medium">{group.accounts.length}</span></span>
            <span>Активны: <span className="text-green-400 font-medium">{activeBots}</span></span>
            <span>В матче: <span className="text-blue-400 font-medium">{inMatchBots}</span></span>
          </div>
        </div>
      </div>

      {/* 3 колонки */}
      <div className="flex flex-1 overflow-hidden">
        {/* КОЛОНКА 1: Статусы и информация о аккаунтах (главная, шире) */}
        <div className="flex-[2] min-w-0 border-r border-border flex flex-col">
          <ColumnHeader
            icon={Eye}
            title="Аккаунты"
            subtitle="Статусы и информация"
          />
          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {group.accounts.map(a => (
              <AccountInfoRow key={a.id} account={a} status={getStatus(a)} />
            ))}
            {group.accounts.length === 0 && (
              <div className="text-center text-text-muted text-xs py-4">
                В группе нет аккаунтов
              </div>
            )}
          </div>
        </div>

        {/* КОЛОНКА 2: Счёт в матче */}
        <div className="flex-1 min-w-0 border-r border-border flex flex-col">
          <ColumnHeader
            icon={Trophy}
            title="Матч"
            subtitle="Киллы · смерти · счёт"
          />
          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {group.accounts.map(a => (
              <MatchStatRow
                key={a.id}
                account={a}
                status={getStatus(a)}
                stats={matchStats[a.id]}
              />
            ))}
          </div>
        </div>

        {/* КОЛОНКА 3: Мини-карта */}
        <div className="flex-1 min-w-0 flex flex-col">
          <ColumnHeader
            icon={MapIcon}
            title="Мини-карта"
            subtitle="Передвижение ботов"
          />
          <div className="flex-1 flex flex-col items-center justify-center p-4 text-center gap-2">
            <div className="p-4 rounded-full bg-bg-hover">
              <MapIcon size={28} className="text-text-muted" />
            </div>
            <p className="text-xs text-text-muted">
              Интеграция мини-карты CS2 будет добавлена в последнюю очередь —
              когда координация ботов будет работать стабильно.
            </p>
          </div>
        </div>
      </div>

      {/* Лог снизу */}
      <div className="border-t border-border bg-bg-secondary/20 shrink-0 h-48 flex flex-col">
        <ColumnHeader icon={Activity} title="Лог" subtitle="События ботов: статусы, дропы, ошибки" />
        <div className="flex-1 min-h-0">
          <EventLog entries={logEntries} />
        </div>
      </div>
    </div>
  )
}

// Кастомный TitleBar для tracking-окна. Drag-зона + кнопки минимизации/закрытия.
function TrackingTitleBar({ title }) {
  return (
    <div className="titlebar-drag flex items-center justify-between h-9 bg-bg-secondary border-b border-border px-3 shrink-0">
      <div className="flex items-center gap-2 titlebar-nodrag min-w-0">
        <Eye size={12} className="text-purple-400 shrink-0" />
        <span className="text-xs font-medium text-text-primary truncate">{title}</span>
      </div>
      <div className="titlebar-nodrag flex items-center">
        <button
          onClick={() => window.api.window.minimize()}
          className="w-8 h-9 flex items-center justify-center hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
        >
          <Minus size={12} />
        </button>
        <button
          onClick={() => window.api.window.close()}
          className="w-8 h-9 flex items-center justify-center hover:bg-red-600 text-text-secondary hover:text-white transition-colors"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  )
}
