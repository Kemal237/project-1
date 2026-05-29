import { execSync } from 'child_process'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { clipboard } from 'electron'
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
// Только 1 попытка ввода Guard — Steam агрессивно банит за частые failed
// попытки ("Слишком много попыток" → 15-30 минут блокировки IP). Если 1
// попытка с правильным autoDelay не сработала — это либо неверный
// shared_secret, либо timing — повторять автоматически опасно.
const MAX_RETRIES       = 1
const MIN_CODE_LIFETIME = 3
const POST_LOGIN_WAIT   = 4000
// Окно "Войти в Steam" создаётся с готовым title, но CEF внутри рисуется ~5-10с.
// Если ввести сразу — данные уйдут в пустоту. Ждём перед первым вводом.
const LOGIN_FORM_RENDER_WAIT = 8000
// Сколько ждать после ввода логина прежде чем считать что Steam показал Guard форму
// в том же окне. CEF держит тот же hwnd, title И размер — детектируем только
// по таймауту (если окно живо через N секунд после ввода логина → Guard).
const POST_LOGIN_GUARD_WAIT  = 3000
// Если размер окна вырос ≥ MAIN_UI_AREA_THRESHOLD — это значит Steam успешно
// залогинился и переключился на главный UI (он гораздо больше login/guard форм).
// Это всё ещё работает для определения SUCCESS (login_accepted).
const MAIN_UI_AREA_THRESHOLD = 1_200 * 700
// Пауза после клика мыши на input поле — даём CEF время поставить фокус.
// Стандартные 200-300мс не хватает в Sandboxie + новый CEF Steam.
const FOCUS_WAIT_AFTER_CLICK = 800

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

