import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  globalShortcut,
  screen,
  clipboard,
  dialog,
  protocol,
  nativeImage
} from 'electron'
import { join, extname } from 'path'
import { existsSync, readFileSync, writeFileSync, createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { Readable } from 'stream'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

// 透明窗口在 Windows 上与 GPU 硬件合成存在已知 bug（视频/画面偶发变灰、残留旧帧，
// 截图等强制全屏重绘后暂时恢复）。禁用硬件加速，改用软件合成，可根治该问题。
// 代价：视频解码走软解，对本地学习视频（通常 720p/1080p）性能足够。
app.disableHardwareAcceleration()

// 注册自定义协议，用于在渲染进程中安全地播放本地视频（支持断点/拖拽播放）
// standard: true 必须启用，否则自定义 scheme 的 URL 解析/媒体加载行为异常
// corsEnabled: true 允许 canvas 读取视频帧（配合响应中的 Access-Control-Allow-Origin）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
])

const DEFAULT_WINDOW_WIDTH = 900
const DEFAULT_WINDOW_HEIGHT = 800
const MIN_WINDOW_WIDTH = 320
const MIN_WINDOW_HEIGHT = 80
const WINDOW_STATE_FILE = 'window-state.json'
const WINDOW_STATE_SAVE_DELAY_MS = 200
const LECTURE_WINDOW_STATE_FILE = 'lecture-window-state.json'
const SETTINGS_FILE = 'app-settings.json'
const NOTES_FILE = 'note.json'
const LECTURE_STATE_FILE = 'lecture-state.json'
const DEFAULT_SETTINGS = {
  textSize: 22,
  opacity: 0.96,
  textColor: '#FFFFFF',
  selectedDictionary: 0,
  studyMode: 'normal',
  appMode: 'study'
}

const VIDEO_MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t'
}

function getMimeType(filePath) {
  return VIDEO_MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream'
}

