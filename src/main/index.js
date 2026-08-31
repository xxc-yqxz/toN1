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

// 窗口方案说明（2026-08 重构）：
// 此前视频/笔记窗口使用 transparent:true（Windows 分层窗口 WS_EX_LAYERED），
// 在视频播放 + 被其他窗口遮挡 + Alt+Q 隐藏显示的组合下，Chromium 会暂停视频
// 渲染且无法可靠恢复，窗口呈现灰色残留。经排查（截图时正常 → 内容本身正确、
// 窗口失去焦点后透过半透明看到灰色背景 → 视频帧未续渲染），透明窗口方案在
// Windows 上无法根治。现改用 Electron 官方推荐的方案：
//   普通窗口（transparent:false）+ setOpacity() 原生窗口不透明度。
// 由 Windows 直接支持原生半透明，不涉及 Chromium 分层窗口渲染暂停逻辑，
// 从机制上绕开变灰问题。代价：背景不能真正"穿透"桌面（显示不透明底色）。

// 仍保留遮挡检测开关：防止窗口被覆盖时 Chromium 暂停渲染（对普通窗口同样有益）
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

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
// 背词主窗口（透明悬浮）允许更小的高度，便于贴合单行文字
const MIN_STUDY_WINDOW_HEIGHT = 24
const MAX_STUDY_WINDOW_HEIGHT = 2000
const WINDOW_STATE_FILE = 'window-state.json'
const WINDOW_STATE_SAVE_DELAY_MS = 200
const LECTURE_WINDOW_STATE_FILE = 'lecture-window-state.json'
const SETTINGS_FILE = 'app-settings.json'
const NOTES_FILE = 'note.json'
const LECTURE_STATE_FILE = 'lecture-state.json'
const BROWSER_STATE_FILE = 'browser-state.json'
const STUDY_PROGRESS_FILE = 'study-progress.json'
const DEFAULT_SETTINGS = {
  textSize: 22,
  opacity: 0.96,
  textColor: '#FFFFFF',
  selectedDictionary: 0,
  studyMode: 'normal',
  appMode: 'study',
  autoSpeakInterval: 0, // 自动朗读间隔（秒），0 = 关闭
  speechRate: 1 // 朗读语速倍率（0.5 ~ 2.0），1 = 正常语速
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
let browserWindow = null
let browserSettingsWindow = null
let modeSelectWindow = null
let tray = null
let saveBoundsTimer = null
let lectureVideoSaveTimer = null
let lectureNoteSaveTimer = null
let snapBottomTimer = null
let appSettings = { ...DEFAULT_SETTINGS }
// Alt+Q 隐藏状态标记：隐藏时窗口移到屏幕外（不 hide()、不改页面透明度），
// isVisible() 恒为 true，因此用独立标记判断当前是否处于隐藏状态
let isWindowHidden = false

function getWindowStatePath() {
  return join(app.getPath('userData'), WINDOW_STATE_FILE)
}

function getSettingsPath() {
  return join(app.getPath('userData'), SETTINGS_FILE)
}

function getStudyProgressPath() {
  return join(app.getPath('userData'), STUDY_PROGRESS_FILE)
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
  const appMode =
    typeof source.appMode === 'string' && (source.appMode === 'lecture' || source.appMode === 'browser')
      ? source.appMode
      : 'study'
  const autoSpeakInterval = Number(
    clampNumber(source.autoSpeakInterval, 0, 3600, DEFAULT_SETTINGS.autoSpeakInterval)
  )
  const speechRate = Number(
    clampNumber(source.speechRate, 0.5, 2, DEFAULT_SETTINGS.speechRate).toFixed(2)
  )

  return {
    textSize,
    opacity,
    textColor,
    selectedDictionary,
    studyMode,
    appMode,
    autoSpeakInterval,
    speechRate
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

// 背词透明窗口跨 DPI 显示器拖拽时，Windows 坐标换算会留下误差，
// 导致窗口底边无法真正贴到屏幕底部（扩展屏尤其明显）。
// 移动停止后检测：若底边距当前显示器 workArea 底部很近（视为「想贴底」），
// 强制 setPosition 精确贴齐，消除跨 DPI 的间隙。
function snapMainWindowToBottomEdge() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized() || mainWindow.isMaximized()) return

  const bounds = mainWindow.getBounds()
  // 隐藏到托盘时窗口在屏幕外，跳过
  if (bounds.x < -10000 || bounds.y < -10000) return

  const display = screen.getDisplayMatching(bounds)
  const workArea = display.workArea
  const bottom = workArea.y + workArea.height
  const windowBottom = bounds.y + bounds.height
  const gap = bottom - windowBottom

  // 仅当底边距屏幕底部 0~2px（视为用户已手动拖到最底）时，强制精确贴齐，
  // 消除跨 DPI 的微小间隙；离底部稍远则不干预，避免误吸附
  if (gap > 0 && gap <= 2) {
    mainWindow.setPosition(bounds.x, bottom - bounds.height)
  }
}

function scheduleSnapToBottom() {
  if (snapBottomTimer) {
    clearTimeout(snapBottomTimer)
  }

  snapBottomTimer = setTimeout(() => {
    snapMainWindowToBottomEdge()
    snapBottomTimer = null
  }, 150)
}

function getAllMainWindows() {
  return [mainWindow, lectureVideoWindow, lectureNoteWindow, browserWindow].filter(
    (win) => win && !win.isDestroyed()
  )
}

// 隐藏/显示：窗口已改为普通窗口（非 transparent），直接使用标准 hide()/show()，
// 不再存在透明窗口分层合成表面丢失的问题，恢复显示 100% 可靠。
function hideToTray() {
  // 隐藏前通知视频窗口暂停播放
  if (lectureVideoWindow && !lectureVideoWindow.isDestroyed()) {
    lectureVideoWindow.webContents.send('lecture:pause-video')
  }

  getAllMainWindows().forEach((win) => {
    win.setSkipTaskbar(true)
    win.hide()
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
    win.show()
  })
  isWindowHidden = false

  // 恢复视频播放（窗口显示后再触发，视频本身会自然刷新画面）
  setTimeout(() => {
    if (lectureVideoWindow && !lectureVideoWindow.isDestroyed()) {
      lectureVideoWindow.webContents.send('lecture:resume-video')
    }
  }, 120)

  // 确保主窗口获得键盘焦点（无边框/普通窗口在 Windows 上 focus 可能延迟生效）
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
    height: 470,
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
  closeBrowserWindow()
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
}

function closeBrowserWindow() {
  if (browserWindow && !browserWindow.isDestroyed()) {
    browserWindow.destroy()
  }
  isWindowHidden = false
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

      // 视频窗口：普通窗口，用原生 setOpacity；
      // 笔记窗口：透明窗口，用 CSS opacity 广播（透明窗口不能用 setOpacity）
      if (lectureVideoWindow && !lectureVideoWindow.isDestroyed() && Number.isFinite(videoRaw)) {
        lectureVideoWindow.setOpacity(Math.min(100, Math.max(10, videoRaw)) / 100)
      }
      if (lectureNoteWindow && !lectureNoteWindow.isDestroyed() && Number.isFinite(noteRaw)) {
        lectureNoteWindow.webContents.send('window:opacity', Math.min(100, Math.max(10, noteRaw)) / 100)
      }

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
    // 不再使用 transparent（分层窗口渲染缺陷导致视频变灰），
    // 改用普通窗口 + setOpacity 原生不透明度。背景为不透明黑色。
    transparent: false,
    hasShadow: false,
    thickFrame: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    title: '听课模式 - 视频',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // 防止 Chromium 认为窗口在后台时暂停视频渲染
      backgroundThrottling: false
    }
  })

  lectureVideoWindow.removeMenu()

  // 运行时再次关闭后台节流（比 webPreferences 配置更可靠），
  // 防止窗口被覆盖/失焦时 Chromium 暂停视频渲染
  lectureVideoWindow.webContents.setBackgroundThrottling(false)

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
    // 笔记窗口没有视频渲染问题，保持透明窗口方案（CSS opacity 控制不透明度），
    // 透明悬浮效果正常，无需切换为普通窗口
    transparent: true,
    hasShadow: false,
    thickFrame: false,
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

  // 运行时关闭后台节流，防止被覆盖/失焦时渲染暂停
  lectureNoteWindow.webContents.setBackgroundThrottling(false)

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

