<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ModeSelect from './components/ModeSelect.vue'
import LectureVideoWindow from './components/LectureVideoWindow.vue'
import LectureNoteWindow from './components/LectureNoteWindow.vue'
import LectureSettings from './components/LectureSettings.vue'
import BrowserWindow from './components/BrowserWindow.vue'
import BrowserSettings from './components/BrowserSettings.vue'

const DEFAULT_SETTINGS = {
  textSize: 22,
  opacity: 0.96,
  textColor: '#FFFFFF',
  selectedDictionary: 0, // 默认选择第一个词典
  studyMode: 'normal', // 默认普通模式
  autoSpeakInterval: 0, // 自动朗读间隔（秒），0 = 关闭
  speechRate: 1 // 朗读语速倍率（0.5 ~ 2.0），1 = 正常语速
}

const windowMode = new URLSearchParams(window.location.search).get('window') || 'main'
const isSettingsWindow = windowMode === 'settings'
const isLectureSettingsWindow = windowMode === 'lecture-settings'
const isLectureVideoWindow = windowMode === 'lecture-video'
const isLectureNoteWindow = windowMode === 'lecture-notes'
const isLectureWindow = isLectureVideoWindow || isLectureNoteWindow
const isBrowserWindow = windowMode === 'browser'
const isBrowserSettingsWindow = windowMode === 'browser-settings'
const isModeSelectWindow = windowMode === 'mode-select'
const isStudyWindow =
  !isSettingsWindow &&
  !isLectureSettingsWindow &&
  !isLectureVideoWindow &&
  !isLectureNoteWindow &&
  !isBrowserWindow &&
  !isBrowserSettingsWindow &&
  !isModeSelectWindow

const words = ref([])
const dictionaryName = ref('')
const dictionaries = ref([]) // 存储所有词典数据
const currentIndex = ref(0)
const currentField = ref('w')
const currentCPartIndex = ref(0)
const expandCount = ref(1) // 解释字段(c)展开显示的分段数量：按数字 1-9 设置
const errorMessage = ref('')
const settingsError = ref('')
const settings = ref({ ...DEFAULT_SETTINGS })
const form = ref({ ...DEFAULT_SETTINGS })
const jumpPosition = ref(1) // 跳转位置输入
const favoriteWords = ref([]) // 收藏的单词集合
const studyMode = ref('normal') // 背诵模式：'normal' 普通模式，'favorites' 收藏模式
let disposeSettingsChangedListener = null
let progressSaveTimer = null
const STUDY_PROGRESS_SAVE_DELAY_MS = 300
const textPanelRef = ref(null)
const valueRef = ref(null)
let contentResizeTimer = null
let resizeObserver = null
let lastSetHeight = 0
let lastSetWidth = 0

// 背词主窗口：让窗口高度贴合内容；单词(w)超宽时自动拉伸宽度
function fitWindowToContent() {
  if (!isStudyWindow) return
  const panel = textPanelRef.value
  const valueEl = valueRef.value
  if (!panel || !valueEl) return

  const height = Math.ceil(panel.getBoundingClientRect().height)

  // 宽度：scrollWidth 反映文字实际宽度（nowrap 超宽时溢出，pre-wrap 时不溢出）
  const valueWidth = Math.ceil(valueEl.scrollWidth)
  const panelPaddingX = 20 // .text-panel 左右 padding 各 10px
  const contentWidth = valueWidth + panelPaddingX
  const currentWidth = window.innerWidth
  const width = contentWidth > currentWidth ? contentWidth : currentWidth

  if (height <= 0 || width <= 0) return
  if (height === lastSetHeight && width === lastSetWidth) return
  lastSetHeight = height
  lastSetWidth = width
  window.api.setContentSize(width, height)
}

function scheduleFitWindow() {
  if (contentResizeTimer) clearTimeout(contentResizeTimer)
  contentResizeTimer = setTimeout(() => {
    fitWindowToContent()
    contentResizeTimer = null
  }, 120)
}

// 窗口跨 DPI 显示器移动时，viewport 尺寸会变化（物理尺寸不变、逻辑尺寸变），
// 需重新按内容贴合一次，避免扩展屏上窗口高度与文字不匹配
function onViewportResize() {
  scheduleFitWindow()
}

function setupContentFit() {
  if (!isStudyWindow) return
  const panel = textPanelRef.value
  if (!panel) return

  // 显示内容变化（翻词/切字段/展开分段）后，重新测量并调整窗口尺寸
  // 单行 nowrap 时面板尺寸不随内容变化，必须靠 watch 主动触发
  watch(displayText, () => {
    nextTick(() => scheduleFitWindow())
  })

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => scheduleFitWindow())
    resizeObserver.observe(panel)
  }
  window.addEventListener('resize', onViewportResize)
  fitWindowToContent()
}

const currentItem = computed(() => words.value[currentIndex.value] ?? null)
const currentCParts = computed(() => {
  if (!currentItem.value || typeof currentItem.value !== 'object') return []

  const rawCValue =
    typeof currentItem.value.c === 'string'
      ? currentItem.value.c
      : typeof currentItem.value.r === 'string'
        ? currentItem.value.r
        : ''

  const parts = rawCValue
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

  return parts
})

// 当前展开显示的分段（从 currentCPartIndex 起，共 expandCount 个，截断到末尾）
const currentExpandedParts = computed(() => {
  const total = currentCParts.value.length
  if (total === 0) return []
  const cIndex = getLoopIndex(currentCPartIndex.value, total)
  const count = Math.min(expandCount.value, total - cIndex)
  return currentCParts.value.slice(cIndex, cIndex + count)
})

function getLoopIndex(index, total) {
  if (total <= 0) return 0
  return ((index % total) + total) % total
}

// 收藏功能
function toggleFavorite() {
  if (!currentItem.value) return

  // 在收藏模式下，使用sourceDict来正确识别单词
  let wordKey
  if (studyMode.value === 'favorites' && currentItem.value.sourceDict) {
    wordKey = `${currentItem.value.sourceDict}:${currentItem.value.w}`
  } else {
    wordKey = `${dictionaryName.value}:${currentItem.value.w}`
  }

  const index = favoriteWords.value.indexOf(wordKey)
  if (index !== -1) {
    favoriteWords.value.splice(index, 1)
  } else {
    favoriteWords.value.push(wordKey)
  }

  // 保存收藏到文件
  saveFavoritesToFile()
}

// 检查当前单词是否已收藏
function isCurrentWordFavorite() {
  if (!currentItem.value) return false

  // 在收藏模式下，单词来自不同的词典，需要根据sourceDict来检查
  if (studyMode.value === 'favorites' && currentItem.value.sourceDict) {
    const wordKey = `${currentItem.value.sourceDict}:${currentItem.value.w}`
    return favoriteWords.value.includes(wordKey)
  }

  // 普通模式下，使用当前词典名称
  const wordKey = `${dictionaryName.value}:${currentItem.value.w}`
  return favoriteWords.value.includes(wordKey)
}

// 保存收藏到star.json文件（3.html 兼容格式：键名 fav_词库名，值为 JSON 字符串数组，
// 与 3.html 中 localStorage 的 fav_<词库名> 存储格式一致，可直接导入 3.html）
async function saveFavoritesToFile() {
  try {
    // 保留文件中已有的其他键（如 3.html 的 err_纠错 数据），避免保存收藏时把它们覆盖掉
    let existing = {}
    try {
      const old = await window.api.loadFavorites()
      if (old) {
        const parsed = JSON.parse(old)
        if (parsed && typeof parsed === 'object') {
          Object.entries(parsed).forEach(([key, value]) => {
            if (typeof key === 'string' && !key.startsWith('fav_')) existing[key] = value
          })
        }
      }
    } catch {
      // 旧文件不存在或不可解析时忽略
    }

    const favoritesData = {}

    // 将收藏单词按词典分组
    for (const wordKey of favoriteWords.value) {
      const colonIndex = wordKey.indexOf(':')
      if (colonIndex <= 0) continue
      const dictName = wordKey.slice(0, colonIndex)
      const word = wordKey.slice(colonIndex + 1)
      const storeKey = `fav_${dictName}`
      if (!favoritesData[storeKey]) {
        favoritesData[storeKey] = []
      }
      favoritesData[storeKey].push(word)
    }

    // 值为 JSON 字符串，与 3.html 的 localStorage 存储格式一致
    for (const key of Object.keys(favoritesData)) {
      favoritesData[key] = JSON.stringify(favoritesData[key])
    }

    await window.api.saveFavorites(JSON.stringify({ ...existing, ...favoritesData }, null, 2))
  } catch (error) {
    console.error('保存收藏失败:', error)
  }
}

