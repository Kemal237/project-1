import { Layers, Play, Square, Clock } from 'lucide-react'

export default function FarmGroups() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">Фарм группы</h1>
        <p className="text-text-secondary text-sm mt-0.5">Управление пакетным фармом XP</p>
      </div>

      <div className="card flex flex-col items-center justify-center py-16 text-center gap-4">
        <div className="p-4 rounded-full bg-bg-hover">
          <Layers size={32} className="text-text-muted" />
        </div>
        <div>
          <p className="text-text-primary font-medium mb-1">Farm Engine</p>
          <p className="text-text-muted text-sm max-w-sm">
            Модуль фарм-движка будет добавлен в следующем этапе разработки.
            Здесь будет управление группами по 10 аккаунтов, запуск CS2 и трекинг XP.
          </p>
        </div>
        <div className="flex gap-3 mt-2">
          <div className="flex items-center gap-2 text-text-muted text-xs">
            <Play size={12} /> Запуск групп
          </div>
          <div className="flex items-center gap-2 text-text-muted text-xs">
            <Clock size={12} /> Планировщик
          </div>
          <div className="flex items-center gap-2 text-text-muted text-xs">
            <Square size={12} /> Остановка
          </div>
        </div>
      </div>
    </div>
  )
}
