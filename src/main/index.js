import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { autoUpdater } from 'electron-updater'
import { setupIPC } from './ipc'
import db from './modules/Database'
import accountManager from './modules/AccountManager'
import workerManager from './modules/WorkerManager'
import settings from './modules/Settings'

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 1100,
    minHeight: 680,
    frame: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
    ?.replace('localhost', '127.0.0.1')

  if (devUrl) {
    const tryLoad = (attempts) => {
      win.loadURL(devUrl).catch(() => {
        if (attempts > 0) setTimeout(() => tryLoad(attempts - 1), 500)
      })
    }
    setTimeout(() => tryLoad(20), 1000)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  return win
}

function getLastWednesdayUTC() {
  const now = new Date()
  const daysSinceWed = now.getUTCDay() >= 3 ? now.getUTCDay() - 3 : now.getUTCDay() + 4
  const d = new Date(now)
  d.setUTCDate(now.getUTCDate() - daysSinceWed)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

app.whenReady().then(async () => {
  await db.init()
  accountManager.resetStatuses()

  const lastWed = getLastWednesdayUTC()
  const lastReset = new Date(settings.get('lastWeeklyReset') || 0)
  if (lastWed > lastReset) {
    accountManager.resetWeeklyDrops()
    settings.set('lastWeeklyReset', lastWed.toISOString())
  }

  const win = createWindow()
  workerManager.init(win.webContents)
  ipcMain.on('window:minimize', () => win.minimize())
  ipcMain.on('window:maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize())
  ipcMain.on('window:close',    () => win.close())
  setupIPC()

  if (app.isPackaged) {
    autoUpdater.autoDownload = true
    autoUpdater.on('update-available',  (info) => win.webContents.send('updater:available', info))
    autoUpdater.on('update-not-available', ()   => win.webContents.send('updater:upToDate'))
    autoUpdater.on('download-progress', (prog) => win.webContents.send('updater:progress', prog))
    autoUpdater.on('update-downloaded', (info) => win.webContents.send('updater:downloaded', info))
    autoUpdater.on('error',             (err)  => win.webContents.send('updater:error', err.message))
    setTimeout(() => autoUpdater.checkForUpdates(), 5000)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
