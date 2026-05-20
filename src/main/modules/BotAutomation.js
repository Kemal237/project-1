import { execSync } from 'child_process'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { BrowserWindow } from 'electron'
import { keyboard, Key } from '@nut-tree-fork/nut-js'
import cs2Launcher from './CS2Launcher'

// Имитация WASD движения для одного аккаунта в окне CS2 (Sandboxie).
//
// Поток работы:
//   1. start(id, pattern) — находим PID нашего sandboxed cs2.exe через
//      Start.exe /box:<box> /list_pids (официальный CLI Sandboxie),
//      затем HWND по PID через EnumWindows.
//   2. Запускаем loop: для каждого {key, durationMs} из PatternEngine
//      активируем окно через AttachThreadInput (обход Windows защиты от
//      focus stealing для background-процессов), затем nut.js press/release.
//   3. Если cs2Launcher.isRunning(id) становится false или пользователь нажал
//      Stop — выходим из цикла и шлём 'stopped' event.

const KEY_MAP = {
  w: Key.W, a: Key.A, s: Key.S, d: Key.D,
}

// Папка для временных PowerShell скриптов
const PS_DIR = join(tmpdir(), 'cs2farmpanel-ps')

// PS-скрипт: ищет HWND главного окна по PID через EnumWindows.
// Выводит число (HWND как Int64) или 0 если не найдено.
const HWND_BY_PID_PS = `
param([int]$TargetPid)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WinEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowTextLength(IntPtr hWnd);
  public static IntPtr Find(uint targetPid) {
    IntPtr found = IntPtr.Zero;
    EnumProc cb = delegate(IntPtr hWnd, IntPtr lp) {
      uint pid = 0;
      GetWindowThreadProcessId(hWnd, out pid);
      if (pid == targetPid && IsWindowVisible(hWnd) && GetWindowTextLength(hWnd) > 0) {
        found = hWnd;
        return false;
      }
      return true;
    };
    EnumWindows(cb, IntPtr.Zero);
    return found;
  }
}
'@
$h = [WinEnum]::Find([uint32]$TargetPid)
Write-Output $h.ToInt64()
`.trim()

// PS-скрипт: активирует окно через AttachThreadInput trick.
// Стандартный workaround Windows защиты от focus stealing для background-процессов.
const ACTIVATE_PS = `
param([long]$Hwnd)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WinAct {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@
$h = [IntPtr]$Hwnd
if (-not [WinAct]::IsWindow($h)) { Write-Output 'INVALID'; exit }
$null = [WinAct]::ShowWindow($h, 9)
$targetPid = [uint32]0
$targetTid = [WinAct]::GetWindowThreadProcessId($h, [ref]$targetPid)
$ourTid = [WinAct]::GetCurrentThreadId()
$null = [WinAct]::AttachThreadInput($ourTid, $targetTid, $true)
$ok = [WinAct]::SetForegroundWindow($h)
$null = [WinAct]::SetFocus($h)
$null = [WinAct]::AttachThreadInput($ourTid, $targetTid, $false)
Write-Output $(if ($ok) { 'OK' } else { 'FAIL' })
`.trim()

class BotAutomation {
  constructor() {
    this.webContents = null
    this._sessions   = new Map()  // accountId → { hwnd, pattern, running, generator }
    this._scriptsWritten = false
  }

  init(webContents) {
    this.webContents = webContents
    this._ensureScripts()
  }

  isRunning(accountId) {
    return this._sessions.has(accountId) && this._sessions.get(accountId).running
  }

  async start(accountId, patternName) {
    if (this._sessions.has(accountId)) {
      throw new Error('Имитация уже запущена для этого аккаунта')
    }
    if (!cs2Launcher.isRunning(accountId)) {
      throw new Error('CS2 не запущена через панель')
    }
    if (patternName !== 'square' && patternName !== 'random') {
      throw new Error(`Неизвестный паттерн: ${patternName}`)
    }

    this._ensureScripts()

    const entry = cs2Launcher._active.get(accountId)
    const boxName = entry?.boxName
    if (!boxName) throw new Error('Не найден boxName для аккаунта')

    const pid = this._findCs2PidInBox(boxName, entry.sbPath)
    if (!pid) throw new Error('cs2.exe не найден в боксе ' + boxName)

    const hwnd = this._findHwndByPid(pid)
    if (!hwnd || hwnd === 0) throw new Error('Окно CS2 не найдено по PID ' + pid)

    const gen = patternName === 'square' ? this._squareGen() : this._randomGen()
    const session = { hwnd, pattern: patternName, running: true, generator: gen }
    this._sessions.set(accountId, session)

    console.log(`[BotAutomation ${accountId}] start pattern=${patternName} hwnd=${hwnd} pid=${pid}`)
    this._sendEvent({ accountId, type: 'started', pattern: patternName, hwnd: String(hwnd) })

    this._runLoop(accountId).catch(err => {
      console.log(`[BotAutomation ${accountId}] loop error:`, err.message)
      this._sendEvent({ accountId, type: 'error', message: err.message })
      this._sessions.delete(accountId)
    })
  }

