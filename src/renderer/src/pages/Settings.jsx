import { useEffect, useState, useCallback } from 'react'
import { Save, Key, Box, Download, RefreshCw, CheckCircle, AlertCircle, Loader, RotateCcw } from 'lucide-react'

function UpdaterSection() {
  const [version, setVersion]   = useState('')
  const [phase,   setPhase]     = useState('idle')  // idle|checking|available|downloading|ready|upToDate|error
  const [percent, setPercent]   = useState(0)
  const [newVer,  setNewVer]    = useState('')
  const [error,   setError]     = useState('')

  useEffect(() => {
    window.api.updater.getVersion().then(setVersion)
    window.api.updater.onAvailable(info => { setPhase('available'); setNewVer(info.version) })
    window.api.updater.onUpToDate(() => setPhase('upToDate'))
    window.api.updater.onProgress(p => { setPhase('downloading'); setPercent(Math.round(p.percent)) })
    window.api.updater.onDownloaded(() => setPhase('ready'))
    window.api.updater.onError(msg => { setPhase('error'); setError(msg) })
    return () => window.api.updater.offAll()
  }, [])

  const check = async () => {
    setPhase('checking')
    setError('')
    await window.api.updater.check()
  }

  return (
    <div className="card space-y-4">
      <p className="text-sm font-medium text-text-primary border-b border-border pb-3 flex items-center gap-2">
        <RotateCcw size={14} /> Обновления
      </p>

      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-text-primary">Текущая версия</p>
          <p className="text-xs text-text-muted font-mono">v{version || '—'}</p>
        </div>
        <div className="flex items-center gap-2">
          {phase === 'checking' ? (
            <button className="btn-ghost" disabled>
              <Loader size={13} className="animate-spin" /> Проверка...
            </button>
          ) : (
            <button className="btn-ghost" onClick={check}>
              <RefreshCw size={13} />
              {phase === 'idle' ? 'Проверить' : 'Проверить снова'}
            </button>
          )}
          {phase === 'upToDate'  && <span className="badge badge-green">Актуальная версия</span>}
          {phase === 'available' && <span className="badge badge-yellow">Доступна v{newVer}</span>}
          {phase === 'ready'     && (
            <button className="btn-primary" onClick={() => window.api.updater.install()}>
              <Download size={13} /> Установить и перезапустить
            </button>
          )}
        </div>
      </div>

      {phase === 'downloading' && (
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs text-text-muted">
            <span>Скачивание обновления...</span>
            <span>{percent}%</span>
          </div>
          <div className="w-full bg-bg-secondary rounded-full h-1.5">
            <div className="bg-accent-blue h-1.5 rounded-full transition-all duration-300"
                 style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="space-y-2">
          <div className="flex items-start gap-2 text-red-400 text-xs">
            <AlertCircle size={13} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
          <button className="btn-ghost text-xs" onClick={() => setPhase('idle')}>Сбросить</button>
        </div>
      )}
    </div>
  )
}

