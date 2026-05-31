import { execFileSync } from 'child_process'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { screen } from 'electron'
import cs2Launcher from './CS2Launcher'
import { computeGrid } from './WindowGridMath'

// Раскладывает уже запущенные окна CS2 по сетке через Win32 SetWindowPos.
// Размер окон сохраняется (SWP_NOSIZE) — двигаем только позицию.
// Чистая математика сетки — в WindowGridMath.js.

const PS_DIR = join(tmpdir(), 'cs2farmpanel-ps')

// PS-скрипт: принимает "pid:x:y;pid:x:y;...", находит окно каждого PID
// через EnumWindows и двигает его SetWindowPos(SWP_NOSIZE|SWP_NOZORDER).
// Выводит число перемещённых окон.
const ARRANGE_PS = `
param([string]$Moves)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WinGrid {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint flags);
  public static IntPtr Find(uint targetPid) {
    IntPtr found = IntPtr.Zero;
    EnumProc cb = delegate(IntPtr h, IntPtr l) {
      uint pid = 0; GetWindowThreadProcessId(h, out pid);
      if (pid == targetPid && IsWindowVisible(h) && GetWindowTextLength(h) > 0) { found = h; return false; }
      return true;
    };
    EnumWindows(cb, IntPtr.Zero);
    return found;
  }
}
'@
$SWP = 0x0001 -bor 0x0004  # SWP_NOSIZE | SWP_NOZORDER
$moved = 0
foreach ($m in $Moves.Split(';')) {
  if (-not $m) { continue }
  $p = $m.Split(':')
  $h = [WinGrid]::Find([uint32]$p[0])
  if ($h -ne [IntPtr]::Zero) {
    [WinGrid]::SetWindowPos($h, [IntPtr]::Zero, [int]$p[1], [int]$p[2], 0, 0, $SWP) | Out-Null
    $moved++
  }
}
Write-Output $moved
`.trim()

class WindowGrid {
  constructor() {
    this._scriptWritten = false
  }

  _ensureScript() {
    if (this._scriptWritten) return
    try {
      mkdirSync(PS_DIR, { recursive: true })
      writeFileSync(join(PS_DIR, 'arrange-windows.ps1'), ARRANGE_PS, 'utf8')
      this._scriptWritten = true
    } catch (e) {
      console.log('[WindowGrid] _ensureScript error:', e.message)
    }
  }

  // Раскладывает все запущенные окна CS2 по сетке.
  // opts.cols — ручной override числа столбцов (иначе авто).
  arrange(opts = {}) {
    const running = [...cs2Launcher._active.values()].filter(e => e.cs2Pid)
    if (!running.length) return { moved: 0 }

    let baseX = 0, baseY = 0
    try {
      const wa = screen.getPrimaryDisplay().workArea
      baseX = wa.x; baseY = wa.y
    } catch {}

    const colsRaw = parseInt(opts.cols, 10)
    const gridOpts = Number.isInteger(colsRaw) && colsRaw > 0 ? { cols: colsRaw } : {}
    const cells = computeGrid(running.length, gridOpts)

    const moves = running
      .map((e, i) => `${e.cs2Pid}:${baseX + cells[i].x}:${baseY + cells[i].y}`)
      .join(';')

    this._ensureScript()
    const script = join(PS_DIR, 'arrange-windows.ps1')
    try {
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Moves', moves],
        { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim()
      const moved = parseInt(out, 10) || 0
      console.log(`[WindowGrid] arranged ${moved}/${running.length} windows`)
      return { moved }
    } catch (e) {
      console.log('[WindowGrid] arrange error:', e.message)
      return { moved: 0, error: e.message }
    }
  }
}

export default new WindowGrid()