  stop(accountId) {
    const s = this._sessions.get(accountId)
    if (!s) return
    s.running = false
    console.log(`[BotAutomation ${accountId}] stop requested`)
  }

  stopAll() {
    for (const id of [...this._sessions.keys()]) this.stop(id)
  }

  // === Internal ===

  _ensureScripts() {
    if (this._scriptsWritten) return
    try {
      mkdirSync(PS_DIR, { recursive: true })
      writeFileSync(join(PS_DIR, 'find-hwnd.ps1'), HWND_BY_PID_PS, 'utf8')
      writeFileSync(join(PS_DIR, 'activate-window.ps1'), ACTIVATE_PS, 'utf8')
      this._scriptsWritten = true
    } catch (e) {
      console.log('[BotAutomation] _ensureScripts error:', e.message)
    }
  }

  _sendEvent(payload) {
    // Broadcast на ВСЕ окна — events нужны и главному окну, и окну имитации
    // (которое имеет свой webContents). Иначе events приходят только в одно окно.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('automation:action', payload)
      }
    }
  }

  async _runLoop(accountId) {
    const session = this._sessions.get(accountId)
    if (!session) return

    while (session.running) {
      if (!cs2Launcher.isRunning(accountId)) {
        this._sendEvent({ accountId, type: 'error', message: 'CS2 закрылся' })
        break
      }

      const { value: action, done } = session.generator.next()
      if (done) break
      const { key, durationMs } = action

      const activated = this._activateWindow(session.hwnd)
      if (!activated) {
        this._sendEvent({ accountId, type: 'error', message: 'Не удалось активировать окно CS2' })
        break
      }
      await this._sleep(80)

      const nutKey = KEY_MAP[key]
      if (!nutKey) {
        this._sendEvent({ accountId, type: 'error', message: 'Неизвестная клавиша: ' + key })
        break
      }

      try {
        await keyboard.pressKey(nutKey)
        this._sendEvent({ accountId, type: 'press', key, durationMs })
        await this._sleep(durationMs)
      } finally {
        try { await keyboard.releaseKey(nutKey) } catch {}
      }
      this._sendEvent({ accountId, type: 'release', key })
    }

    this._sessions.delete(accountId)
    this._sendEvent({ accountId, type: 'stopped' })
    console.log(`[BotAutomation ${accountId}] stopped`)
  }

  // === Patterns ===

  *_squareGen() {
    while (true) {
      yield { key: 'w', durationMs: 2000 }
      yield { key: 'd', durationMs: 2000 }
      yield { key: 's', durationMs: 2000 }
      yield { key: 'a', durationMs: 2000 }
    }
  }

  *_randomGen() {
    const keys = ['w', 'a', 's', 'd']
    while (true) {
      const key = keys[Math.floor(Math.random() * keys.length)]
      const durationMs = 300 + Math.floor(Math.random() * 1200)
      yield { key, durationMs }
    }
  }

  // === Win32 helpers через временные PS-скрипты ===

  // Находит PID sandboxed cs2.exe. Использует фильтр по модулю SbieDll.dll —
  // надёжный маркер sandboxed процесса (тот же подход что CS2Launcher._countBoxedProcesses).
  // На текущем этапе панель работает с одним CS2 за раз, поэтому возвращаем первый matching.
  // boxName/sbPath приняты для будущего различения боксов (когда будет multi-window).
  _findCs2PidInBox(_boxName, _sbPath) {
    try {
      const out = execSync(
        `powershell -NoProfile -Command "Get-Process cs2 -EA SilentlyContinue | Where-Object { try { $_.Modules.ModuleName -contains 'SbieDll.dll' } catch { $false } } | Select-Object -ExpandProperty Id"`,
        { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim()
      if (!out) return null
      const pids = out.split(/\s+/).map(Number).filter(Boolean)
      return pids[0] || null
    } catch (e) {
      console.log('[BotAutomation] _findCs2PidInBox error:', e.message)
      return null
    }
  }

  _findHwndByPid(pid) {
    const script = join(PS_DIR, 'find-hwnd.ps1')
    if (!existsSync(script)) this._ensureScripts()
    try {
      const out = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -TargetPid ${pid}`,
        { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim()
      const hwnd = Number(out)
      return isNaN(hwnd) ? 0 : hwnd
    } catch (e) {
      console.log('[BotAutomation] _findHwndByPid error:', e.message)
      return 0
    }
  }

  _activateWindow(hwnd) {
    const script = join(PS_DIR, 'activate-window.ps1')
    if (!existsSync(script)) this._ensureScripts()
    try {
      const out = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -Hwnd ${hwnd}`,
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim()
      return out === 'OK'
    } catch (e) {
      console.log('[BotAutomation] _activateWindow error:', e.message)
      return false
    }
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
  }
}

export default new BotAutomation()