let mainWindow = null
let settingsWindow = null
let lectureSettingsWindow = null
let lectureVideoWindow = null
let lectureNoteWindow = null
let modeSelectWindow = null
let tray = null
let saveBoundsTimer = null
let lectureVideoSaveTimer = null
let lectureNoteSaveTimer = null
let appSettings = { ...DEFAULT_SETTINGS }
// Alt+Q 隐藏状态标记：透明窗口不使用 hide()（会导致 DWM 合成表面失效变灰），
// 改为移到屏幕外，因此无法用 isVisible() 判断，需要独立标记
let isWindowHidden = false
// 隐藏前各窗口的原始位置，用于恢复
const offscreenPositions = new Map()

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
  const appMode = typeof source.appMode === 'string' && source.appMode === 'lecture' ? 'lecture' : 'study'

  return {
    textSize,
    opacity,
    textColor,
    selectedDictionary,
    studyMode,
    appMode
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
  // 隐藏到托盘时窗口位于屏幕外，跳过保存，避免覆盖正常位置记录
  if (bounds.x < -10000 || bounds.y < -10000) return
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

function getAllMainWindows() {
  return [mainWindow, lectureVideoWindow, lectureNoteWindow].filter(
    (win) => win && !win.isDestroyed()
  )
}

// 强制 DWM 重建透明窗口合成表面。
// 原理：DWM 对屏幕外/隐藏后透明的窗口可能丢弃合成表面，仅靠 invalidate()
// 或 setBackgroundColor() 无法可靠触发重建（DWM 可能忽略这些非几何信号）。
// 改变窗口大小是 DWM 无法忽略的几何变化，必然重新合成。放大后保持 50ms 给
// DWM 充足时间采样新表面再恢复，人眼无法察觉 +2px 的短暂变化。
function forceDwmRefresh(win) {
  if (!win || win.isDestroyed()) return
  try {
    const [w, h] = win.getSize()
    // 放大触发 DWM 表面重建
    win.setSize(w + 2, h)
    // 同步 invalidate，让 Chromium 在重建的表面上产出内容帧
    win.webContents?.invalidate()
    // 保持 50ms 给 DWM 充足时间采样新合成表面，再恢复大小
    setTimeout(() => {
      if (!win.isDestroyed()) {
        win.setSize(w, h)
        win.webContents?.invalidate()
      }
    }, 50)
  } catch { /* 忽略 */ }
}

function hideToTray() {
  // 隐藏前通知视频窗口暂停播放
  if (lectureVideoWindow && !lectureVideoWindow.isDestroyed()) {
    lectureVideoWindow.webContents.send('lecture:pause-video')
  }

  // 透明窗口不能直接 hide()（DWM 合成表面被销毁，恢复时重建失败则灰屏）。
  // 移到屏幕外保持窗口活跃，恢复时通过 forceDwmRefresh 重建表面。
  // 注意：移出前不 invalidate，因为 opacity < 100% 时 effectiveBackground
  // 是 transparent，invalid 会渲染一帧透明背景，DWM 缓存后恢复时反而变灰。
  const offscreenX = -32000
  const offscreenY = -32000

  getAllMainWindows().forEach((win) => {
    offscreenPositions.set(win.id, win.getPosition())
    win.setSkipTaskbar(true)
    win.setPosition(offscreenX, offscreenY)
  })
  isWindowHidden = true
}

function showPrimaryWindow() {
  const wins = getAllMainWindows()
  if (wins.length === 0) {
    openModeSelectDialog()
    return
  }

  wins.forEach((win) => {
    if (win.isMinimized()) {
      win.restore()
    }
    win.setSkipTaskbar(false)
    // 从屏幕外移回隐藏前的位置
    const savedPos = offscreenPositions.get(win.id)
    if (savedPos) {
      win.setPosition(savedPos[0], savedPos[1])
      offscreenPositions.delete(win.id)
    }
    win.show()
  })
  isWindowHidden = false

  // 第 1 次：延迟 20ms 再刷新。setPosition + show 后 DWM 可能尚未完成
  // 窗口在可见区域的注册，立即刷新等效于对着一个"不在位"的窗口操作，
  // 延迟一小段时间让 DWM 先把窗口安顿好再触发几何变更，命中率更高。
  setTimeout(() => {
    wins.forEach((win) => forceDwmRefresh(win))
  }, 20)

  // 第 2 次：恢复视频播放 + 二次 forceDwmRefresh（视频恢复出帧期间 DWM
  // 可能丢弃表面，再次刷新覆盖高风险窗口）
  setTimeout(() => {
    if (lectureVideoWindow && !lectureVideoWindow.isDestroyed()) {
      lectureVideoWindow.webContents.send('lecture:resume-video')
    }
    wins.forEach((win) => forceDwmRefresh(win))
  }, 120)

  // 第 3 次：视频出帧高峰（约 0.5s）后的最终兜底
  setTimeout(() => {
    wins.forEach((win) => {
      if (!win.isDestroyed()) {
        try { forceDwmRefresh(win) } catch { /* 忽略 */ }
      }
    })
  }, 550)

  // 确保主窗口获得键盘焦点（无边框/透明窗口在 Windows 上 focus 可能延迟生效）
  const focusTarget = wins[0]
  focusTarget.setFocusable(true)
  focusTarget.focus()
  setTimeout(() => {
    if (!focusTarget.isDestroyed()) {
      focusTarget.focus()
    }
  }, 100)
}

function toggleWindowVisibility() {
  const wins = getAllMainWindows()
  if (wins.length === 0) {
    openModeSelectDialog()
    return
  }

  if (isWindowHidden) {
    showPrimaryWindow()
    return
  }

  hideToTray()
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

// 听课模式设置弹窗（Alt+S 触发）：选择视频 + 调整窗口不透明度
function openLectureSettingsDialog() {
  if (lectureSettingsWindow && !lectureSettingsWindow.isDestroyed()) {
    lectureSettingsWindow.show()
    lectureSettingsWindow.focus()
    return
  }

  lectureSettingsWindow = new BrowserWindow({
    width: 520,
    height: 560,
    minWidth: 460,
    minHeight: 300,
    show: false,
    autoHideMenuBar: true,
    maximizable: false,
    title: '听课设置',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  lectureSettingsWindow.removeMenu()

  lectureSettingsWindow.on('ready-to-show', () => {
    lectureSettingsWindow?.show()
    lectureSettingsWindow?.focus()
  })

  lectureSettingsWindow.on('closed', () => {
    lectureSettingsWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    lectureSettingsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=lecture-settings`)
  } else {
    lectureSettingsWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'lecture-settings' }
    })
  }
}

function createModeSelectWindow() {
  if (modeSelectWindow && !modeSelectWindow.isDestroyed()) {
    modeSelectWindow.show()
    modeSelectWindow.focus()
    return
  }

  modeSelectWindow = new BrowserWindow({
    width: 500,
    height: 380,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    autoHideMenuBar: true,
    title: '选择模式',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  modeSelectWindow.removeMenu()

  modeSelectWindow.on('ready-to-show', () => {
    modeSelectWindow?.show()
    modeSelectWindow?.focus()
  })

  modeSelectWindow.on('closed', () => {
    modeSelectWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    modeSelectWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=mode-select`)
  } else {
    modeSelectWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'mode-select' }
    })
  }
}

function closePrimaryWindows() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy()
  }
  closeLectureWindows()
}

