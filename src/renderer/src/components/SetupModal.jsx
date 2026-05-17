import { useState, useEffect } from 'react'
import { Download, CheckCircle, AlertCircle, Loader } from 'lucide-react'

export default function SetupModal({ onDone }) {
  const [phase, setPhase]       = useState('checking')  // checking | needed | installing | done | error
  const [progress, setProgress] = useState('')
  const [error, setError]       = useState('')

  useEffect(() => {
    window.api.sandboxie.status().then(s => {
      if (s.installed) { onDone(); return }
      setPhase('needed')
    })

    window.api.sandboxie.onProgress(msg => {
      if (msg === '__done__') {
        setPhase('done')
        setTimeout(onDone, 1800)
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
    // result handled via onProgress events
  }

  if (phase === 'checking') return null

  return (
    <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 backdrop-blur-sm">
      <div className="card max-w-md w-full mx-4 space-y-4 shadow-2xl">
        <h2 className="text-base font-semibold text-text-primary">Проверка зависимостей</h2>

        {phase === 'needed' && (
          <>
            <div className="flex items-start gap-3 text-sm text-text-secondary">
              <AlertCircle size={16} className="text-yellow-400 mt-0.5 shrink-0" />
              <p>
                <span className="text-text-primary font-medium">Sandboxie Classic</span> не установлен.
                Он необходим для запуска CS2 в изолированной песочнице.
              </p>
            </div>
            <div className="flex gap-2">
              <button className="btn-primary flex-1" onClick={install}>
                <Download size={14} />
                Установить автоматически
              </button>
              <button className="btn-ghost" onClick={onDone}>Пропустить</button>
            </div>
          </>
        )}

        {phase === 'installing' && (
          <div className="flex items-center gap-3 text-sm text-text-secondary py-2">
            <Loader size={16} className="animate-spin text-accent-blue shrink-0" />
            <span>{progress || 'Подготовка...'}</span>
          </div>
        )}

        {phase === 'done' && (
          <div className="flex items-center gap-2 text-green-400 text-sm py-2">
            <CheckCircle size={16} />
            <span>Sandboxie Classic успешно установлен!</span>
          </div>
        )}

        {phase === 'error' && (
          <>
            <div className="flex items-start gap-2 text-red-400 text-sm">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
            <div className="flex gap-2">
              <button className="btn-primary flex-1" onClick={install}>
                <Download size={14} />
                Повторить
              </button>
              <button className="btn-ghost flex-1" onClick={onDone}>Пропустить</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
