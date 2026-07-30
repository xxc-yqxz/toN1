<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const DEFAULT_SETTINGS = {
  textSize: 22,
  opacity: 0.96,
  textColor: '#FFFFFF',
  selectedDictionary: 0, // 默认选择第一个词典
  studyMode: 'normal' // 默认普通模式
}

const windowMode = new URLSearchParams(window.location.search).get('window') || 'main'
const isSettingsWindow = windowMode === 'settings'

const words = ref([])
const dictionaryName = ref('')
const dictionaries = ref([]) // 存储所有词典数据
const currentIndex = ref(0)
const currentField = ref('w')
const currentCPartIndex = ref(0)
const errorMessage = ref('')
const settingsError = ref('')
const settings = ref({ ...DEFAULT_SETTINGS })
const form = ref({ ...DEFAULT_SETTINGS })
const jumpPosition = ref(1) // 跳转位置输入
const favoriteWords = ref(new Set()) // 收藏的单词集合
const studyMode = ref('normal') // 背诵模式：'normal' 普通模式，'favorites' 收藏模式
let disposeSettingsChangedListener = null

const currentItem = computed(() => words.value[currentIndex.value] ?? null)
const currentCParts = computed(() => {
  if (!currentItem.value || typeof currentItem.value !== 'object') return []

  const rawCValue =
    typeof currentItem.value.c === 'string'
      ? currentItem.value.c
      : typeof currentItem.value.r === 'string'
        ? currentItem.value.r
        : ''

  console.log('当前单词c字段内容:', rawCValue)
  console.log('当前单词数据结构:', currentItem.value)

  const parts = rawCValue
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

  console.log('解析后的c部分:', parts)
  return parts
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

  if (favoriteWords.value.has(wordKey)) {
    favoriteWords.value.delete(wordKey)
    console.log('取消收藏:', wordKey)
  } else {
    favoriteWords.value.add(wordKey)
    console.log('添加收藏:', wordKey)
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
    return favoriteWords.value.has(wordKey)
  }

  // 普通模式下，使用当前词典名称
  const wordKey = `${dictionaryName.value}:${currentItem.value.w}`
  return favoriteWords.value.has(wordKey)
}

// 保存收藏到star.json文件
async function saveFavoritesToFile() {
  try {
    // 按照3.html的格式组织数据
    const favoritesByDict = {}

    // 将收藏单词按词典分组
    favoriteWords.value.forEach((wordKey) => {
      const [dictName, word] = wordKey.split(':')
      if (!favoritesByDict[dictName]) {
        favoritesByDict[dictName] = []
      }
      favoritesByDict[dictName].push(word)
    })

    const favoritesData = {
      name: '用户收藏集',
      type: '用户自定义',
      description: '导出的所有词库收藏数据',
      timestamp: new Date().toISOString(),
      favorites: favoritesByDict,
      errors: {} // 当前应用没有纠错功能，留空
    }

    await window.api.saveFavorites(JSON.stringify(favoritesData, null, 2))
  } catch (error) {
    console.error('保存收藏失败:', error)
  }
}

// 从star.json文件加载收藏
async function loadFavoritesFromFile() {
  try {
    const favoritesData = await window.api.loadFavorites()
    if (favoritesData) {
      const parsedData = JSON.parse(favoritesData)

      // 处理3.html格式的收藏数据
      const favoriteWordSet = new Set()

      if (parsedData.favorites && typeof parsedData.favorites === 'object') {
        // 新版格式：按词典分组的收藏数据
        Object.entries(parsedData.favorites).forEach(([dictName, words]) => {
          if (Array.isArray(words)) {
            words.forEach((word) => {
              favoriteWordSet.add(`${dictName}:${word}`)
            })
          }
        })
      } else if (Array.isArray(parsedData.favorites)) {
        // 旧版格式：简单的单词数组
        parsedData.favorites.forEach((wordKey) => {
          favoriteWordSet.add(wordKey)
        })
      }

      favoriteWords.value = favoriteWordSet
    } else {
      // 如果文件不存在，创建空的收藏文件
      favoriteWords.value = new Set()
      await saveFavoritesToFile()
    }
  } catch (error) {
    console.error('加载收藏失败:', error)
    // 出错时也创建空的收藏文件
    favoriteWords.value = new Set()
    await saveFavoritesToFile()
  }
}

// 切换背诵模式
function toggleStudyMode(targetMode) {
  console.log('切换背诵模式:', targetMode)
  if (targetMode === 'favorites') {
    studyMode.value = 'favorites'
    console.log('切换到收藏模式，开始加载收藏单词')
    loadFavoriteWords()
  } else {
    studyMode.value = 'normal'
    console.log('切换到普通模式，重新加载单词')
    reloadWords()
  }
}

// 加载收藏单词
function loadFavoriteWords() {
  console.log('开始加载收藏单词，收藏数量:', favoriteWords.value.size)
  console.log('收藏的单词:', Array.from(favoriteWords.value))

  if (favoriteWords.value.size === 0) {
    console.log('收藏单词为空，显示提示')
    alert('暂无收藏单词，请先收藏一些单词再切换到收藏模式')
    studyMode.value = 'normal'
    return
  }

  // 创建收藏单词列表
  const favoriteWordList = []
  dictionaries.value.forEach((dict) => {
    dict.words.forEach((word) => {
      const wordKey = `${dict.name}:${word.w}`
      if (favoriteWords.value.has(wordKey)) {
        favoriteWordList.push({
          ...word,
          sourceDict: dict.name
        })
      }
    })
  })

  console.log('找到的收藏单词数量:', favoriteWordList.length)

  if (favoriteWordList.length === 0) {
    console.log('收藏的单词在当前词典中不存在')
    alert('收藏的单词在当前词典中不存在')
    studyMode.value = 'normal'
    return
  }

  words.value = favoriteWordList
  currentIndex.value = 0
  dictionaryName.value = '收藏单词'
  console.log('收藏单词加载完成，当前单词数量:', words.value.length)
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
  const cIndex = getLoopIndex(currentCPartIndex.value, cTotal)
  const cPosition = cTotal > 0 ? `[${cIndex + 1}/${cTotal}]` : '[0/0]'
  return cTotal > 0 ? `[${wordPosition}] ${cPosition} ${currentCParts.value[cIndex]}` : `[${wordPosition}] (空)`
})