function SandboxieSection() {
  const [status,   setStatus]   = useState(null)   // null | { installed, version }
  const [phase,    setPhase]    = useState('idle')  // idle | installing | done | error
  const [progress, setProgress] = useState('')
  const [error,    setError]    = useState('')

  const [spinning, setSpinning] = useState(false)

  const refresh = useCallback(() => {
    setStatus(null)
    setSpinning(true)
    Promise.all([
      window.api.sandboxie.status().then(setStatus),
      new Promise(r => setTimeout(r, 700)),
    ]).finally(() => setSpinning(false))
  }, [])

  useEffect(() => {
    refresh()
    window.api.sandboxie.onProgress(msg => {
      if (msg === '__done__') {
        setPhase('done')
        refresh()
      } else if (msg.startsWith('__error__:')) {
        setError(msg.replace('__error__:', ''))
        setPhase('error')
      } else {
        setProgress(msg)
      }
    })
    return () => window.api.sandboxie.offProgress()
  }, [])

  const install = async () => {
    setPhase('installing')
    setError('')
    setProgress('')
    await window.api.sandboxie.install()
  }

  return (
    <div className="card space-y-4">
      <p className="text-sm font-medium text-text-primary border-b border-border pb-3 flex items-center gap-2">
        <Box size={14} /> Зависимости
      </p>

      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <p className="text-sm text-text-primary">Sandboxie Classic</p>
          <p className="text-xs text-text-muted">Требуется для изоляции CS2</p>
        </div>
        <div className="flex items-center gap-2">
          {status === null ? (
            <span className="badge badge-gray">Проверка...</span>
          ) : status.installed ? (
            <>
              <CheckCircle size={14} className="text-green-400" />
              <span className="badge badge-green">
                {status.version || 'Установлен'}
              </span>
            </>
          ) : (
            <span className="badge badge-red">Не установлен</span>
          )}
          <button className="btn-ghost p-1" onClick={refresh} title="Обновить" disabled={spinning}>
            {spinning ? <Loader size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
        </div>
      </div>

      {status && !status.installed && phase === 'idle' && (
        <button className="btn-primary w-full" onClick={install}>
          <Download size={14} />
          Установить Sandboxie Classic
        </button>
      )}

      {phase === 'installing' && (
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader size={14} className="animate-spin text-accent-blue shrink-0" />
          <span>{progress || 'Подготовка...'}</span>
        </div>
      )}

      {phase === 'done' && (
        <div className="flex items-center gap-2 text-green-400 text-sm">
          <CheckCircle size={14} />
          <span>Sandboxie Classic успешно установлен!</span>
        </div>
      )}

      {phase === 'error' && (
        <>
          <div className="flex items-start gap-2 text-red-400 text-sm">
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
          <button className="btn-primary w-full" onClick={install}>
            <Download size={14} />
            Повторить установку
          </button>
        </>
      )}
    </div>
  )
}

export default function Settings() {
  const [s, setS]         = useState({})
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.api.settings.get().then(setS)
  }, [])

  const set = (k, v) => setS(prev => ({ ...prev, [k]: v }))

  const save = async () => {
    for (const [k, v] of Object.entries(s)) await window.api.settings.set(k, v)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">Настройки</h1>
        <p className="text-text-secondary text-sm mt-0.5">Конфигурация фарм-панели</p>
      </div>

      <div className="card space-y-4">
        <p className="text-sm font-medium text-text-primary border-b border-border pb-3">Фарм группы</p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Размер пакета (аккаунтов)</label>
            <input className="input" type="number" min="1" max="20"
              value={s.batch_size || '10'}
              onChange={e => set('batch_size', e.target.value)} />
            <p className="text-text-muted text-xs mt-1">Рекомендуется: 10</p>
          </div>
          <div>
            <label className="label">Мин. пауза между пакетами (мин)</label>
            <input className="input" type="number" min="10"
              value={s.min_batch_delay || '30'}
              onChange={e => set('min_batch_delay', e.target.value)} />
          </div>
          <div>
            <label className="label">Макс. пауза между пакетами (мин)</label>
            <input className="input" type="number"
              value={s.max_batch_delay || '90'}
              onChange={e => set('max_batch_delay', e.target.value)} />
          </div>
        </div>
      </div>

      <div className="card space-y-4">
        <p className="text-sm font-medium text-text-primary border-b border-border pb-3">Задержки логина</p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Мин. задержка между логинами (сек)</label>
            <input className="input" type="number" min="10"
              value={s.min_login_delay || '15'}
              onChange={e => set('min_login_delay', e.target.value)} />
          </div>
          <div>
            <label className="label">Макс. задержка между логинами (сек)</label>
            <input className="input" type="number"
              value={s.max_login_delay || '45'}
              onChange={e => set('max_login_delay', e.target.value)} />
          </div>
        </div>
      </div>

      <div className="card space-y-4">
        <p className="text-sm font-medium text-text-primary border-b border-border pb-3">Сессия CS2</p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Мин. длина сессии (часов)</label>
            <input className="input" type="number" min="1" max="6"
              value={s.session_min_hours || '2'}
              onChange={e => set('session_min_hours', e.target.value)} />
          </div>
          <div>
            <label className="label">Макс. длина сессии (часов)</label>
            <input className="input" type="number" min="2" max="8"
              value={s.session_max_hours || '4'}
              onChange={e => set('session_max_hours', e.target.value)} />
          </div>
        </div>
      </div>

      <div className="card space-y-4">
        <p className="text-sm font-medium text-text-primary border-b border-border pb-3 flex items-center gap-2">
          <Key size={14} /> Лицензия
        </p>
        <div>
          <label className="label">Ключ активации</label>
          <input className="input font-mono"
            value={s.license_key || ''}
            onChange={e => set('license_key', e.target.value)}
            placeholder="XXXX-XXXX-XXXX-XXXX" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-text-muted text-xs">Статус:</span>
          <span className={`badge ${s.license_status === 'active' ? 'badge-green' : 'badge-red'}`}>
            {s.license_status === 'active' ? 'Активна' : 'Не активирована'}
          </span>
        </div>
      </div>

      <UpdaterSection />
      <SandboxieSection />

      <button
        className={`btn-primary ${saved ? 'bg-green-600 hover:bg-green-600' : ''}`}
        onClick={save}
      >
        <Save size={14} />
        {saved ? 'Сохранено ✓' : 'Сохранить настройки'}
      </button>
    </div>
  )
}