function closeLectureWindows() {
  // destroy() 不会触发 close 事件，先手动保存窗口位置/大小
  saveLectureWindowState('video')
  saveLectureWindowState('notes')

  if (lectureVideoWindow && !lectureVideoWindow.isDestroyed()) {
    lectureVideoWindow.destroy()
  }
  if (lectureNoteWindow && !lectureNoteWindow.isDestroyed()) {
    lectureNoteWindow.destroy()
  }

  // 清理隐藏状态（隐藏中切换模式/退出时，避免残留标记影响新窗口）
  isWindowHidden = false
  offscreenPositions.clear()
}

function openModeSelectDialog() {
  closePrimaryWindows()
  createModeSelectWindow()
}

function getLectureWindowByKey(key) {
  return key === 'video' ? lectureVideoWindow : lectureNoteWindow
}

function saveLectureWindowState(key) {
  const win = getLectureWindowByKey(key)
  if (!win || win.isDestroyed()) return
  if (win.isMinimized() || win.isMaximized()) return

  const bounds = win.getBounds()
  // 隐藏到托盘时窗口位于屏幕外，跳过保存，避免覆盖正常位置记录
  if (bounds.x < -10000 || bounds.y < -10000) return
  const logicalW = bounds.width
  const logicalH = bounds.height

  // 校验合理性，避免透明窗口在隐藏/关闭过程中返回的异常值覆盖正常记录
  if (!Number.isFinite(logicalW) || !Number.isFinite(logicalH)) return
  if (logicalW < 100 || logicalH < 60) return

  // 保存物理尺寸（逻辑 × 所在显示器缩放因子），跨 DPI 显示器恢复时按目标缩放换算，避免视觉尺寸变化
  // 统一按窗口左上角判断显示器（与恢复时一致，避免跨屏窗口 scale 判断不一致）
  const display = screen.getDisplayMatching({ x: bounds.x, y: bounds.y, width: 1, height: 1 })
  const scale = display?.scaleFactor || 1
  const saveBounds = {
    x: bounds.x,
    y: bounds.y,
    width: Math.round(logicalW * scale),
    height: Math.round(logicalH * scale),
    scaleFactor: scale
  }

  const statePath = join(app.getPath('userData'), LECTURE_WINDOW_STATE_FILE)
  let all = {}
  try {
    if (existsSync(statePath)) {
      all = JSON.parse(readFileSync(statePath, 'utf-8'))
    }
  } catch {
    all = {}
  }

  all[key] = saveBounds
  try {
    writeFileSync(statePath, JSON.stringify(all), 'utf-8')
  } catch (error) {
    console.warn('Failed to save lecture window state:', error)
  }
}

function scheduleLectureWindowStateSave(key) {
  // 每个窗口独立的防抖定时器，避免互相覆盖
  if (key === 'video') {
    if (lectureVideoSaveTimer) {
      clearTimeout(lectureVideoSaveTimer)
    }
    lectureVideoSaveTimer = setTimeout(() => {
      saveLectureWindowState('video')
      lectureVideoSaveTimer = null
    }, WINDOW_STATE_SAVE_DELAY_MS)
  } else {
    if (lectureNoteSaveTimer) {
      clearTimeout(lectureNoteSaveTimer)
    }
    lectureNoteSaveTimer = setTimeout(() => {
      saveLectureWindowState('notes')
      lectureNoteSaveTimer = null
    }, WINDOW_STATE_SAVE_DELAY_MS)
  }
}

