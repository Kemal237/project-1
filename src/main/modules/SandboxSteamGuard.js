import { execSync } from 'child_process'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { keyboard, Key } from '@nut-tree-fork/nut-js'
import SteamTotp from 'steam-totp'

// Автоматический ввод Steam Guard кода в sandboxed Steam.
//
// Flow:
//   1. После запуска Steam.exe -login user pass, Steam может показать диалог
//      "Steam Guard - Computer Authorization Required"
//   2. Polling 500мс через EnumWindows ищет это окно по нескольким известным title-паттернам
//   3. Если найдено: генерирует код через steam-totp (с проверкой времени жизни),
//      активирует окно через AttachThreadInput (как в BotAutomation), вводит код через nut.js
//   4. Ждёт закрытия окна 5 сек. Если закрылось → код принят
//   5. Если не закрылось → код отклонён, retry до 3 раз
//   6. Если окно не появилось за GUARD_WAIT_TIMEOUT — Steam использовал cached login
//      (ssfn файлы валидны) → ничего делать не нужно

const PS_DIR = join(tmpdir(), 'cs2farmpanel-ps-guard')

const GUARD_WAIT_TIMEOUT = 60_000  // максимум ждём появления Guard окна
const GUARD_POLL_INTERVAL = 500    // интервал опроса
const CODE_SUBMIT_WAIT = 5000      // ждём закрытия окна после ввода кода
const MAX_RETRIES = 3              // попыток ввода если код отклонён
const MIN_CODE_LIFETIME = 3        // если код истекает раньше — ждём новый

