const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('path')

let mainWindow

function createWindow() {
  const isDev = !app.isPackaged
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 1100,
    minHeight: 680,
    frame: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(async () => {
  // Инициализируем БД до создания окна
  const database = require('./modules/Database')
  await database.init()

  createWindow()
  setupIPC()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// ─── Window controls ──────────────────────────────────────────────────────────

ipcMain.on('window:minimize', () => mainWindow.minimize())
ipcMain.on('window:maximize', () => {
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
})
ipcMain.on('window:close', () => mainWindow.close())

// ─── IPC handlers ─────────────────────────────────────────────────────────────

function setupIPC() {
  const accountManager = require('./modules/AccountManager')
  const proxyManager   = require('./modules/ProxyManager')
  const settingsModule = require('./modules/Settings')
  const dropTracker    = require('./modules/DropTracker')

  // Accounts
  ipcMain.handle('accounts:getAll',    ()           => accountManager.getAll())
  ipcMain.handle('accounts:add',       (_, data)    => accountManager.add(data))
  ipcMain.handle('accounts:update',    (_, id, data)=> accountManager.update(id, data))
  ipcMain.handle('accounts:delete',    (_, id)      => accountManager.delete(id))
  ipcMain.handle('accounts:import',    (_, text)    => accountManager.importFromText(text))

  // Proxies
  ipcMain.handle('proxies:getAll',     ()           => proxyManager.getAll())
  ipcMain.handle('proxies:add',        (_, data)    => proxyManager.add(data))
  ipcMain.handle('proxies:delete',     (_, id)      => proxyManager.delete(id))
  ipcMain.handle('proxies:validate',   (_, data)    => proxyManager.validate(data))
  ipcMain.handle('proxies:assign',     (_, pid, aid)=> proxyManager.assign(pid, aid))

  // Settings
  ipcMain.handle('settings:get',       ()           => settingsModule.getAll())
  ipcMain.handle('settings:set',       (_, k, v)   => settingsModule.set(k, v))

  // Drops
  ipcMain.handle('drops:getAll',       ()           => dropTracker.getAll())
  ipcMain.handle('drops:getByAccount', (_, id)      => dropTracker.getByAccount(id))
  ipcMain.handle('drops:getStats',     ()           => dropTracker.getStats())
}
