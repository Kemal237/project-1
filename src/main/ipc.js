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

  ipcMain.handle('farm:start',    (_, id) => workerManager.start(id))
  ipcMain.handle('farm:stop', async (_, id) => {
    await workerManager.stop(id)
    accountManager.update(id, { status: 'idle' })
    workerManager.webContents?.send('worker:statusChange', { accountId: id, status: 'idle' })
  })
  ipcMain.handle('farm:stopAll', async () => {
    const ids = [...workerManager.workers.keys()]
    await workerManager.stopAll()
    for (const id of ids) {
      accountManager.update(id, { status: 'idle' })
      workerManager.webContents?.send('worker:statusChange', { accountId: id, status: 'idle' })
    }
  })
  ipcMain.handle('farm:statuses', ()      => workerManager.getAllStatuses())
  ipcMain.handle('farm:steamGuardCode', (_, accountId, code) =>
    workerManager.provideCode(accountId, code)
  )

  ipcMain.handle('launcher:start', async (_, accountId) => {
    const creds = accountManager.getCredentials(accountId)
    if (!creds) return { ok: false, error: 'Аккаунт не найден' }

    await workerManager.stop(accountId)
    accountManager.update(accountId, { status: 'cs2_preparing' })

    const send = (status, message) => {
      accountManager.update(accountId, { status })
      workerManager.webContents?.send('worker:statusChange', { accountId, status, message })
    }

    cs2Launcher.start(accountId, creds, send).catch(err => {
      send('error', err.message)
      cs2Launcher.stop(accountId)
    })

    return { ok: true }
  })

  ipcMain.handle('launcher:stop', async (_, accountId) => {
    botAutomation.stop(accountId)
    cs2Launcher.stop(accountId)
    accountManager.update(accountId, { status: 'idle' })
    workerManager.webContents?.send('worker:statusChange', { accountId, status: 'idle' })
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
          { timeout: 20_000, stdio: 'pipe' }
        )
      } catch {}
      // 4. Сбрасываем статусы всех аккаунтов в idle
      const accounts = accountManager.getAll()
      accountManager.resetStatuses()
      for (const a of accounts) {
        workerManager.webContents?.send('worker:statusChange', { accountId: a.id, status: 'idle' })
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