function createBrowserWindow() {
  if (browserWindow && !browserWindow.isDestroyed()) {
    browserWindow.show()
    browserWindow.focus()
    return
  }

  browserWindow = new BrowserWindow({
    // 默认手机尺寸（约 400x860，竖屏手机比例）
    width: 400,
    height: 860,
    minWidth: 320,
    minHeight: 480,
    show: false,
    // 无边框：去掉系统标题栏及最小化/最大化/关闭按钮
    frame: false,
    autoHideMenuBar: true,
    // 浏览器模式：普通窗口 + setOpacity 原生半透明，避免透明窗口灰屏问题
    transparent: false,
    backgroundColor: '#ffffff',
    title: '浏览器模式',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // 启用 <webview> 标签以加载外部网页
      webviewTag: true,
      backgroundThrottling: false
    }
  })

  browserWindow.removeMenu()
  browserWindow.webContents.setBackgroundThrottling(false)

  browserWindow.on('ready-to-show', () => {
    browserWindow?.show()
  })

  browserWindow.on('closed', () => {
    browserWindow = null
  })

  // webview 中点击 target=_blank 链接时，用系统浏览器打开，而不是新建窗口。
  // 滚轮缩放改由渲染进程注入脚本实现（before-input-event 不触发 webview 滚轮事件）
  browserWindow.webContents.on('did-attach-webview', (_event, wc) => {
    wc.setWindowOpenHandler((details) => {
      shell.openExternal(details.url)
      return { action: 'deny' }
    })
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    browserWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=browser`)
  } else {
    browserWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'browser' }
    })
  }
}

// 浏览器模式设置弹窗（Alt+S 触发）：输入网址 + 调整窗口不透明度
function openBrowserSettingsDialog() {
  if (browserSettingsWindow && !browserSettingsWindow.isDestroyed()) {
    browserSettingsWindow.show()
    browserSettingsWindow.focus()
    return
  }

  browserSettingsWindow = new BrowserWindow({
    width: 520,
    height: 420,
    minWidth: 460,
    minHeight: 260,
    show: false,
    autoHideMenuBar: true,
    maximizable: false,
    title: '浏览器设置',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  browserSettingsWindow.removeMenu()

  browserSettingsWindow.on('ready-to-show', () => {
    browserSettingsWindow?.show()
    browserSettingsWindow?.focus()
  })

  browserSettingsWindow.on('closed', () => {
    browserSettingsWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    browserSettingsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=browser-settings`)
  } else {
    browserSettingsWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'browser-settings' }
    })
  }
}

