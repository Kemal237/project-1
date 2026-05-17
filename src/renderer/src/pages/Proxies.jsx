import { useEffect, useState } from 'react'
import { Plus, Trash2, RefreshCw, CheckCircle, XCircle, Loader } from 'lucide-react'

function AddProxyModal({ onSave, onClose }) {
  const [form, setForm]   = useState({ host: '', port: '', username: '', password: '', type: 'socks5' })
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    const [r] = await Promise.all([
      window.api.proxies.validate(form),
      new Promise(r => setTimeout(r, 700)),
    ])
    setTestResult(r)
    setTesting(false)
  }

  const save = async () => {
    if (!form.host || !form.port) return
    await window.api.proxies.add(form)
    onSave()
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-bg-card border border-border rounded-xl w-[420px] p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-text-primary mb-5">Добавить прокси</h2>
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="label">Host *</label>
              <input className="input font-mono text-xs" value={form.host} onChange={e => set('host', e.target.value)} placeholder="proxy.example.com" />
            </div>
            <div>
              <label className="label">Port *</label>
              <input className="input font-mono text-xs" value={form.port} onChange={e => set('port', e.target.value)} placeholder="1080" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Username</label>
              <input className="input text-xs" value={form.username} onChange={e => set('username', e.target.value)} />
            </div>
            <div>
              <label className="label">Password</label>
              <input className="input text-xs" type="password" value={form.password} onChange={e => set('password', e.target.value)} />
            </div>
          </div>
          <div>
            <label className="label">Тип</label>
            <select className="input" value={form.type} onChange={e => set('type', e.target.value)}>
              <option value="socks5">SOCKS5</option>
              <option value="socks4">SOCKS4</option>
              <option value="http">HTTP</option>
            </select>
          </div>

          {testResult && (
            <div className={`flex items-center gap-2 text-sm px-3 py-2 rounded-md ${testResult.valid ? 'bg-green-400/10 text-green-400' : 'bg-red-400/10 text-red-400'}`}>
              {testResult.valid
                ? <><CheckCircle size={14} /> IP: {testResult.ip}</>
                : <><XCircle size={14} /> {testResult.error}</>}
            </div>
          )}
        </div>

        <div className="flex gap-2 mt-5">
          <button className="btn-ghost flex-1" onClick={test} disabled={testing || !form.host}>
            {testing ? <Loader size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Проверить
          </button>
          <button className="btn-ghost" onClick={onClose}>Отмена</button>
          <button className="btn-primary" onClick={save} disabled={!form.host || !form.port}>Добавить</button>
        </div>
      </div>
    </div>
  )
}

export default function Proxies() {
  const [proxies, setProxies] = useState([])
  const [modal, setModal]     = useState(false)
  const [validating, setValidating] = useState(false)

  const load = async () => setProxies(await window.api.proxies.getAll())

  useEffect(() => { load() }, [])

  const validateAll = async () => {
    setValidating(true)
    const start = Date.now()
    for (const p of proxies) {
      const r = await window.api.proxies.validate({ host: p.host, port: p.port, username: p.username, type: p.type })
      setProxies(prev => prev.map(x => x.id === p.id ? { ...x, isValid: r.valid, lastIp: r.ip } : x))
    }
    const elapsed = Date.now() - start
    if (elapsed < 700) await new Promise(r => setTimeout(r, 700 - elapsed))
    setValidating(false)
    load()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Прокси</h1>
          <p className="text-text-secondary text-sm mt-0.5">{proxies.length} прокси</p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={validateAll} disabled={validating}>
            {validating ? <Loader size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Проверить все
          </button>
          <button className="btn-primary" onClick={() => setModal(true)}>
            <Plus size={14} /> Добавить
          </button>
        </div>
      </div>

      <div className="card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-text-muted text-xs">
              <th className="px-4 py-3 text-left">Хост</th>
              <th className="px-4 py-3 text-left">Тип</th>
              <th className="px-4 py-3 text-left">Статус</th>
              <th className="px-4 py-3 text-left">IP</th>
              <th className="px-4 py-3 text-right">Аккаунтов</th>
              <th className="px-4 py-3 text-right">Проверен</th>
              <th className="px-4 py-3 w-12"></th>
            </tr>
          </thead>
          <tbody>
            {proxies.map(p => (
              <tr key={p.id} className="border-b border-border/50 hover:bg-bg-hover/50 transition-colors">
                <td className="px-4 py-3 font-mono text-text-primary text-xs">
                  {p.host}:{p.port}
                  {p.username && <span className="text-text-muted ml-2">@{p.username}</span>}
                </td>
                <td className="px-4 py-3">
                  <span className="badge-gray uppercase text-xs">{p.type}</span>
                </td>
                <td className="px-4 py-3">
                  {p.isValid
                    ? <span className="badge-green"><CheckCircle size={10} /> Активен</span>
                    : <span className="badge-red"><XCircle size={10} /> Недоступен</span>}
                </td>
                <td className="px-4 py-3 font-mono text-text-secondary text-xs">
                  {p.lastIp || '—'}
                </td>
                <td className="px-4 py-3 text-right text-text-secondary">{p.accountsCount}</td>
                <td className="px-4 py-3 text-right text-text-muted text-xs">
                  {p.lastCheckedAt ? new Date(p.lastCheckedAt).toLocaleTimeString('ru') : '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    className="btn-ghost p-1.5"
                    onClick={async () => { await window.api.proxies.delete(p.id); load() }}
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
            {proxies.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-text-muted">
                  Прокси нет. Добавьте SOCKS5 прокси для защиты аккаунтов.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modal && <AddProxyModal onSave={() => { load(); setModal(false) }} onClose={() => setModal(false)} />}
    </div>
  )
}