// PS-скрипт: в ОДНОМ процессе активирует окно, КЛИКАЕТ по полю ввода (ставит
// caret в нужный input), затем шлёт Ctrl+A + Ctrl+V (+ опц. Enter) через SendKeys.
//
// Почему всё в одном процессе и именно в таком порядке:
//   1) SetForegroundWindow — окно Steam на переднем плане (нужно для SendKeys).
//   2) Клик мышью по (X,Y) ВНУТРИ уже активного окна — ставит caret в поле CEF.
//      Это ПОСЛЕДНЕЕ действие, ставящее фокус, прямо перед вставкой.
//   3) Ctrl+A + Ctrl+V — вставка в сфокусированное поле.
//
// РАНЬШЕ было два бага: (а) активация и SendKeys в РАЗНЫХ процессах — foreground
// терялся между ними; (б) SetFocus($h) на top-level окно уводил фокус С поля
// ВВОДА обратно на рамку → в момент вставки "поле не выбрано", текст не вставлялся.
// Оба исправлены: один процесс + клик по полю вместо SetFocus.
const PASTE_PS = `
param([long]$Hwnd, [int]$X = 0, [int]$Y = 0, [int]$Enter = 0)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Paster {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int n);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
'@
# Явный Ctrl+<key> через keybd_event с контролируемыми задержками. Надёжнее
# SendKeys: каждый шаг (Ctrl down -> key down -> key up -> Ctrl up) с паузой,
# Ctrl гарантированно дожимается и отпускается — не залипает между ^a и ^v.
function Send-Ctrl([byte]$vk) {
  [Paster]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40  # Ctrl down
  [Paster]::keybd_event($vk,  0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60  # key down
  [Paster]::keybd_event($vk,  0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40  # key up
  [Paster]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40  # Ctrl up
}
$h = [IntPtr]$Hwnd
if (-not [Paster]::IsWindow($h)) { Write-Output 'INVALID'; exit }
$targetPid = [uint32]0
$targetTid = [Paster]::GetWindowThreadProcessId($h, [ref]$targetPid)
$ourTid = [Paster]::GetCurrentThreadId()
$null = [Paster]::AttachThreadInput($ourTid, $targetTid, $true)
$null = [Paster]::ShowWindow($h, 9)
$null = [Paster]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 250
if ($X -gt 0 -and $Y -gt 0) {
  $null = [Paster]::SetCursorPos($X, $Y)
  Start-Sleep -Milliseconds 60
  [Paster]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)  # LEFTDOWN
  Start-Sleep -Milliseconds 40
  [Paster]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)  # LEFTUP
  Start-Sleep -Milliseconds 350
}
Send-Ctrl 0x41        # Ctrl+A — выделить содержимое поля
Start-Sleep -Milliseconds 120
Send-Ctrl 0x56        # Ctrl+V — вставить
Start-Sleep -Milliseconds 200
if ($Enter -eq 1) {
  [Paster]::keybd_event(0x0D, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40  # Enter down
  [Paster]::keybd_event(0x0D, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 80  # Enter up
}
$null = [Paster]::AttachThreadInput($ourTid, $targetTid, $false)
Write-Output 'OK'
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
      writeFileSync(join(PS_DIR, 'paste-to-window.ps1'),    PASTE_PS,              'utf8')
      this._scriptsWritten = true
    } catch (e) {
      console.log('[SandboxSteamGuard] _ensureScripts error:', e.message)
    }
  }

  async tryAutoInput(accountId, login, password, sharedSecret, onStep, options = {}) {
    const { boxName = null } = options
    this._ensureScripts()
    this._seenHwnds.clear()
    this._loginHwnd = null
    this._loginRect = null
    this._loginSubmittedAt = 0

    // Безопасная обёртка — onStep может быть undefined
    const step = (status, message) => {
      try { onStep && onStep(status, message) } catch {}
    }

    console.log(`[SandboxSteamGuard ${accountId}] waiting for Steam window (max ${POLL_TIMEOUT / 1000}s)...`)
    let loginSubmitted = false

    const deadline = Date.now() + POLL_TIMEOUT
    while (Date.now() < deadline) {
      const allWindows = this._enumSteamWindows()
      // Sandboxie добавляет маркер [#] в title И префикс Sandbox:<box>: к classname.
      // boxName задан → СТРОГО окна нашего бокса (класс "Sandbox:<box>:..."),
      // иначе авто-ввод при 2+ запущенных боксах может попасть в окно чужого
      // аккаунта. Без boxName (одиночный запуск) — любой из двух признаков.
      const sandboxed = allWindows.filter(w => {
        const cls = w.class || ''
        const isSandboxed = (w.title || '').includes('[#]') || cls.startsWith('Sandbox:')
        if (!isSandboxed) return false
        // boxName задан → исключаем окна ЧУЖИХ боксов (Sandbox:<other>:...),
        // чтобы при 2+ запущенных аккаунтах авто-ввод не попал в чужое окно.
        // Окна нашего бокса и неоднозначные (только [#], без Sandbox:-класса)
        // оставляем — это не ломает одиночный запуск.
        if (boxName && cls.startsWith('Sandbox:') && !cls.startsWith(`Sandbox:${boxName}:`)) {
          return false
        }
        return true
      })

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

      // Steam показал "Слишком много попыток" — не пытаемся дальше, это
      // временный бан 15-30 мин. Выводим понятный статус и выходим.
      if (found.rateLimited) {
        console.log(`[SandboxSteamGuard ${accountId}] Steam rate limit detected — too many failed attempts. Wait 15-30 min or change IP.`)
        step('error', 'Steam: слишком много попыток. Подожди 15-30 мин или смени IP')
        return { ok: false, reason: 'rate_limited' }
      }

      if (found.login && !loginSubmitted) {
        if (!login || !password) {
          console.log(`[SandboxSteamGuard ${accountId}] login dialog detected but no credentials — skip`)
          return { ok: false, reason: 'no_credentials' }
        }
        console.log(`[SandboxSteamGuard ${accountId}] login dialog hwnd=${found.login} (${found.loginInfo}), waiting ${LOGIN_FORM_RENDER_WAIT/1000}s for CEF form to render...`)
        step('steam_login_form', 'Окно входа Steam обнаружено')
        await this._sleep(LOGIN_FORM_RENDER_WAIT)

        if (!this._isWindowVisible(found.login)) {
          console.log(`[SandboxSteamGuard ${accountId}] login window closed before submit — already accepted`)
          step('steam_logged_in', 'Авторизация завершена')
          return { ok: true, reason: 'login_already_accepted' }
        }

        console.log(`[SandboxSteamGuard ${accountId}] entering credentials...`)
        step('steam_entering_creds', 'Ввод логина и пароля...')
        const ok = await this._submitLogin(found.login, found.loginRect, login, password)
        if (!ok) {
          step('error', 'Не удалось ввести логин/пароль')
          return { ok: false, reason: 'login_failed' }
        }

        loginSubmitted = true
        // Сохраняем rect окна — CEF UI Steam держит тот же hwnd для Login/Guard/MainUI,
        // переключая HTML-содержимое. Нам нужны координаты для последующего клика на Guard.
        this._loginHwnd = found.login
        this._loginRect = found.loginRect
        this._loginSubmittedAt = Date.now()
        console.log(`[SandboxSteamGuard ${accountId}] credentials submitted, monitoring window for guard/done...`)
        step('steam_creds_submitted', 'Логин отправлен, ожидание Steam Guard...')
        await this._sleep(POST_LOGIN_WAIT)
        continue
      }

      // Явный Guard window (Steam дал ему отдельный hwnd или сменил title)
      if (found.guard) {
        if (!sharedSecret) {
          console.log(`[SandboxSteamGuard ${accountId}] Guard window appeared but no shared_secret — manual input needed`)
          step('awaiting_guard', 'Требуется ручной ввод Steam Guard')
          return { ok: false, reason: 'no_shared_secret' }
        }
        console.log(`[SandboxSteamGuard ${accountId}] Guard window hwnd=${found.guard} (${found.guardInfo}), submitting code...`)
        step('steam_entering_guard', 'Ввод кода Steam Guard...')
        const result = await this._submitGuardCode(accountId, found.guard, found.guardRect || this._loginRect, sharedSecret)
        if (result.ok) step('steam_logged_in', 'Авторизация Steam Guard прошла')
        else step('error', 'Steam Guard код отклонён')
        return result
      }

      // После ввода логина — отслеживаем СМЕНУ СТРАНИЦЫ через размер окна.
      // Steam CEF держит тот же hwnd и title для login/guard/main UI, но
      // меняет РАЗМЕР окна при смене страницы. Это надёжнее чем таймаут.
      if (loginSubmitted && this._loginHwnd) {
        const sinceLogin = Date.now() - this._loginSubmittedAt
        const currRect   = this._getWindowRect(this._loginHwnd)

        if (!currRect) {
          console.log(`[SandboxSteamGuard ${accountId}] login window closed — login accepted, no Guard required`)
          step('steam_logged_in', 'Авторизация завершена (без Guard)')
          return { ok: true, reason: 'login_only' }
        }

        const currArea = currRect.width * currRect.height

        // Окно стало главным UI Steam → login принят полностью
        if (currArea >= MAIN_UI_AREA_THRESHOLD) {
          console.log(`[SandboxSteamGuard ${accountId}] window grew to ${currRect.width}x${currRect.height} — main Steam UI, login fully accepted`)
          step('steam_logged_in', 'Авторизация Steam завершена')
          return { ok: true, reason: 'login_accepted' }
        }

        // Окно живо ≥ POST_LOGIN_GUARD_WAIT после login → Steam показывает
        // Guard форму в том же окне (размер CEF не меняет — подтверждено тестами).
        if (sinceLogin >= POST_LOGIN_GUARD_WAIT) {
          if (!sharedSecret) {
            console.log(`[SandboxSteamGuard ${accountId}] window still open ${Math.floor(sinceLogin/1000)}s after login (${currRect.width}x${currRect.height}), no shared_secret — manual input needed`)
            step('awaiting_guard', 'Требуется ручной ввод Steam Guard')
            return { ok: false, reason: 'no_shared_secret' }
          }
          console.log(`[SandboxSteamGuard ${accountId}] Guard form expected (${currRect.width}x${currRect.height}, ${Math.floor(sinceLogin/1000)}s after login), submitting code...`)
          step('steam_entering_guard', 'Ввод кода Steam Guard...')
          const result = await this._submitGuardCode(accountId, this._loginHwnd, currRect, sharedSecret)
          if (result.ok) step('steam_logged_in', 'Авторизация Steam Guard прошла')
          else step('error', 'Steam Guard код отклонён')
          return result
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
    let rateLimited = false

    for (const w of windows) {
      if (!w.visible) continue
      // Чистим title от Sandboxie маркеров "[#] ... [#]" перед матчингом
      const rawTitle  = (w.title || '')
      const cleanRaw  = rawTitle.replace(/\[#\]/g, '').trim()
      const title     = cleanRaw.toLowerCase()
      const cls       = w.class || ''
      const area      = w.width * w.height

      // Rate limit ошибка Steam: "Слишком много попыток" / "Too many attempts"
      if (title.includes('слишком много попыток') ||
          title.includes('too many') ||
          title.includes('too many login') ||
          title.includes('too many failed')) {
        rateLimited = true
      }

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
      rateLimited,
    }
  }

  async _submitLogin(hwnd, rect, login, password) {
    if (!this._activateWindow(hwnd)) return false
    await this._sleep(700)  // даём окну фокус после активации

    try {
      // Steam CEF login UI: окно ~705x440. Поле "Имя аккаунта" в левой колонке.
      //   X: ~25% от ширины (левая колонка)
      //   Y: ~32% (поле логина) и ~52% (поле пароля) от высоты
      const loginX = rect.left + Math.floor(rect.width  * 0.25)
      const loginY = rect.top  + Math.floor(rect.height * 0.32)
      const passX  = loginX
      const passY  = rect.top  + Math.floor(rect.height * 0.52)

      // _pasteText активирует окно, кликает по полю (caret в input) и вставляет
      // буфер (Ctrl+A+Ctrl+V) — всё в одном PS-процессе. Enter только после
      // пароля — отправка формы входа.
      await this._pasteText(hwnd, loginX, loginY, login, false)
      await this._sleep(400)

      await this._pasteText(hwnd, passX, passY, password, true)  // пароль + Enter (submit)
      await this._sleep(400)

      return true
    } catch (e) {
      console.log(`[SandboxSteamGuard] _submitLogin error: ${e.message}`)
      return false
    }
  }

  // Фокус на input через одиночный клик + большая пауза.
  // Без очистки — поля на чистом запуске пустые.
  // FOCUS_WAIT_AFTER_CLICK (800мс) обязателен — Sandboxie+CEF медленно
  // обрабатывают клик, без паузы первые символы type улетают мимо.
  async _focusField(x, y) {
    try {
      await mouse.setPosition(new Point(x, y))
      await this._sleep(100)
      await mouse.pressButton(Button.LEFT)
      await this._sleep(50)
      await mouse.releaseButton(Button.LEFT)
      await this._sleep(FOCUS_WAIT_AFTER_CLICK)
    } catch (e) {
      console.log(`[SandboxSteamGuard] _focusField error: ${e.message}`)
    }
  }

  // Вставка текста через системный буфер обмена С ПРИВЯЗКОЙ К ОКНУ.
  // 1) Electron clipboard.writeText — синхронно кладёт текст в буфер.
  // 2) paste-to-window.ps1 — в ОДНОМ процессе активирует окно Steam и шлёт
  //    Ctrl+A + Ctrl+V (+ Enter если withEnter). Активация и вставка в одном
  //    процессе — foreground не успевает перехватиться, Ctrl+V попадает в Steam.
  //
  // Почему clipboard, а не keyboard.type: keyboard.type шлёт символы по одному
  // через SendInput, и пока CEF не финализировал focus — первые keystroke
  // теряются. Ctrl+V вставляет весь текст за один dispatch.
  //
  // Почему SendKeys, а не nut.js Ctrl+V: libnut выставляет KF_REPEAT флаг,
  // который Chromium/CEF фильтрует (bug 109151). SendKeys (keybd_event)
  // проходит в CEF — подтверждено: физический Ctrl+V вставляет в Steam.
  async _pasteText(hwnd, x, y, text, withEnter = false) {
    try {
      clipboard.writeText(text)
      const verified = clipboard.readText()
      if (verified !== text) {
        console.log(`[SandboxSteamGuard] !!! CLIPBOARD WRITE FAILED: expected ${text.length} chars, got ${verified.length}: "${verified}"`)
      } else {
        console.log(`[SandboxSteamGuard] clipboard ok (${text.length} chars)`)
      }
      // Дать Sandboxie синхронизировать буфер обмена в песочницу прежде чем
      // sandboxed CEF прочитает его по Ctrl+V — иначе вставка флакает (пусто).
      await this._sleep(250)
      const res = this._pasteToWindow(hwnd, x, y, withEnter)
      console.log(`[SandboxSteamGuard] paste-to-window(hwnd=${hwnd}, xy=${x},${y}, enter=${withEnter}) -> ${res}`)
      await this._sleep(300)
    } catch (e) {
      console.log(`[SandboxSteamGuard] _pasteText error: ${e.message}`)
    }
  }

  // Активирует окно hwnd, кликает по (x,y) для постановки caret в поле, затем
  // вставляет содержимое буфера (Ctrl+A, Ctrl+V) — всё в одном процессе
  // PowerShell. windowsHide — чтобы консоль powershell не мелькала и не крала
  // foreground. Возвращает 'OK' / 'INVALID' / 'ERROR'.
  _pasteToWindow(hwnd, x, y, withEnter = false) {
    const script = join(PS_DIR, 'paste-to-window.ps1')
    if (!existsSync(script)) this._ensureScripts()
    try {
      return execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -Hwnd ${hwnd} -X ${Math.round(x)} -Y ${Math.round(y)} -Enter ${withEnter ? 1 : 0}`,
        { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
      ).trim()
    } catch (e) {
      console.log(`[SandboxSteamGuard] _pasteToWindow error: ${e.message}`)
      return 'ERROR'
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
        // Steam Guard CEF UI: 5-значное поле для кода в верхней-средней части
        // окна (под заголовком "Подтвердите вход"). Координата Y ~40%.
        // _pasteText сам кликнет по (cx,cy) внутри окна и вставит код.
        let cx = 0, cy = 0
        if (rect) {
          cx = rect.left + Math.floor(rect.width  * 0.50)
          cy = rect.top  + Math.floor(rect.height * 0.40)
          console.log(`[SandboxSteamGuard ${accountId}] Guard field at (${cx}, ${cy}) — window ${rect.width}x${rect.height}@(${rect.left},${rect.top})`)
        }

        // Ввод Guard кода через clipboard paste с привязкой к окну (+Enter).
        await this._pasteText(hwnd, cx, cy, code, true)
        await this._sleep(150)
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

  // Возвращает { left, top, width, height } или null если окно закрылось.
  // Использует уже существующий enum-windows скрипт — фильтруем по hwnd.
  _getWindowRect(hwnd) {
    const all = this._enumSteamWindows()
    const w = all.find(x => Number(x.hwnd) === Number(hwnd))
    if (!w || !w.visible) return null
    return { left: w.left, top: w.top, width: w.width, height: w.height }
  }

  // Ждёт пока в системе появится sandboxed окно Steam с размером главного UI
  // (≥ MAIN_UI_AREA_THRESHOLD). Это надёжный признак что пользователь
  // (вручную или автоматически) залогинился — после login Steam показывает
  // большое окно с библиотекой/магазином. До логина окно входа маленькое.
  // Возвращает true если main UI появилось, false если timeout.
  async waitForMainSteamUI(timeoutMs = 300_000, pollMs = 1500) {
    this._ensureScripts()
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const all = this._enumSteamWindows()
      const sandboxed = all.filter(w =>
        w.visible &&
        ((w.title || '').includes('[#]') || (w.class || '').startsWith('Sandbox:'))
      )
      const mainUi = sandboxed.find(w => (w.width * w.height) >= MAIN_UI_AREA_THRESHOLD)
      if (mainUi) {
        return true
      }
      await this._sleep(pollMs)
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
