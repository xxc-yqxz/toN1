import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  globalShortcut,
  screen,
  clipboard
} from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

const DEFAULT_WINDOW_WIDTH = 900
const DEFAULT_WINDOW_HEIGHT = 800
const MIN_WINDOW_WIDTH = 320
const MIN_WINDOW_HEIGHT = 80
const WINDOW_STATE_FILE = 'window-state.json'
const WINDOW_STATE_SAVE_DELAY_MS = 200
const SETTINGS_FILE = 'app-settings.json'
const DEFAULT_SETTINGS = {
  textSize: 22,
  opacity: 0.96,
  textColor: '#FFFFFF',
  selectedDictionary: 0,
  studyMode: 'normal'
}

let mainWindow = null
let settingsWindow = null
let tray = null
let saveBoundsTimer = null
let appSettings = { ...DEFAULT_SETTINGS }

function getWindowStatePath() {
  return join(app.getPath('userData'), WINDOW_STATE_FILE)
}

function getSettingsPath() {
  return join(app.getPath('userData'), SETTINGS_FILE)
}

function clampNumber(value, min, max, fallback) {
  const numericValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numericValue)) return fallback
  return Math.min(max, Math.max(min, numericValue))
}

function sanitizeSettings(input) {
  const source = input && typeof input === 'object' ? input : {}

  const textSize = Math.round(clampNumber(source.textSize, 12, 120, DEFAULT_SETTINGS.textSize))
  const opacity = Number(clampNumber(source.opacity, 0.1, 1, DEFAULT_SETTINGS.opacity).toFixed(2))
  const selectedDictionary = Math.round(clampNumber(source.selectedDictionary, 0, 999, DEFAULT_SETTINGS.selectedDictionary))
  const rawTextColor =
    typeof source.textColor === 'string' ? source.textColor.trim().toUpperCase() : ''
  const textColor = /^#[0-9A-F]{6}$/.test(rawTextColor) ? rawTextColor : DEFAULT_SETTINGS.textColor
  const studyMode = typeof source.studyMode === 'string' && source.studyMode === 'favorites' ? 'favorites' : 'normal'

  return {
    textSize,
    opacity,
    textColor,
    selectedDictionary,
    studyMode
  }
}

function loadAppSettings() {
  const settingsPath = getSettingsPath()

  try {
    if (!existsSync(settingsPath)) return { ...DEFAULT_SETTINGS }
    const content = readFileSync(settingsPath, 'utf-8')
    const parsed = JSON.parse(content)
    return sanitizeSettings({ ...DEFAULT_SETTINGS, ...parsed })
  } catch (error) {
    console.warn('Failed to load app settings:', error)
    return { ...DEFAULT_SETTINGS }
  }
}

function saveAppSettings(input) {
  const merged = { ...appSettings, ...(input && typeof input === 'object' ? input : {}) }
  const settings = sanitizeSettings(merged)
  const settingsPath = getSettingsPath()

  try {
    writeFileSync(settingsPath, JSON.stringify(settings), 'utf-8')
    return settings
  } catch (error) {
    console.error('Failed to save app settings:', error)
    throw new Error('Failed to save app settings')
  }
}

function loadWindowState() {
  const defaultState = {
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT
  }
  const windowStatePath = getWindowStatePath()

  try {
    if (!existsSync(windowStatePath)) return defaultState
    const content = readFileSync(windowStatePath, 'utf-8')
    const parsed = JSON.parse(content)

    const state = {
      width: Number.isFinite(parsed.width)
        ? Math.max(MIN_WINDOW_WIDTH, Math.round(parsed.width))
        : defaultState.width,
      height: Number.isFinite(parsed.height)
        ? Math.max(MIN_WINDOW_HEIGHT, Math.round(parsed.height))
        : defaultState.height
    }

    if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
      state.x = Math.round(parsed.x)
      state.y = Math.round(parsed.y)
    }

    return state
  } catch (error) {
    console.warn('Failed to load window state:', error)
    return defaultState
  }
}

