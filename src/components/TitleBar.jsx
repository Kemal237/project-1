import { Minus, Square, X } from 'lucide-react'

export default function TitleBar() {
  return (
    <div className="titlebar-drag flex items-center justify-between h-10 bg-bg-secondary border-b border-border px-4 shrink-0">
      <div className="flex items-center gap-2 titlebar-nodrag">
        <div className="w-3 h-3 rounded-full bg-accent-green" />
        <span className="text-xs font-semibold text-text-primary tracking-wider uppercase">
          CS2 Farm Panel
        </span>
        <span className="text-xs text-text-muted">v1.0.0</span>
      </div>

      <div className="titlebar-nodrag flex items-center">
        <button
          onClick={() => window.api.window.minimize()}
          className="w-10 h-10 flex items-center justify-center hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
        >
          <Minus size={14} />
        </button>
        <button
          onClick={() => window.api.window.maximize()}
          className="w-10 h-10 flex items-center justify-center hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
        >
          <Square size={13} />
        </button>
        <button
          onClick={() => window.api.window.close()}
          className="w-10 h-10 flex items-center justify-center hover:bg-red-600 text-text-secondary hover:text-white transition-colors"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