function getInitialLectureBounds(key, defaultWidth, defaultHeight) {
  const defaultState = { width: defaultWidth, height: defaultHeight }
  try {
    const statePath = join(app.getPath('userData'), LECTURE_WINDOW_STATE_FILE)
    if (!existsSync(statePath)) return defaultState
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8'))
    const saved = parsed[key]
    if (!saved || typeof saved !== 'object') return defaultState
    // 校验保存值合理性，异常（过小/位置无效）时回退默认
    if (!Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return defaultState
    if (saved.width < 100 || saved.height < 60) return defaultState

    // 目标显示器缩放因子：优先按保存位置确定，否则用主屏
    let targetScale = 1
    if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      const display = screen.getDisplayMatching({ x: saved.x, y: saved.y, width: 1, height: 1 })
      targetScale = display?.scaleFactor || 1
    } else {
      targetScale = screen.getPrimaryDisplay()?.scaleFactor || 1
    }

    // 保存的是物理尺寸，按目标显示器缩放因子换算回逻辑尺寸，保持视觉（物理）尺寸一致
    const bounds = {
      width: Math.max(100, Math.round(saved.width / targetScale)),
      height: Math.max(60, Math.round(saved.height / targetScale))
    }

    // 恢复上次保存的窗口位置（x/y），需在屏幕内
    if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      const candidate = { x: saved.x, y: saved.y, width: bounds.width, height: bounds.height }
      if (isBoundsVisible(candidate)) {
        bounds.x = Math.round(saved.x)
        bounds.y = Math.round(saved.y)
      }
    }
    return bounds
  } catch (error) {
    console.warn('Failed to load lecture window state:', error)
    return defaultState
  }
}

// 从 lecture-state.json 读取保存的不透明度，分别应用到视频/笔记窗口
function applySavedWindowOpacity() {
  const apply = () => {
    try {
      const statePath = join(process.cwd(), LECTURE_STATE_FILE)
      if (!existsSync(statePath)) return
      const state = JSON.parse(readFileSync(statePath, 'utf-8'))
      // 兼容旧版本保存的统一 windowOpacity 字段
      const videoRaw = Number(state.videoOpacity ?? state.windowOpacity)
      const noteRaw = Number(state.noteOpacity ?? state.windowOpacity)

      const applyOpacity = (win, raw) => {
        if (win && !win.isDestroyed() && Number.isFinite(raw)) {
          win.webContents.send('window:opacity', Math.min(100, Math.max(10, raw)) / 100)
        }
      }
      applyOpacity(lectureVideoWindow, videoRaw)
      applyOpacity(lectureNoteWindow, noteRaw)

      // 恢复保存的背景色（视频/笔记窗口分别设置）
      const videoBg = typeof state.videoBackground === 'string' ? state.videoBackground : null
      const noteBg = typeof state.noteBackground === 'string' ? state.noteBackground : null
      if (videoBg && lectureVideoWindow && !lectureVideoWindow.isDestroyed()) {
        lectureVideoWindow.webContents.send('window:background', videoBg)
      }
      if (noteBg && lectureNoteWindow && !lectureNoteWindow.isDestroyed()) {
        lectureNoteWindow.webContents.send('window:background', noteBg)
      }

      // 恢复编辑器样式（字体颜色/大小）
      if (lectureNoteWindow && !lectureNoteWindow.isDestroyed()) {
        if (typeof state.editorColor === 'string') {
          lectureNoteWindow.webContents.send('editor:style', 'color', state.editorColor)
        }
        if (Number.isFinite(Number(state.editorFontSize))) {
          lectureNoteWindow.webContents.send('editor:style', 'fontSize', Number(state.editorFontSize))
        }
      }
    } catch (error) {
      console.warn('Failed to apply saved window opacity:', error)
    }
  }

  // 等待所有听课窗口加载完成后再广播，避免事件在渲染端监听注册前丢失
  const windows = [lectureVideoWindow, lectureNoteWindow].filter((w) => w && !w.isDestroyed())
  if (windows.length === 0) return

  const pending = windows.filter((w) => w.webContents.isLoading())
  if (pending.length === 0) {
    apply()
    return
  }

  let applied = false
  const tryApply = () => {
    if (applied) return
    if (windows.some((w) => !w.isDestroyed() && w.webContents.isLoading())) return
    applied = true
    apply()
  }
  pending.forEach((w) => {
    w.webContents.once('did-finish-load', tryApply)
  })
}