function isBoundsVisible(bounds) {
  return screen.getAllDisplays().some(({ workArea }) => {
    const intersectsHorizontally =
      bounds.x < workArea.x + workArea.width && bounds.x + bounds.width > workArea.x
    const intersectsVertically =
      bounds.y < workArea.y + workArea.height && bounds.y + bounds.height > workArea.y
    return intersectsHorizontally && intersectsVertically
  })
}

function getInitialBounds() {
  const state = loadWindowState()
  const hasPosition = Number.isFinite(state.x) && Number.isFinite(state.y)
  if (!hasPosition) return state

  const restoredBounds = {
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height
  }

  if (isBoundsVisible(restoredBounds)) return restoredBounds

  const workArea = screen.getPrimaryDisplay().workArea
  return {
    width: state.width,
    height: state.height,
    x: workArea.x + Math.max(0, Math.floor((workArea.width - state.width) / 2)),
    y: workArea.y + Math.max(0, Math.floor((workArea.height - state.height) / 2))
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized() || mainWindow.isMaximized()) return

  const bounds = mainWindow.getBounds()
  const windowStatePath = getWindowStatePath()

  try {
    writeFileSync(windowStatePath, JSON.stringify(bounds), 'utf-8')
  } catch (error) {
    console.warn('Failed to save window state:', error)
  }
}

function scheduleWindowStateSave() {
  if (saveBoundsTimer) {
    clearTimeout(saveBoundsTimer)
  }

  saveBoundsTimer = setTimeout(() => {
    saveWindowState()
    saveBoundsTimer = null
  }, WINDOW_STATE_SAVE_DELAY_MS)
}

function hideToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.setSkipTaskbar(true)
  mainWindow.hide()
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }

  mainWindow.setSkipTaskbar(false)
  mainWindow.show()
  mainWindow.focus()
}

function toggleWindowVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }

  if (mainWindow.isVisible()) {
    hideToTray()
    return
  }

  showMainWindow()
}

