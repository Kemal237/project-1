import { useEffect, useState, useCallback } from 'react'
import { Save, Key, Box, Download, RefreshCw, CheckCircle, AlertCircle, Loader, RotateCcw, Folder, Check, Trash2 } from 'lucide-react'

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
    window.api.updater.onError(msg  => {
      const friendly = /ERR_CONNECTION|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(msg)
        ? 'Нет подключения к серверу обновлений'
        : msg
      setUpPhase('error'); setUpError(friendly); setSpinning(false)
    })

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
          {upPhase === 'upToDate' && (
            <>
              <CheckCircle size={13} className="text-green-400" />
              <span className="badge badge-green">Актуальная версия</span>
            </>
          )}
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
              <button className="btn-ghost p-1 text-red-400 hover:text-red-300" title="Удалить Sandboxie"
                onClick={async () => {
                  if (!confirm('Удалить Sandboxie Classic?')) return
                  await window.api.sandboxie.uninstall()
                  refreshSandboxie()
                }}>
                <Trash2 size={13} />
              </button>
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

function PathRow({ label, settingKey, found, onSaved }) {
  const [value,   setValue]   = useState('')
  const [saving,  setSaving]  = useState(false)
  const [saved,   setSavedOk] = useState(false)

  useEffect(() => {
    window.api.settings.get().then(s => setValue(s[settingKey] || ''))
  }, [settingKey])

  const apply = async (path) => {
    const v = path ?? value
    setSaving(true)
    await window.api.settings.set(settingKey, v || null)
    await onSaved()
    setSaving(false)
    setSavedOk(true)
    setTimeout(() => setSavedOk(false), 1500)
  }

  const pick = async () => {
    const path = await window.api.dialog.openFolder()
    if (!path) return
    setValue(path)
    await apply(path)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-primary">{label}</p>
        <div className="flex items-center gap-1.5">
          {found === null && <span className="badge badge-gray">Проверка...</span>}
          {found === true  && <><CheckCircle size={13} className="text-green-400" /><span className="badge badge-green">Найден</span></>}
          {found === false && <span className={label === 'Steam' ? 'badge badge-red' : 'badge badge-yellow'}>Не найден</span>}
        </div>
      </div>
      <div className="flex gap-1.5">
        <input
          className="input flex-1 text-xs font-mono"
          placeholder={`Путь к ${label}...`}
          value={value}
          onChange={e => { setValue(e.target.value); setSavedOk(false) }}
          onKeyDown={e => e.key === 'Enter' && apply()}
        />
        <button className="btn-ghost p-2" title="Выбрать папку" onClick={pick}>
          <Folder size={13} />
        </button>
        <button
          className={`btn-ghost p-2 ${saved ? 'text-green-400' : ''}`}
          title="Применить"
          onClick={() => apply()}
          disabled={saving}
        >
          {saving ? <Loader size={13} className="animate-spin" /> : <Check size={13} />}
        </button>
      </div>
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

      <PathRow
        label="Steam"
        settingKey="steam_path"
        found={deps === null ? null : deps.steam.found}
        onSaved={refresh}
      />

      <div className="border-t border-border" />

      <PathRow
        label="Counter-Strike 2"
        settingKey="cs2_path"
        found={deps === null ? null : deps.cs2.found}
        onSaved={refresh}
      />

      {deps && !deps.cs2.found && !deps.steam.found && (
        <p className="text-xs text-text-muted">
          Укажи пути вручную или установи Steam и CS2, затем нажми обновить.
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
        <p className="text-sm font-medium text-text-primary border-b border-border pb-3">Раскладка окон CS2</p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Столбцов в сетке</label>
            <input className="input" type="number" min="1" max="10"
              placeholder="Авто"
              value={s.window_grid_cols || ''}
              onChange={e => set('window_grid_cols', e.target.value)} />
            <p className="text-text-muted text-xs mt-1">Пусто = авто (√n). При запуске по умолчанию 2.</p>
          </div>
          <div>
            <label className="label">Авто-раскладка при запуске</label>
            <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
              <input type="checkbox"
                checked={s.window_grid_autoarrange !== 'false'}
                onChange={e => set('window_grid_autoarrange', e.target.checked ? 'true' : 'false')} />
              <span className="text-sm text-text-secondary">
                Открывать окно CS2 сразу в своей ячейке
              </span>
            </label>
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
