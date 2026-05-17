import { ipcMain, dialog, app } from 'electron'
import { autoUpdater } from 'electron-updater'
import accountManager    from './modules/AccountManager'
import proxyManager      from './modules/ProxyManager'
import settings          from './modules/Settings'
import dropTracker       from './modules/DropTracker'
import workerManager     from './modules/WorkerManager'
import sandboxieManager  from './modules/SandboxieManager'

export function setupIPC() {
  ipcMain.handle('accounts:getAll',    ()           => accountManager.getAll())
  ipcMain.handle('accounts:add',       (_, d)       => accountManager.add(d))
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

  ipcMain.handle('updater:getVersion', () => app.getVersion())
  ipcMain.handle('updater:check',     () => app.isPackaged ? autoUpdater.checkForUpdates() : null)
  ipcMain.handle('updater:install',   () => autoUpdater.quitAndInstall(false, true))

  ipcMain.handle('sandboxie:status', () => sandboxieManager.getStatus())

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

  ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
}
