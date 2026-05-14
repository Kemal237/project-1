import { useEffect, useState, useCallback } from 'react'
import { Plus, Upload, Trash2, RefreshCw, Shield, ShieldOff, Search, Play, Square } from 'lucide-react'

const STATUS_BADGE = {
  online:       'badge-green',
  farming:      'badge-green',
  connecting:   'badge-yellow',
  reconnecting: 'badge-yellow',
  idle:         'badge-gray',
  no_prime:     'badge-orange',
  banned:       'badge-red',
  error:        'badge-red',
  warmup:       'badge-yellow',
}

const STATUS_LABEL = {
  online:       'Онлайн',
  farming:      'Фармит',
  connecting:   'Подключение...',
  reconnecting: 'Реконнект...',
  idle:         'Офлайн',
  no_prime:     'Нет Prime',
  banned:       'Забанен',
  error:        'Ошибка',
  warmup:       'Прогрев',
}

const ACTIVE_STATUSES = new Set(['online', 'connecting', 'reconnecting', 'farming'])

function AddAccountModal({ proxies, onSave, onClose }) {
  const [form, setForm] = useState({ login: '', password: '', sharedSecret: '', identitySecret: '', proxyId: '', isPrime: true, notes: '' })

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const save = async () => {
    if (!form.login || !form.password) return
    await window.api.accounts.add({ ...form, proxyId: form.proxyId || null })
    onSave()
  }

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
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Shared Secret</label>
              <input className="input font-mono text-xs" value={form.sharedSecret} onChange={e => set('sharedSecret', e.target.value)} placeholder="2FA Secret" />
            </div>
            <div>
              <label className="label">Identity Secret</label>
              <input className="input font-mono text-xs" value={form.identitySecret} onChange={e => set('identitySecret', e.target.value)} placeholder="Trade Secret" />
            </div>
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
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.isPrime} onChange={e => set('isPrime', e.target.checked)} className="rounded" />
            <span className="text-sm text-text-secondary">Prime статус</span>
          </label>
          <div>
            <label className="label">Заметки</label>
            <input className="input" value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Необязательно" />
          </div>
        </div>
        <div className="flex gap-2 mt-5 justify-end">
          <button className="btn-ghost" onClick={onClose}>Отмена</button>
          <button className="btn-primary" onClick={save}>Добавить</button>
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

  const load = useCallback(async () => {
    const [a, p] = await Promise.all([window.api.accounts.getAll(), window.api.proxies.getAll()])
    setAccounts(a)
    setProxies(p)
  }, [])

  useEffect(() => {
    load()

    window.api.farm.statuses().then(s => setWorkerStatuses(s || {}))

    window.api.farm.onStatus(({ accountId, status, message }) => {
      setWorkerStatuses(prev => ({ ...prev, [accountId]: { status, message } }))
    })
    window.api.farm.onError(({ accountId, message }) => {
      setWorkerStatuses(prev => ({ ...prev, [accountId]: { status: 'error', message } }))
    })

    return () => window.api.farm.offAll()
  }, [load])

  const getStatus = (account) => {
    const ws = workerStatuses[account.id]
    return ws ? ws.status : account.status
  }

  const isActive = (account) => ACTIVE_STATUSES.has(getStatus(account))

  const handleStart = async (id) => { await window.api.farm.start(id) }
  const handleStop  = async (id) => { await window.api.farm.stop(id) }

  const handleStartAll = async () => {
    const eligible = accounts.filter(a => a.isPrime && a.proxy && !isActive(a))
    for (const a of eligible) await window.api.farm.start(a.id)
  }

  const handleStopAll = async () => { await window.api.farm.stopAll() }

  const filtered = accounts.filter(a =>
    a.login.toLowerCase().includes(search.toLowerCase())
  )

  const toggleSelect = (id) => setSelected(s => {
    const n = new Set(s)
    n.has(id) ? n.delete(id) : n.add(id)
    return n
  })

  const deleteSelected = async () => {
    for (const id of selected) await window.api.accounts.delete(id)
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
            <button className="btn-danger" onClick={deleteSelected}>
              <Trash2 size={14} /> Удалить ({selected.size})
            </button>
          )}
          <button className="btn-ghost" onClick={handleStopAll}>
            <Square size={14} /> Стоп все
          </button>
          <button className="btn-primary" onClick={handleStartAll}>
            <Play size={14} /> Старт все
          </button>
          <button className="btn-ghost" onClick={() => setModal('import')}>
            <Upload size={14} /> Импорт
          </button>
          <button className="btn-ghost" onClick={load}>
            <RefreshCw size={14} />
          </button>
          <button className="btn-primary" onClick={() => setModal('add')}>
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

      <div className="card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-text-muted text-xs">
              <th className="px-4 py-3 text-left w-8">
                <input
                  type="checkbox"
                  onChange={e => setSelected(e.target.checked ? new Set(filtered.map(a => a.id)) : new Set())}
                  checked={selected.size === filtered.length && filtered.length > 0}
                />
              </th>
              <th className="px-4 py-3 text-left">Логин</th>
              <th className="px-4 py-3 text-left">Статус</th>
              <th className="px-4 py-3 text-left">Prime</th>
              <th className="px-4 py-3 text-left">Прокси</th>
              <th className="px-4 py-3 text-right">XP</th>
              <th className="px-4 py-3 text-right">Дропов / неделя</th>
              <th className="px-4 py-3 text-right">Всего дропов</th>
              <th className="px-4 py-3 text-right">Последний дроп</th>
              <th className="px-4 py-3 text-right w-24"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(a => {
              const status  = getStatus(a)
              const active  = ACTIVE_STATUSES.has(status)
              const noPrime = status === 'no_prime' || !a.isPrime
              return (
                <tr key={a.id} className="border-b border-border/50 hover:bg-bg-hover/50 transition-colors">
                  <td className="px-4 py-3">
                    <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleSelect(a.id)} />
                  </td>
                  <td className="px-4 py-3 font-mono text-text-primary">{a.login}</td>
                  <td className="px-4 py-3">
                    <span className={STATUS_BADGE[status] || 'badge-gray'}>
                      {STATUS_LABEL[status] || status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {a.isPrime
                      ? <Shield size={14} className="text-yellow-400" />
                      : <ShieldOff size={14} className="text-text-muted" />}
                  </td>
                  <td className="px-4 py-3 text-text-secondary font-mono text-xs">
                    {a.proxy ? `${a.proxy.host}:${a.proxy.port}` : <span className="text-text-muted">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right text-text-secondary">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-1.5 bg-bg-hover rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.min((a.xpProgress / 5000) * 100, 100)}%` }} />
                      </div>
                      <span className="text-xs text-text-muted w-12 text-right">{a.xpProgress}/5000</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-green-400">{a.dropsThisWeek}</td>
                  <td className="px-4 py-3 text-right text-text-secondary">{a.dropsTotal}</td>
                  <td className="px-4 py-3 text-right text-text-muted text-xs">
                    {a.lastDropAt ? new Date(a.lastDropAt).toLocaleDateString('ru') : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {!noPrime && (
                        active
                          ? <button className="btn-ghost p-1.5" title="Остановить" onClick={() => handleStop(a.id)}>
                              <Square size={13} className="text-red-400" />
                            </button>
                          : <button className="btn-ghost p-1.5" title="Запустить" onClick={() => handleStart(a.id)}>
                              <Play size={13} className="text-green-400" />
                            </button>
                      )}
                      <button
                        className="btn-ghost p-1.5"
                        onClick={async () => { await window.api.accounts.delete(a.id); load() }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-12 text-center text-text-muted">
                  {search ? 'Ничего не найдено' : 'Аккаунтов нет. Добавьте первый.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modal === 'add'    && <AddAccountModal proxies={proxies} onSave={() => { load(); setModal(null) }} onClose={() => setModal(null)} />}
      {modal === 'import' && <ImportModal onSave={load} onClose={() => setModal(null)} />}
    </div>
  )
}
