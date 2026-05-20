import { useEffect, useState } from 'react'
import { Bot, Play, Square, X, Loader } from 'lucide-react'

// Standalone окно имитации движения. Открывается через openAutomationWindow(id)
// в main process, URL hash `#/automation/<id>` определяет какой аккаунт обслуживается.
export default function AutomationWindow({ accountId }) {
  const [account, setAccount] = useState(null)
  const [pattern, setPattern] = useState('square')
  const [running, setRunning] = useState(false)
  const [log, setLog]         = useState([])
  const [error, setError]     = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    const load = async () => {
      const accounts = await window.api.accounts.getAll()
      const a = accounts.find(x => x.id === Number(accountId)) || null
      if (mounted) {
        setAccount(a)
        setLoading(false)
      }
      const st = await window.api.automation.status(Number(accountId))
      if (mounted) setRunning(!!st?.running)
    }
    load()
    return () => { mounted = false }
  }, [accountId])

  useEffect(() => {
    window.api.automation.onAction(payload => {
      if (payload.accountId !== Number(accountId)) return
      if (payload.type === 'started') setRunning(true)
      if (payload.type === 'stopped') setRunning(false)
      if (payload.type === 'error') {
        setError(payload.message)
        setRunning(false)
      }
      if (payload.type === 'press' || payload.type === 'release') {
        setError(null)
        setLog(prev => {
          const next = [{ time: new Date().toLocaleTimeString(), ...payload }, ...prev]
          return next.slice(0, 15)
        })
      }
    })
    return () => window.api.automation.offAction()
  }, [accountId])

  const handleStart = async () => {
    setError(null)
    setLog([])
    const r = await window.api.automation.start(Number(accountId), pattern)
    if (!r?.ok) setError(r?.error || 'Не удалось запустить имитацию')
  }

  const handleStop = async () => {
    await window.api.automation.stop(Number(accountId))
  }

  const handleClose = () => window.close()
  const handleMinimize = () => window.api.window.minimize()

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-bg-primary">
        <Loader className="animate-spin text-text-muted" size={20} />
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col bg-bg-primary text-text-primary">
      {/* Custom titlebar (frame: false) */}
      <div className="flex items-center justify-between px-3 py-2 bg-bg-card border-b border-border drag-region">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Bot size={14} className="text-purple-400" />
          Имитация — {account?.login || `#${accountId}`}
        </div>
        <div className="flex items-center gap-1 no-drag">
          <button className="btn-ghost p-1" onClick={handleMinimize} title="Свернуть">
            <span className="text-xs">─</span>
          </button>
          <button className="btn-ghost p-1" onClick={handleClose} title="Закрыть">
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        <div>
          <div className="text-xs text-text-muted mb-2">Паттерн движения:</div>
          <div className="space-y-1">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="pattern" value="square" checked={pattern === 'square'}
                disabled={running}
                onChange={() => setPattern('square')} />
              <span className="text-sm">Квадрат (W → D → S → A, по 2с)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="pattern" value="random" checked={pattern === 'random'}
                disabled={running}
                onChange={() => setPattern('random')} />
              <span className="text-sm">Рандом (случайные клавиши, 300-1500мс)</span>
            </label>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span className="text-text-muted">Статус:</span>
          {running
            ? <span className="text-green-400">● Активна</span>
            : <span className="text-text-muted">○ Остановлена</span>}
        </div>

        {error && <div className="text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded">{error}</div>}

        <div>
          <div className="text-xs text-text-muted mb-1">Лог действий:</div>
          <div className="bg-bg-hover rounded p-2 h-48 overflow-y-auto text-xs font-mono">
            {log.length === 0
              ? <div className="text-text-muted">Нет действий</div>
              : log.map((l, i) => (
                  <div key={i} className="text-text-secondary">
                    {l.time}  {l.type === 'press' ? '↓' : '↑'} {l.key?.toUpperCase()}
                    {l.durationMs ? `  ${l.durationMs}мс` : ''}
                  </div>
                ))}
          </div>
        </div>
      </div>

      <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
        {!running
          ? <button className="btn-primary text-sm px-4 py-1.5 flex items-center gap-1" onClick={handleStart}>
              <Play size={13} /> Старт
            </button>
          : <button className="btn-danger text-sm px-4 py-1.5 flex items-center gap-1" onClick={handleStop}>
              <Square size={13} /> Стоп
            </button>}
      </div>
    </div>
  )
}
