import { useEffect, useState, useCallback } from 'react'
import { Plus, Upload, Trash2, RefreshCw, Loader, ShieldCheck, ShieldOff, Shield, Search, Play, Square, Package, Pencil, Smartphone, ArrowLeftRight, Gamepad2, ChevronLeft, ChevronRight, Bot } from 'lucide-react'

const STATUS_BADGE = {
  online:           'badge-green',
  farming:          'badge-green',
  lobby:            'badge-blue',
  steam_launching:  'badge-yellow',
  steam_loading:    'badge-yellow',
  steam_running:    'badge-blue',
  cs2_preparing:    'badge-yellow',
  cs2_launching:    'badge-yellow',
  cs2_searching:    'badge-yellow',
  cs2_loading:      'badge-yellow',
  cs2_match_loading:'badge-yellow',
  cs2_match:        'badge-green',
  cs2_in_match:     'badge-green',
  cs2_lobby:        'badge-blue',
  connecting:       'badge-yellow',
  reconnecting:     'badge-yellow',
  idle:             'badge-gray',
  no_prime:         'badge-orange',
  banned:           'badge-red',
  error:            'badge-red',
  warmup:           'badge-yellow',
  awaiting_guard:   'badge-yellow',
}

const STATUS_LABEL = {
  online:           'Онлайн',
  farming:          'Фармит',
  lobby:            'В лобби',
  steam_launching:  'Запуск Steam',
  steam_loading:    'Steam загружается',
  steam_running:    'В Steam',
  cs2_preparing:    'Подготовка',
  cs2_launching:    'Запуск CS2',
  cs2_searching:    'Ищет матч',
  cs2_loading:      'CS2 загружается',
  cs2_match_loading:'Загрузка матча',
  cs2_match:        'В матче',
  cs2_in_match:     'В матче',
  cs2_lobby:        'В лобби',
  connecting:       'Подключение...',
  reconnecting:     'Реконнект...',
  idle:             'Офлайн',
  no_prime:         'Нет Prime',
  banned:           'Забанен',
  error:            'Ошибка',
  warmup:           'Прогрев',
  awaiting_guard:   'Введи код',
}

const CS2_STATUSES = new Set(['farming', 'lobby', 'steam_launching', 'steam_running', 'cs2_preparing', 'cs2_launching', 'cs2_searching', 'cs2_loading', 'cs2_match', 'cs2_match_loading', 'cs2_in_match', 'cs2_lobby'])

const ACTIVE_STATUSES = new Set(['online', 'connecting', 'reconnecting', 'farming', 'awaiting_guard', 'no_prime', 'steam_launching', 'steam_loading', 'steam_running'])

function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.3, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.3)
  } catch {}
}