const valueStyle = computed(() => ({
  fontSize: `${settings.value.textSize}px`,
  opacity: settings.value.opacity,
  color: settings.value.textColor
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

  return {
    textSize,
    opacity,
    textColor,
    selectedDictionary,
    studyMode
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
    console.log(validDictionaries, 'validDictionaries')

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
    console.log(normalized, 'normalized')

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
  } catch (error) {
    words.value = []
    dictionaryName.value = ''
    currentIndex.value = 0
    currentCPartIndex.value = 0
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
}

function goNext() {
  if (words.value.length === 0) return
  currentIndex.value = (currentIndex.value + 1) % words.value.length
  currentCPartIndex.value = 0
}

function goPrev() {
  if (words.value.length === 0) return
  currentIndex.value = (currentIndex.value - 1 + words.value.length) % words.value.length
  currentCPartIndex.value = 0
}

function goNextCPart() {
  const total = currentCParts.value.length
  if (total === 0) return
  currentCPartIndex.value = getLoopIndex(currentCPartIndex.value + 1, total)
}

function goPrevCPart() {
  const total = currentCParts.value.length
  if (total === 0) return
  currentCPartIndex.value = getLoopIndex(currentCPartIndex.value - 1, total)
}

function toggleField() {
  currentField.value = currentField.value === 'w' ? 'c' : 'w'
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

// 语音朗读功能 - 调用外部API
async function speakWithAPI(textToSpeak, lang = 'ja-JP') {
  if (!textToSpeak.trim()) return

  // 根据语言选择语音模型
  const voice = lang === 'zh-CN' ? 'zh-CN-XiaozhenNeural' : 'ja-JP-MayuNeural'
  const speed = lang === 'zh-CN' ? 1.1 : 1

  try {
    const response = await fetch('https://tts.wangwangit.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        input: textToSpeak,
        voice: voice,
        speed: speed,
        pitch: '0',
        style: 'affectionate'
      })
    })

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    const audioBlob = await response.blob()
    const audioUrl = URL.createObjectURL(audioBlob)

    // 创建音频元素并播放
    const audio = new Audio(audioUrl)
    audio.play()

    // 播放完成后清理URL
    audio.onended = () => {
      URL.revokeObjectURL(audioUrl)
    }
  } catch (error) {
    console.error('语音播放失败:', error)
    // 如果API调用失败，可以回退到浏览器API
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(textToSpeak)
      utterance.lang = lang
      utterance.rate = speed
      window.speechSynthesis.speak(utterance)
    }
  }
}

