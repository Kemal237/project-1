import { execSync } from 'child_process'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { keyboard, Key, mouse, Point, Button } from '@nut-tree-fork/nut-js'
import SteamTotp from 'steam-totp'

// Автоматический ввод логина+пароля+Steam Guard в sandboxed Steam.
//
// КЛЮЧЕВАЯ ИДЕЯ (v1.1.8): окна ищем НАПРЯМУЮ через EnumWindows без фильтра
// по PID. Get-Process не видит sandboxed Steam-процессы (проверено логом
// "<no steam/steamwebhelper processes found>"), но EnumWindows их видит
// (BotAutomation так же находит окно CS2). Фильтруем top-level окна
// по классу (Chrome_WidgetWin*, SDL_app, vgui*), размеру и title.

const PS_DIR = join(tmpdir(), 'cs2farmpanel-ps-guard')

const POLL_TIMEOUT      = 600_000  // 10 мин — первый запуск Steam в боксе скачивает клиент
const POLL_INTERVAL     = 1500
const CODE_SUBMIT_WAIT  = 5000
const MAX_RETRIES       = 3
const MIN_CODE_LIFETIME = 3
const POST_LOGIN_WAIT   = 4000
// Окно "Войти в Steam" создаётся с готовым title, но CEF внутри рисуется ~5-10с.
// Если ввести сразу — данные уйдут в пустоту. Ждём перед первым вводом.
const LOGIN_FORM_RENDER_WAIT = 8000
// Сколько ждать после ввода логина прежде чем считать что Steam показал Guard форму
// в том же окне (CEF меняет HTML, hwnd и title остаются прежние).
const POST_LOGIN_GUARD_WAIT  = 5000