function createLectureVideoWindow() {
  if (lectureVideoWindow && !lectureVideoWindow.isDestroyed()) {
    lectureVideoWindow.show()
    lectureVideoWindow.focus()
    return
  }

  const bounds = getInitialLectureBounds('video', 900, 650)
  const restoredVideoBounds =
    Number.isFinite(bounds.x) && Number.isFinite(bounds.y)
      ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      : null

  lectureVideoWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(restoredVideoBounds && isBoundsVisible(restoredVideoBounds)
      ? { x: bounds.x, y: bounds.y }
      : {}),
    minWidth: 100,
    minHeight: 60,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    autoHideMenuBar: true,
    backgroundColor: '#00000000',
    title: '听课模式 - 视频',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // 防止 Chromium 认为窗口在后台时暂停视频渲染（透明窗口偶发灰屏的诱因之一）
      backgroundThrottling: false
    }
  })

  lectureVideoWindow.removeMenu()

  lectureVideoWindow.on('ready-to-show', () => {
    lectureVideoWindow?.show()
  })

  lectureVideoWindow.on('move', () => scheduleLectureWindowStateSave('video'))
  lectureVideoWindow.on('resize', () => scheduleLectureWindowStateSave('video'))
  lectureVideoWindow.on('close', () => saveLectureWindowState('video'))
  lectureVideoWindow.on('closed', () => {
    lectureVideoWindow = null
    // 关闭视频窗口时同步关闭笔记窗口，保持听课模式整体退出
    if (lectureNoteWindow && !lectureNoteWindow.isDestroyed()) {
      lectureNoteWindow.close()
    }
  })

  lectureVideoWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    lectureVideoWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=lecture-video`)
  } else {
    lectureVideoWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'lecture-video' }
    })
  }
}

function createLectureNoteWindow() {
  if (lectureNoteWindow && !lectureNoteWindow.isDestroyed()) {
    lectureNoteWindow.show()
    lectureNoteWindow.focus()
    return
  }

  const bounds = getInitialLectureBounds('notes', 640, 800)
  const restoredNoteBounds =
    Number.isFinite(bounds.x) && Number.isFinite(bounds.y)
      ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      : null

  lectureNoteWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(restoredNoteBounds && isBoundsVisible(restoredNoteBounds)
      ? { x: bounds.x, y: bounds.y }
      : {}),
    minWidth: 100,
    minHeight: 60,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    autoHideMenuBar: true,
    backgroundColor: '#00000000',
    title: '听课模式 - 笔记',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  lectureNoteWindow.removeMenu()

  lectureNoteWindow.on('ready-to-show', () => {
    lectureNoteWindow?.show()
  })

  lectureNoteWindow.on('move', () => scheduleLectureWindowStateSave('notes'))
  lectureNoteWindow.on('resize', () => scheduleLectureWindowStateSave('notes'))
  lectureNoteWindow.on('close', () => saveLectureWindowState('notes'))
  lectureNoteWindow.on('closed', () => {
    lectureNoteWindow = null
    // 关闭笔记窗口时同步关闭视频窗口
    if (lectureVideoWindow && !lectureVideoWindow.isDestroyed()) {
      lectureVideoWindow.close()
    }
  })

  lectureNoteWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    lectureNoteWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=lecture-notes`)
  } else {
    lectureNoteWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'lecture-notes' }
    })
  }
}

