// Глобальный mutex для синхронизации клавиатурного/мышиного ввода через nut.js.
//
// Проблема: nut.js использует SendInput на уровне ОС — клавиатура/мышь хоста
// общая для всех процессов. Если 2 модуля одновременно пытаются ввести данные
// (напр. 2 параллельных tryAutoInput в разные sandboxed Steam окна) — события
// перемешиваются, символы теряются, фокус активируется не у того окна.
//
// Решение: FIFO-очередь. Один владелец lock'а в каждый момент времени.
// acquire(label) ждёт пока освободится, возвращает release-функцию.
// release-функция идемпотентна (повторный вызов безопасен).
//
// Использование:
//   const release = await inputMutex.acquire('bot-12 login')
//   try {
//     await keyboard.type('login')
//     ...
//   } finally {
//     release()
//   }

class InputMutex {
  constructor() {
    this._holder = null   // { label, acquiredAt } или null
    this._queue  = []     // [{ label, resolve }, ...]
  }

  // Возвращает Promise<releaseFn>. Когда mutex освободится — promise резолвится
  // release-функцией; вызови её когда закончил работу с клавиатурой/мышью.
  acquire(label = 'unnamed') {
    return new Promise((resolve) => {
      const entry = { label, resolve }
      if (!this._holder) {
        this._grant(entry)
      } else {
        this._queue.push(entry)
        console.log(`[InputMutex] queued: ${label} (queue size: ${this._queue.length}, holder: ${this._holder.label})`)
      }
    })
  }

  // Текущий статус — для UI/диагностики
  isLocked() { return this._holder !== null }
  currentHolder() { return this._holder ? this._holder.label : null }
  queueSize() { return this._queue.length }
  queueLabels() { return this._queue.map(e => e.label) }

  _grant(entry) {
    this._holder = { label: entry.label, acquiredAt: Date.now() }
    console.log(`[InputMutex] acquired: ${entry.label}`)

    let released = false
    const release = () => {
      if (released) return
      released = true
      const heldMs = Date.now() - this._holder.acquiredAt
      console.log(`[InputMutex] released: ${entry.label} (held ${heldMs}ms)`)
      this._holder = null
      const next = this._queue.shift()
      if (next) this._grant(next)
    }
    entry.resolve(release)
  }

  // Принудительно очистить очередь (например при общем Stop).
  // Текущий держатель НЕ затрагивается — он сам вызовет release когда закончит.
  // Все ожидающие в очереди получат release-функцию которая ничего не делает
  // (чтобы их код не подвис на await).
  clearQueue() {
    const dropped = this._queue.splice(0)
    for (const entry of dropped) {
      console.log(`[InputMutex] dropped from queue: ${entry.label}`)
      entry.resolve(() => {})  // no-op release — их работа отменена
    }
    return dropped.length
  }
}

export default new InputMutex()
