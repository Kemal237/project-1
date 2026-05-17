import { useState, useEffect } from 'react'
import { Download, X, Loader, CheckCircle, RotateCcw } from 'lucide-react'

export default function UpdateModal({ info, onDismiss }) {
  const [phase,   setPhase]   = useState('available') // available | downloading | ready
  const [percent, setPercent] = useState(0)

  useEffect(() => {
    window.api.updater.onProgress(p => {
      setPhase('downloading')
      setPercent(Math.round(p.percent))
    })
    window.api.updater.onDownloaded(() => setPhase('ready'))
    return () => window.api.updater.offModal()
  }, [])

  const handleDownload = () => {
    setPhase('downloading')
    window.api.updater.download()
  }

  const handleInstall = () => window.api.updater.install()

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="card w-[420px] space-y-5">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-accent-blue/10">
              <RotateCcw size={16} className="text-accent-blue" />
            </div>
            <div>
              <p className="text-sm font-semibold text-text-primary">Доступно обновление</p>
              <p className="text-xs text-text-muted mt-0.5">
                {info?.version ? `v${info.version}` : 'Новая версия'}
              </p>
            </div>
          </div>
          {phase !== 'downloading' && (
            <button className="btn-ghost p-1.5" onClick={onDismiss} title="Отложить">
              <X size={14} />
            </button>
          )}
        </div>

        {info?.releaseNotes && phase === 'available' && (
          <div className="bg-bg-secondary rounded-lg p-3 text-xs text-text-secondary max-h-32 overflow-y-auto">
            {typeof info.releaseNotes === 'string'
              ? info.releaseNotes
              : 'Новая версия панели готова к установке.'}
          </div>
        )}

        {phase === 'available' && !info?.releaseNotes && (
          <p className="text-sm text-text-secondary">
            Новая версия панели готова к установке. Рекомендуем обновиться.
          </p>
        )}

        {phase === 'downloading' && (
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-text-muted">
              <span className="flex items-center gap-1.5">
                <Loader size={12} className="animate-spin" />
                Скачивание...
              </span>
              <span>{percent}%</span>
            </div>
            <div className="w-full bg-bg-secondary rounded-full h-1.5">
              <div
                className="bg-accent-blue h-1.5 rounded-full transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        )}

        {phase === 'ready' && (
          <div className="flex items-center gap-2 text-green-400 text-sm">
            <CheckCircle size={14} />
            <span>Обновление скачано и готово к установке</span>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          {phase === 'available' && (
            <>
              <button className="btn-primary flex-1" onClick={handleDownload}>
                <Download size={13} />
                Установить
              </button>
              <button className="btn-ghost flex-1" onClick={onDismiss}>
                Отложить
              </button>
            </>
          )}
          {phase === 'downloading' && (
            <button className="btn-ghost flex-1" disabled>
              <Loader size={13} className="animate-spin" />
              Скачивание...
            </button>
          )}
          {phase === 'ready' && (
            <>
              <button className="btn-primary flex-1" onClick={handleInstall}>
                <RotateCcw size={13} />
                Перезапустить и установить
              </button>
              <button className="btn-ghost flex-1" onClick={onDismiss}>
                Позже
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