function openSettingsDialog() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return
  }

  settingsWindow = new BrowserWindow({
    width: 520,
    height: 600,
    minWidth: 460,
    minHeight: 300,
    show: false,
    autoHideMenuBar: true,
    maximizable: false,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // 开启调试
  // settingsWindow.webContents.openDevTools()

  settingsWindow.removeMenu()

  settingsWindow.on('ready-to-show', () => {
    settingsWindow?.show()
    settingsWindow?.focus()
  })

  settingsWindow.on('closed', () => {
    settingsWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    settingsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=settings`)
  } else {
    settingsWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'settings' }
    })
  }
}

function createTray() {
  if (tray) return

  tray = new Tray(icon)
  tray.setToolTip('toN1')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Show Window',
        click: showMainWindow
      },
      {
        label: 'Hide to Tray',
        click: hideToTray
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => app.quit()
      }
    ])
  )

  tray.on('double-click', () => {
    showMainWindow()
  })
}

function createWindow() {
  const initialBounds = getInitialBounds()

  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: initialBounds.width,
    height: initialBounds.height,
    ...(Number.isFinite(initialBounds.x) && Number.isFinite(initialBounds.y)
      ? { x: initialBounds.x, y: initialBounds.y }
      : {}),
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.removeMenu()

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('move', scheduleWindowStateSave)
  mainWindow.on('resize', scheduleWindowStateSave)
  mainWindow.on('close', saveWindowState)
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function loadWordsFromLocalFile() {
  // 使用绝对路径读取 data.json 文件
  const dataPath = 'D:\\MyCode\\toN1\\src\\data.json'

  try {
    if (!existsSync(dataPath)) {
      throw new Error('data.json file not found at: ' + dataPath)
    }

    const content = readFileSync(dataPath, 'utf-8')
    const parsed = JSON.parse(content)

    // 返回整个数组，因为 data.json 是一个包含多个词典的数组
    if (Array.isArray(parsed)) {
      return parsed
    } else {
      throw new Error('Invalid data structure in data.json - expected an array')
    }
  } catch (error) {
    console.error('Failed to load words from data.json:', error)
    throw new Error(`Failed to load data.json: ${error.message}`)
  }
}

function notifySettingsChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('settings:changed', appSettings)
  }

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('settings:changed', appSettings)
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  appSettings = loadAppSettings()

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))
  ipcMain.handle('settings:get', () => appSettings)
  ipcMain.on('settings:close', (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    if (senderWindow && senderWindow === settingsWindow) {
      senderWindow.close()
    }
  })
  ipcMain.handle('settings:save', (_, payload) => {
    appSettings = saveAppSettings(payload)
    notifySettingsChanged()
    return appSettings
  })
  ipcMain.handle('clipboard:copy-text', (_, text) => {
    const content = typeof text === 'string' ? text : String(text ?? '')
    clipboard.writeText(content)
    return true
  })
  ipcMain.handle('words:jump', (_, payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false

    const source = payload && typeof payload === 'object' ? payload : {}
    const rawWordIndex = Number(source.wordIndex ?? source.index)
    const rawCPartIndex = Number(source.cPartIndex)
    const wordIndex = Number.isFinite(rawWordIndex) ? Math.trunc(rawWordIndex) : 0
    const cPartIndex = Number.isFinite(rawCPartIndex) ? Math.trunc(rawCPartIndex) : 0
    const field = source.field === 'c' ? 'c' : 'w'

    mainWindow.webContents.send('words:jump', { wordIndex, cPartIndex, field })
    showMainWindow()
    return true
  })
  ipcMain.handle('words:load', async () => {
    try {
      return loadWordsFromLocalFile()
    } catch (error) {
      console.error('Failed to load words from data.json:', error)
      throw error
    }
  })

  // 收藏文件操作
  ipcMain.handle('save-favorites', async (_, favoritesData) => {
    try {
      // 保存到项目根目录下的star.json文件
      const projectRoot = process.cwd()
      const favoritesPath = join(projectRoot, 'star.json')
      console.log('当前工作目录:', projectRoot)
      console.log('保存收藏文件到:', favoritesPath)
      writeFileSync(favoritesPath, favoritesData, 'utf-8')
      console.log('收藏文件保存成功')
      return true
    } catch (error) {
      console.error('Failed to save favorites:', error)
      throw error
    }
  })

  ipcMain.handle('load-favorites', async () => {
    try {
      // 从项目根目录下的star.json文件加载
      const projectRoot = process.cwd()
      const favoritesPath = join(projectRoot, 'star.json')
      console.log('当前工作目录:', projectRoot)
      console.log('尝试加载收藏文件:', favoritesPath)
      if (!existsSync(favoritesPath)) {
        console.log('收藏文件不存在')
        return null
      }
      const content = readFileSync(favoritesPath, 'utf-8')
      console.log('收藏文件加载成功')
      return content
    } catch (error) {
      console.error('Failed to load favorites:', error)
      throw error
    }
  })

  createWindow()
  createTray()

  const shortcutRegistered = globalShortcut.register('Alt+Q', () => {
    toggleWindowVisibility()
  })

  if (!shortcutRegistered) {
    console.warn('Failed to register global shortcut Alt+Q.')
  }

  const settingsShortcutRegistered = globalShortcut.register('Alt+S', () => {
    openSettingsDialog()
  })

  if (!settingsShortcutRegistered) {
    console.warn('Failed to register global shortcut Alt+S.')
  }

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      return
    }

    showMainWindow()
  })
})

app.on('before-quit', () => {
  if (saveBoundsTimer) {
    clearTimeout(saveBoundsTimer)
    saveBoundsTimer = null
  }

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.destroy()
    settingsWindow = null
  }

  globalShortcut.unregisterAll()
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