function SteamGuardModal({ request, total = 1, index = 0, onPrev, onNext, onSubmit, onClose }) {
  const [code, setCode] = useState('')
  const [timeLeft, setTimeLeft] = useState(120)

  useEffect(() => {
    setTimeLeft(120)
    setCode('')
  }, [request?.accountId])

  useEffect(() => {
    const id = setInterval(() => {
      setTimeLeft(t => (t <= 1 ? 120 : t - 1))
    }, 1000)
    return () => clearInterval(id)
  }, [])

  const submit = () => {
    if (!code.trim()) return
    onSubmit(request.accountId, code.trim())
    setCode('')
  }

  const handleKey = (e) => {
    if (e.key === 'Enter') submit()
  }

  const hasMultiple = total > 1

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-bg-card border border-border rounded-xl w-[400px] p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-text-primary">Steam Guard</h2>
            {hasMultiple && (
              <span className="text-xs text-text-muted bg-bg-secondary px-2 py-0.5 rounded-full">
                {index + 1} из {total}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {hasMultiple && (
              <>
                <button
                  className="btn-ghost p-1 disabled:opacity-30"
                  onClick={onPrev}
                  disabled={index === 0}
                  title="Предыдущий аккаунт"
                >
                  <ChevronLeft size={14} />
                </button>
                <button
                  className="btn-ghost p-1 disabled:opacity-30"
                  onClick={onNext}
                  disabled={index === total - 1}
                  title="Следующий аккаунт"
                >
                  <ChevronRight size={14} />
                </button>
              </>
            )}
            <span className="text-sm text-text-muted ml-2">{timeLeft}с</span>
          </div>
        </div>
        <div className="text-sm text-text-secondary">
          <span className="font-mono text-text-primary">{request.login}</span>
          <p className="mt-1 text-text-muted">
            {request.domain
              ? `Введи код из письма на ${request.domain}`
              : 'Введи код из мобильного аутентификатора Steam'}
          </p>
        </div>
        {request.lastCodeWrong && (
          <p className="text-xs text-red-400 bg-red-400/10 rounded px-3 py-2">
            Неверный код — попробуй снова
          </p>
        )}
        <input
          className="input text-center font-mono tracking-widest text-lg"
          placeholder="XXXXX"
          value={code}
          onChange={e => setCode(e.target.value.toUpperCase())}
          onKeyDown={handleKey}
          maxLength={7}
          autoFocus
        />
        <div className="flex flex-col gap-2">
          <div className="flex gap-2 justify-end">
            <button className="btn-ghost" onClick={onClose}>Скрыть</button>
            <button className="btn-primary" onClick={submit} disabled={!code.trim()}>
              Подтвердить
            </button>
          </div>
          {!request.domain && (
            <button
              className="btn-ghost text-xs w-full justify-center border border-border/50 rounded-md py-2"
              onClick={() => onSubmit(request.accountId, null)}
            >
              ✓ Я подтвердил вход в мобильном приложении Steam
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function AddAccountModal({ proxies, onSave, onClose }) {
  const [form, setForm] = useState({ login: '', password: '', proxyId: '', notes: '' })
  const [maFilePath, setMaFilePath] = useState(null)
  const [maError, setMaError] = useState('')
  const [saving, setSaving] = useState(false)

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const pickMaFile = async () => {
    const path = await window.api.dialog.openMaFile()
    if (path) { setMaFilePath(path); setMaError('') }
  }

  const save = async () => {
    if (!form.login || !form.password) return
    setSaving(true)
    setMaError('')
    try {
      if (maFilePath) {
        const { id } = await window.api.accounts.add({ ...form, proxyId: form.proxyId || null })
        const r = await window.api.accounts.importMaFile(id, maFilePath)
        if (!r.ok) {
          await window.api.accounts.delete(id)
          setMaError(r.error)
          return
        }
        onSave()
        return
      }
      await window.api.accounts.add({ ...form, proxyId: form.proxyId || null })
      onSave()
    } catch (e) {
      setMaError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const maFileName = maFilePath ? maFilePath.split('\\').pop().split('/').pop() : null

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-bg-card border border-border rounded-xl w-[440px] p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-text-primary mb-5">Добавить аккаунт</h2>
        <div className="space-y-3">
          <div>
            <label className="label">Логин *</label>
            <input className="input" value={form.login} onChange={e => set('login', e.target.value)} placeholder="steam_login" />
          </div>
          <div>
            <label className="label">Пароль *</label>
            <input className="input" type="password" value={form.password} onChange={e => set('password', e.target.value)} placeholder="••••••••" />
          </div>
          <div>
            <label className="label">maFile <span className="text-text-muted">(необязательно)</span></label>
            <div className="relative">
              <div
                className="input w-full text-xs font-mono truncate pr-8 cursor-pointer flex items-center"
                onClick={pickMaFile}
                title="Выбрать maFile"
              >
                {maFileName
                  ? <span className="text-green-400">{maFileName}</span>
                  : <span className="text-text-muted">Не выбран</span>}
              </div>
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary transition-colors"
                onClick={maFilePath ? () => { setMaFilePath(null); setMaError('') } : pickMaFile}
                title={maFilePath ? 'Убрать' : 'Выбрать maFile'}
              >
                {maFilePath
                  ? <Trash2 size={13} className="text-red-400" />
                  : <Smartphone size={13} />}
              </button>
            </div>
            {maError && (
              <p className="text-xs text-red-400 mt-1">{maError}</p>
            )}
          </div>
          <div>
            <label className="label">Прокси</label>
            <select className="input" value={form.proxyId} onChange={e => set('proxyId', e.target.value)}>
              <option value="">Без прокси</option>
              {proxies.map(p => (
                <option key={p.id} value={p.id}>{p.host}:{p.port}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Заметки</label>
            <input className="input" value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Необязательно" />
          </div>
        </div>
        <div className="flex gap-2 mt-5 justify-end">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>Отмена</button>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? <Loader size={13} className="animate-spin" /> : null}
            Добавить
          </button>
        </div>
      </div>
    </div>
  )
}

function EditAccountModal({ account, proxies, onSave, onClose }) {
  const [form, setForm] = useState({
    login:   account.login || '',
    password: '',
    proxyId: account.proxyId != null ? String(account.proxyId) : '',
    notes:   account.notes || '',
  })
  const [maFilePath, setMaFilePath] = useState(null)
  const [maError, setMaError] = useState('')
  const [saving, setSaving] = useState(false)

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const pickMaFile = async () => {
    const path = await window.api.dialog.openMaFile()
    if (path) { setMaFilePath(path); setMaError('') }
  }

  const save = async () => {
    if (!form.login) return
    setSaving(true)
    setMaError('')
    try {
      const patch = { login: form.login, proxyId: form.proxyId || null, notes: form.notes }
      if (form.password) patch.password = form.password
      await window.api.accounts.update(account.id, patch)
      if (maFilePath) {
        const r = await window.api.accounts.importMaFile(account.id, maFilePath)
        if (!r.ok) { setMaError(r.error); return }
      }
      onSave()
    } catch (e) {
      setMaError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const maFileName = maFilePath ? maFilePath.split('\\').pop().split('/').pop() : null

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-bg-card border border-border rounded-xl w-[440px] p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-text-primary mb-5">Редактировать аккаунт</h2>
        <div className="space-y-3">
          <div>
            <label className="label">Логин *</label>
            <input className="input" value={form.login} onChange={e => set('login', e.target.value)} placeholder="steam_login" />
          </div>
          <div>
            <label className="label">Пароль <span className="text-text-muted">(оставь пустым чтобы не менять)</span></label>
            <input className="input" type="password" value={form.password} onChange={e => set('password', e.target.value)} placeholder="••••••••" />
          </div>
          <div>
            <label className="label">
              maFile
              {account.hasSharedSecret
                ? <span className="text-green-400 ml-1.5 text-[10px]">✓ импортирован</span>
                : <span className="text-text-muted ml-1.5">(не импортирован)</span>}
            </label>
            <div className="relative">
              <div
                className="input w-full text-xs font-mono truncate pr-8 cursor-pointer flex items-center"
                onClick={pickMaFile}
                title="Выбрать maFile"
              >
                {maFileName
                  ? <span className="text-green-400">{maFileName}</span>
                  : <span className="text-text-muted">{account.hasSharedSecret ? 'Выбрать новый файл...' : 'Не выбран'}</span>}
              </div>
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary transition-colors"
                onClick={maFilePath ? () => { setMaFilePath(null); setMaError('') } : pickMaFile}
                title={maFilePath ? 'Убрать' : 'Выбрать maFile'}
              >
                {maFilePath ? <Trash2 size={13} className="text-red-400" /> : <Smartphone size={13} />}
              </button>
            </div>
            {maError && <p className="text-xs text-red-400 mt-1">{maError}</p>}
          </div>
          <div>
            <label className="label">Прокси</label>
            <select className="input" value={form.proxyId} onChange={e => set('proxyId', e.target.value)}>
              <option value="">Без прокси</option>
              {proxies.map(p => (
                <option key={p.id} value={p.id}>{p.host}:{p.port}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Заметки</label>
            <input className="input" value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Необязательно" />
          </div>
        </div>
        <div className="flex gap-2 mt-5 justify-end">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>Отмена</button>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? <Loader size={13} className="animate-spin" /> : null}
            Сохранить
          </button>
        </div>
      </div>
    </div>
  )
}

function ImportModal({ onSave, onClose }) {
  const [text, setText] = useState('')
  const [result, setResult] = useState(null)

  const doImport = async () => {
    const r = await window.api.accounts.import(text)
    setResult(r)
    if (r.success > 0) onSave()
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-bg-card border border-border rounded-xl w-[500px] p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-text-primary mb-2">Массовый импорт</h2>
        <p className="text-text-muted text-xs mb-4">Формат: <span className="font-mono text-text-secondary">login:password:shared_secret:identity_secret</span></p>
        <textarea
          className="input h-48 resize-none font-mono text-xs"
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={"account1:pass1:secret1:\naccount2:pass2:secret2:"}
        />
        {result && (
          <div className="mt-3 text-xs space-y-1">
            <p className="text-green-400">✓ Импортировано: {result.success}</p>
            {result.failed > 0 && <p className="text-red-400">✗ Ошибок: {result.failed}</p>}
          </div>
        )}
        <div className="flex gap-2 mt-4 justify-end">
          <button className="btn-ghost" onClick={onClose}>Закрыть</button>
          <button className="btn-primary" onClick={doImport} disabled={!text.trim()}>Импортировать</button>
        </div>
      </div>
    </div>
  )
}

export default function Accounts() {
  const [accounts, setAccounts]             = useState([])
  const [proxies, setProxies]               = useState([])
  const [search, setSearch]                 = useState('')
  const [modal, setModal]                   = useState(null)
  const [selected, setSelected]             = useState(new Set())
  const [workerStatuses, setWorkerStatuses] = useState({})
  const [steamGuardQueue, setSteamGuardQueue] = useState([])
  const [guardIndex, setGuardIndex]           = useState(0)
  const [dropToast, setDropToast] = useState(null)
  const [isRefreshing, setIsRefreshing]   = useState(false)
  const [isStartingAll, setIsStartingAll] = useState(false)
  const [isStoppingAll, setIsStoppingAll] = useState(false)
  const [editId, setEditId]               = useState(null)

  const load = useCallback(async () => {
    setIsRefreshing(true)
    await Promise.all([
      window.api.accounts.getAll().then(a => setAccounts(a)),
      window.api.proxies.getAll().then(p => setProxies(p)),
      new Promise(r => setTimeout(r, 700)),
    ])
    setIsRefreshing(false)
  }, [])

  useEffect(() => {
    load()
    window.api.farm.statuses().then(s => setWorkerStatuses(s || {}))

    window.api.farm.onStatus(({ accountId, status, message }) => {
      setWorkerStatuses(prev => ({ ...prev, [accountId]: { status, message } }))
      // Перезагружаем аккаунты чтобы подхватить обновлённый isPrime из БД
      if (status === 'online' || status === 'no_prime') load()
    })
    window.api.farm.onError(({ accountId, message }) => {
      setWorkerStatuses(prev => ({ ...prev, [accountId]: { status: 'error', message } }))
    })
    window.api.farm.onSteamGuard(({ accountId, domain, lastCodeWrong }) => {
      setSteamGuardQueue(prev => {
        const idx = prev.findIndex(r => r.accountId === accountId)
        if (idx >= 0) {
          // Тот же аккаунт повторно просит код (например, после неверного кода) — обновляем
          const next = [...prev]
          next[idx] = { accountId, domain, lastCodeWrong }
          return next
        }
        return [...prev, { accountId, domain, lastCodeWrong }]
      })
      playBeep()
      const prevTitle = document.title
      document.title = '🔔 Введи Steam Guard код!'
      setTimeout(() => { document.title = prevTitle }, 5000)
    })
    window.api.farm.onDrop(({ accountId, item }) => {
      const acc = accounts.find(a => a.id === accountId)
      setDropToast({ login: acc?.login ?? `#${accountId}`, itemName: item.name })
      setTimeout(() => setDropToast(null), 4000)
    })
    window.api.farm.onXpUpdate(({ accountId, xp, level }) => {
      setAccounts(prev => prev.map(a => a.id === accountId ? { ...a, xpProgress: xp, playerLevel: level } : a))
    })
    return () => window.api.farm.offAll()
  }, [load])

  const getStatus = (account) => {
    const ws = workerStatuses[account.id]
    return ws ? ws.status : account.status
  }

  const getMessage = (account) => workerStatuses[account.id]?.message ?? null

  const isActive = (account) => ACTIVE_STATUSES.has(getStatus(account))

  const handleStart = async (id) => { await window.api.farm.start(id) }
  const handleStop  = async (id) => { await window.api.farm.stop(id) }

  const handleStartAll = async () => {
    setIsStartingAll(true)
    const eligible = accounts.filter(a => a.isPrime && a.proxy && !isActive(a))
    await Promise.all(eligible.map(a => window.api.farm.start(a.id)))
    setIsStartingAll(false)
  }

  const handleStopAll = async () => {
    setIsStoppingAll(true)
    await window.api.farm.stopAll()
    setIsStoppingAll(false)
  }

  const handleSteamGuardSubmit = async (accountId, code) => {
    await window.api.farm.submitCode(accountId, code)
    setSteamGuardQueue(prev => prev.filter(r => r.accountId !== accountId))
    setGuardIndex(0)
  }

  const handleSteamGuardClose = () => {
    setSteamGuardQueue(prev => prev.filter((_, i) => i !== guardIndex))
    setGuardIndex(i => Math.max(0, i - 1))
  }

  const CS2_ACTIVE = new Set(['cs2_preparing', 'steam_launching', 'steam_loading', 'steam_running', 'cs2_launching', 'cs2_loading', 'cs2_lobby', 'cs2_match_loading', 'cs2_in_match'])

  const handleStartCS2 = async (id) => { await window.api.launcher.start(id) }

  const handleStopCS2  = async (id) => { await window.api.launcher.stop(id) }

  const filtered = accounts.filter(a =>
    a.login.toLowerCase().includes(search.toLowerCase())
  )

  const toggleSelect = (id) => setSelected(s => {
    const n = new Set(s)
    n.has(id) ? n.delete(id) : n.add(id)
    return n
  })

  const startSelected = async () => {
    const ids = [...selected].filter(id => {
      const a = accounts.find(x => x.id === id)
      return a && a.proxy && !isActive(a)
    })
    await Promise.all(ids.map(id => window.api.farm.start(id)))
  }

  const stopSelected = async () => {
    await Promise.all([...selected].map(id => window.api.farm.stop(id)))
  }

  const deleteSelected = async () => {
    await Promise.all([...selected].map(id => window.api.accounts.delete(id)))
    setSelected(new Set())
    load()
  }

  const activeCount = accounts.filter(a => isActive(a)).length

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Аккаунты</h1>
          <p className="text-text-secondary text-sm mt-0.5">
            {accounts.length} аккаунтов
            {activeCount > 0 && <span className="text-green-400 ml-2">· {activeCount} активных</span>}
          </p>
        </div>
        <div className="flex gap-2">
          {selected.size > 0 && (
            <>
              <button className="btn-ghost transition-all active:scale-95" onClick={startSelected}>
                <Play size={14} className="text-green-400" /> Старт ({selected.size})
              </button>
              <button className="btn-ghost transition-all active:scale-95" onClick={stopSelected}>
                <Square size={14} className="text-red-400" /> Стоп ({selected.size})
              </button>
              <button className="btn-danger transition-all active:scale-95" onClick={deleteSelected}>
                <Trash2 size={14} /> Удалить ({selected.size})
              </button>
            </>
          )}
          <button
            className="btn-ghost transition-all active:scale-95 disabled:opacity-50"
            onClick={handleStopAll}
            disabled={isStoppingAll || activeCount === 0}
          >
            <Square size={14} className={isStoppingAll ? 'animate-pulse' : ''} />
            {isStoppingAll ? 'Стоп...' : 'Стоп все'}
          </button>
          <button
            className="btn-primary transition-all active:scale-95 disabled:opacity-50"
            onClick={handleStartAll}
            disabled={isStartingAll}
          >
            <Play size={14} className={isStartingAll ? 'animate-pulse' : ''} />
            {isStartingAll ? 'Запуск...' : 'Старт все'}
          </button>
          <button className="btn-ghost transition-all active:scale-95" onClick={() => setModal('import')}>
            <Upload size={14} /> Импорт
          </button>
          <button
            className="btn-ghost transition-all active:scale-95"
            onClick={load}
            disabled={isRefreshing}
          >
            {isRefreshing ? <Loader size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
          <button className="btn-primary transition-all active:scale-95" onClick={() => setModal('add')}>
            <Plus size={14} /> Добавить
          </button>
        </div>
      </div>

      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          className="input pl-9"
          placeholder="Поиск по логину..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="card p-0 overflow-visible">
        <table className="w-full text-sm table-fixed">
          <colgroup>
            <col className="w-8" />
            <col className="w-40" />
            <col className="w-48" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-52" />
            <col />
            <col className="w-44" />
          </colgroup>
          <thead>
            <tr className="border-b border-border text-text-muted text-xs">
              <th className="px-4 py-3 text-left">
                <input
                  type="checkbox"
                  onChange={e => setSelected(e.target.checked ? new Set(filtered.map(a => a.id)) : new Set())}
                  checked={filtered.length > 0 && filtered.every(a => selected.has(a.id))}
                />
              </th>
              <th className="px-4 py-3 text-left">Логин</th>
              <th className="px-4 py-3 text-left">Статус</th>
              <th className="px-4 py-3 text-center">Prime</th>
              <th className="px-4 py-3 text-center">2FA</th>
              <th className="px-4 py-3 text-left">Прокси</th>
              <th className="px-4 py-3 text-right">XP</th>
              <th className="px-4 py-3 text-right"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(a => {
              const status  = getStatus(a)
              const active  = ACTIVE_STATUSES.has(status)
              const noPrime = status === 'no_prime'
              const msg     = getMessage(a)
              return (
                <tr key={a.id} className="border-b border-border/50 hover:bg-bg-hover/50 transition-colors">
                  <td className="px-4 py-3">
                    <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleSelect(a.id)} />
                  </td>
                  <td className="px-4 py-3 font-mono text-text-primary">{a.login}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <span className={`${STATUS_BADGE[status] || 'badge-gray'} cursor-default`}>
                        {STATUS_LABEL[status] || status}
                      </span>
                      {msg && (
                        <div className="relative group/msg">
                          <span className="text-text-muted cursor-help text-xs select-none">ⓘ</span>
                          <div className="absolute left-0 top-full mt-1 z-50 hidden group-hover/msg:block bg-gray-900 border border-border rounded-md px-2.5 py-1.5 text-xs text-text-secondary shadow-xl pointer-events-none max-w-[300px] break-words whitespace-normal min-w-[160px]">
                            {msg}
                          </div>
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="relative group inline-flex items-center justify-center">
                      {!a.lastLoginAt
                        ? <Shield size={16} className="text-text-muted" />
                        : a.isPrime
                          ? <ShieldCheck size={16} className="text-blue-400" />
                          : <ShieldOff size={16} className="text-red-400" />}
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 text-xs bg-gray-900 text-white rounded border border-border whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none z-50">
                        {!a.lastLoginAt ? 'Prime неизвестен' : a.isPrime ? 'Prime статус активен' : 'Prime отсутствует'}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="inline-flex items-center justify-center gap-1.5">
                      <div className="relative group/sg">
                        <Smartphone size={15} className={a.hasSharedSecret ? 'text-green-400' : 'text-text-muted opacity-40'} />
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 text-xs bg-gray-900 text-white rounded border border-border whitespace-nowrap opacity-0 group-hover/sg:opacity-100 transition-opacity duration-150 pointer-events-none z-50">
                          {a.hasSharedSecret ? 'maFile подключён' : 'maFile не импортирован'}
                        </div>
                      </div>
                      <div className="relative group/id">
                        <ArrowLeftRight size={15} className={a.hasIdentitySecret ? 'text-green-400' : 'text-text-muted opacity-40'} />
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 text-xs bg-gray-900 text-white rounded border border-border whitespace-nowrap opacity-0 group-hover/id:opacity-100 transition-opacity duration-150 pointer-events-none z-50">
                          {a.hasIdentitySecret ? 'Trade подключён' : 'Identity secret не добавлен'}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-text-secondary font-mono text-xs">
                    {a.proxy ? (
                      <div className="flex items-center gap-1.5">
                        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${a.proxy.isValid ? 'bg-green-400' : 'bg-red-400'}`} />
                        {a.proxy.host}:{a.proxy.port}
                      </div>
                    ) : <span className="text-text-muted">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right text-text-secondary">
                    <div className="flex items-center justify-end gap-2">
                      {a.playerLevel != null && (
                        <span className="text-xs font-medium text-blue-400">Ур.{a.playerLevel}</span>
                      )}
                      <div className="w-16 h-1.5 bg-bg-hover rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.min((a.xpProgress / 5000) * 100, 100)}%` }} />
                      </div>
                      <span className="text-xs text-text-muted w-12 text-right">{a.xpProgress}/5000</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {active
                        ? <button className="btn-ghost p-1.5" title="Отключить" onClick={() => handleStop(a.id)}>
                            <Square size={13} className="text-red-400" />
                          </button>
                        : <button className="btn-ghost p-1.5" title="Подключить"
                            onClick={() => handleStart(a.id)}
                            disabled={CS2_ACTIVE.has(status)}>
                            <Play size={13} className={CS2_ACTIVE.has(status) ? 'text-text-muted opacity-40' : 'text-green-400'} />
                          </button>
                      }
                      {CS2_ACTIVE.has(status) ? (
                        <button className="btn-ghost p-1.5" title="Остановить CS2"
                          onClick={() => handleStopCS2(a.id)}>
                          <Gamepad2 size={13} className="text-red-400" />
                        </button>
                      ) : (
                        <button className="btn-ghost p-1.5" title="Запустить CS2"
                          onClick={() => handleStartCS2(a.id)}>
                          <Gamepad2 size={13} className="text-blue-400" />
                        </button>
                      )}
                      <button className="btn-ghost p-1.5"
                        title="Имитация движения (откроется отдельное окно)"
                        onClick={() => window.api.automation.openWindow(a.id)}>
                        <Bot size={13} className="text-purple-400" />
                      </button>
                      <button className="btn-ghost p-1.5" title="Редактировать" onClick={() => setEditId(a.id)}>
                        <Pencil size={13} className="text-text-muted" />
                      </button>
                      <button className="btn-ghost p-1.5" title="Удалить"
                        onClick={async () => { await window.api.accounts.delete(a.id); load() }}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-text-muted">
                  {search ? 'Ничего не найдено' : 'Аккаунтов нет. Добавьте первый.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modal === 'add'    && <AddAccountModal proxies={proxies} onSave={() => { load(); setModal(null) }} onClose={() => setModal(null)} />}
      {modal === 'import' && <ImportModal onSave={load} onClose={() => setModal(null)} />}
      {editId && <EditAccountModal account={accounts.find(a => a.id === editId)} proxies={proxies} onSave={() => { load(); setEditId(null) }} onClose={() => setEditId(null)} />}
      {steamGuardQueue.length > 0 && (() => {
        const safeIdx = Math.min(guardIndex, steamGuardQueue.length - 1)
        const current = steamGuardQueue[safeIdx]
        return (
          <SteamGuardModal
            request={{
              ...current,
              login: accounts.find(a => a.id === current.accountId)?.login ?? String(current.accountId),
            }}
            total={steamGuardQueue.length}
            index={safeIdx}
            onPrev={() => setGuardIndex(i => Math.max(0, i - 1))}
            onNext={() => setGuardIndex(i => Math.min(steamGuardQueue.length - 1, i + 1))}
            onSubmit={handleSteamGuardSubmit}
            onClose={handleSteamGuardClose}
          />
        )
      })()}
      {dropToast && (
        <div className="fixed bottom-6 right-6 bg-bg-card border border-green-500/40 rounded-xl px-4 py-3 shadow-xl z-50 flex items-center gap-3">
          <Package size={16} className="text-green-400 shrink-0" />
          <div>
            <p className="text-xs text-text-muted">{dropToast.login}</p>
            <p className="text-sm font-medium text-green-400">Дроп получен: {dropToast.itemName}</p>
          </div>
        </div>
      )}
    </div>
  )
}
