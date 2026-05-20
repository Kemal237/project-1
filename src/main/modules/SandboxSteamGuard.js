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

// PS-скрипт: ищем Steam окно — login dialog ИЛИ Steam Guard окно.
// Возвращаем "type|hwnd":
//   "guard|<hwnd>" — окно Steam Guard (нужен 2FA код)
//   "login|<hwnd>" — окно входа Steam (нужны login+password)
//   "none|0"       — нет таких окон
//
// Логика:
//   1. Ищем все visible окна с классом Chrome_WidgetWin / SDL_app / vgui
//      (Steam в Sandboxie использует CEF или SDL — оба типа возможны)
//   2. Анализируем title:
//      - "steam guard" / "computer authorization" / "авторизация" → guard
//      - "sign in" / "войдите" / "steam" (без других слов) → login
//      - просто "Steam" без title → главное окно Steam (может быть login state)
//   3. Login dialog часто имеет title "Steam Sign In" или просто "Steam" (новый CEF UI)
const FIND_WINDOW_PS = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class SteamFind {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  public static string Find() {
    string guardResult = "none|0";
    string loginResult = "none|0";

    EnumProc cb = delegate(IntPtr hWnd, IntPtr lp) {
      if (!IsWindowVisible(hWnd)) return true;
      int len = GetWindowTextLength(hWnd);
      if (len < 4) return true;

      StringBuilder sb = new StringBuilder(len + 1);
      GetWindowText(hWnd, sb, sb.Capacity);
      string title = sb.ToString();
      string titleLower = title.ToLower();

      StringBuilder cn = new StringBuilder(256);
      GetClassName(hWnd, cn, cn.Capacity);
      string className = cn.ToString();
      bool steamClass = className.Contains("Chrome_WidgetWin") ||
                        className.Contains("SDL_app") ||
                        className.Contains("vgui") ||
                        className.Contains("CUIEngine");

      // Guard окно: явный indicator в title
      if (titleLower.Contains("steam guard") ||
          titleLower.Contains("computer authorization") ||
          titleLower.Contains("авторизация компьютера") ||
          titleLower.Contains("подтверждение steam guard")) {
        guardResult = "guard|" + hWnd.ToInt64();
        return true; // продолжаем искать
      }

      // Login dialog (старый формат): title "Steam Sign In" или "Steam - Вход"
      if (titleLower.Contains("sign in") || titleLower.Contains("steam - вход")) {
        loginResult = "login|" + hWnd.ToInt64();
        return true;
      }

      // Login dialog (новый CEF формат 2023+): title просто "Steam" + класс Chrome_WidgetWin
      // Это главное окно Steam — но в login state оно показывает login form
      // (отличить от уже-залогиненного state невозможно без OCR; используем как fallback)
      if (titleLower == "steam" && steamClass && loginResult == "none|0") {
        loginResult = "login|" + hWnd.ToInt64();
        return true;
      }

      return true;
    };
    EnumWindows(cb, IntPtr.Zero);

    // Guard приоритетнее login (если оба есть — сначала вводим код Guard)
    return guardResult != "none|0" ? guardResult : loginResult;
  }
}
'@
$r = [SteamFind]::Find()
Write-Output $r
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
      writeFileSync(join(PS_DIR, 'find-window.ps1'),  FIND_WINDOW_PS, 'utf8')
      writeFileSync(join(PS_DIR, 'is-window.ps1'),    IS_WINDOW_PS,   'utf8')
      writeFileSync(join(PS_DIR, 'activate-guard.ps1'), ACTIVATE_PS, 'utf8')
      this._scriptsWritten = true
    } catch (e) {
      console.log('[SandboxSteamGuard] _ensureScripts error:', e.message)
    }
  }

  // Главный API. Возвращает { ok, reason }.
  // Обрабатывает ДВА типа окон последовательно:
  //   1. Steam login dialog (поля логин+пароль) — вводим credentials через nut.js
  //   2. Steam Guard dialog (5-значный код) — вводим код из shared_secret
  // Если первого нет — Steam использует cached login. Если второго нет — ssfn доверяет машине.
  async tryAutoInput(accountId, login, password, sharedSecret) {
    this._ensureScripts()

    console.log(`[SandboxSteamGuard ${accountId}] waiting for Steam window (max ${GUARD_WAIT_TIMEOUT / 1000}s)...`)
    let loginSubmitted = false

    const deadline = Date.now() + GUARD_WAIT_TIMEOUT
    while (Date.now() < deadline) {
      const found = this._findSteamWindow()
      if (!found) {
        await this._sleep(GUARD_POLL_INTERVAL)
        continue
      }

      // Login dialog — вводим креды один раз
      if (found.type === 'login' && !loginSubmitted) {
        if (!login || !password) {
          console.log(`[SandboxSteamGuard ${accountId}] login dialog detected but no credentials — skip`)
          return { ok: false, reason: 'no_credentials' }
        }
        console.log(`[SandboxSteamGuard ${accountId}] login dialog hwnd=${found.hwnd}, entering credentials...`)
        const ok = await this._submitLogin(found.hwnd, login, password)
        if (!ok) {
          return { ok: false, reason: 'login_failed' }
        }
        loginSubmitted = true
        console.log(`[SandboxSteamGuard ${accountId}] credentials submitted, waiting for next step...`)
        await this._sleep(3000)  // даём Steam отреагировать
        continue
      }

      // Guard dialog — вводим код
      if (found.type === 'guard') {
        if (!sharedSecret) {
          console.log(`[SandboxSteamGuard ${accountId}] Guard window appeared but no shared_secret — manual input needed`)
          return { ok: false, reason: 'no_shared_secret' }
        }
        console.log(`[SandboxSteamGuard ${accountId}] Guard window hwnd=${found.hwnd}, submitting code...`)
        return await this._submitGuardCode(accountId, found.hwnd, sharedSecret)
      }

      await this._sleep(GUARD_POLL_INTERVAL)
    }

    if (loginSubmitted) {
      console.log(`[SandboxSteamGuard ${accountId}] login submitted, no Guard required — ssfn cached`)
      return { ok: true, reason: 'login_only' }
    }
    console.log(`[SandboxSteamGuard ${accountId}] no Steam window appeared — Steam used cached login (ok)`)
    return { ok: true, reason: 'no_guard_needed' }
  }

  // Вводит login + Tab + password + Enter в login dialog.
  async _submitLogin(hwnd, login, password) {
    if (!this._activateWindow(hwnd)) return false
    await this._sleep(400)  // Steam UI медленный, даём время на фокус

    try {
      // Очистим поле (на случай auto-fill)
      await keyboard.pressKey(Key.LeftControl, Key.A)
      await keyboard.releaseKey(Key.LeftControl, Key.A)
      await this._sleep(50)
      await keyboard.pressKey(Key.Delete)
      await keyboard.releaseKey(Key.Delete)
      await this._sleep(80)

      // Вводим логин
      await this._typeString(login)
      await this._sleep(150)

      // Tab → поле пароля
      await keyboard.pressKey(Key.Tab)
      await keyboard.releaseKey(Key.Tab)
      await this._sleep(150)

      // Вводим пароль
      await this._typeString(password)
      await this._sleep(150)

      // Enter → submit
      await keyboard.pressKey(Key.Enter)
      await keyboard.releaseKey(Key.Enter)
      return true
    } catch (e) {
      console.log(`[SandboxSteamGuard] _submitLogin error: ${e.message}`)
      return false
    }
  }

  async _submitGuardCode(accountId, hwnd, sharedSecret) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (!this._isWindowVisible(hwnd)) {
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
      await this._sleep(200)

      try {
        await keyboard.pressKey(Key.LeftControl, Key.A)
        await keyboard.releaseKey(Key.LeftControl, Key.A)
        await this._sleep(50)
        await keyboard.pressKey(Key.Delete)
        await keyboard.releaseKey(Key.Delete)
        await this._sleep(80)

        for (const ch of code) {
          const key = this._charToKey(ch)
          if (key) {
            await keyboard.pressKey(key)
            await this._sleep(40)
            await keyboard.releaseKey(key)
            await this._sleep(40)
          }
        }
        await this._sleep(120)
        await keyboard.pressKey(Key.Enter)
        await this._sleep(50)
        await keyboard.releaseKey(Key.Enter)
      } catch (e) {
        console.log(`[SandboxSteamGuard ${accountId}] keyboard input error: ${e.message}`)
        if (attempt === MAX_RETRIES) return { ok: false, reason: 'activation_failed' }
        await this._sleep(2000)
        continue
      }

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

  // Печатает произвольную строку через встроенный nut.js type() —
  // он сам обрабатывает спец-символы, регистр, layouts (важно для паролей
  // которые могут содержать !@#$% и подобное).
  async _typeString(str) {
    try {
      // Замедляем для надёжности (CEF UI Steam может терять символы при быстром вводе)
      const prevDelay = keyboard.config.autoDelayMs
      keyboard.config.autoDelayMs = 35
      await keyboard.type(str)
      keyboard.config.autoDelayMs = prevDelay
    } catch (e) {
      console.log(`[SandboxSteamGuard] _typeString error: ${e.message}`)
      throw e
    }
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

  async _waitForWindowClosed(hwnd, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this._isWindowVisible(hwnd)) return true
      await this._sleep(250)
    }
    return false
  }

  // Возвращает { type: 'login'|'guard', hwnd: number } или null если ничего не найдено
  _findSteamWindow() {
    const script = join(PS_DIR, 'find-window.ps1')
    if (!existsSync(script)) this._ensureScripts()
    try {
      const out = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`,
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim()
      const [type, hwndStr] = out.split('|')
      if (type === 'none') return null
      const hwnd = Number(hwndStr)
      if (isNaN(hwnd) || hwnd === 0) return null
      return { type, hwnd }
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