// 从star.json文件加载收藏
// 优先解析 3.html 兼容格式（键名 fav_词库名，值为 JSON 字符串数组），
// 同时兼容旧版 electron 格式（favorites 按词典分组的对象 / 纯单词数组）
async function loadFavoritesFromFile() {
  try {
    const favoritesData = await window.api.loadFavorites()
    if (favoritesData) {
      const parsedData = JSON.parse(favoritesData)
      const favoriteWordList = []

      // 解析 3.html 格式的收藏（fav_词库名 键）
      if (parsedData && typeof parsedData === 'object') {
        Object.entries(parsedData).forEach(([key, value]) => {
          if (typeof key !== 'string' || !key.startsWith('fav_')) return
          const dictName = key.slice(4)
          if (!dictName) return

          let wordList = value
          if (typeof value === 'string') {
            try {
              wordList = JSON.parse(value)
            } catch {
              console.warn(`词典 ${dictName} 的收藏数据不是合法的 JSON，已跳过`)
              return
            }
          }
          if (!Array.isArray(wordList)) return

          wordList.forEach((word) => {
            if (typeof word !== 'string' || !word) return
            const wordKey = `${dictName}:${word}`
            if (!favoriteWordList.includes(wordKey)) {
              favoriteWordList.push(wordKey)
            }
          })
        })
      }

      // 兼容旧版 electron 格式：没有 fav_ 键时，解析 favorites 字段
      if (favoriteWordList.length === 0 && parsedData && typeof parsedData === 'object') {
        if (parsedData.favorites && typeof parsedData.favorites === 'object') {
          // 旧版按词典分组的收藏数据（值可能是数组或 JSON 字符串）
          Object.entries(parsedData.favorites).forEach(([dictName, words]) => {
            let wordList = words
            if (typeof words === 'string') {
              try {
                wordList = JSON.parse(words)
              } catch {
                console.warn(`词典 ${dictName} 的收藏数据不是合法的 JSON，已跳过`)
                return
              }
            }
            if (!Array.isArray(wordList)) return

            wordList.forEach((word) => {
              if (typeof word !== 'string' || !word) return
              const wordKey = `${dictName}:${word}`
              if (!favoriteWordList.includes(wordKey)) {
                favoriteWordList.push(wordKey)
              }
            })
          })
        } else if (Array.isArray(parsedData.favorites)) {
          // 更旧版格式：简单的单词数组（元素为 "词典:单词" 或纯单词）
          parsedData.favorites.forEach((wordKey) => {
            if (typeof wordKey === 'string' && !favoriteWordList.includes(wordKey)) {
              favoriteWordList.push(wordKey)
            }
          })
        }
      }

      favoriteWords.value = favoriteWordList
    } else {
      // 如果文件不存在，创建空的收藏文件
      favoriteWords.value = []
      await saveFavoritesToFile()
    }
  } catch (error) {
    console.error('加载收藏失败:', error)
    // 出错时也创建空的收藏文件
    favoriteWords.value = []
    await saveFavoritesToFile()
  }
}

// 切换背诵模式
function toggleStudyMode(targetMode) {
  if (targetMode === 'favorites') {
    studyMode.value = 'favorites'
    loadFavoriteWords()
  } else {
    studyMode.value = 'normal'
    reloadWords()
  }
}

// 加载收藏单词
function loadFavoriteWords() {
  if (favoriteWords.value.length === 0) {
    alert('暂无收藏单词，请先收藏一些单词再切换到收藏模式')
    studyMode.value = 'normal'
    return
  }

  // 只显示当前选中词典的收藏单词
  const selectedIndex = settings.value.selectedDictionary || 0
  const currentDict = dictionaries.value[selectedIndex] || dictionaries.value[0]

  const favoriteWordList = []
  if (currentDict) {
    currentDict.words.forEach((word) => {
      const wordKey = `${currentDict.name}:${word.w}`
      if (favoriteWords.value.includes(wordKey)) {
        favoriteWordList.push({
          ...word,
          sourceDict: currentDict.name
        })
      }
    })
  }

  if (favoriteWordList.length === 0) {
    alert(`当前词典「${currentDict ? currentDict.name : ''}」没有收藏单词，请先收藏再切换到收藏模式`)
    studyMode.value = 'normal'
    return
  }

  words.value = favoriteWordList
  currentIndex.value = 0
  dictionaryName.value = currentDict.name
}

const displayText = computed(() => {
  if (!currentItem.value) {
    return '未加载数据'
  }

  const wordPosition = `${currentIndex.value + 1}/${words.value.length}`

  if (currentField.value === 'w') {
    const value = currentItem.value.w
    const isFavorite = isCurrentWordFavorite()
    const favoriteMark = isFavorite ? '* ' : ''

    if (typeof value === 'string' && value.trim().length > 0) {
      return `[${wordPosition}] ${favoriteMark}${value}`
    }

    return `[${wordPosition}] ${favoriteMark}(空)`
  }

  const cTotal = currentCParts.value.length
  if (cTotal === 0) return `[${wordPosition}] (空)`

  const cIndex = getLoopIndex(currentCPartIndex.value, cTotal)
  const count = Math.min(expandCount.value, cTotal - cIndex)
  const endIndex = cIndex + count - 1
  const cPosition = count > 1 ? `[${cIndex + 1}-${endIndex + 1}/${cTotal}]` : `[${cIndex + 1}/${cTotal}]`
  // 多个分段用空格连接，单行显示（不换行）
  return `[${wordPosition}] ${cPosition} ${currentExpandedParts.value.join(' ')}`
})

const valueStyle = computed(() => ({
  fontSize: `${settings.value.textSize}px`,
  opacity: settings.value.opacity,
  color: settings.value.textColor,
  // 所有字段均单行显示，不换行（超宽时由窗口自动拉伸）
  whiteSpace: 'nowrap'
}))

function normalizeSettings(payload) {
  const source = payload && typeof payload === 'object' ? payload : {}

  const textSizeRaw = Math.round(Number(source.textSize))
  const opacityRaw = Number(source.opacity)
  const selectedDictionaryRaw = Math.round(Number(source.selectedDictionary))
  const rawTextColor =
    typeof source.textColor === 'string' ? source.textColor.trim().toUpperCase() : ''
  const studyModeRaw = typeof source.studyMode === 'string' ? source.studyMode : ''

  const textSize = Number.isFinite(textSizeRaw)
    ? Math.max(12, Math.min(120, textSizeRaw))
    : DEFAULT_SETTINGS.textSize
  const opacity = Number.isFinite(opacityRaw)
    ? Number(Math.max(0.1, Math.min(1, opacityRaw)).toFixed(2))
    : DEFAULT_SETTINGS.opacity
  const selectedDictionary = Number.isFinite(selectedDictionaryRaw)
    ? Math.max(0, selectedDictionaryRaw)
    : DEFAULT_SETTINGS.selectedDictionary
  const textColor = /^#[0-9A-F]{6}$/.test(rawTextColor) ? rawTextColor : DEFAULT_SETTINGS.textColor
  const studyMode = studyModeRaw === 'favorites' ? 'favorites' : 'normal'
  const autoSpeakIntervalRaw = Number(source.autoSpeakInterval)
  const autoSpeakInterval = Number.isFinite(autoSpeakIntervalRaw)
    ? Math.max(0, Math.min(3600, autoSpeakIntervalRaw))
    : DEFAULT_SETTINGS.autoSpeakInterval
  const speechRateRaw = Number(source.speechRate)
  const speechRate = Number.isFinite(speechRateRaw)
    ? Number(Math.max(0.5, Math.min(2, speechRateRaw)).toFixed(2))
    : DEFAULT_SETTINGS.speechRate

  return {
    textSize,
    opacity,
    textColor,
    selectedDictionary,
    studyMode,
    autoSpeakInterval,
    speechRate
  }
}

async function loadSettings() {
  try {
    const payload = await window.api.getSettings()
    const normalized = normalizeSettings(payload)
    settings.value = normalized
    form.value = { ...normalized }

    // 设置背诵模式状态
    studyMode.value = normalized.studyMode

    settingsError.value = ''
  } catch (error) {
    settings.value = { ...DEFAULT_SETTINGS }
    form.value = { ...DEFAULT_SETTINGS }
    studyMode.value = DEFAULT_SETTINGS.studyMode
    settingsError.value = error instanceof Error ? error.message : String(error)
  }
}

