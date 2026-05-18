import { useEffect, useState, useCallback } from 'react'
import { Save, Key, Box, Download, RefreshCw, CheckCircle, AlertCircle, Loader, RotateCcw } from 'lucide-react'

function UpdatesSection() {
  // — Updater —
  const [version,  setVersion]  = useState('')
  const [upPhase,  setUpPhase]  = useState('idle')
  const [upError,  setUpError]  = useState('')
  const [spinning, setSpinning] = useState(false)

  // — Sandboxie —
  const [sbStatus,   setSbStatus]   = useState(null)
  const [sbPhase,    setSbPhase]    = useState('idle')
  const [sbProgress, setSbProgress] = useState('')
  const [sbError,    setSbError]    = useState('')
  const [sbSpin,     setSbSpin]     = useState(false)

  const refreshSandboxie = useCallback(() => {
    setSbStatus(null)
    setSbSpin(true)
    Promise.all([
      window.api.sandboxie.status().then(setSbStatus),
      new Promise(r => setTimeout(r, 700)),
    ]).finally(() => setSbSpin(false))
  }, [])

  useEffect(() => {
    window.api.updater.getVersion().then(setVersion)
    window.api.updater.onUpToDate(() => { setUpPhase('upToDate'); setSpinning(false) })
    window.api.updater.onError(msg  => { setUpPhase('error'); setUpError(msg); setSpinning(false) })

    refreshSandboxie()
    window.api.sandboxie.onProgress(msg => {
      if (msg === '__done__') {
        setSbPhase('done')
        refreshSandboxie()
      } else if (msg.startsWith('__error__:')) {
        setSbError(msg.replace('__error__:', ''))
        setSbPhase('error')
      } else {
        setSbProgress(msg)
      }
    })

    return () => {
      window.api.updater.offSettings()
      window.api.sandboxie.offProgress()
    }
  }, [])

  const checkUpdates = async () => {
    setSpinning(true)
    setUpPhase('checking')
    setUpError('')
    await Promise.all([
      window.api.updater.check(),
      new Promise(r => setTimeout(r, 700)),
    ])
    setSpinning(false)
  }

  const installSandboxie = async () => {
    setSbPhase('installing')
    setSbError('')
    setSbProgress('')
    await window.api.sandboxie.install()
  }

  return (
    <div className="card space-y-4">
      <p className="text-sm font-medium text-text-primary border-b border-border pb-3 flex items-center gap-2">
        <RotateCcw size={14} /> Обновления
      </p>

      {/* App version */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <p className="text-sm text-text-primary">Версия панели</p>
          <p className="text-xs text-text-muted font-mono">v{version || '—'}</p>
        </div>
        <div className="flex items-center gap-2">
          {upPhase === 'upToDate' && <span className="badge badge-green">Актуальная версия</span>}
          <button className="btn-ghost p-1" onClick={checkUpdates} disabled={spinning} title="Проверить обновления">
            {spinning ? <Loader size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
        </div>
      </div>
      {upPhase === 'error' && (
        <div className="flex items-start gap-2 text-red-400 text-xs">
          <AlertCircle size={13} className="shrink-0 mt-0.5" /><span>{upError}</span>
        </div>
      )}

      <div className="border-t border-border" />

      {/* Sandboxie */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <p className="text-sm text-text-primary">Sandboxie Classic</p>
          <p className="text-xs text-text-muted">Изоляция CS2 по аккаунтам</p>
        </div>
        <div className="flex items-center gap-2">
          {sbStatus === null ? (
            <span className="badge badge-gray">Проверка...</span>
          ) : sbStatus.installed ? (
            <>
              <CheckCircle size={13} className="text-green-400" />
              <span className="badge badge-green">{sbStatus.version || 'Установлен'}</span>
            </>
          ) : (
            <span className="badge badge-red">Не установлен</span>
          )}
          <button className="btn-ghost p-1" onClick={refreshSandboxie} title="Обновить" disabled={sbSpin}>
            {sbSpin ? <Loader size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
        </div>
      </div>

      {sbStatus && !sbStatus.installed && sbPhase === 'idle' && (
        <button className="btn-primary w-full" onClick={installSandboxie}>
          <Download size={14} /> Установить Sandboxie Classic
        </button>
      )}
      {sbPhase === 'installing' && (
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader size={14} className="animate-spin text-accent-blue shrink-0" />
          <span>{sbProgress || 'Подготовка...'}</span>
        </div>
      )}
      {sbPhase === 'done' && (
        <div className="flex items-center gap-2 text-green-400 text-sm">
          <CheckCircle size={14} /><span>Sandboxie Classic успешно установлен!</span>
        </div>
      )}
      {sbPhase === 'error' && (
        <>
          <div className="flex items-start gap-2 text-red-400 text-sm">
            <AlertCircle size={14} className="shrink-0 mt-0.5" /><span>{sbError}</span>
          </div>
          <button className="btn-primary w-full" onClick={installSandboxie}>
            <Download size={14} /> Повторить установку
          </button>
        </>
      )}
    </div>
  )
}

function DependenciesSection() {
  const [deps,     setDeps]     = useState(null)
  const [spinning, setSpinning] = useState(false)

  const refresh = useCallback(() => {
    setDeps(null)
    setSpinning(true)
    Promise.all([
      window.api.deps.detect().then(setDeps),
      new Promise(r => setTimeout(r, 700)),
    ]).finally(() => setSpinning(false))
  }, [])

  useEffect(() => { refresh() }, [])

  const shortPath = (p) => {
    if (!p) return ''
    const parts = p.replace(/\\/g, '/').split('/')
    return parts.length > 3 ? `...\\${parts.slice(-2).join('\\')}` : p
  }

  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between border-b border-border pb-3">
        <p className="text-sm font-medium text-text-primary flex items-center gap-2">
          <Box size={14} /> Зависимости
        </p>
        <button className="btn-ghost p-1" onClick={refresh} title="Обновить" disabled={spinning}>
          {spinning ? <Loader size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
      </div>

      {/* Steam */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <p className="text-sm text-text-primary">Steam</p>
          <p className="text-xs text-text-muted font-mono">
            {deps?.steam?.path ? shortPath(deps.steam.path) : '—'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {deps === null ? (
            <span className="badge badge-gray">Проверка...</span>
          ) : deps.steam.found ? (
            <>
              <CheckCircle size={13} className="text-green-400" />
              <span className="badge badge-green">Найден</span>
            </>
          ) : (
            <span className="badge badge-red">Не найден</span>
          )}
        </div>
      </div>

      {/* CS2 */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <p className="text-sm text-text-primary">Counter-Strike 2</p>
          <p className="text-xs text-text-muted font-mono">
            {deps?.cs2?.path ? shortPath(deps.cs2.path) : '—'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {deps === null ? (
            <span className="badge badge-gray">Проверка...</span>
          ) : deps.cs2.found ? (
            <>
              <CheckCircle size={13} className="text-green-400" />
              <span className="badge badge-green">Найден</span>
            </>
          ) : (
            <span className="badge badge-yellow">Не найден</span>
          )}
        </div>
      </div>

      {deps && !deps.cs2.found && (
        <p className="text-xs text-text-muted">
          CS2 не найден — убедись что игра установлена через Steam.
        </p>
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

      <UpdatesSection />
      <DependenciesSection />

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
