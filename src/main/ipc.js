import { ipcMain } from 'electron'
import accountManager from './modules/AccountManager'
import proxyManager   from './modules/ProxyManager'
import settings       from './modules/Settings'
import dropTracker    from './modules/DropTracker'

export function setupIPC() {
  ipcMain.handle('accounts:getAll',    ()           => accountManager.getAll())
  ipcMain.handle('accounts:add',       (_, d)       => accountManager.add(d))
  ipcMain.handle('accounts:update',    (_, id, d)   => accountManager.update(id, d))
  ipcMain.handle('accounts:delete',    (_, id)      => accountManager.delete(id))
  ipcMain.handle('accounts:import',    (_, text)    => accountManager.importFromText(text))

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
}