function normalizeWords(payload) {
  // 处理 data.json 的数组结构，数组中每个元素都有 name 和 words 属性
  if (Array.isArray(payload)) {
    // 存储所有词典数据
    const validDictionaries = payload.filter(
      (dict) =>
        dict &&
        typeof dict === 'object' &&
        Array.isArray(dict.words) &&
        typeof dict.name === 'string'
    )

    dictionaries.value = validDictionaries

    // 如果有多个词典，根据设置选择词典
    if (validDictionaries.length > 0) {
      const selectedIndex = settings.value.selectedDictionary || 0
      const selectedDictionary = validDictionaries[selectedIndex] || validDictionaries[0]

      return {
        words: selectedDictionary.words.filter((item) => item && typeof item === 'object'),
        name: selectedDictionary.name
      }
    }

    // 如果没有找到有效的词典结构，尝试直接使用数组作为单词列表
    return {
      words: payload.filter((item) => item && typeof item === 'object'),
      name: ''
    }
  }

  return { words: [], name: '' }
}

async function reloadWords() {
  try {
    const rawData = await window.api.loadWords()
    const normalized = normalizeWords(rawData)

    if (normalized.words.length === 0) {
      words.value = []
      dictionaryName.value = ''
      currentIndex.value = 0
      currentCPartIndex.value = 0
      errorMessage.value = 'JSON 中没有可显示的数据'
      return
    }

    words.value = normalized.words
    dictionaryName.value = normalized.name
    currentIndex.value = 0
    currentCPartIndex.value = 0
    errorMessage.value = ''

    await restoreStudyProgress()
  } catch (error) {
    words.value = []
    dictionaryName.value = ''
    currentIndex.value = 0
    currentCPartIndex.value = 0
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
}

// 背诵进度：翻词/切字段后防抖保存，仅普通模式生效
function scheduleProgressSave() {
  if (studyMode.value !== 'normal') return
  if (progressSaveTimer) clearTimeout(progressSaveTimer)
  progressSaveTimer = setTimeout(() => {
    void saveStudyProgress()
    progressSaveTimer = null
  }, STUDY_PROGRESS_SAVE_DELAY_MS)
}

async function saveStudyProgress() {
  if (studyMode.value !== 'normal') return
  if (!dictionaryName.value || words.value.length === 0) return
  try {
    await window.api.saveStudyProgress({
      dictionaryName: dictionaryName.value,
      wordIndex: currentIndex.value,
      cPartIndex: currentCPartIndex.value,
      field: currentField.value,
      expandCount: expandCount.value
    })
  } catch (error) {
    console.error('保存背诵进度失败:', error)
  }
}

// 启动/切换词典后恢复该词典上次的背诵位置
async function restoreStudyProgress() {
  if (studyMode.value !== 'normal') return
  if (words.value.length === 0) return
  try {
    const progress = await window.api.loadStudyProgress()
    if (!progress || typeof progress !== 'object') return
    if (progress.dictionaryName !== dictionaryName.value) return

    const wordIndex = Number(progress.wordIndex)
    const cPartIndex = Number(progress.cPartIndex)
    const savedExpandCount = Number(progress.expandCount)

    if (Number.isFinite(wordIndex) && wordIndex >= 0 && wordIndex < words.value.length) {
      currentIndex.value = wordIndex
    }
    // 分段索引：越界时用取模兜底（词典变化导致分段数变化时仍安全）
    if (Number.isFinite(cPartIndex) && cPartIndex >= 0) {
      const total = currentCParts.value.length
      currentCPartIndex.value = total > 0 ? getLoopIndex(cPartIndex, total) : 0
    }
    if (progress.field === 'c' || progress.field === 'w') {
      currentField.value = progress.field
    }
    // 展开数量：限制在 1-9 范围内
    if (Number.isFinite(savedExpandCount) && savedExpandCount >= 1 && savedExpandCount <= 9) {
      expandCount.value = Math.round(savedExpandCount)
    }
  } catch (error) {
    console.error('恢复背诵进度失败:', error)
  }
}

function goNext() {
  if (words.value.length === 0) return
  currentIndex.value = (currentIndex.value + 1) % words.value.length
  currentCPartIndex.value = 0
  expandCount.value = 1
  scheduleProgressSave()
}

function goPrev() {
  if (words.value.length === 0) return
  currentIndex.value = (currentIndex.value - 1 + words.value.length) % words.value.length
  currentCPartIndex.value = 0
  expandCount.value = 1
  scheduleProgressSave()
}

function goNextCPart(step = 1) {
  const total = currentCParts.value.length
  if (total === 0) return
  // 翻页式循环：越过末尾则归零（回到第 1 条），而非取模落到中间
  const next = currentCPartIndex.value + step
  currentCPartIndex.value = next >= total ? 0 : next
  scheduleProgressSave()
}

function goPrevCPart(step = 1) {
  const total = currentCParts.value.length
  if (total === 0) return
  // 翻页式循环：越过开头则跳到最后一页对齐位置（而非取模）
  const prev = currentCPartIndex.value - step
  currentCPartIndex.value = prev < 0 ? Math.floor((total - 1) / step) * step : prev
  scheduleProgressSave()
}

function toggleField() {
  currentField.value = currentField.value === 'w' ? 'c' : 'w'
  scheduleProgressSave()
}

async function jumpToPosition() {
  if (words.value.length === 0) {
    settingsError.value = '没有可跳转的数据'
    return
  }

  const position = Number(jumpPosition.value)
  if (!Number.isFinite(position) || position < 1 || position > words.value.length) {
    settingsError.value = `请输入有效的数字 (1-${words.value.length})`
    return
  }

  try {
    // 通过 IPC 发送跳转指令到主窗口
    await window.api.jumpToPosition(position - 1)
    settingsError.value = ''

    // 关闭设置窗口
    closeSettingsWindow()
  } catch (error) {
    settingsError.value = '跳转失败：' + (error instanceof Error ? error.message : String(error))
  }
}

// ---------- 中日文混合朗读 ----------

// 判断是否为日文假名（平假名/片假名/长音符等，中文不会出现的字符）
function isKana(ch) {
  const code = ch.codePointAt(0)
  return (
    (code >= 0x3040 && code <= 0x309f) || // 平假名
    (code >= 0x30a0 && code <= 0x30ff) || // 片假名
    (code >= 0x31f0 && code <= 0x31ff) || // 片假名语音扩展
    ch === 'ー' ||
    ch === 'ゝ' ||
    ch === 'ゞ' ||
    ch === 'ヽ' ||
    ch === 'ヾ'
  )
}

// 判断是否为中日共用汉字（CJK 统一表意文字）
function isCJK(ch) {
  const code = ch.codePointAt(0)
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff)
  )
}

// 中文判断词/结构助词/中文后缀：日语中几乎不会单独使用，汉字邻假名扫描遇到它们即中断，
// 避免「だろう是简体」「に対して前加的名词」「て形」这类日文词尾+中文释义被整段误判为日语
const ZH_BARRIER = new Set(['是', '为', '的', '形'])

// 允许「回溯合并」的中文关键词白名单：仅结构助词/中文后缀类。
// 命中这些词时，可把日文缓冲尾部紧邻的连续汉字一并划归中文；
// 其他关键词（如「都」「例」「表」）在日语中也可能出现，禁止回溯，避免误伤日文汉字词
const BACKTRACK_ZH_KEYWORDS = new Set(['的', '是', '为', '名词', '形'])

// 简体中文中不存在（或几乎不用）的日文汉字字形：出现即视为强日语信号。
// 解决「春子、元気？」「日本語」「単語」这类纯汉字/少假名日语句被判成中文的问题：
// 字本身或邻接汉字出现这些字形，即判为日语
const JA_ONLY_CJK = new Set([
  '気', '売', '読', '駅', '辺', '図', '広', '実', '芸', '発',
  '関', '対', '単', '応', '転', '従', '児', '営', '産', '円',
  '歳', '済', '続', '薬', '価', '変', '検', '雑', '験', '桜',
  '楽', '帰', '県', '毎', '後', '無', '優', '時', '間', '語',
  '題', '問', '話', '聞', '連', '選', '達', '週', '進', '運',
  '動', '強', '値', '質', '悪', '試', '難', '覚', '備', '員',
  '綺', '麗', '漢', '級', '終', '結', '給', '統', '録', '認',
  '調', '訳', '許', '設', '談', '論', '諸', '誰', '網', '総',
  '製', '複', '衛', '術', '規', '観', '触', '計', '詞', '誠',
  '誤', '講', '課', '謝', '議', '護', '負', '貫', '財', '貨',
  '資', '賛', '賞', '費', '賀', '賢', '購', '贈', '込', '違',
  '適', '遺', '遠', '遅', '遷', '還', '齢', '歴', '類', '離',
  '陸', '険', '隊', '階', '際', '陽', '隠', '領', '顔', '頭',
  '願', '額', '飯', '飲', '館', '駆', '駐', '驚', '魚', '鳥',
  '髪', '機', '構', '権', '橋', '極', '歓', '顕', '厳', '闘',
  '脳', '悩', '納', '騒', '増', '臓', '蔵', '層', '荘', '蒼',
  '詔', '渋', '獣', '縦', '粛', '縮', '樹', '収', '執', '衆',
  '鋭', '躍', '預', '揚', '揺', '葉', '様', '窯', '養', '羅',
  '頼', '絡', '濫', '覧', '裏', '竜', '両', '涼', '猟', '緑',
  '臨', '輪', '涙', '塁', '練', '論', '枠', '億', '憶', '穏',
  '禍', '絵', '拡', '殻', '渇', '仮', '換', '簡', '艦', '鑑',
  '環', '監', '寛', '幹', '巻', '陥', '偽', '戯', '犠', '儀',
  '漁', '喫', '詰', '暁', '況', '狭', '頬', '業', '訓', '勲',
  '薫', '恵', '蛍', '掲', '軽', '傾', '継', '撃', '倹', '剣',
  '圏', '献', '鍵', '賢', '謙', '懸', '戻', '塩', '帳', '遡',
  '諦', '辿'
])

