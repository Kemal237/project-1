import { useEffect, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Layers, Play, Pencil, Trash2, Search, Shield, ShieldCheck, ShieldOff, AlertTriangle, Loader, Square, Eye, UserPlus, Users, LayoutGrid } from 'lucide-react'

// Все модалки FarmGroups рендерятся через Portal в document.body чтобы
// перекрывать TitleBar (у которого -webkit-app-region: drag создаёт
// собственный stacking-context и обычная z-50 не покрывает его).
function ModalPortal({ children, onClose }) {
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      {children}
    </div>,
    document.body
  )
}

// Иконки prime/прокси — те же что в разделе "Аккаунты" для единообразия.
// Prime: серый Shield (вход ещё не делали), синий ShieldCheck (есть), красный ShieldOff (нет)
// Proxy: цветная точка (зелёная если valid, красная если invalid, серая если нет прокси)
function PrimeIcon({ account, size = 13 }) {
  if (!account.lastLoginAt) {
    return <Shield size={size} className="text-text-muted" />
  }
  if (account.isPrime) {
    return <ShieldCheck size={size} className="text-blue-400" />
  }
  return <ShieldOff size={size} className="text-red-400" />
}

function ProxyDot({ proxy }) {
  if (!proxy) {
    return <span className="w-1.5 h-1.5 rounded-full bg-text-muted/40 shrink-0" />
  }
  return (
    <span
      className={`w-1.5 h-1.5 rounded-full shrink-0 ${proxy.isValid ? 'bg-green-400' : 'bg-red-400'}`}
    />
  )
}

const MIN_ACCOUNTS = 2
const MAX_ACCOUNTS = 4

// Бейдж аккаунта в карточке группы: компактный вид с иконками prime и proxy
// (те же что в разделе Аккаунты).
function AccountBadge({ account }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-bg-hover text-xs">
      <span className="font-mono text-text-primary truncate max-w-[90px]">{account.login}</span>
      <div className="flex items-center gap-1.5 shrink-0">
        <PrimeIcon account={account} size={12} />
        <ProxyDot proxy={account.proxy} />
      </div>
    </div>
  )
}

