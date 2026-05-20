import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { autoUpdater } from 'electron-updater'
import { setupIPC } from './ipc'
import db from './modules/Database'
import accountManager from './modules/AccountManager'
import workerManager from './modules/WorkerManager'
import settings from './modules/Settings'
import gsiServer from './modules/CS2GSIServer'
import botAutomation from './modules/BotAutomation'

// Отдельное окно для имитации движения — удобнее чем модалка когда
// пользователь возится с CS2 рядом. Один accountId = одно окно (повторный
// вызов фокусирует существующее).
const _automationWindows = new Map()
function openAutomationWindow(accountId) {
  const existing = _automationWindows.get(accountId)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return existing
  }
  const win = new BrowserWindow({
    width: 460,
    height: 560,
    minWidth: 420,
    minHeight: 480,
    frame: false,
    backgroundColor: '#0d1117',
    title: `Имитация — #${accountId}`,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
    ?.replace('localhost', '127.0.0.1')
  const url = devUrl
    ? `${devUrl}#/automation/${accountId}`
    : `file://${join(__dirname, '../renderer/index.html')}#/automation/${accountId}`

  if (devUrl) {
    const tryLoad = (attempts) => {
      win.loadURL(url).catch(() => {
        if (attempts > 0) setTimeout(() => tryLoad(attempts - 1), 500)
      })
    }
    setTimeout(() => tryLoad(20), 200)
  } else {
    win.loadURL(url)
  }

  win.webContents.on('before-input-event', (_, input) => {
    if ((input.control && input.shift && input.key === 'I') || input.key === 'F12') {
      win.webContents.toggleDevTools()
    }
  })

  win.on('closed', () => _automationWindows.delete(accountId))
  _automationWindows.set(accountId, win)
  return win
}

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

  win.webContents.on('before-input-event', (_, input) => {
    if ((input.control && input.shift && input.key === 'I') || input.key === 'F12') {
      win.webContents.toggleDevTools()
    }
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
  botAutomation.init(win.webContents)
  // window:* events — действуют на окно из которого пришёл event (главное ИЛИ автоматизации)
  ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('window:maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w) return
    w.isMaximized() ? w.unmaximize() : w.maximize()
  })
  ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  setupIPC()

  // GSI HTTP сервер для приёма state events от CS2.
  // CS2 шлёт POST по URI из gamestate_integration_botpanel.cfg (cfg создаётся в CS2Launcher.start).
  gsiServer.ensure().catch(e => console.log('[GSI] start failed:', e.message))

  // Окно имитации — открывается отдельным BrowserWindow для удобной работы рядом с CS2.
  ipcMain.handle('automation:openWindow', (_, accountId) => {
    openAutomationWindow(accountId)
    return { ok: true }
  })

  if (app.isPackaged) {
    autoUpdater.autoDownload = false
    autoUpdater.on('update-available',    (info) => win.webContents.send('updater:available', info))
    autoUpdater.on('update-not-available',  ()   => win.webContents.send('updater:upToDate'))
    autoUpdater.on('download-progress',  (prog) => win.webContents.send('updater:progress', prog))
    autoUpdater.on('update-downloaded',  (info) => win.webContents.send('updater:downloaded', info))
    autoUpdater.on('error',              (err)  => win.webContents.send('updater:error', err.message))

    // Запускаем проверку только ПОСЛЕ того как renderer полностью загрузился —
    // иначе event updater:available уходит в никуда если listener ещё не зарегистрирован.
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000)
    })

    // Периодическая проверка каждые 30 минут для долгоживущих сессий
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 30 * 60 * 1000)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
