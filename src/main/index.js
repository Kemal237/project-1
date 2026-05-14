import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { setupIPC } from './ipc'
import db from './modules/Database'

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

  // Принудительно используем 127.0.0.1 вместо localhost (IPv6 vs IPv4 на Windows)
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

app.whenReady().then(async () => {
  await db.init()
  const win = createWindow()
  ipcMain.on('window:minimize', () => win.minimize())
  ipcMain.on('window:maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize())
  ipcMain.on('window:close',    () => win.close())
  setupIPC()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