// Модалка создания/редактирования группы. Принимает initial=null для создания,
// initial={group} для редактирования. Чекбокс-список аккаунтов с поиском.
function GroupEditorModal({ initial, accounts, onSave, onClose }) {
  const [name, setName] = useState(initial?.name || '')
  const [description, setDescription] = useState(initial?.description || '')
  const [selected, setSelected] = useState(
    new Set((initial?.accounts || []).map(a => a.id))
  )
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const isEdit = !!initial
  const filtered = accounts.filter(a =>
    a.login.toLowerCase().includes(search.toLowerCase())
  )

  const toggle = (id) => setSelected(s => {
    const next = new Set(s)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  const selectedAccounts = accounts.filter(a => selected.has(a.id))
  const noPrimeCount     = selectedAccounts.filter(a => !a.isPrime).length

  const canSave =
    name.trim().length > 0 &&
    selected.size >= MIN_ACCOUNTS &&
    selected.size <= MAX_ACCOUNTS &&
    !saving

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setError('')
    const payload = {
      name: name.trim(),
      description: description.trim(),
      accountIds: [...selected],
    }
    const result = isEdit
      ? await window.api.groups.update(initial.id, payload)
      : await window.api.groups.create(payload)
    setSaving(false)
    if (!result?.ok) {
      setError(result?.error || 'Не удалось сохранить группу')
      return
    }
    onSave()
  }

  return (
    <ModalPortal onClose={onClose}>
      <div
        className="card w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-text-primary">
          {isEdit ? 'Редактировать группу' : 'Создать группу'}
        </h2>

        <div className="space-y-3">
          <div>
            <label className="label">Название *</label>
            <input
              className="input"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Например: 4 на Boyard"
              autoFocus
            />
          </div>
          <div>
            <label className="label">Описание</label>
            <input
              className="input"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Необязательно"
            />
          </div>
          <div>
            <label className="label flex items-center justify-between">
              <span>Аккаунты * <span className="text-text-muted text-[10px]">({MIN_ACCOUNTS}–{MAX_ACCOUNTS})</span></span>
              <span className={`text-xs ${
                selected.size < MIN_ACCOUNTS || selected.size > MAX_ACCOUNTS
                  ? 'text-red-400' : 'text-green-400'
              }`}>
                Выбрано: {selected.size}
              </span>
            </label>
            <div className="relative mb-2">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                className="input pl-9 text-xs"
                placeholder="Поиск аккаунта..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <div className="border border-border rounded-md max-h-56 overflow-y-auto">
              {filtered.length === 0 && (
                <div className="px-3 py-4 text-center text-text-muted text-xs">
                  {accounts.length === 0 ? 'Сначала добавь аккаунты' : 'Ничего не найдено'}
                </div>
              )}
              {filtered.map(a => {
                const isSelected = selected.has(a.id)
                const overLimit  = !isSelected && selected.size >= MAX_ACCOUNTS
                return (
                  <label
                    key={a.id}
                    className={`flex items-center gap-3 px-3 py-2 border-b border-border/40 last:border-b-0 cursor-pointer transition-colors ${
                      isSelected ? 'bg-blue-500/10' : 'hover:bg-bg-hover'
                    } ${overLimit ? 'opacity-40 cursor-not-allowed' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={overLimit}
                      onChange={() => toggle(a.id)}
                    />
                    <span className="font-mono text-sm text-text-primary truncate flex-1">{a.login}</span>
                    <PrimeIcon account={a} size={14} />
                    <div className="flex items-center gap-1.5 text-xs text-text-muted font-mono w-32 truncate">
                      <ProxyDot proxy={a.proxy} />
                      {a.proxy ? `${a.proxy.host}:${a.proxy.port}` : '—'}
                    </div>
                  </label>
                )
              })}
            </div>
          </div>

          {noPrimeCount > 0 && (
            <div className="flex items-start gap-2 px-3 py-2 bg-yellow-500/10 border border-yellow-500/30 rounded-md">
              <AlertTriangle size={14} className="text-yellow-400 mt-0.5 shrink-0" />
              <div className="text-xs text-yellow-200/90">
                Выбрано аккаунтов без Prime: <span className="font-medium">{noPrimeCount}</span>.
                Они не получат XP в матче Valve. Можно продолжить — но фарм
                будет идти только для prime-аккаунтов в группе.
              </div>
            </div>
          )}

          {selected.size > MAX_ACCOUNTS && (
            <div className="text-xs text-red-400">
              Максимум {MAX_ACCOUNTS} аккаунта в группе
            </div>
          )}

          {error && (
            <div className="text-xs text-red-400 bg-red-400/10 rounded px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>
            Отмена
          </button>
          <button className="btn-primary" onClick={save} disabled={!canSave}>
            {saving ? <Loader size={13} className="animate-spin" /> : null}
            {isEdit ? 'Сохранить' : 'Создать'}
          </button>
        </div>
      </div>
    </ModalPortal>
  )
}

// Карточка одной группы в списке: имя, описание, аккаунты, кнопки действий.
// Кнопки: Запустить/Стоп, Отслеживать (открывает отдельное окно), Редактировать, Удалить.
// isRunning=true → зелёная обводка + бейдж "Онлайн" сверху по центру.
function GroupCard({ group, onLaunch, onTrack, onEdit, onDelete, onFriend, friending, onGather, isRunning }) {
  const [gathering, setGathering] = useState(false)

  const handleGatherClick = async () => {
    setGathering(true)
    try {
      await onGather(group)
    } finally {
      setGathering(false)
    }
  }

  const noPrimeCount = group.accounts.filter(a => !a.isPrime).length
  return (
    <div className={`card p-4 space-y-3 transition-colors relative ${
      isRunning
        ? 'border-green-500/70 shadow-[0_0_0_1px_rgba(34,197,94,0.5)] hover:border-green-500'
        : 'hover:border-blue-500/40'
    }`}>
      {isRunning && (
        <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-green-600 text-white shadow-md uppercase tracking-wider">
          ● Онлайн
        </span>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Layers size={14} className="text-blue-400 shrink-0" />
            <h3 className="text-base font-semibold text-text-primary truncate">{group.name}</h3>
          </div>
          {group.description && (
            <p className="text-xs text-text-muted mt-1 line-clamp-2">{group.description}</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {isRunning ? (
            <button
              className="btn-ghost p-1.5"
              title="Остановить группу"
              onClick={() => onLaunch(group, true)}
            >
              <Square size={13} className="text-red-400" />
            </button>
          ) : (
            <button
              className="btn-ghost p-1.5"
              title="Запустить группу"
              onClick={() => onLaunch(group, false)}
            >
              <Play size={13} className="text-green-400" />
            </button>
          )}
          <button
            className="btn-ghost p-1.5"
            title="Отслеживать (откроется отдельное окно)"
            onClick={() => onTrack(group)}
          >
            <Eye size={13} className="text-purple-400" />
          </button>
          <button
            className="btn-ghost p-1.5"
            title="Подружить аккаунты группы (Steam, в фоне)"
            onClick={() => onFriend(group)}
            disabled={friending}
          >
            {friending
              ? <Loader size={13} className="animate-spin text-blue-400" />
              : <UserPlus size={13} className="text-blue-400" />}
          </button>
          <button
            className="btn-ghost p-1.5"
            title="Собрать ботов в пати (Wingman)"
            onClick={handleGatherClick}
            disabled={gathering}
          >
            {gathering
              ? <Loader size={13} className="animate-spin text-orange-400" />
              : <Users size={13} className="text-orange-400" />}
          </button>
          <button className="btn-ghost p-1.5" title="Редактировать" onClick={() => onEdit(group)}>
            <Pencil size={13} className="text-text-muted" />
          </button>
          <button className="btn-ghost p-1.5" title="Удалить" onClick={() => onDelete(group)}>
            <Trash2 size={13} className="text-red-400" />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {group.accounts.length === 0 && (
          <span className="text-xs text-text-muted">Нет аккаунтов</span>
        )}
        {group.accounts.map(a => (
          <AccountBadge key={a.id} account={a} />
        ))}
      </div>

      {noPrimeCount > 0 && (
        <div className="flex items-center gap-1.5 text-[11px] text-yellow-400/90">
          <AlertTriangle size={11} />
          <span>{noPrimeCount} без Prime — не получат XP</span>
        </div>
      )}
    </div>
  )
}

// Модалка-блокер при попытке запустить группу, аккаунты которой уже заняты
// (запущены из Accounts или из другой группы). Параллельный ввод данных в
// две Steam-формы одновременно невозможен — сначала надо остановить занятые.
function GroupConflictModal({ group, busyAccounts, onClose }) {
  return (
    <ModalPortal onClose={onClose}>
      <div className="card w-full max-w-md p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-text-primary">
          Аккаунты группы уже запущены
        </h2>
        <div className="text-sm text-text-secondary space-y-2">
          <p>
            Группу <span className="text-text-primary font-medium">«{group.name}»</span>{' '}
            нельзя запустить — следующие аккаунты уже работают:
          </p>
          <ul className="space-y-1 max-h-40 overflow-y-auto">
            {busyAccounts.map((a, i) => (
              <li key={i} className="flex items-center justify-between px-3 py-1.5 bg-bg-hover rounded-md">
                <span className="font-mono text-text-primary text-xs">{a.login}</span>
                <span className="text-xs text-yellow-400">{a.status}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-text-muted">
            Остановите их (в разделе «Аккаунты» или в окне отслеживания
            другой группы) и попробуйте снова.
          </p>
        </div>
        <div className="flex justify-end">
          <button className="btn-primary" onClick={onClose}>Понятно</button>
        </div>
      </div>
    </ModalPortal>
  )
}

// Простое модальное подтверждение удаления.
function ConfirmDeleteModal({ group, onCancel, onConfirm }) {
  return (
    <ModalPortal onClose={onCancel}>
      <div className="card w-full max-w-sm p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-text-primary">Удалить группу?</h2>
        <p className="text-sm text-text-secondary">
          Группа <span className="text-text-primary font-medium">«{group.name}»</span> будет
          удалена. Аккаунты сами останутся — удалится только их связь с группой.
        </p>
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onCancel}>Отмена</button>
          <button className="btn-danger" onClick={onConfirm}>Удалить</button>
        </div>
      </div>
    </ModalPortal>
  )
}

// Модалка ввода кода Steam Guard для friend-сессии (аккаунты без maFile).
// domain != null — код из email; иначе — код из приложения Steam Mobile.
function FriendGuardModal({ login, domain, onSubmit, onClose }) {
  const [code, setCode] = useState('')
  const submit = () => { const c = code.trim(); if (c) onSubmit(c) }
  return (
    <ModalPortal onClose={onClose}>
      <div className="card w-full max-w-sm p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-text-primary">Код Steam Guard</h2>
        <p className="text-sm text-text-secondary">
          Аккаунт <span className="text-text-primary font-medium">«{login}»</span>:{' '}
          {domain
            ? <>введи код из письма на <span className="text-text-primary">{domain}</span>.</>
            : <>введи текущий код из приложения <span className="text-text-primary">Steam Mobile</span>.</>}
        </p>
        <input
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          placeholder="XXXXX"
          maxLength={10}
          className="input w-full text-center tracking-[0.4em] font-mono text-lg uppercase"
        />
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Отмена</button>
          <button className="btn-primary" onClick={submit} disabled={!code.trim()}>Подтвердить</button>
        </div>
      </div>
    </ModalPortal>
  )
}

// Статусы которые считаются "идёт авто-вход" — пока хотя бы один аккаунт из
// другой группы в этих статусах, нельзя запускать вторую группу с тем же
// аккаунтом (параллельный ввод невозможен) и нельзя из Accounts тоже.
const LOGIN_IN_PROGRESS_STATUSES = new Set([
  'cs2_preparing', 'queued', 'steam_launching', 'steam_loading',
  'steam_login_form', 'steam_entering_creds', 'steam_creds_submitted',
  'steam_entering_guard', 'awaiting_guard',
])
// Статусы при которых аккаунт считается "запущен в составе группы"
// (для подсветки Stop-кнопки на карточке).
const GROUP_RUNNING_STATUSES = new Set([
  ...LOGIN_IN_PROGRESS_STATUSES,
  'steam_logged_in', 'steam_running',
  'cs2_launching', 'cs2_loading', 'cs2_match_loading', 'cs2_match',
  'cs2_in_match', 'cs2_lobby', 'cs2_searching',
])

export default function FarmGroups() {
  const [groups, setGroups]       = useState([])
  const [accounts, setAccounts]   = useState([])
  const [loading, setLoading]     = useState(true)
  const [editing, setEditing]     = useState(null)   // { initial: null|group } или null
  const [deleting, setDeleting]   = useState(null)   // group или null
  const [notice, setNotice]       = useState('')     // toast
  const [friendingId, setFriendingId] = useState(null)
  const [guardReq, setGuardReq]   = useState(null)   // { accountId, login, domain } или null
  // Live-статусы аккаунтов (с воркеров) — для isGroupRunning и блок-модалки.
  const [workerStatuses, setWorkerStatuses] = useState({})
  // Конфликт-модалка: { group, busyAccounts: [{login, status}] }
  const [conflict, setConflict] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [g, a] = await Promise.all([
      window.api.groups.getAll(),
      window.api.accounts.getAll(),
    ])
    setGroups(g)
    setAccounts(a)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Подписка на статусы воркеров — нужно для отображения "запущена/нет"
  // на карточке группы и для проверки конфликта при попытке запуска.
  useEffect(() => {
    window.api.farm.statuses().then(s => setWorkerStatuses(s || {}))
    window.api.farm.onStatus(({ accountId, status, message }) => {
      setWorkerStatuses(prev => ({ ...prev, [accountId]: { status, message } }))
    })
    window.api.farm.onError(({ accountId, message }) => {
      setWorkerStatuses(prev => ({ ...prev, [accountId]: { status: 'error', message } }))
    })
    return () => window.api.farm.offAll()
  }, [])

  const handleSaved = () => {
    setEditing(null)
    load()
  }

  const handleDelete = async () => {
    if (!deleting) return
    await window.api.groups.delete(deleting.id)
    setDeleting(null)
    load()
  }

  const getStatus = useCallback((account) =>
    workerStatuses[account.id]?.status ?? account.status ?? 'idle',
    [workerStatuses])

  // Группа считается "запущенной" если ХОТЯ БЫ ОДИН её аккаунт в активном
  // статусе (preparing → matchready). Это управляет кнопкой Запуск/Стоп.
  const isGroupRunning = useCallback((group) =>
    group.accounts.some(a => GROUP_RUNNING_STATUSES.has(getStatus(a))),
    [getStatus])

  // Запуск/остановка группы. При запуске: если кто-то из аккаунтов группы
  // УЖЕ занят (запущен в другой группе или из Accounts) — показываем модалку
  // конфликта вместо запуска. На стопе блокировок нет.
  const handleLaunch = async (group, isStop) => {
    if (isStop) {
      await window.api.groups.stop(group.id)
      return
    }
    const busy = group.accounts
      .map(a => ({ login: a.login, status: getStatus(a) }))
      .filter(x => GROUP_RUNNING_STATUSES.has(x.status))
    if (busy.length > 0) {
      setConflict({ group, busyAccounts: busy })
      return
    }
    const r = await window.api.groups.start(group.id)
    if (!r?.ok) {
      setNotice(r?.error || 'Не удалось запустить группу')
      setTimeout(() => setNotice(''), 3000)
      return
    }
    setNotice(`Запуск группы «${group.name}» — sequential, ${r.started} аккаунтов`)
    setTimeout(() => setNotice(''), 2500)
  }

  // Открывает отдельное окно отслеживания группы (новый BrowserWindow).
  const handleTrack = async (group) => {
    await window.api.groups.openTracking(group.id)
  }

  // Невидимо дружит аккаунты группы через steam-user (требует idle-аккаунты).
  // Логин аккаунтов без maFile идёт через подтверждение на телефоне (Steam
  // Mobile) — прогресс показывает, какой аккаунт ждёт подтверждения.
  const handleFriend = async (group) => {
    setFriendingId(group.id)
    setNotice(`Дружим аккаунты группы «${group.name}»...`)
    const byId = new Map(group.accounts.map(a => [a.id, a.login]))
    window.api.groups.onFriendsProgress(({ accountId, status, message }) => {
      const login = byId.get(accountId) || `#${accountId}`
      if (status === 'awaiting_guard') setNotice(`«${login}»: ${message}`)
      else if (status === 'connecting') setNotice(`«${login}»: вход в Steam...`)
      else if (status === 'connected')  setNotice(`«${login}»: в сети`)
      else if (status === 'friending')  setNotice(`«${login}»: добавление в друзья...`)
    })
    // Запрос кода Steam Guard от main — показываем модалку ввода.
    window.api.groups.onFriendsSteamGuard(({ accountId, domain }) => {
      setGuardReq({ accountId, login: byId.get(accountId) || `#${accountId}`, domain })
    })
    try {
      const r = await window.api.groups.ensureFriends(group.id)
      if (r?.ok) {
        setNotice(`Группа «${group.name}»: все аккаунты подружены ✓`)
      } else if (r?.error) {
        setNotice(r.error)
      } else {
        const bad = (r?.failed?.length || 0) + (r?.impossible?.length || 0)
        setNotice(`Группа «${group.name}»: подружены не все (${bad} пар с проблемой)`)
      }
    } finally {
      window.api.groups.offFriendsProgress()
      window.api.groups.offFriendsSteamGuard()
      setGuardReq(null)
      setFriendingId(null)
      setTimeout(() => setNotice(''), 6000)
    }
  }

  // Собирает ботов группы в одно пати (Wingman). Прогресс по парам
  // транслируется через onPartyProgress и отображается в notice.
  const handleGather = async (group) => {
    setNotice(null)
    window.api.groups.onPartyProgress((d) => {
      if (d.type === 'pair') {
        const msg = d.status === 'done'
          ? `Пара ${d.leaderId}+${d.memberId}: готово ✓`
          : d.status === 'error'
            ? `Пара ${d.leaderId}+${d.memberId}: ошибка — ${d.error}`
            : `Собираем пару ${d.leaderId}+${d.memberId}...`
        setNotice(msg)
      }
    })
    try {
      const r = await window.api.groups.gatherParty(group.id)
      if (r?.ok) {
        setNotice(`Группа «${group.name}»: все пати собраны ✓`)
      } else {
        const errMsgs = r?.results?.filter(x => !x.ok).map(x => x.error).filter(Boolean)
        setNotice(`Ошибка: ${errMsgs?.length ? errMsgs.join('; ') : (r?.error || 'неизвестно')}`)
      }
    } catch (e) {
      setNotice(`Ошибка: ${e.message}`)
    } finally {
      window.api.groups.offPartyProgress()
      setTimeout(() => setNotice(''), 6000)
    }
  }

  // Отправляет введённый код Steam Guard в main для ожидающей сессии.
  const handleSubmitGuard = (code) => {
    if (guardReq) window.api.groups.submitFriendsCode(guardReq.accountId, code)
    setGuardReq(null)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Фарм группы</h1>
          <p className="text-text-secondary text-sm mt-0.5">
            {groups.length} {groups.length === 1 ? 'группа' : 'групп'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn-ghost transition-all active:scale-95"
            onClick={async () => {
              const r = await window.api.windows.arrangeGrid({})
              setNotice(r?.error
                ? `Ошибка раскладки: ${r.error}`
                : r?.moved
                  ? `Разложено окон: ${r.moved}`
                  : 'Нет запущенных окон CS2')
              setTimeout(() => setNotice(''), 2500)
            }}
            title="Разложить окна CS2 по сетке"
          >
            <LayoutGrid size={14} /> Разложить окна
          </button>
          <button
            className="btn-primary transition-all active:scale-95"
            onClick={() => setEditing({ initial: null })}
          >
            <Plus size={14} /> Создать группу
          </button>
        </div>
      </div>

      {loading ? (
        <div className="card flex justify-center py-16">
          <Loader size={20} className="animate-spin text-text-muted" />
        </div>
      ) : groups.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center gap-4">
          <div className="p-4 rounded-full bg-bg-hover">
            <Layers size={32} className="text-text-muted" />
          </div>
          <div>
            <p className="text-text-primary font-medium mb-1">Групп пока нет</p>
            <p className="text-text-muted text-sm max-w-sm">
              Создай группу из 2–4 аккаунтов, чтобы запускать CS2 синхронно
              и фармить XP в общем матче.
            </p>
          </div>
          <button
            className="btn-primary transition-all active:scale-95"
            onClick={() => setEditing({ initial: null })}
          >
            <Plus size={14} /> Создать первую группу
          </button>
        </div>
      ) : (
        <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
          {groups.map(g => (
            <GroupCard
              key={g.id}
              group={g}
              isRunning={isGroupRunning(g)}
              onLaunch={handleLaunch}
              onTrack={handleTrack}
              onEdit={(group) => setEditing({ initial: group })}
              onDelete={(group) => setDeleting(group)}
              onFriend={handleFriend}
              friending={friendingId === g.id}
              onGather={handleGather}
            />
          ))}
        </div>
      )}

      {editing && (
        <GroupEditorModal
          initial={editing.initial}
          accounts={accounts}
          onSave={handleSaved}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <ConfirmDeleteModal
          group={deleting}
          onCancel={() => setDeleting(null)}
          onConfirm={handleDelete}
        />
      )}
      {conflict && (
        <GroupConflictModal
          group={conflict.group}
          busyAccounts={conflict.busyAccounts}
          onClose={() => setConflict(null)}
        />
      )}
      {guardReq && (
        <FriendGuardModal
          login={guardReq.login}
          domain={guardReq.domain}
          onSubmit={handleSubmitGuard}
          onClose={() => setGuardReq(null)}
        />
      )}

      {notice && (
        <div className="fixed bottom-6 right-6 bg-bg-card border border-blue-500/40 rounded-xl px-4 py-3 shadow-xl z-50 text-sm text-text-primary">
          {notice}
        </div>
      )}
    </div>
  )
}