// 日文常用标点：邻接扫描允许跳过，使「春子、元気？」的「春子」能越过「、」关联到「気」
const JA_PUNCT = new Set(['、', '。', '？', '！', '…'])

// 汉字是否邻近日语成分（假名 / 日文特有字形），可跳过相邻汉字与日文标点：
// 邻假名或邻日文字形 → 日文，否则 → 中文
function hasAdjacentKana(chars, index) {
  for (let j = index - 1; j >= 0; j--) {
    if (ZH_BARRIER.has(chars[j])) break
    if (isKana(chars[j])) return true
    if (JA_ONLY_CJK.has(chars[j])) return true
    if (!isCJK(chars[j])) {
      if (JA_PUNCT.has(chars[j])) continue
      break
    }
  }
  for (let j = index + 1; j < chars.length; j++) {
    if (ZH_BARRIER.has(chars[j])) break
    if (isKana(chars[j])) return true
    if (JA_ONLY_CJK.has(chars[j])) return true
    if (!isCJK(chars[j])) {
      if (JA_PUNCT.has(chars[j])) continue
      break
    }
  }
  return false
}

// 中文高频词/引导词表：这些词几乎只出现在中文里，用于显式打断日文判定
// 解决「わけだ暗含」「は除了提示」这类日文助词/词尾与中文紧挨、被误判为日文的问题
const ZH_KEYWORDS = [
  '暗含', '例句', '说明', '表示', '表达', '强调', '对比', '原因', '并列', '推测',
  '断定', '可能', '打算', '确信', '义务', '接续', '解释', '感觉', '暗示', '主题',
  '对象', '否定', '肯定', '语气', '语感', '翻译', '翻译成', '相当于', '多用于',
  '常用于', '含有', '包含', '例如', '比如', '示例', '注意', '注', '译', '例', '表',
  '意为', '意思是', '指', '指的是', '即', '也就是', '用法', '含义', '意思',
  '除了', '提示', '可以', '还可以', '以及', '但是', '而且', '因为', '所以', '如果',
  '那么', '就是', '只有', '只要', '不仅', '而是', '或者', '还是', '虽然', '因此',
  '由于', '还能', '也能', '往往', '一般', '通常', '常常', '也',
  // 中文判断词/结构助词：单独出现时必是中文释义（如「だろう是简体」「前加的名词」），
  // 放在末尾避免遮挡上面的多字词；「形」用于「て形」「ます形」等中文叫法
  // 注意：不能加单字「都」——「京都」「東京」等日文词含都，会被误判为中文
  '是', '为', '名词', '的', '形',
  // 简体独有的词性名（日语写作「動詞」），避免「接续：动词て形」中「动词」被假名带偏成日语
  '动词'
]

// 在给定位置尝试匹配一个中文关键词，返回匹配长度（未匹配返回 0）
function matchZhKeyword(chars, index) {
  for (const kw of ZH_KEYWORDS) {
    const kwChars = [...kw]
    let ok = true
    for (let k = 0; k < kwChars.length; k++) {
      if (chars[index + k] !== kwChars[k]) {
        ok = false
        break
      }
    }
    if (ok) return kwChars.length
  }
  return 0
}

// 简体中文中同样存在、但在教材语境里应读日语的汉字词（情感/能力类形容词等）。
// 这些词没有假名、字形也非日文特有，单靠启发式会被误判为中文，
// 例如「→嫌い、好き、怖い / 上手、下手、苦手」中的「上手」「下手」「苦手」。
// 整体命中即强制归日语
const JA_WORDS = ['上手', '下手', '苦手']

// 在给定位置尝试匹配一个日文汉字词，返回匹配长度（未匹配返回 0）
function matchJaWord(chars, index) {
  for (const w of JA_WORDS) {
    const wChars = [...w]
    let ok = true
    for (let k = 0; k < wChars.length; k++) {
      if (chars[index + k] !== wChars[k]) {
        ok = false
        break
      }
    }
    if (ok) return wChars.length
  }
  return 0
}

// 把中日混合文本切分为 [{ text, lang }]，lang 为 'ja' 或 'zh'
function splitMixedText(text) {
  const chars = [...text]
  const segments = []
  let buf = ''
  let bufLang = null

  const flush = () => {
    const t = buf.trim()
    if (t) segments.push({ text: t, lang: bufLang === 'ja' ? 'ja' : 'zh' })
    buf = ''
    bufLang = null
  }

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]

    // 空白与斜杠作为分隔符
    if (/\s/.test(ch) || ch === '/') {
      flush()
      continue
    }

    if (isKana(ch)) {
      if (bufLang !== 'ja') flush()
      buf += ch
      bufLang = 'ja'
      continue
    }

    if (isCJK(ch)) {
      // 优先匹配中文关键词（如「暗含」「例句」「名词」等），强制归中文，打断前面的日文
      const kwLen = matchZhKeyword(chars, i)
      if (kwLen > 0) {
        const kw = chars.slice(i, i + kwLen).join('')
        // 命中中文关键词时，把日文缓冲尾部紧邻的连续汉字一并划归中文，
        // 解决「に対して前加的名词」这类日文短语与中文释义紧挨、汉字部分被误判为日文的问题。
        // 回溯仅对「的/是/为/名词/形」等中文结构词生效，避免「京都」等日文汉字词
        // 因命中「都」「例」等单字关键词而被误划为中文
        const needBacktrack = BACKTRACK_ZH_KEYWORDS.has(kw)
        if (bufLang === 'ja' && buf.length > 0 && needBacktrack) {
          let cut = buf.length
          while (cut > 0 && isCJK(buf[cut - 1]) && !ZH_BARRIER.has(buf[cut - 1])) cut--
          if (cut < buf.length) {
            const tailZh = buf.slice(cut)
            buf = buf.slice(0, cut)
            flush() // 先推出日文前缀（如「に対して」），再续写中文
            buf = tailZh
          } else {
            flush()
          }
        } else if (bufLang !== 'zh') {
          flush()
        }
        for (let k = 0; k < kwLen; k++) {
          buf += chars[i + k]
        }
        i += kwLen - 1
        bufLang = 'zh'
        continue
      }

      // 命中日文汉字词（如「上手」「下手」「苦手」），即使无假名也强制归日语
      const jaWordLen = matchJaWord(chars, i)
      if (jaWordLen > 0) {
        if (bufLang !== 'ja') flush()
        for (let k = 0; k < jaWordLen; k++) {
          buf += chars[i + k]
        }
        i += jaWordLen - 1
        bufLang = 'ja'
        continue
      }

      // 字本身是日文特有字形（如「気」「語」），或与假名/日文字形相邻 → 日语
      const lang = JA_ONLY_CJK.has(ch) || hasAdjacentKana(chars, i) ? 'ja' : 'zh'
      if (bufLang !== null && bufLang !== lang) flush()
      buf += ch
      bufLang = lang
      continue
    }

    // 其他字符（数字、拉丁字母、各类标点符号）
    if (/[0-9A-Za-z]/.test(ch)) {
      // 数字/拉丁字母：看是否与假名相邻决定语言（如「3つ」「100円」是日语）
      const nearKana =
        (i > 0 && isKana(chars[i - 1])) || (i + 1 < chars.length && isKana(chars[i + 1]))
      const lang = nearKana ? 'ja' : bufLang === 'ja' ? 'ja' : 'zh'
      if (bufLang !== null && bufLang !== lang) flush()
      buf += ch
      bufLang = lang
      continue
    }

    // 其他标点符号：跟随相邻片段
    if (bufLang === null) {
      buf += ch
      bufLang = 'zh'
    } else {
      buf += ch
    }
  }
  flush()
  return segments
}