// PS-скрипт: найти HWND окна Steam Guard (или любого Steam dialog с авторизацией).
// Используем несколько паттернов title т.к. зависит от языка/версии Steam.
const FIND_GUARD_PS = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class GuardFind {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

  public static IntPtr Find() {
    IntPtr found = IntPtr.Zero;
    EnumProc cb = delegate(IntPtr hWnd, IntPtr lp) {
      if (!IsWindowVisible(hWnd)) return true;
      int len = GetWindowTextLength(hWnd);
      if (len < 5) return true;
      StringBuilder sb = new StringBuilder(len + 1);
      GetWindowText(hWnd, sb, sb.Capacity);
      string title = sb.ToString().ToLower();
      // Возможные паттерны Steam Guard окна
      if (title.Contains("steam guard") ||
          title.Contains("computer authorization") ||
          title.Contains("авторизация компьютера") ||
          title.Contains("подтверждение steam guard")) {
        // Дополнительная проверка: класс окна — Steam использует "vguiPopupWindow"
        StringBuilder cn = new StringBuilder(256);
        GetClassName(hWnd, cn, cn.Capacity);
        string className = cn.ToString();
        if (className.Contains("vgui") || className.Contains("SDL") || className.Contains("Steam")) {
          found = hWnd;
          return false;
        }
        // Fallback: даже если класс не совпал, доверяем title
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
$h = [GuardFind]::Find()
Write-Output $h.ToInt64()
`.trim()

// PS-скрипт: проверить что HWND ещё валиден (окно не закрылось).
const IS_WINDOW_PS = `
param([long]$Hwnd)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WinCheck {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
'@
$h = [IntPtr]$Hwnd
$exists = [WinCheck]::IsWindow($h) -and [WinCheck]::IsWindowVisible($h)
Write-Output $(if ($exists) { '1' } else { '0' })
`.trim()

// PS-скрипт: активировать окно через AttachThreadInput trick (как в BotAutomation).
const ACTIVATE_PS = `
param([long]$Hwnd)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class GuardAct {
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
if (-not [GuardAct]::IsWindow($h)) { Write-Output 'INVALID'; exit }
$null = [GuardAct]::ShowWindow($h, 9)
$targetPid = [uint32]0
$targetTid = [GuardAct]::GetWindowThreadProcessId($h, [ref]$targetPid)
$ourTid = [GuardAct]::GetCurrentThreadId()
$null = [GuardAct]::AttachThreadInput($ourTid, $targetTid, $true)
$ok = [GuardAct]::SetForegroundWindow($h)
$null = [GuardAct]::SetFocus($h)
$null = [GuardAct]::AttachThreadInput($ourTid, $targetTid, $false)
Write-Output $(if ($ok) { 'OK' } else { 'FAIL' })
`.trim()

class SandboxSteamGuard {
  constructor() {
    this._scriptsWritten = false
  }

  _ensureScripts() {
    if (this._scriptsWritten) return
    try {
      mkdirSync(PS_DIR, { recursive: true })
      writeFileSync(join(PS_DIR, 'find-guard.ps1'),  FIND_GUARD_PS, 'utf8')
      writeFileSync(join(PS_DIR, 'is-window.ps1'),   IS_WINDOW_PS,  'utf8')
      writeFileSync(join(PS_DIR, 'activate-guard.ps1'), ACTIVATE_PS, 'utf8')
      this._scriptsWritten = true
    } catch (e) {
      console.log('[SandboxSteamGuard] _ensureScripts error:', e.message)
    }
  }

  // Главный API. Возвращает { ok, reason }:
  //   ok=true:  reason='no_guard_needed'  | 'auto_submitted'
  //   ok=false: reason='no_shared_secret' | 'window_not_found' | 'code_rejected' | 'activation_failed'
  async tryAutoInput(accountId, sharedSecret) {
    if (!sharedSecret) {
      console.log(`[SandboxSteamGuard ${accountId}] no shared_secret in DB — skipping auto-input (manual code required)`)
      return { ok: false, reason: 'no_shared_secret' }
    }

    this._ensureScripts()

    console.log(`[SandboxSteamGuard ${accountId}] waiting for Steam Guard window (max ${GUARD_WAIT_TIMEOUT / 1000}s)...`)
    const hwnd = await this._waitForGuardWindow(GUARD_WAIT_TIMEOUT)
    if (!hwnd) {
      console.log(`[SandboxSteamGuard ${accountId}] no Guard window appeared — Steam used cached login (ok)`)
      return { ok: true, reason: 'no_guard_needed' }
    }

    console.log(`[SandboxSteamGuard ${accountId}] Guard window found hwnd=${hwnd}, submitting code...`)

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const stillVisible = this._isWindowVisible(hwnd)
      if (!stillVisible) {
        console.log(`[SandboxSteamGuard ${accountId}] Guard window closed before attempt ${attempt} — likely accepted`)
        return { ok: true, reason: 'auto_submitted' }
      }

      const code = await this._generateFreshCode(sharedSecret)
      console.log(`[SandboxSteamGuard ${accountId}] attempt ${attempt}/${MAX_RETRIES}, code=${code}`)

      const activated = this._activateWindow(hwnd)
      if (!activated) {
        console.log(`[SandboxSteamGuard ${accountId}] activation failed on attempt ${attempt}`)
        if (attempt === MAX_RETRIES) return { ok: false, reason: 'activation_failed' }
        await this._sleep(2000)
        continue
      }

      await this._sleep(150)  // фокус устаканивается

      // Очищаем поле (на случай если что-то уже введено)
      try { await keyboard.pressKey(Key.LeftControl, Key.A); await keyboard.releaseKey(Key.LeftControl, Key.A) } catch {}
      await this._sleep(50)
      try { await keyboard.pressKey(Key.Delete); await keyboard.releaseKey(Key.Delete) } catch {}
      await this._sleep(50)

      // Вводим код по символу — надёжнее чем type() для коротких строк
      try {
        for (const ch of code) {
          const key = this._charToKey(ch)
          if (key) {
            await keyboard.pressKey(key)
            await this._sleep(30)
            await keyboard.releaseKey(key)
            await this._sleep(30)
          }
        }
        await this._sleep(100)
        await keyboard.pressKey(Key.Enter)
        await this._sleep(50)
        await keyboard.releaseKey(Key.Enter)
      } catch (e) {
        console.log(`[SandboxSteamGuard ${accountId}] keyboard input error: ${e.message}`)
        if (attempt === MAX_RETRIES) return { ok: false, reason: 'activation_failed' }
        await this._sleep(2000)
        continue
      }

      // Ждём CODE_SUBMIT_WAIT — если окно закрылось, код принят
      const closed = await this._waitForWindowClosed(hwnd, CODE_SUBMIT_WAIT)
      if (closed) {
        console.log(`[SandboxSteamGuard ${accountId}] code accepted on attempt ${attempt}`)
        return { ok: true, reason: 'auto_submitted' }
      }

      console.log(`[SandboxSteamGuard ${accountId}] code rejected on attempt ${attempt}, retrying...`)
    }

    console.log(`[SandboxSteamGuard ${accountId}] all ${MAX_RETRIES} attempts failed`)
    return { ok: false, reason: 'code_rejected' }
  }

  // === Internal ===

  async _generateFreshCode(sharedSecret) {
    // Steam Guard коды живут 30 сек (TOTP стандарт).
    // Если до конца текущего окна < MIN_CODE_LIFETIME — ждём следующее.
    const secsInWindow = Math.floor(Date.now() / 1000) % 30
    const remaining = 30 - secsInWindow
    if (remaining < MIN_CODE_LIFETIME) {
      console.log(`[SandboxSteamGuard] code expires in ${remaining}s, waiting for next window...`)
      await this._sleep((remaining + 1) * 1000)
    }
    return SteamTotp.generateAuthCode(sharedSecret)
  }

  async _waitForGuardWindow(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hwnd = this._findGuardWindow()
      if (hwnd) return hwnd
      await this._sleep(GUARD_POLL_INTERVAL)
    }
    return null
  }

  async _waitForWindowClosed(hwnd, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this._isWindowVisible(hwnd)) return true
      await this._sleep(250)
    }
    return false
  }

  _findGuardWindow() {
    const script = join(PS_DIR, 'find-guard.ps1')
    if (!existsSync(script)) this._ensureScripts()
    try {
      const out = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`,
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim()
      const hwnd = Number(out)
      return isNaN(hwnd) || hwnd === 0 ? null : hwnd
    } catch {
      return null
    }
  }

  _isWindowVisible(hwnd) {
    const script = join(PS_DIR, 'is-window.ps1')
    if (!existsSync(script)) this._ensureScripts()
    try {
      const out = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -Hwnd ${hwnd}`,
        { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim()
      return out === '1'
    } catch {
      return false
    }
  }

  _activateWindow(hwnd) {
    const script = join(PS_DIR, 'activate-guard.ps1')
    if (!existsSync(script)) this._ensureScripts()
    try {
      const out = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -Hwnd ${hwnd}`,
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim()
      return out === 'OK'
    } catch {
      return false
    }
  }

  _charToKey(ch) {
    const c = ch.toUpperCase()
    const map = {
      '0': Key.Num0, '1': Key.Num1, '2': Key.Num2, '3': Key.Num3, '4': Key.Num4,
      '5': Key.Num5, '6': Key.Num6, '7': Key.Num7, '8': Key.Num8, '9': Key.Num9,
      'A': Key.A, 'B': Key.B, 'C': Key.C, 'D': Key.D, 'E': Key.E, 'F': Key.F,
      'G': Key.G, 'H': Key.H, 'J': Key.J, 'K': Key.K, 'L': Key.L, 'M': Key.M,
      'N': Key.N, 'P': Key.P, 'Q': Key.Q, 'R': Key.R, 'T': Key.T, 'V': Key.V,
      'W': Key.W, 'X': Key.X, 'Y': Key.Y,
    }
    return map[c] || null
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
  }
}

export default new SandboxSteamGuard()
