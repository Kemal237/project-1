import { ipcMain, dialog, app } from 'electron'
import { readFileSync } from 'fs'
import { execSync } from 'child_process'
import { autoUpdater } from 'electron-updater'
import accountManager    from './modules/AccountManager'
import proxyManager      from './modules/ProxyManager'
import settings          from './modules/Settings'
import dropTracker       from './modules/DropTracker'
import workerManager     from './modules/WorkerManager'
import sandboxieManager    from './modules/SandboxieManager'
import cs2Launcher        from './modules/CS2Launcher'
import steamConfigPatcher from './modules/SteamConfigPatcher'
import botAutomation     from './modules/BotAutomation'
import inputMutex        from './modules/InputMutex'
import groupManager      from './modules/GroupManager'
import friendManager     from './modules/FriendManager'

export function setupIPC() {
  // Создаём боксы Sandboxie для всех известных аккаунтов при старте (пока ничего не запущено).
  // Служба SbieSvc перезапускается один раз через UAC — надёжный способ подхватить новые боксы.
  setTimeout(async () => {
    try {
      const accounts = accountManager.getAll()
      if (!accounts.length) return
      const steamPath = await steamConfigPatcher.detectSteamPath()
      const cs2Path   = await steamConfigPatcher.detectCS2Path(steamPath)
      if (steamPath && cs2Path) {
        // Одноразовая миграция в v1.0.50: полностью wipe старые боксы (могли иметь
        // унаследованные настройки) и пересоздать с актуальным безопасным конфигом.
        const wipedFlag = 'boxes_wiped_v1050'
        const allSettings = settings.getAll()
        const wipeFirst = allSettings[wipedFlag] !== 'true'
        await cs2Launcher.setupBoxes(accounts.map(a => a.id), steamPath, cs2Path, { wipeFirst })
        if (wipeFirst) settings.set(wipedFlag, 'true')
      }
    } catch (e) {
      console.log('[Startup] Sandboxie setupBoxes:', e.message)
    }
  }, 5000)

  ipcMain.handle('accounts:getAll',    ()           => accountManager.getAll())
  ipcMain.handle('accounts:add',       async (_, d) => {
    const result = accountManager.add(d)
    // Сразу создаём бокс Sandboxie — служба узнает о боксе через SbieIni,
    // и при запуске CS2 не будет ошибки "Invalid box name parameter".
    try {
      const steamPath = await steamConfigPatcher.detectSteamPath()
      const cs2Path   = await steamConfigPatcher.detectCS2Path(steamPath)
      if (steamPath && cs2Path) {
        await cs2Launcher.setupBoxes([result.id], steamPath, cs2Path)
      }
    } catch (e) {
      console.log('[accounts:add] setupBoxes:', e.message)
    }
    return result
  })
  ipcMain.handle('accounts:update',    (_, id, d)   => accountManager.update(id, d))
  ipcMain.handle('accounts:delete',    (_, id)      => accountManager.delete(id))
  ipcMain.handle('accounts:import',        (_, text)    => accountManager.importFromText(text))
  ipcMain.handle('accounts:getCredentials',(_, id)      => accountManager.getCredentials(id))

  ipcMain.handle('proxies:getAll',     ()           => proxyManager.getAll())
  ipcMain.handle('proxies:add',        (_, d)       => proxyManager.add(d))
  ipcMain.handle('proxies:delete',     (_, id)      => proxyManager.delete(id))
  ipcMain.handle('proxies:validate',   (_, d)       => proxyManager.validate(d))
  ipcMain.handle('proxies:assign',     (_, pid, aid)=> proxyManager.assign(pid, aid))

  ipcMain.handle('settings:get',       ()           => settings.getAll())
  ipcMain.handle('settings:set',       (_, k, v)    => settings.set(k, v))

  ipcMain.handle('drops:getAll',       ()           => dropTracker.getAll())
  ipcMain.handle('drops:getByAccount', (_, id)      => dropTracker.getByAccount(id))
  ipcMain.handle('drops:getStats',     ()           => dropTracker.getStats())

  ipcMain.handle('groups:getAll',  ()           => groupManager.getAll())
  ipcMain.handle('groups:get',     (_, id)      => groupManager.get(id))
  ipcMain.handle('groups:create',  (_, data)    => {
    try { return { ok: true, ...groupManager.create(data) } }
    catch (e) { return { ok: false, error: e.message } }
  })
  ipcMain.handle('groups:update',  (_, id, data) => {
    try { groupManager.update(id, data); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  })
  ipcMain.handle('groups:delete',  (_, id)      => {
    try { groupManager.delete(id); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('friends:ensureGroup', async (_, groupId) => {
    const onProgress = (accountId, status, message) =>
      workerManager.send('friends:progress', { accountId, status, message })
    try {
      return await friendManager.ensureGroupFriends(groupId, onProgress)
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('farm:start',    (_, id) => workerManager.start(id))
  ipcMain.handle('farm:stop', async (_, id) => {
    await workerManager.stop(id)
    accountManager.update(id, { status: 'idle' })
    workerManager.send('worker:statusChange', { accountId: id, status: 'idle' })
  })
  ipcMain.handle('farm:stopAll', async () => {
    const ids = [...workerManager.workers.keys()]
    await workerManager.stopAll()
    for (const id of ids) {
      accountManager.update(id, { status: 'idle' })
      workerManager.send('worker:statusChange', { accountId: id, status: 'idle' })
    }
  })
  ipcMain.handle('farm:statuses', ()      => workerManager.getAllStatuses())
  ipcMain.handle('farm:steamGuardCode', (_, accountId, code) =>
    workerManager.provideCode(accountId, code)
  )

  // Возвращает текущее состояние глобального input mutex.
  // Используется UI чтобы решить — запустить сразу или показать модалку очереди.
  ipcMain.handle('launcher:mutexState', () => ({
    locked:     inputMutex.isLocked(),
    holder:     inputMutex.currentHolder(),
    queueSize:  inputMutex.queueSize(),
    queueLabels: inputMutex.queueLabels(),
  }))

  // Внутренняя функция: запустить CS2 launcher для одного аккаунта.
  // Используется как из launcher:start (одиночный запуск), так и из
  // groups:start (запуск группы ПОСЛЕДОВАТЕЛЬНО: следующий аккаунт стартует
  // только после того как предыдущий полностью залогинился — см. groups:start).
  async function startLauncherForAccount(accountId, { useMutex } = {}) {
    const creds = accountManager.getCredentials(accountId)
    if (!creds) return { ok: false, error: 'Аккаунт не найден' }

    await workerManager.stop(accountId)
    const initialStatus = (useMutex && inputMutex.isLocked()) ? 'queued' : 'cs2_preparing'
    accountManager.update(accountId, { status: initialStatus })

    const send = (status, message) => {
      accountManager.update(accountId, { status })
      workerManager.send('worker:statusChange', { accountId, status, message })
    }

    if (useMutex && inputMutex.isLocked()) {
      send('queued', `В очереди (держит: ${inputMutex.currentHolder()})`)
    }

    cs2Launcher.start(accountId, creds, send, { useMutex: !!useMutex }).catch(err => {
      send('error', err.message)
      cs2Launcher.stop(accountId)
    })

    return { ok: true }
  }

  // Внутренняя функция: остановить CS2 launcher + автоматизацию для аккаунта.
  function stopLauncherForAccount(accountId) {
    botAutomation.stop(accountId)
    cs2Launcher.stop(accountId)
    accountManager.update(accountId, { status: 'idle' })
    workerManager.send('worker:statusChange', { accountId, status: 'idle' })
  }

  // opts.useMutex=true — ввод (логин/пароль/Guard) сериализуется через
  // глобальный InputMutex. Используется когда параллельно может запускаться
  // 2+ ботов (групповой запуск или ручной "Запустить в очерёдности").
  ipcMain.handle('launcher:start', async (_, accountId, opts = {}) =>
    startLauncherForAccount(accountId, { useMutex: !!opts.useMutex })
  )

  ipcMain.handle('launcher:stop', async (_, accountId) => {
    stopLauncherForAccount(accountId)
    return { ok: true }
  })

  // Перезапуск аккаунта (кнопка в окне отслеживания): убить ВСЕ процессы
  // бокса аккаунта → пауза для очистки → запустить заново. Ограничение
  // последовательности: если ДРУГОЙ аккаунт сейчас проходит вход в Steam —
  // запрещаем (нельзя вводить логин/пароль/Guard в две формы одновременно).
  ipcMain.handle('launcher:restart', async (_, accountId) => {
    // Валидация на входе (defense in depth): accountId уходит в имя бокса,
    // которое попадает в shell-команду killBox. Только целое положительное.
    if (!Number.isInteger(accountId) || accountId <= 0) {
      return { ok: false, error: 'Некорректный аккаунт' }
    }
    const blocker = findAccountLoggingIn(accountId)
    if (blocker) {
      return {
        ok: false,
        reason: 'login_in_progress',
        error: `Сейчас входит ${blocker.login}. Дождись завершения входа.`,
        busyId: blocker.id,
        busyLogin: blocker.login,
      }
    }
    // Полная остановка + гарантированное убийство бокса (даже если аккаунт
    // не в _active — после краша/ручного закрытия/зависшего входа).
    stopLauncherForAccount(accountId)
    cs2Launcher.killBox(accountId)
    // Пауза, чтобы Sandboxie успел освободить бокс перед повторным запуском.
    await new Promise(r => setTimeout(r, 1500))
    return startLauncherForAccount(accountId, { useMutex: false })
  })

  // Статусы при которых "вход в Steam завершён" — sequential запуск группы
  // ждёт что аккаунт перейдёт в один из них, прежде чем запустить следующий.
  // error/idle — терминальные, бот зафейлился или был остановлен.
  const LOGIN_DONE_STATUSES = new Set([
    'steam_logged_in', 'steam_running',
    'cs2_launching', 'cs2_loading', 'cs2_lobby',
    'cs2_match_loading', 'cs2_match', 'cs2_in_match',
    'error', 'idle',
  ])

  // Статусы "идёт вход в Steam" — пока хотя бы один аккаунт в этих статусах,
  // перезапуск ДРУГОГО блокируется (параллельный ввод логина/пароля/Guard в
  // две CEF-формы невозможен). Зеркало LOGIN_IN_PROGRESS_STATUSES в Accounts.jsx.
  const LOGIN_IN_PROGRESS = new Set([
    'cs2_preparing', 'queued',
    'steam_launching', 'steam_loading', 'steam_login_form',
    'steam_entering_creds', 'steam_creds_submitted', 'steam_entering_guard',
    'awaiting_guard',
  ])

  // Возвращает первый аккаунт (кроме excludeId), который сейчас проходит вход
  // в Steam, или null. Ограничение последовательности для launcher:restart.
  function findAccountLoggingIn(excludeId) {
    for (const a of accountManager.getAll()) {
      if (a.id === excludeId) continue
      if (a.status && LOGIN_IN_PROGRESS.has(a.status)) return a
    }
    return null
  }

  // Ждёт пока статус accountId перейдёт в один из LOGIN_DONE_STATUSES
  // (или истечёт timeout). Используется в groups:start чтобы запускать
  // следующий бот ТОЛЬКО после того как предыдущий полностью залогинился.
  async function waitForLoginComplete(accountId, timeoutMs = 600_000, pollMs = 1000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const status = accountManager.getStatus(accountId)
      if (status && LOGIN_DONE_STATUSES.has(status)) return status
      await new Promise(r => setTimeout(r, pollMs))
    }
    return null  // timeout — продолжаем со следующего, не ждём бесконечно
  }

  // Группа запускается ПОСЛЕДОВАТЕЛЬНО: первый аккаунт стартует, ждём пока он
  // полностью залогинится (steam_logged_in или дальше), потом второй, и т.д.
  // Параллельный запуск ломал ввод — два Steam-окна получали клики/символы
  // одновременно, даже с mutex'ом (mutex захватывался только в момент ввода,
  // но окна обоих ботов появлялись одновременно и tryAutoInput путался).
  // Возвращает результаты сразу после старта последнего — UI получает статусы
  // через broadcast worker:statusChange и обновляется в реальном времени.
  ipcMain.handle('groups:start', async (_, groupId) => {
    const group = groupManager.get(groupId)
    if (!group) return { ok: false, error: 'Группа не найдена' }
    if (group.accounts.length === 0) return { ok: false, error: 'В группе нет аккаунтов' }

    // Запускаем последовательно — НЕ await Promise.all. Возвращаем сразу OK,
    // дальше работа идёт в фоне. UI отслеживает через worker:statusChange.
    ;(async () => {
      for (const a of group.accounts) {
        const r = await startLauncherForAccount(a.id, { useMutex: false })
        if (!r.ok) {
          console.log(`[groups:start] failed to start ${a.login}: ${r.error}`)
          continue
        }
        // Ждём пока этот аккаунт пройдёт вход — потом следующий.
        const final = await waitForLoginComplete(a.id)
        console.log(`[groups:start] ${a.login} login complete with status: ${final || 'TIMEOUT'}`)
        // Если предыдущий зафейлился или попал в idle (Stop), следующий всё
        // равно запускается — пользователь решит что делать с конкретным ботом.
      }
    })().catch(e => console.log('[groups:start] sequential loop error:', e.message))

    return { ok: true, started: group.accounts.length }
  })

  // Остановка группы: останавливаем все аккаунты группы.
  ipcMain.handle('groups:stop', async (_, groupId) => {
    const group = groupManager.get(groupId)
    if (!group) return { ok: false, error: 'Группа не найдена' }
    for (const a of group.accounts) {
      stopLauncherForAccount(a.id)
    }
    return { ok: true }
  })

  ipcMain.handle('automation:start', async (_, accountId, pattern) => {
    try {
      await botAutomation.start(accountId, pattern)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle('automation:stop', async (_, accountId) => {
    botAutomation.stop(accountId)
    return { ok: true }
  })
  ipcMain.handle('automation:status', (_, accountId) => ({
    running: botAutomation.isRunning(accountId),
  }))

  ipcMain.handle('updater:getVersion', () => app.getVersion())
  ipcMain.handle('updater:check',     () => app.isPackaged ? autoUpdater.checkForUpdates() : null)
  ipcMain.handle('updater:download',  () => autoUpdater.downloadUpdate())
  ipcMain.handle('updater:install',   () => autoUpdater.quitAndInstall(false, true))

  ipcMain.handle('deps:detect', async () => {
    const steamPath = await steamConfigPatcher.detectSteamPath()
    const cs2Path   = await steamConfigPatcher.detectCS2Path(steamPath)
    return {
      steam: { found: !!steamPath, path: steamPath },
      cs2:   { found: !!cs2Path,   path: cs2Path   },
    }
  })

  ipcMain.handle('sandboxie:status', () => sandboxieManager.getStatus())

  ipcMain.handle('sandboxie:killAll', async () => {
    try {
      // 0. Останавливаем все имитации (циклы в BotAutomation)
      botAutomation.stopAll()
      // 1. Останавливаем все воркеры (Steam-фарм)
      await workerManager.stopAll()
      // 2. Останавливаем все CS2-лаунчеры (Stop.exe для каждого tracked бокса)
      cs2Launcher.stopAll()
      // 3. Принудительно убиваем ВСЕ оставшиеся sandboxed процессы через PowerShell
      //    (имеют SbieDll.dll в памяти — надёжный маркер)
      try {
        execSync(
          `powershell -NoProfile -Command "Get-Process -EA SilentlyContinue | Where-Object { try { $_.Modules.ModuleName -contains 'SbieDll.dll' } catch { $false } } | Stop-Process -Force -EA SilentlyContinue"`,
          { timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] }
        )
      } catch {}
      // 4. Сбрасываем статусы всех аккаунтов в idle
      const accounts = accountManager.getAll()
      accountManager.resetStatuses()
      for (const a of accounts) {
        workerManager.send('worker:statusChange', { accountId: a.id, status: 'idle' })
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('sandboxie:uninstall', async () => {
    try { sandboxieManager.uninstall(); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('sandboxie:install', async (event) => {
    const send = msg => event.sender.send('sandboxie:progress', msg)
    try {
      await sandboxieManager.install(send)
      send('__done__')
      return { ok: true }
    } catch (e) {
      send('__error__:' + e.message)
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('accounts:importMaFile', async (_, id, filePath) => {
    try {
      const raw = readFileSync(filePath, 'utf8').replace(/^﻿/, '') // убираем BOM если есть
      let ma
      try { ma = JSON.parse(raw) } catch {
        return { ok: false, error: 'Файл не является валидным JSON. Возможно, он зашифрован паролем — используй незашифрованный maFile из Steam Desktop Authenticator.' }
      }

      const sharedSecret   = ma.shared_secret   ? String(ma.shared_secret).trim()   : ''
      const identitySecret = ma.identity_secret ? String(ma.identity_secret).trim() : ''

      if (!sharedSecret) return { ok: false, error: 'Поле shared_secret не найдено или пустое в maFile. Проверь что выбран правильный файл.' }

      accountManager.update(id, { sharedSecret, identitySecret })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:openMaFile', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Выбери maFile',
      filters: [{ name: 'Steam maFile', extensions: ['maFile'] }],
      properties: ['openFile'],
    })
    return result.canceled ? null : result.filePaths[0]
  })
}