// PS-скрипт: возвращает ВСЕ top-level окна с непустым title.
// Фильтрация по классу убрана — sandboxed Steam splash имеет нестандартный класс.
// Sandboxed окна определяем в JS по маркеру "[#]" в title (добавляет Sandboxie).
// Также отсекаем 0x0 окна (невидимые placeholder'ы) — их в Windows десятки.
// Возвращает JSON: [{hwnd, pid, title, class, width, height, visible}]
const ENUM_STEAM_WINDOWS_PS = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class WinE {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static List<long[]> Wins = new List<long[]>();
  public static List<string> Titles = new List<string>();
  public static List<string> Classes = new List<string>();

  public static void Enumerate() {
    Wins.Clear(); Titles.Clear(); Classes.Clear();
    EnumProc cb = delegate(IntPtr hWnd, IntPtr lp) {
      int len = GetWindowTextLength(hWnd);
      if (len < 1) return true;  // окна с пустым title не интересны
      StringBuilder t = new StringBuilder(len + 1);
      GetWindowText(hWnd, t, t.Capacity);
      string title = t.ToString();
      RECT r;
      int w = 0, h = 0, x = 0, y = 0;
      if (GetWindowRect(hWnd, out r)) { x = r.Left; y = r.Top; w = r.Right - r.Left; h = r.Bottom - r.Top; }
      if (w < 100 || h < 100) return true;  // отсекаем placeholder'ы
      StringBuilder c = new StringBuilder(256);
      GetClassName(hWnd, c, c.Capacity);
      bool visible = IsWindowVisible(hWnd);
      uint pid = 0;
      GetWindowThreadProcessId(hWnd, out pid);
      Wins.Add(new long[] { hWnd.ToInt64(), (long)pid, w, h, visible ? 1L : 0L, x, y });
      Titles.Add(title);
      Classes.Add(c.ToString());
      return true;
    };
    EnumWindows(cb, IntPtr.Zero);
  }
}
'@
[WinE]::Enumerate()
$out = New-Object 'System.Collections.Generic.List[object]'
for ($i = 0; $i -lt [WinE]::Wins.Count; $i++) {
  $w = [WinE]::Wins[$i]
  $obj = [PSCustomObject]@{
    hwnd    = $w[0]
    pid     = [int]$w[1]
    width   = [int]$w[2]
    height  = [int]$w[3]
    visible = ($w[4] -eq 1)
    left    = [int]$w[5]
    top     = [int]$w[6]
    title   = [WinE]::Titles[$i]
    class   = [WinE]::Classes[$i]
  }
  $out.Add($obj)
}
$out | ConvertTo-Json -Compress
`.trim()

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
    this._seenHwnds = new Set()  // hwnd-ы которые уже логировались (чтоб не спамить)
    this._loginHwnd = null
    this._loginRect = null
    this._loginSubmittedAt = 0
  }

  _ensureScripts() {
    if (this._scriptsWritten) return
    try {
      mkdirSync(PS_DIR, { recursive: true })
      writeFileSync(join(PS_DIR, 'enum-steam-windows.ps1'), ENUM_STEAM_WINDOWS_PS, 'utf8')
      writeFileSync(join(PS_DIR, 'is-window.ps1'),          IS_WINDOW_PS,          'utf8')
      writeFileSync(join(PS_DIR, 'activate-guard.ps1'),     ACTIVATE_PS,           'utf8')
      this._scriptsWritten = true
    } catch (e) {
      console.log('[SandboxSteamGuard] _ensureScripts error:', e.message)
    }
  }

  async tryAutoInput(accountId, login, password, sharedSecret) {
    this._ensureScripts()
    this._seenHwnds.clear()
    this._loginHwnd = null
    this._loginRect = null
    this._loginSubmittedAt = 0

    console.log(`[SandboxSteamGuard ${accountId}] waiting for Steam window (max ${POLL_TIMEOUT / 1000}s)...`)
    let loginSubmitted = false

    const deadline = Date.now() + POLL_TIMEOUT
    while (Date.now() < deadline) {
      const allWindows = this._enumSteamWindows()
      // Sandboxie добавляет маркер [#] в title И префикс Sandbox:<box>: к classname.
      // Любой из двух признаков надёжно идентифицирует sandboxed окно.
      const sandboxed = allWindows.filter(w =>
        (w.title || '').includes('[#]') || (w.class || '').startsWith('Sandbox:')
      )

      // Логируем каждое НОВОЕ окно (по hwnd) — увидим как Steam развивается:
      // splash → bootstrap → login dialog → main UI
      const fresh = sandboxed.filter(w => !this._seenHwnds.has(w.hwnd))
      if (fresh.length > 0) {
        for (const w of fresh) this._seenHwnds.add(w.hwnd)
        const summary = fresh.map(w =>
          `[${w.visible?'V':'-'} ${w.width}x${w.height} class="${w.class}" title="${w.title}"]`
        ).join(' ')
        console.log(`[SandboxSteamGuard ${accountId}] new sandboxed window(s): ${summary}`)
      }

      const found = this._classifyWindows(sandboxed)

      if (found.login && !loginSubmitted) {
        if (!login || !password) {
          console.log(`[SandboxSteamGuard ${accountId}] login dialog detected but no credentials — skip`)
          return { ok: false, reason: 'no_credentials' }
        }
        console.log(`[SandboxSteamGuard ${accountId}] login dialog hwnd=${found.login} (${found.loginInfo}), waiting ${LOGIN_FORM_RENDER_WAIT/1000}s for CEF form to render...`)
        await this._sleep(LOGIN_FORM_RENDER_WAIT)

        if (!this._isWindowVisible(found.login)) {
          console.log(`[SandboxSteamGuard ${accountId}] login window closed before submit — already accepted`)
          return { ok: true, reason: 'login_already_accepted' }
        }

        console.log(`[SandboxSteamGuard ${accountId}] entering credentials...`)
        const ok = await this._submitLogin(found.login, found.loginRect, login, password)
        if (!ok) return { ok: false, reason: 'login_failed' }

        loginSubmitted = true
        // Сохраняем rect окна — CEF UI Steam держит тот же hwnd для Login/Guard/MainUI,
        // переключая HTML-содержимое. Нам нужны координаты для последующего клика на Guard.
        this._loginHwnd = found.login
        this._loginRect = found.loginRect
        this._loginSubmittedAt = Date.now()
        console.log(`[SandboxSteamGuard ${accountId}] credentials submitted, monitoring window for guard/done...`)
        await this._sleep(POST_LOGIN_WAIT)
        continue
      }

      // Явный Guard window (Steam дал ему отдельный hwnd или сменил title)
      if (found.guard) {
        if (!sharedSecret) {
          console.log(`[SandboxSteamGuard ${accountId}] Guard window appeared but no shared_secret — manual input needed`)
          return { ok: false, reason: 'no_shared_secret' }
        }
        console.log(`[SandboxSteamGuard ${accountId}] Guard window hwnd=${found.guard} (${found.guardInfo}), submitting code...`)
        return await this._submitGuardCode(accountId, found.guard, found.guardRect || this._loginRect, sharedSecret)
      }

      // После ввода логина — отслеживаем что происходит с тем же CEF окном.
      // Title часто НЕ меняется (CEF не апдейтит WIN32 title при смене HTML).
      // Эвристика: окно живо ≥ POST_LOGIN_GUARD_WAIT → считаем что показан Guard.
      if (loginSubmitted && this._loginHwnd) {
        const sinceLogin = Date.now() - this._loginSubmittedAt
        const stillVisible = this._isWindowVisible(this._loginHwnd)

        if (!stillVisible) {
          console.log(`[SandboxSteamGuard ${accountId}] login window closed — login accepted, no Guard required`)
          return { ok: true, reason: 'login_only' }
        }

        if (sinceLogin >= POST_LOGIN_GUARD_WAIT) {
          if (!sharedSecret) {
            console.log(`[SandboxSteamGuard ${accountId}] window still open ${Math.floor(sinceLogin/1000)}s after login but no shared_secret — manual Guard input needed`)
            return { ok: false, reason: 'no_shared_secret' }
          }
          console.log(`[SandboxSteamGuard ${accountId}] window still open ${Math.floor(sinceLogin/1000)}s after login — assuming Guard form, submitting code...`)
          return await this._submitGuardCode(accountId, this._loginHwnd, this._loginRect, sharedSecret)
        }
      }

      await this._sleep(POLL_INTERVAL)
    }

    if (loginSubmitted) {
      console.log(`[SandboxSteamGuard ${accountId}] login submitted, no Guard required — ssfn cached`)
      return { ok: true, reason: 'login_only' }
    }
    console.log(`[SandboxSteamGuard ${accountId}] no Steam window appeared — Steam used cached login (ok)`)
    return { ok: true, reason: 'no_guard_needed' }
  }

  // === Внутренняя логика ===

  _enumSteamWindows() {
    const script = join(PS_DIR, 'enum-steam-windows.ps1')
    if (!existsSync(script)) this._ensureScripts()
    try {
      const out = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`,
        { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim()
      if (!out) return []
      let parsed
      try { parsed = JSON.parse(out) } catch { return [] }
      if (!Array.isArray(parsed)) parsed = [parsed]
      return parsed
    } catch {
      return []
    }
  }

  _classifyWindows(windows) {
    let guard = null, guardInfo = '', guardRect = null
    let bestLogin = null

    for (const w of windows) {
      if (!w.visible) continue
      // Чистим title от Sandboxie маркеров "[#] ... [#]" перед матчингом
      const rawTitle  = (w.title || '')
      const cleanRaw  = rawTitle.replace(/\[#\]/g, '').trim()
      const title     = cleanRaw.toLowerCase()
      const cls       = w.class || ''
      const area      = w.width * w.height

      // Guard: явный indicator в title
      if (title.includes('steam guard') ||
          title.includes('computer authorization') ||
          title.includes('авторизация компьютера') ||
          title.includes('подтверждение steam guard')) {
        guard = w.hwnd
        guardInfo = `${w.width}x${w.height}@(${w.left},${w.top}) "${rawTitle}"`
        guardRect = { left: w.left, top: w.top, width: w.width, height: w.height }
        continue
      }

      // Splash Steam ("Steam — синхронизация" / "Steam — Loading" / "Updating Steam")
      // обычно меньше login UI. Login 2024+ ~720x480 минимум. Порог ≥500x350.
      if (w.width < 500 || w.height < 350) continue

      // Login: явные ключевые слова в title после чистки от Sandboxie маркера
      const isExplicitLogin =
        title.includes('sign in') ||
        title.includes('войти') ||
        title.includes('вход') ||
        title === 'steam'

      // CEF login без явного title (после чистки пустой)
      const isCefLogin =
        title === '' &&
        (cls.includes('Chrome_WidgetWin') || cls.includes('SDL_app'))

      // Страховка: sandboxed Steam UI окно подходящего размера с любым
      // упоминанием "steam" в title (латиница не страдает от кодировки).
      // Класс SDL_app / Chrome_WidgetWin / CUIEngine + размер ≥500x350.
      const isSandboxedSteamUi =
        (cls.includes('SDL_app') || cls.includes('Chrome_WidgetWin') || cls.includes('CUIEngine')) &&
        title.includes('steam')

      if (isExplicitLogin || isCefLogin || isSandboxedSteamUi) {
        if (!bestLogin || area > bestLogin.area) {
          bestLogin = {
            hwnd: w.hwnd,
            area,
            left: w.left,
            top: w.top,
            width: w.width,
            height: w.height,
            info: `${w.width}x${w.height}@(${w.left},${w.top}) "${rawTitle}" class="${cls}"`,
          }
        }
      }
    }

    return {
      login:     bestLogin?.hwnd || null,
      loginRect: bestLogin ? { left: bestLogin.left, top: bestLogin.top, width: bestLogin.width, height: bestLogin.height } : null,
      loginInfo: bestLogin?.info || '',
      guard,
      guardRect,
      guardInfo,
    }
  }

  async _submitLogin(hwnd, rect, login, password) {
    if (!this._activateWindow(hwnd)) return false
    await this._sleep(500)

    try {
      // Steam CEF login UI: окно ~705x440. Поле "Имя аккаунта" в левой колонке,
      // под подписью. Координаты пропорциональны (на случай других размеров окна):
      //   X: ~25% от ширины (левая колонка по центру)
      //   Y: ~32% от высоты (под заголовком поля)
      // Поле пароля — Y ~52%.
      const loginFieldX = rect.left + Math.floor(rect.width * 0.25)
      const loginFieldY = rect.top  + Math.floor(rect.height * 0.32)
      const passFieldX  = loginFieldX
      const passFieldY  = rect.top  + Math.floor(rect.height * 0.52)

      // Сохраним прежнее autoDelayMs у мыши и keyboard
      const prevMouseDelay = mouse.config.autoDelayMs
      mouse.config.autoDelayMs = 50

      // Клик по полю логина → фокус
      await mouse.setPosition(new Point(loginFieldX, loginFieldY))
      await this._sleep(80)
      await mouse.click(Button.LEFT)
      await this._sleep(250)

      // Очистим поле на случай auto-fill
      await keyboard.pressKey(Key.LeftControl, Key.A)
      await keyboard.releaseKey(Key.LeftControl, Key.A)
      await this._sleep(80)
      await keyboard.pressKey(Key.Delete)
      await keyboard.releaseKey(Key.Delete)
      await this._sleep(100)

      await this._typeString(login)
      await this._sleep(250)

      // Клик по полю пароля → фокус (надёжнее чем Tab, он может уйти на checkbox/QR)
      await mouse.setPosition(new Point(passFieldX, passFieldY))
      await this._sleep(80)
      await mouse.click(Button.LEFT)
      await this._sleep(250)

      await keyboard.pressKey(Key.LeftControl, Key.A)
      await keyboard.releaseKey(Key.LeftControl, Key.A)
      await this._sleep(80)
      await keyboard.pressKey(Key.Delete)
      await keyboard.releaseKey(Key.Delete)
      await this._sleep(100)

      await this._typeString(password)
      await this._sleep(250)

      await keyboard.pressKey(Key.Enter)
      await keyboard.releaseKey(Key.Enter)

      mouse.config.autoDelayMs = prevMouseDelay
      return true
    } catch (e) {
      console.log(`[SandboxSteamGuard] _submitLogin error: ${e.message}`)
      return false
    }
  }

  async _submitGuardCode(accountId, hwnd, rect, sharedSecret) {
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
      await this._sleep(400)

      try {
        // Steam Guard CEF UI: 5-значное поле для кода обычно в центре окна.
        // Y ~45% от высоты, X центр (50%). Если rect не передан — fallback
        // на простую активацию без клика мыши.
        if (rect) {
          const cx = rect.left + Math.floor(rect.width  * 0.50)
          const cy = rect.top  + Math.floor(rect.height * 0.45)
          const prevMouseDelay = mouse.config.autoDelayMs
          mouse.config.autoDelayMs = 50
          await mouse.setPosition(new Point(cx, cy))
          await this._sleep(80)
          await mouse.click(Button.LEFT)
          await this._sleep(250)
          mouse.config.autoDelayMs = prevMouseDelay
        }

        await keyboard.pressKey(Key.LeftControl, Key.A)
        await keyboard.releaseKey(Key.LeftControl, Key.A)
        await this._sleep(60)
        await keyboard.pressKey(Key.Delete)
        await keyboard.releaseKey(Key.Delete)
        await this._sleep(100)

        for (const ch of code) {
          const key = this._charToKey(ch)
          if (key) {
            await keyboard.pressKey(key)
            await this._sleep(50)
            await keyboard.releaseKey(key)
            await this._sleep(50)
          }
        }
        await this._sleep(150)
        await keyboard.pressKey(Key.Enter)
        await this._sleep(60)
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

  async _typeString(str) {
    try {
      const prevDelay = keyboard.config.autoDelayMs
      keyboard.config.autoDelayMs = 35
      await keyboard.type(str)
      keyboard.config.autoDelayMs = prevDelay
    } catch (e) {
      console.log(`[SandboxSteamGuard] _typeString error: ${e.message}`)
      throw e
    }
  }

  async _generateFreshCode(sharedSecret) {
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