// 合并相邻同语言片段：减少 TTS 调用次数，避免每段音频自带静音造成明显停顿
function mergeAdjacentSegments(segments) {
  const merged = []
  for (const seg of segments) {
    const last = merged[merged.length - 1]
    if (last && last.lang === seg.lang) {
      last.text += ' ' + seg.text
    } else {
      merged.push({ text: seg.text, lang: seg.lang })
    }
  }
  return merged
}

// 裁剪 AudioBuffer 开头与结尾的静音，消除段间明显停顿
function trimSilence(buffer, threshold = 0.01) {
  const channels = buffer.numberOfChannels
  const sampleRate = buffer.sampleRate
  const length = buffer.length
  if (length === 0) return buffer

  let start = 0
  let end = length - 1

  outerStart: for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < channels; ch++) {
      if (Math.abs(buffer.getChannelData(ch)[i]) > threshold) {
        start = i
        break outerStart
      }
    }
  }

  outerEnd: for (let i = length - 1; i >= 0; i--) {
    for (let ch = 0; ch < channels; ch++) {
      if (Math.abs(buffer.getChannelData(ch)[i]) > threshold) {
        end = i
        break outerEnd
      }
    }
  }

  if (end <= start) return buffer

  const ctx = getAudioContext()
  if (!ctx) return buffer

  const newLength = end - start + 1
  const newBuffer = ctx.createBuffer(channels, newLength, sampleRate)
  for (let ch = 0; ch < channels; ch++) {
    newBuffer.copyToChannel(buffer.getChannelData(ch).subarray(start, end + 1), ch)
  }
  return newBuffer
}

// 单条音频上下文（惰性创建）
let sharedAudioContext = null
function getAudioContext() {
  if (!sharedAudioContext) {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return null
    sharedAudioContext = new Ctx()
  }
  return sharedAudioContext
}