async function speakCurrentText(isChinese = false) {
  if (!currentItem.value) return

  let textToSpeak = ''

  if (currentField.value === 'w') {
    // 播放单词，排除序号
    const value = currentItem.value.w
    if (typeof value === 'string' && value.trim().length > 0) {
      textToSpeak = value.trim()

      // 语音朗读时替换：N → めいし，V → どうし（如果N或V在末尾，不加"+"），/符号添加停顿
      // 先处理N+数字+/出现在句中的情况（末尾不加+）
      textToSpeak = textToSpeak
        .replace(/\bN(\d+)\s*\//g, 'めいし$1/')
        .replace(/\bV(\d+)\s*\//g, 'どうし$1/')
      // 再处理句中的N+数字（后面有内容，不加+）
      textToSpeak = textToSpeak
        .replace(/\bN(\d+)(?=\S)/g, 'めいし$1')
        .replace(/\bV(\d+)(?=\S)/g, 'どうし$1')
      // 然后处理末尾的N+数字（加+）
      textToSpeak = textToSpeak
        .replace(/\bN(\d+)$/g, 'めいし$1+')
        .replace(/\bV(\d+)$/g, 'どうし$1+')
      // 再处理末尾的单独N/V
      textToSpeak = textToSpeak.replace(/\bN$/g, 'めいし').replace(/\bV$/g, 'どうし')
      // 最后处理单独的N/V（不在末尾）
      textToSpeak = textToSpeak.replace(/\bN(?!$)/g, 'めいし+').replace(/\bV(?!$)/g, 'どうし+')
      textToSpeak = textToSpeak.replace(/\//g, '。/。') // 在/符号前后添加空格产生停顿效果
    }
  } else {
    // 播放解释，排除序号
    const cTotal = currentCParts.value.length
    const cIndex = getLoopIndex(currentCPartIndex.value, cTotal)
    if (cTotal > 0) {
      const cValue = currentCParts.value[cIndex]
      // 提取实际内容，排除示例和翻译
      const lines = cValue.split('\n')
      if (lines.length > 0) {
        if (isChinese) {
          // 中文模式：播放第二行（中文翻译）
          textToSpeak = lines.length > 1 ? lines[1].trim() : lines[0].trim()

           // 处理中文文本：去掉圆圈数字符号⓪-⑩
          textToSpeak = textToSpeak
            .replace(/^译[:：]?\s*/, '') // 去掉开头的"译："或"译"
            .replace(/[⓪①-⑩]/g, '') // 去掉圆圈数字符号⓪①-⑩
            .replace(/…/g, '什么') // 将…替换为什么
            .replace(/\s+/g, ' ') // 合并多个空格
            .replace(/\//g, '。/。') // 在/符号前后添加空格产生停顿效果
            .trim()
        } else {
          // 日语模式：播放第一行（日语解释）
          textToSpeak = lines[0].trim()

          // 处理日语文本：去掉开头的"例："或"例"，去掉所有括号内容，/符号添加停顿
          textToSpeak = textToSpeak
            .replace(/^例[:：]?\s*/, '') // 去掉开头的"例："或"例"
            .replace(/（[^）]*）/g, '') // 去掉所有括号内的内容
            .replace(/\//g, '。/。') // 在/符号前后添加空格产生停顿效果
            .replace(/\s+/g, ' ') // 合并多个空格
            .trim()
        }
      }
    }
  }

  if (textToSpeak) {
    await speakWithAPI(textToSpeak, isChinese ? 'zh-CN' : 'ja-JP')
  }
}

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

  if (isSettingsWindow) {
    if (key === 'escape') {
      closeSettingsWindow()
      event.preventDefault()
    }
    return
  }

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
    goNextCPart()
    event.preventDefault()
    return
  }

  if (key === 'arrowup') {
    goPrevCPart()
    event.preventDefault()
    return
  }

  if (key === 'x') {
    toggleField()
    event.preventDefault()
  }
}

onMounted(async () => {
  if (isSettingsWindow) {
    document.body.classList.add('settings-window')
  } else {
    document.body.classList.remove('settings-window')
  }

  window.addEventListener('keydown', onKeyDown)

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

  // 无论是否是设置窗口，都加载词典数据
  await reloadWords()

  // 加载收藏数据
  await loadFavoritesFromFile()

  // 如果设置中保存的是收藏模式，切换到收藏模式
  if (studyMode.value === 'favorites') {
    console.log('启动时检测到收藏模式，切换到收藏模式')
    loadFavoriteWords()
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)

  if (disposeSettingsChangedListener) {
    disposeSettingsChangedListener()
    disposeSettingsChangedListener = null
  }
})
</script>

<template>
  <main v-if="isSettingsWindow" class="settings-page no-drag">
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

      <p v-if="settingsError" class="error">{{ settingsError }}</p>

      <div class="actions">
        <button type="button" @click="closeSettingsWindow">取消</button>
        <button type="submit">保存</button>
      </div>
    </form>
  </main>

  <main v-else class="text-panel">
    <p class="value" :style="valueStyle">{{ displayText }}</p>
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