function selectMode(mode) {
  const targetMode = mode === 'lecture' ? 'lecture' : 'study'
  appSettings = saveAppSettings({ ...appSettings, appMode: targetMode })

  closePrimaryWindows()

  if (targetMode === 'lecture') {
    createLectureVideoWindow()
    createLectureNoteWindow()
    applySavedWindowOpacity()
  } else {
    createWindow()
  }

  if (modeSelectWindow && !modeSelectWindow.isDestroyed()) {
    modeSelectWindow.close()
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
        click: showPrimaryWindow
      },
      {
        label: '切换模式…',
        click: openModeSelectDialog
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
    showPrimaryWindow()
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

  ;[lectureVideoWindow, lectureNoteWindow].forEach((win) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('settings:changed', appSettings)
    }
  })

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

  // 自定义 media:// 协议：把渲染进程的 media://video/<path> 请求代理到本地文件
  // 手动处理 Range 请求，保证视频可正常播放与拖拽进度
  protocol.handle('media', async (request) => {
    try {
      const url = new URL(request.url)
      // 形如 media://video/<encodeURIComponent(绝对路径)>，其中 <绝对路径> 落在 pathname 中
      const filePath = decodeURIComponent(url.pathname.slice(1))
      if (!existsSync(filePath)) {
        return new Response('Not found', { status: 404 })
      }

      const { size } = await stat(filePath)
      const mimeType = getMimeType(filePath)
      const rangeHeader = request.headers.get('Range')

      if (rangeHeader) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)
        if (match) {
          let start = match[1] ? parseInt(match[1], 10) : 0
          let end = match[2] ? parseInt(match[2], 10) : size - 1
          if (!Number.isFinite(start) || start < 0) start = 0
          if (!Number.isFinite(end) || end >= size) end = size - 1
          if (start > end) {
            return new Response('Range not satisfiable', { status: 416 })
          }
          const stream = Readable.toWeb(createReadStream(filePath, { start, end }))
          return new Response(stream, {
            status: 206,
            headers: {
              'Content-Type': mimeType,
              'Content-Length': String(end - start + 1),
              'Content-Range': `bytes ${start}-${end}/${size}`,
              'Accept-Ranges': 'bytes',
              'Access-Control-Allow-Origin': '*'
            }
          })
        }
      }

      const stream = Readable.toWeb(createReadStream(filePath))
      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*'
        }
      })
    } catch (error) {
      console.error('Failed to serve media file:', error)
      return new Response('Not found', { status: 404 })
    }
  })

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
  // 复制图片到剪贴板（F1 截取视频帧）
  ipcMain.handle('clipboard:write-image', (_, dataUrl) => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return false
    try {
      clipboard.writeImage(nativeImage.createFromDataURL(dataUrl))
      return true
    } catch (error) {
      console.error('Failed to write image to clipboard:', error)
      return false
    }
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
    showPrimaryWindow()
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

  // 模式选择
  ipcMain.handle('mode:select', (_, mode) => {
    selectMode(mode)
    return true
  })

  // 选择本地视频文件
  ipcMain.handle('dialog:select-video', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择视频文件',
      properties: ['openFile'],
      filters: [
        { name: '视频文件', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'flv', 'ts'] }
      ]
    })

    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // 笔记读写：保存到项目根目录的 note.json，文件不存在时自动创建
  ipcMain.handle('notes:load', async () => {
    const notesPath = join(process.cwd(), NOTES_FILE)
    try {
      if (!existsSync(notesPath)) return ''
      return readFileSync(notesPath, 'utf-8')
    } catch (error) {
      console.error('Failed to load notes:', error)
      return ''
    }
  })

  ipcMain.handle('notes:save', async (_, content) => {
    const notesPath = join(process.cwd(), NOTES_FILE)
    try {
      // writeFileSync 在文件不存在时会自动创建
      writeFileSync(notesPath, typeof content === 'string' ? content : '', 'utf-8')
      return true
    } catch (error) {
      console.error('Failed to save notes:', error)
      throw error
    }
  })

  // 听课模式状态（视频路径、不透明度、置顶等）
  ipcMain.handle('lecture:load-state', async () => {
    const statePath = join(process.cwd(), LECTURE_STATE_FILE)
    try {
      if (!existsSync(statePath)) return null
      return JSON.parse(readFileSync(statePath, 'utf-8'))
    } catch (error) {
      console.error('Failed to load lecture state:', error)
      return null
    }
  })

  ipcMain.handle('lecture:save-state', async (_, payload) => {
    const statePath = join(process.cwd(), LECTURE_STATE_FILE)
    try {
      writeFileSync(
        statePath,
        JSON.stringify(payload && typeof payload === 'object' ? payload : {}),
        'utf-8'
      )
      return true
    } catch (error) {
      console.error('Failed to save lecture state:', error)
      return false
    }
  })

  // 窗口不透明度控制（供听课模式使用，可分别设置视频/笔记窗口）
  // 窗口为 transparent，无法使用 setOpacity，改为向目标窗口广播事件，由渲染层用 CSS opacity 实现
  ipcMain.handle('window:set-opacity', (event, target, value) => {
    const opacity = Number(clampNumber(value, 0.05, 1, 1).toFixed(2))
    const targetWindow = target === 'notes' ? lectureNoteWindow : lectureVideoWindow
    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.webContents.send('window:opacity', opacity)
    }
    return true
  })

  // 手动拖拽窗口：按增量移动当前窗口（笔记窗口按住任意处拖动）
  ipcMain.on('window:move-by', (event, dx, dy) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    const [x, y] = win.getPosition()
    win.setPosition(Math.round(x + (Number(dx) || 0)), Math.round(y + (Number(dy) || 0)))
  })

  // 设置窗口背景色（视频/笔记窗口分别设置，支持透明）
  ipcMain.handle('window:set-background', (event, target, color) => {
    const targetWindow = target === 'notes' ? lectureNoteWindow : lectureVideoWindow
    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.webContents.send('window:background', typeof color === 'string' ? color : '#000000')
    }
    return true
  })

  // 编辑器样式（字体颜色/大小）广播给笔记窗口
  ipcMain.handle('window:set-editor-style', (event, key, value) => {
    if (lectureNoteWindow && !lectureNoteWindow.isDestroyed()) {
      lectureNoteWindow.webContents.send('editor:style', key, value)
    }
    return true
  })

  // 设置弹窗中选择了新视频，通知视频窗口切换
  ipcMain.handle('lecture:set-video', (_, filePath) => {
    if (lectureVideoWindow && !lectureVideoWindow.isDestroyed()) {
      lectureVideoWindow.webContents.send('lecture:video-changed', typeof filePath === 'string' ? filePath : '')
      // transparent 窗口在切换视频源重载 <video> 时 DWM 合成可能异常（画面变灰），
      // 延迟强制重绘刷新（与 Alt+Q 隐藏/显示变灰是同一类问题）
      setTimeout(() => {
        if (!lectureVideoWindow.isDestroyed() && lectureVideoWindow.webContents) {
          lectureVideoWindow.webContents.invalidate()
        }
      }, 200)
    }
    return true
  })

  ipcMain.on('lecture-settings:close', (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    if (senderWindow && senderWindow === lectureSettingsWindow) {
      senderWindow.close()
    }
  })

  ipcMain.on('app:quit', () => {
    app.quit()
  })

  createModeSelectWindow()
  createTray()

  const shortcutRegistered = globalShortcut.register('Alt+Q', () => {
    toggleWindowVisibility()
  })

  if (!shortcutRegistered) {
    console.warn('Failed to register global shortcut Alt+Q.')
  }

  const settingsShortcutRegistered = globalShortcut.register('Alt+S', () => {
    // 听课模式下弹出听课设置（选择视频 / 窗口不透明度），背词模式保持原有设置
    if (appSettings.appMode === 'lecture') {
      openLectureSettingsDialog()
    } else {
      openSettingsDialog()
    }
  })

  if (!settingsShortcutRegistered) {
    console.warn('Failed to register global shortcut Alt+S.')
  }

  const modeShortcutRegistered = globalShortcut.register('Alt+M', () => {
    openModeSelectDialog()
  })

  if (!modeShortcutRegistered) {
    console.warn('Failed to register global shortcut Alt+M.')
  }

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createModeSelectWindow()
      return
    }

    showPrimaryWindow()
  })
})

app.on('before-quit', () => {
  if (saveBoundsTimer) {
    clearTimeout(saveBoundsTimer)
    saveBoundsTimer = null
  }

  if (lectureVideoSaveTimer) {
    clearTimeout(lectureVideoSaveTimer)
    lectureVideoSaveTimer = null
  }
  if (lectureNoteSaveTimer) {
    clearTimeout(lectureNoteSaveTimer)
    lectureNoteSaveTimer = null
  }

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.destroy()
    settingsWindow = null
  }

  if (lectureSettingsWindow && !lectureSettingsWindow.isDestroyed()) {
    lectureSettingsWindow.destroy()
    lectureSettingsWindow = null
  }

  closeLectureWindows()

  if (modeSelectWindow && !modeSelectWindow.isDestroyed()) {
    modeSelectWindow.destroy()
    modeSelectWindow = null
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