// 用 TTS 合成单段文本，返回解码后的 AudioBuffer（失败返回 null）
async function synthesizeToBuffer(text, lang) {
  const voice = lang === 'zh-CN' ? 'zh-CN-XiaozhenNeural' : 'ja-JP-MayuNeural'
  // 语速 = 用户设置的倍率 × 语言基准速度（中文 1.1 / 日语 1.0，保持默认 1 倍时的原有听感）
  const baseSpeed = lang === 'zh-CN' ? 1.1 : 1
  const speed = Number((settings.value.speechRate * baseSpeed).toFixed(2))

  const response = await fetch('https://tts.wangwangit.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: text,
      voice: voice,
      speed: speed,
      pitch: '0',
      style: 'affectionate'
    })
  })

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`)
  }

  const ctx = getAudioContext()
  if (!ctx) return null

  const audioBlob = await response.blob()
  const arrayBuffer = await audioBlob.arrayBuffer()
  return await ctx.decodeAudioData(arrayBuffer)
}

// 追踪正在播放的 buffer 源，用于新朗读前停止旧播放
let activeSources = []
function stopSpeaking() {
  activeSources.forEach((src) => {
    try {
      src.stop()
    } catch {
      // 已停止
    }
  })
  activeSources = []
}

// 把多个 AudioBuffer 按顺序无缝拼接播放；返回在全部播放结束后 resolve 的 Promise
function playBuffers(buffers) {
  const ctx = getAudioContext()
  if (!ctx || buffers.length === 0) return Promise.resolve()
  ctx.resume()
  stopSpeaking()

  let startTime = ctx.currentTime + 0.05
  buffers.forEach((buf) => {
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    src.start(startTime)
    activeSources.push(src)
    // 段间留极短间隔（0.05s），避免裁剪静音后相邻片段过于急促
    startTime += buf.duration + 0.05
  })

  // 按预计总播放时长（含段间间隔）resolve，供自动朗读按节拍继续
  const totalMs = Math.max(0, (startTime - ctx.currentTime) * 1000)
  return new Promise((resolve) => {
    setTimeout(resolve, totalMs + 120)
  })
}

// 浏览器 TTS 朗读并等待播放完成（fallback）
function speakViaSpeechSynthesis(text, lang) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) {
      resolve()
      return
    }
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = lang
    utterance.rate = settings.value.speechRate
    utterance.onend = () => resolve()
    utterance.onerror = () => resolve()
    // 超时兜底，防止个别系统不触发 onend
    setTimeout(resolve, Math.max(3000, text.length * 200))
    window.speechSynthesis.speak(utterance)
  })
}

// / 分隔的子句之间插入的停顿时长（秒）
const SLASH_PAUSE_SECONDS = 0.5

// 生成指定秒数的静音 AudioBuffer（用于 / 前后的停顿）
function createSilenceBuffer(seconds) {
  const ctx = getAudioContext()
  if (!ctx) return null
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds))
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  buf.getChannelData(0).fill(0)
  return buf
}

// 混合合成单个子句（不含 /）：切分中日文 → 并发合成各片段，返回 AudioBuffer 数组（保持顺序，失败片段跳过）
async function synthesizeMixedPartToBuffers(text) {
  if (!text || !text.trim()) return []

  const segments = mergeAdjacentSegments(splitMixedText(text))
  if (segments.length === 0) return []

  const results = await Promise.all(
    segments.map(async (seg) => {
      try {
        const buf = await synthesizeToBuffer(seg.text, seg.lang === 'ja' ? 'ja-JP' : 'zh-CN')
        return buf ? trimSilence(buf) : null
      } catch (error) {
        console.error('片段合成失败:', seg, error)
        return null
      }
    })
  )

  return results.filter((buf) => buf !== null)
}

// 混合合成：按 / 拆分为多个子句，子句之间插入 0.5s 停顿（如「である / だ / です」）
async function synthesizeMixedToBuffers(text) {
  if (!text || !text.trim()) return []

  // / 与全角冒号都作为停顿分隔符（如「断定：である / だ / です」→ 三段，之间各停顿 0.5s）
  const parts = text
    .split(/[/：]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (parts.length === 0) return []

  const partBuffers = await Promise.all(parts.map((part) => synthesizeMixedPartToBuffers(part)))

  const result = []
  partBuffers.forEach((bufs, i) => {
    if (i > 0) {
      const silence = createSilenceBuffer(SLASH_PAUSE_SECONDS)
      if (silence) result.push(silence)
    }
    result.push(...bufs)
  })
  return result
}

// 单语言合成：强制按指定语言合成整段文本，返回单个 AudioBuffer 的数组（失败返回 []）
async function synthesizeSingleToBuffers(text, lang) {
  if (!text || !text.trim()) return []
  try {
    const buf = await synthesizeToBuffer(text, lang)
    return buf ? [trimSilence(buf)] : []
  } catch (error) {
    console.error('语音合成失败:', error)
    return []
  }
}

// 单词文本朗读前替换：N → めいし，V → どうし，/ → 停顿
function normalizeWordSpeechText(value) {
  return value
    .trim()
    .replace(/\bN(\d+)\s*\//g, 'めいし$1/')
    .replace(/\bV(\d+)\s*\//g, 'どうし$1/')
    .replace(/\bN(\d+)(?=\S)/g, 'めいし$1')
    .replace(/\bV(\d+)(?=\S)/g, 'どうし$1')
    .replace(/\bN(\d+)$/g, 'めいし$1+')
    .replace(/\bV(\d+)$/g, 'どうし$1+')
    .replace(/\bN$/g, 'めいし')
    .replace(/\bV$/g, 'どうし')
    .replace(/\bN(?!$)/g, 'めいし+')
    .replace(/\bV(?!$)/g, 'どうし+')
    .replace(/\//g, '。/。')
}

// 取词条的 c 分段（含 r 兼容），与 currentCParts 一致
function getCPartsOf(item) {
  if (!item || typeof item !== 'object') return []
  const rawCValue =
    typeof item.c === 'string'
      ? item.c
      : typeof item.r === 'string'
        ? item.r
        : ''
  return rawCValue
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

// 判断词条是否来自 N1单词/N2单词 词典（普通模式看当前词典名，收藏模式看 sourceDict）
function isN12WordItem(item) {
  if (dictionaryName.value === 'N1单词' || dictionaryName.value === 'N2单词') return true
  if (item && typeof item === 'object') {
    return item.sourceDict === 'N1单词' || item.sourceDict === 'N2单词'
  }
  return false
}

// 合成 w 的音频（N1单词/N2单词 强制日语，其余中日混合）
// N1单词/N2单词：c 按 \n 划分后下标 0 为日文读音（如「暗算」→ あんざん）时，
// 朗读 w 用该读音；下标 0 为英文（外来语注音，如 almond）或不存在时才读 w 本身
async function synthesizeWordToBuffers(value, item) {
  if (typeof value !== 'string' || !value.trim()) return []
  const textToSpeak = normalizeWordSpeechText(value)
  if (!textToSpeak) return []

  if (isN12WordItem(item)) {
    const reading = getCPartsOf(item)[0]
    // 下标 0 含日文假名则视为日文读音，用它朗读 w；否则回退读 w 本身
    const readingText = reading && /[ぁ-んァ-ン]/.test(reading) ? reading.trim() : ''
    return synthesizeSingleToBuffers(readingText || textToSpeak, 'ja-JP')
  }
  return synthesizeMixedToBuffers(textToSpeak)
}

// 处理 N1/N2 单词的中文释义行文本（下标 1+），供整行中文朗读
// 如「⓪ 名・形 划算，实惠」→ 去掉圆圈数字，并把「・」换成中文顿号 →「名、形 划算，实惠」
// 整行内容（词性 + 释义）全部保留，强制用中文 voice 朗读
function normalizeChineseMeaningText(part) {
  return part
    .replace(/[⓪①-⑩]/g, '')
    .replace(/[・·]/g, '、')
    .replace(/\s+/g, ' ')
    .trim()
}

// 合成 c 的一个分段的音频
// N1单词/N2单词：按 \n 下标分语言——下标 0 = 日语读音，下标 1+ = 词性+中文释义（整行中文朗读）
// 其余词库：中日混合合成（N1/N2语法先剔除括号内容）
async function synthesizeCPartToBuffers(part, partIndex, item) {
  if (typeof part !== 'string' || !part.trim()) return []

  if (isN12WordItem(item)) {
    if (partIndex === 0) {
      return synthesizeSingleToBuffers(part.trim(), 'ja-JP')
    }
    // 中文释义行：整行（含词性）全部按中文朗读，如「名、形 划算，实惠」「词组 事已至此」
    const text = normalizeChineseMeaningText(part)
    return text ? synthesizeSingleToBuffers(text, 'zh-CN') : []
  }

  // 其余词库：中日混合（N1/N2语法：括号内注音/补充说明不用于生成语音）
  let text = part
  if (dictionaryName.value === 'N1语法' || dictionaryName.value === 'N2语法') {
    text = text.replace(/（[^）]*）/g, '')
  }
  return text.trim() ? synthesizeMixedToBuffers(text) : []
}

// ---------- 分段音频缓存与预加载 ----------
// 朗读单元（段）：{ itemIndex, item, kind: 'w'|'c', cIndex }，cIndex 仅 c 段有效
// key 带词典名前缀：换词典/收藏集后朗读规则可能不同，旧音频缓存必须隔离失效
function segmentKey(seg) {
  return `${dictionaryName.value}:${seg.itemIndex}:${seg.kind}${seg.kind === 'c' ? ':' + seg.cIndex : ''}`
}

// 缓存：key -> { item, buffers }；item 引用校验，换词典后旧缓存自动失效
const speechCache = new Map()
const speechInflight = new Map()
const SPEECH_CACHE_MAX = 60

async function buildSegmentBuffers(seg) {
  const { item, kind, cIndex } = seg
  if (!item) return []
  if (kind === 'w') {
    return synthesizeWordToBuffers(item.w, item)
  }
  const parts = getCPartsOf(item)
  const part = parts[cIndex]
  if (!part) return []
  return synthesizeCPartToBuffers(part, cIndex, item)
}

// 获取某段音频（缓存命中直接返回，否则合成并缓存；同段并发只合成一次）
// 缓存项带语速标记：修改语速后旧缓存自动失效，避免播放旧语速音频
async function getSegmentBuffers(seg) {
  const key = segmentKey(seg)
  const rate = settings.value.speechRate
  const hit = speechCache.get(key)
  if (hit && hit.item === seg.item && hit.rate === rate) {
    return hit.buffers.length > 0 ? hit.buffers : null
  }
  const existing = speechInflight.get(key)
  if (existing) return existing

  const promise = buildSegmentBuffers(seg)
    .then((buffers) => {
      if (speechCache.size >= SPEECH_CACHE_MAX) {
        const oldestKey = speechCache.keys().next().value
        speechCache.delete(oldestKey)
      }
      speechCache.set(key, { item: seg.item, buffers, rate })
      speechInflight.delete(key)
      return buffers
    })
    .catch((error) => {
      console.error('语音合成失败:', seg, error)
      speechInflight.delete(key)
      return []
    })
  speechInflight.set(key, promise)
  return promise
}

// 段朗读的整体语言与文本（合成全部失败时用于浏览器 TTS 回退）
function describeSegmentSpeech(seg) {
  const { item, kind, cIndex } = seg
  if (!item) return { text: '', lang: 'ja-JP' }
  if (kind === 'w') {
    const text = normalizeWordSpeechText(typeof item.w === 'string' ? item.w : '')
    if (isN12WordItem(item)) {
      // 与合成逻辑一致：c 下标 0 为日文读音时用它朗读，否则读 w 本身
      const reading = getCPartsOf(item)[0]
      const speechText = reading && /[ぁ-んァ-ン]/.test(reading) ? reading.trim() : text
      return { text: speechText, lang: 'ja-JP' }
    }
    const lang = /[ぁ-んァ-ン]/.test(text) ? 'ja-JP' : 'zh-CN'
    return { text, lang }
  }
  const part = getCPartsOf(item)[cIndex] || ''
  if (isN12WordItem(item)) {
    if (cIndex === 0) return { text: part.trim(), lang: 'ja-JP' }
    const text = normalizeChineseMeaningText(part)
    return { text, lang: 'zh-CN' }
  }
  let text = part
  if (dictionaryName.value === 'N1语法' || dictionaryName.value === 'N2语法') {
    text = text.replace(/（[^）]*）/g, '')
  }
  return { text: text.trim(), lang: /[ぁ-んァ-ン]/.test(text) ? 'ja-JP' : 'zh-CN' }
}

// 朗读序列中的下一个段：w → 本词 c[0..n-1] → 下一词 w → …（跨词按 words 顺序循环）
function nextSegment(seg) {
  const totalWords = words.value.length
  if (!totalWords || !seg.item) return null
  if (seg.kind === 'w') {
    const parts = getCPartsOf(seg.item)
    if (parts.length) {
      return { itemIndex: seg.itemIndex, item: seg.item, kind: 'c', cIndex: 0 }
    }
  } else if (seg.cIndex + 1 < getCPartsOf(seg.item).length) {
    return {
      itemIndex: seg.itemIndex,
      item: seg.item,
      kind: 'c',
      cIndex: seg.cIndex + 1
    }
  }
  const nextIdx = (seg.itemIndex + 1) % totalWords
  const nextItem = words.value[nextIdx]
  return { itemIndex: nextIdx, item: nextItem, kind: 'w', cIndex: -1 }
}

// 后台预加载后续 n 段音频（不阻塞当前播放）
function prefetchNextSegments(seg, n) {
  let cur = seg
  for (let i = 0; i < n; i++) {
    cur = nextSegment(cur)
    if (!cur) break
    getSegmentBuffers(cur).catch(() => {})
  }
}

// 播放一个朗读段（手动/自动朗读共用）：
// 优先用缓存音频；播放完成后后台预加载之后 2 段作为缓存
async function playSegment(seg) {
  if (!seg || !seg.item) return

  const buffers = await getSegmentBuffers(seg)
  if (buffers && buffers.length > 0) {
    await playBuffers(buffers)
  } else {
    // 合成失败回退浏览器 TTS（按该段整体语言粗略朗读）
    const fb = describeSegmentSpeech(seg)
    if (fb.text) await speakViaSpeechSynthesis(fb.text, fb.lang)
  }

  // 预加载之后 2 段的文本音频作为缓存，供下次朗读/自动朗读直接使用
  prefetchNextSegments(seg, 2)
}

async function speakCurrentText(isChinese = false) {
  const item = currentItem.value
  if (!item) return
  const itemIndex = currentIndex.value

  if (currentField.value === 'w') {
    // 单词：先做 N/V → めいし/どうし 等替换，再按词库选择日语/中日混合朗读
    await playSegment({ itemIndex, item, kind: 'w', cIndex: -1 })
    return
  }

  // 解释：朗读当前展开的所有分段（按词库规则分语言，逐段播放并预加载后续）
  const total = currentCParts.value.length
  if (total === 0) return
  const cIndex = getLoopIndex(currentCPartIndex.value, total)
  const parts = currentExpandedParts.value
  if (parts.length === 0) return

  for (let i = 0; i < parts.length; i++) {
    await playSegment({ itemIndex, item, kind: 'c', cIndex: cIndex + i })
  }
}

// ---------- 自动朗读 ----------
// 顺序：当前单词 w → c 全部分段 → 下一个单词，按设置的间隔（秒）循环
const autoSpeakRunning = ref(false)
let autoSpeakTimer = null

function stopAutoSpeak() {
  autoSpeakRunning.value = false
  if (autoSpeakTimer) {
    clearTimeout(autoSpeakTimer)
    autoSpeakTimer = null
  }
}

function sleepAutoSpeak(ms) {
  return new Promise((resolve) => {
    autoSpeakTimer = setTimeout(() => {
      autoSpeakTimer = null
      resolve()
    }, ms)
  })
}

async function runAutoSpeakLoop() {
  const rawInterval = Number(settings.value.autoSpeakInterval)
  const intervalMs =
    Number.isFinite(rawInterval) && rawInterval > 0 ? Math.round(rawInterval * 1000) : 0

  while (autoSpeakRunning.value) {
    const item = currentItem.value
    if (!item || words.value.length === 0) break
    const itemIndex = currentIndex.value

    // 1. 先朗读 w（播放同时预加载后续 2 段）
    if (typeof item.w === 'string' && item.w.trim()) {
      // 界面同步切换为当前播放的单词
      currentField.value = 'w'
      scheduleProgressSave()
      await playSegment({ itemIndex, item, kind: 'w', cIndex: -1 })
      await sleepAutoSpeak(intervalMs)
      if (!autoSpeakRunning.value) break
    }

    // 2. 再依次朗读 c 的全部分段（N1/N2单词按行分语言：0=日语，1+=中文）
    const cParts = currentCParts.value
    for (let i = 0; i < cParts.length; i++) {
      if (!autoSpeakRunning.value) break
      // 界面同步切换为当前播放的分段（只展开显示该行）
      currentField.value = 'c'
      currentCPartIndex.value = i
      expandCount.value = 1
      scheduleProgressSave()
      await playSegment({ itemIndex, item, kind: 'c', cIndex: i })
      await sleepAutoSpeak(intervalMs)
    }
    if (!autoSpeakRunning.value) break

    // 3. 翻到下一个单词：先切回单词显示再翻词，
    //    避免翻词后界面仍停留在上一个词的释义 c，等待间隔期间直接显示下一个词的 w
    currentField.value = 'w'
    currentCPartIndex.value = 0
    expandCount.value = 1
    goNext()
    await sleepAutoSpeak(intervalMs)
  }

  autoSpeakRunning.value = false
}

function startAutoSpeak() {
  const rawInterval = Number(settings.value.autoSpeakInterval)
  if (!isStudyWindow) return
  if (!Number.isFinite(rawInterval) || rawInterval <= 0) return
  if (autoSpeakRunning.value) return
  autoSpeakRunning.value = true
  void runAutoSpeakLoop()
}

// Alt+E 切换：按下后才开始自动朗读，再按停止
function toggleAutoSpeak() {
  if (!isStudyWindow) return
  if (autoSpeakRunning.value) {
    stopAutoSpeak()
    return
  }
  // 未设置间隔时默认按 1 秒节拍播放（不修改设置文件）
  const rawInterval = Number(settings.value.autoSpeakInterval)
  if (!Number.isFinite(rawInterval) || rawInterval <= 0) {
    settings.value = { ...settings.value, autoSpeakInterval: 1 }
  }
  startAutoSpeak()
}

// 自动朗读由 Alt+E 快捷键控制；
// 这里仅在间隔变为无效（0）时停止，避免 0 间隔导致无节拍空转
watch(
  () => settings.value.autoSpeakInterval,
  () => {
    if (!isStudyWindow) return
    const rawInterval = Number(settings.value.autoSpeakInterval)
    if (!Number.isFinite(rawInterval) || rawInterval <= 0) {
      stopAutoSpeak()
    }
  }
)

async function saveSettings() {
  settingsError.value = ''

  try {
    // 保存设置时包含背诵模式状态
    const payload = {
      ...normalizeSettings(form.value),
      studyMode: studyMode.value
    }
    const saved = await window.api.saveSettings(payload)
    const normalized = normalizeSettings(saved)
    settings.value = normalized
    form.value = { ...normalized }
    window.api.closeSettingsWindow()
  } catch (error) {
    settingsError.value = error instanceof Error ? error.message : String(error)
  }
}

function closeSettingsWindow() {
  window.api.closeSettingsWindow()
}

function closeLectureSettingsWindow() {
  window.api.closeLectureSettingsWindow()
}

function closeBrowserSettingsWindow() {
  window.api.closeBrowserSettingsWindow()
}

async function copyCurrentDisplayText() {
  const text = typeof displayText.value === 'string' ? displayText.value : ''
  if (!text) return

  try {
    await window.api.copyText(text)
  } catch (error) {
    console.error('Failed to copy display text:', error)
  }
}

function onKeyDown(event) {
  if (event.repeat) return
  const key = event.key.toLowerCase()

  if (isSettingsWindow || isLectureSettingsWindow || isBrowserSettingsWindow) {
    if (key === 'escape') {
      if (isLectureSettingsWindow) {
        closeLectureSettingsWindow()
      } else if (isBrowserSettingsWindow) {
        closeBrowserSettingsWindow()
      } else {
        closeSettingsWindow()
      }
      event.preventDefault()
    }
    return
  }

  // 听课模式 / 模式选择窗口的按键由各自的组件自行处理
  if (isLectureWindow || isModeSelectWindow) return

  if (event.altKey && key === 'c') {
    void copyCurrentDisplayText()
    event.preventDefault()
    return
  }

  if (event.altKey && key === 'a') {
    speakCurrentText(false) // 日语语音
    event.preventDefault()
    return
  }

  if (event.altKey && key === 'w') {
    speakCurrentText(true) // 中文语音
    event.preventDefault()
    return
  }

  if (event.altKey && key === 'd') {
    toggleFavorite() // 收藏/取消收藏
    event.preventDefault()
    return
  }

  // Alt+E：开始/停止自动朗读
  if (event.altKey && key === 'e') {
    toggleAutoSpeak()
    event.preventDefault()
    return
  }

  if (event.altKey || event.ctrlKey || event.metaKey) return

  if (key === 'c') {
    goNext()
    event.preventDefault()
    return
  }

  if (key === 'z') {
    goPrev()
    event.preventDefault()
    return
  }

  if (key === 'arrowdown') {
    // 展开显示时按「一屏」翻页：从当前显示的最末尾往下翻
    goNextCPart(expandCount.value)
    event.preventDefault()
    return
  }

  if (key === 'arrowup') {
    // 展开显示时按「一屏」翻页：从当前显示的最开始往上翻
    goPrevCPart(expandCount.value)
    event.preventDefault()
    return
  }

  if (key === 'x') {
    toggleField()
    event.preventDefault()
    return
  }

  // 解释字段(c)下按数字 1-9：从当前分段开始向下展开对应数量的分段
  if (currentField.value === 'c' && /^[1-9]$/.test(key)) {
    expandCount.value = Number(key)
    scheduleProgressSave()
    event.preventDefault()
  }
}

// 鼠标滚轮翻词：显示单词(w)时切换上下词；显示解释(c)时切换解释内部分段
let wheelLastTriggerTime = 0
const WHEEL_THROTTLE_MS = 200

function onWheel(event) {
  if (!isStudyWindow) return
  const now = Date.now()
  if (now - wheelLastTriggerTime < WHEEL_THROTTLE_MS) return

  if (event.deltaY < 0) {
    wheelLastTriggerTime = now
    if (currentField.value === 'c') {
      goPrevCPart()
    } else {
      goPrev()
    }
  } else if (event.deltaY > 0) {
    wheelLastTriggerTime = now
    if (currentField.value === 'c') {
      goNextCPart()
    } else {
      goNext()
    }
  }
}

// 手动拖动窗口（替代 CSS drag 区域，使滚轮事件能正常到达）
let dragState = null

function onPointerDown(event) {
  if (!isStudyWindow) return
  if (event.button !== 0) return
  dragState = { x: event.screenX, y: event.screenY }
  if (event.target && typeof event.target.setPointerCapture === 'function') {
    try {
      event.target.setPointerCapture(event.pointerId)
    } catch {
      // 忽略 pointer capture 失败（不影响拖动）
    }
  }
}

function onPointerMove(event) {
  if (!dragState) return
  const dx = event.screenX - dragState.x
  const dy = event.screenY - dragState.y
  if (dx === 0 && dy === 0) return
  dragState.x = event.screenX
  dragState.y = event.screenY
  window.api.moveWindowBy(dx, dy)
}

function onPointerUp() {
  dragState = null
}

onMounted(async () => {
  if (isSettingsWindow || isLectureSettingsWindow || isBrowserSettingsWindow) {
    document.body.classList.add('settings-window')
  } else {
    document.body.classList.remove('settings-window')
  }

  if (isLectureWindow) {
    document.body.classList.add('lecture-window')
  } else {
    document.body.classList.remove('lecture-window')
  }

  if (isBrowserWindow) {
    document.body.classList.add('browser-window')
  } else {
    document.body.classList.remove('browser-window')
  }

  if (isModeSelectWindow) {
    document.body.classList.add('mode-select-window')
  } else {
    document.body.classList.remove('mode-select-window')
  }

  if (isStudyWindow) {
    document.body.classList.add('study-window')
  } else {
    document.body.classList.remove('study-window')
  }

  window.addEventListener('keydown', onKeyDown)

  if (isStudyWindow) {
    window.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    setupContentFit()
  }

  disposeSettingsChangedListener = window.electron.ipcRenderer.on(
    'settings:changed',
    (_, payload) => {
      const normalized = normalizeSettings(payload)
      settings.value = normalized

      // 更新背诵模式状态
      studyMode.value = normalized.studyMode

      if (isSettingsWindow) {
        form.value = { ...normalized }
        return
      }

      // 听课 / 浏览器 / 模式选择窗口不涉及背词逻辑
      if (
        isLectureWindow ||
        isLectureSettingsWindow ||
        isBrowserWindow ||
        isBrowserSettingsWindow ||
        isModeSelectWindow
      )
        return

      // 只有在普通模式下才重新加载单词
      if (normalized.studyMode === 'normal') {
        reloadWords()
      } else if (normalized.studyMode === 'favorites') {
        // 如果是切换到收藏模式，加载收藏单词
        loadFavoriteWords()
      }
    }
  )

  // 监听跳转事件（仅主窗口）
  if (!isSettingsWindow) {
    window.electron.ipcRenderer.on('words:jump', (_, payload) => {
      const source = payload && typeof payload === 'object' ? payload : {}
      const wordIndex = Number(source.wordIndex)
      const cPartIndex = Number(source.cPartIndex)

      if (Number.isFinite(wordIndex) && words.value.length > 0) {
        currentIndex.value = Math.max(0, Math.min(wordIndex, words.value.length - 1))
        currentCPartIndex.value = Number.isFinite(cPartIndex) ? cPartIndex : 0
        currentField.value = source.field === 'c' ? 'c' : 'w'
      }
    })
  }

  await loadSettings()

  // 听课 / 浏览器 / 模式选择窗口无需加载词典数据
  if (
    isLectureWindow ||
    isLectureSettingsWindow ||
    isBrowserWindow ||
    isBrowserSettingsWindow ||
    isModeSelectWindow
  )
    return

  // 无论是否是设置窗口，都加载词典数据
  await reloadWords()

  // 加载收藏数据
  await loadFavoritesFromFile()

  // 如果设置中保存的是收藏模式，切换到收藏模式
  if (studyMode.value === 'favorites') {
    loadFavoriteWords()
  }
})

onBeforeUnmount(() => {
  stopAutoSpeak()
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('wheel', onWheel)
  window.removeEventListener('pointerdown', onPointerDown)
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)

  if (progressSaveTimer) {
    clearTimeout(progressSaveTimer)
    progressSaveTimer = null
  }
  void saveStudyProgress()

  if (contentResizeTimer) {
    clearTimeout(contentResizeTimer)
    contentResizeTimer = null
  }
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  window.removeEventListener('resize', onViewportResize)

  if (disposeSettingsChangedListener) {
    disposeSettingsChangedListener()
    disposeSettingsChangedListener = null
  }
})
</script>

<template>
  <ModeSelect v-if="isModeSelectWindow" />

  <LectureSettings v-else-if="isLectureSettingsWindow" />

  <LectureVideoWindow v-else-if="isLectureVideoWindow" />

  <LectureNoteWindow v-else-if="isLectureNoteWindow" />

  <BrowserSettings v-else-if="isBrowserSettingsWindow" />

  <BrowserWindow v-else-if="isBrowserWindow" />

  <main v-else-if="isSettingsWindow" class="settings-page no-drag">
    <form class="settings-dialog" @submit.prevent="saveSettings">
      <h3 class="settings-title">设置</h3>

      <label v-if="dictionaries.length > 0" class="field">
        <span>选择词典</span>
        <select v-model.number="form.selectedDictionary">
          <option v-for="(dict, index) in dictionaries" :key="index" :value="index">
            {{ dict.name }}
          </option>
        </select>
      </label>

      <label class="field">
        <span>跳转到位置</span>
        <div class="jump-row">
          <input
            v-model.number="jumpPosition"
            type="number"
            min="1"
            :max="words.length"
            placeholder="输入位置"
          />
          <button type="button" @click="jumpToPosition">跳转</button>
        </div>
      </label>

      <label class="field">
        <span>背诵模式</span>
        <div class="mode-toggle-row">
          <button
            type="button"
            class="mode-toggle-btn"
            :class="{ active: studyMode === 'normal' }"
            @click="toggleStudyMode('normal')"
          >
            📚 普通模式
          </button>
          <button
            type="button"
            class="mode-toggle-btn"
            :class="{ active: studyMode === 'favorites' }"
            @click="toggleStudyMode('favorites')"
          >
            ❤️ 收藏模式
          </button>
        </div>
        <div class="mode-description">
          {{ studyMode === 'normal' ? '背诵当前词典的所有单词' : '只背诵收藏的单词' }}
        </div>
      </label>

      <label class="field">
        <span>文本大小</span>
        <input v-model.number="form.textSize" type="number" min="12" max="120" step="1" />
      </label>

      <label class="field">
        <span>不透明度</span>
        <input v-model.number="form.opacity" type="number" min="0.1" max="1" step="0.05" />
      </label>

      <label class="field">
        <span>文本颜色</span>
        <div class="color-row">
          <input v-model="form.textColor" class="color-picker" type="color" />
          <input v-model="form.textColor" type="text" placeholder="#FFFFFF" />
        </div>
      </label>

      <label class="field">
        <span>自动朗读间隔（秒）</span>
        <input v-model.number="form.autoSpeakInterval" type="number" min="0" max="3600" step="0.5" />
        <small class="field-hint">填 0 关闭；在背词窗口按 Alt+E 开始后，按「w → c → 下一个单词」的顺序自动循环朗读，再按一次停止</small>
      </label>

      <label class="field">
        <span>朗读语速</span>
        <div class="rate-row">
          <input v-model.number="form.speechRate" type="range" min="0.5" max="2" step="0.1" />
          <span class="rate-value">{{ form.speechRate }} 倍</span>
        </div>
        <small class="field-hint">1 = 正常语速；大于 1 更快，小于 1 更慢（对合成音频与浏览器朗读均生效）</small>
      </label>

      <p v-if="settingsError" class="error">{{ settingsError }}</p>

      <div class="actions">
        <button type="button" @click="closeSettingsWindow">取消</button>
        <button type="submit">保存</button>
      </div>
    </form>
  </main>

  <main v-else ref="textPanelRef" class="text-panel">
    <p ref="valueRef" class="value" :style="valueStyle">{{ displayText }}</p>
  </main>
</template>

<style scoped>
.jump-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.jump-row input {
  flex: 1;
  min-width: 80px;
}

.rate-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.rate-row input[type='range'] {
  flex: 1;
  min-width: 0;
}

.rate-value {
  flex: none;
  min-width: 56px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.85);
}

.jump-row button {
  padding: 6px 12px;
  background: #007acc;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
}

.jump-row button:hover {
  background: #005a9e;
}

.jump-row button:active {
  background: #004578;
}

/* 模式切换按钮样式 */
.mode-toggle-row {
  display: flex;
  gap: 10px;
  margin-bottom: 8px;
}

.mode-toggle-btn {
  flex: 1;
  padding: 10px 16px;
  border: 1px solid #ccc;
  background: #f0f0f0;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.3s;
}

.mode-toggle-btn:hover {
  background: #e0e0e0;
}

.mode-toggle-btn.active {
  background: #007acc;
  border-color: #005a9e;
  color: white;
}

.mode-toggle-btn.active:hover {
  background: #005a9e;
}

.mode-description {
  font-size: 12px;
  color: #666;
  margin-top: 5px;
}
</style>