// 从 browser-state.json 恢复网址与不透明度
function applySavedBrowserState() {
  const apply = () => {
    try {
      const statePath = join(process.cwd(), BROWSER_STATE_FILE)
      if (!existsSync(statePath)) return
      const state = JSON.parse(readFileSync(statePath, 'utf-8'))
      const raw = Number(state.browserOpacity)
      if (browserWindow && !browserWindow.isDestroyed() && Number.isFinite(raw)) {
        browserWindow.setOpacity(Math.min(100, Math.max(10, raw)) / 100)
      }
      if (typeof state.browserUrl === 'string' && state.browserUrl) {
        if (browserWindow && !browserWindow.isDestroyed()) {
          browserWindow.webContents.send('browser:navigate', state.browserUrl)
        }
      }
    } catch (error) {
      console.warn('Failed to apply saved browser state:', error)
    }
  }

  if (!browserWindow || browserWindow.isDestroyed()) return
  if (browserWindow.webContents.isLoading()) {
    browserWindow.webContents.once('did-finish-load', apply)
  } else {
    apply()
  }
}

function selectMode(mode) {
  const targetMode = mode === 'lecture' ? 'lecture' : mode === 'browser' ? 'browser' : 'study'
  appSettings = saveAppSettings({ ...appSettings, appMode: targetMode })

  closePrimaryWindows()

  if (targetMode === 'lecture') {
    createLectureVideoWindow()
    createLectureNoteWindow()
    applySavedWindowOpacity()
  } else if (targetMode === 'browser') {
    createBrowserWindow()
    applySavedBrowserState()
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
    minHeight: MIN_STUDY_WINDOW_HEIGHT,
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

  mainWindow.on('move', () => {
    scheduleWindowStateSave()
    scheduleSnapToBottom()
  })
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

  // 背诵进度持久化：保存/恢复上次背到的词典与位置
  ipcMain.handle('progress:load', async () => {
    const progressPath = getStudyProgressPath()
    try {
      if (!existsSync(progressPath)) return null
      const parsed = JSON.parse(readFileSync(progressPath, 'utf-8'))
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch (error) {
      console.warn('Failed to load study progress:', error)
      return null
    }
  })

  ipcMain.handle('progress:save', async (_, payload) => {
    const progressPath = getStudyProgressPath()
    try {
      writeFileSync(
        progressPath,
        JSON.stringify(payload && typeof payload === 'object' ? payload : {}),
        'utf-8'
      )
      return true
    } catch (error) {
      console.error('Failed to save study progress:', error)
      return false
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

  // 背词主窗口：按内容调整窗口尺寸（高度贴合文字；宽度在文字超宽时自动拉伸）
  // 左边缘固定不动，宽度变化时向右侧延伸（x 不变、width 增大）
  ipcMain.handle('window:set-content-size', (_, width, height) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    const bounds = mainWindow.getBounds()
    const display = screen.getDisplayMatching(bounds)
    // 宽度上限：当前显示器工作区宽度，避免长文本把窗口拉得超出屏幕
    const maxWidth = Math.max(MIN_WINDOW_WIDTH, Math.floor(display.workArea.width))
    const currentWidth = mainWindow.getContentSize()[0]
    const targetWidth = Math.round(clampNumber(width, MIN_WINDOW_WIDTH, maxWidth, currentWidth))
    const targetHeight = Math.round(
      clampNumber(height, MIN_STUDY_WINDOW_HEIGHT, MAX_STUDY_WINDOW_HEIGHT, MIN_STUDY_WINDOW_HEIGHT)
    )
    mainWindow.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: targetWidth,
      height: targetHeight
    })
    return true
  })

  // 窗口不透明度控制（供听课/浏览器模式使用，可分别设置各窗口）
  // 视频/浏览器窗口为普通窗口，用原生 setOpacity；
  // 笔记窗口为透明窗口（不能用 setOpacity），广播 CSS opacity 事件由渲染层应用
  ipcMain.handle('window:set-opacity', (event, target, value) => {
    const opacity = Number(clampNumber(value, 0.05, 1, 1).toFixed(2))
    if (target === 'notes') {
      if (lectureNoteWindow && !lectureNoteWindow.isDestroyed()) {
        lectureNoteWindow.webContents.send('window:opacity', opacity)
      }
    } else if (target === 'browser') {
      if (browserWindow && !browserWindow.isDestroyed()) {
        browserWindow.setOpacity(opacity)
      }
    } else if (lectureVideoWindow && !lectureVideoWindow.isDestroyed()) {
      lectureVideoWindow.setOpacity(opacity)
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

  // 浏览器模式：设置弹窗输入网址后导航浏览器窗口
  ipcMain.handle('browser:navigate', (_, url) => {
    if (browserWindow && !browserWindow.isDestroyed() && typeof url === 'string' && url) {
      browserWindow.webContents.send('browser:navigate', url)
    }
    return true
  })

  // 浏览器模式状态（网址、不透明度）
  ipcMain.handle('browser:load-state', async () => {
    const statePath = join(process.cwd(), BROWSER_STATE_FILE)
    try {
      if (!existsSync(statePath)) return null
      return JSON.parse(readFileSync(statePath, 'utf-8'))
    } catch (error) {
      console.error('Failed to load browser state:', error)
      return null
    }
  })

  ipcMain.handle('browser:save-state', async (_, payload) => {
    const statePath = join(process.cwd(), BROWSER_STATE_FILE)
    try {
      writeFileSync(
        statePath,
        JSON.stringify(payload && typeof payload === 'object' ? payload : {}),
        'utf-8'
      )
      return true
    } catch (error) {
      console.error('Failed to save browser state:', error)
      return false
    }
  })

  ipcMain.on('browser-settings:close', (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    if (senderWindow && senderWindow === browserSettingsWindow) {
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
    // 听课模式弹听课设置、浏览器模式弹浏览器设置、背词模式保持原有设置
    if (appSettings.appMode === 'lecture') {
      openLectureSettingsDialog()
    } else if (appSettings.appMode === 'browser') {
      openBrowserSettingsDialog()
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

  if (snapBottomTimer) {
    clearTimeout(snapBottomTimer)
    snapBottomTimer = null
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

  if (browserSettingsWindow && !browserSettingsWindow.isDestroyed()) {
    browserSettingsWindow.destroy()
    browserSettingsWindow = null
  }

  closeLectureWindows()
  closeBrowserWindow()

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
