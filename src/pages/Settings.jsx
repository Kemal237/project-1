import { useEffect, useState } from 'react'
import { Save, Key } from 'lucide-react'

export default function Settings() {
  const [s, setS]   = useState({})
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.api.settings.get().then(setS)
  }, [])

  const set = (k, v) => setS(prev => ({ ...prev, [k]: v }))

  const save = async () => {
    for (const [k, v] of Object.entries(s)) {
      await window.api.settings.set(k, v)
    }
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

      <button className="btn-primary" onClick={save}>
        <Save size={14} />
        {saved ? 'Сохранено ✓' : 'Сохранить настройки'}
      </button>
    </div>
  )
}
