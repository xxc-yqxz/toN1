<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const videoUrl = ref('')
const videoEl = ref(null)
const isPlaying = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const showControls = ref(false)
const videoError = ref('')
const backgroundColor = ref('#000000')
const windowOpacity = ref(100)

// 计算有效背景色：当透明度 < 100% 时使用透明背景，避免黑色/彩色背景
// 形成灰色幕布遮罩（CSS opacity 会同时作用于背景和内容，非透明背景
// 在降低透明度时会产生颜色污染）
const effectiveBackground = computed(() => {
  if (windowOpacity.value >= 100) return backgroundColor.value
  return 'transparent'
})
const pendingProgress = ref(null)
const playbackRate = ref(1)
let disposeVideoChanged = null
let disposeWindowBackground = null
let disposeWindowOpacity = null
let disposePauseVideo = null
let disposeResumeVideo = null
let progressTimer = null
// 标记：是否因 Alt+Q 隐藏而被暂停（显示时需自动恢复播放）
let shouldResumeOnShow = false

// Alt+Q 隐藏窗口时暂停视频（记录需恢复的播放状态）
function onPauseVideo() {
  const el = videoEl.value
  if (el && !el.paused) {
    shouldResumeOnShow = true
    el.pause()
  }
}

// Alt+Q 显示窗口时恢复播放（仅当隐藏前正在播放）
function onResumeVideo() {
  const el = videoEl.value
  if (el && shouldResumeOnShow) {
    shouldResumeOnShow = false
    // 通过微调 opacity 强制 Chromium 软件渲染器重绘 <video> 帧，
    // 避免 DWM 合成表面重建后 Chromium 来不及推送新帧而卡在灰屏
    el.style.opacity = '0.99'
    setTimeout(() => {
      if (el) el.style.opacity = '1'
    }, 50)
    void el.play()
  }
}

const currentTimeText = computed(() => formatTime(currentTime.value))
const durationText = computed(() => formatTime(duration.value))

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '00:00'
  const s = Math.floor(sec % 60)
  const m = Math.floor((sec / 60) % 60)
  const h = Math.floor(sec / 3600)
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

function toMediaUrl(filePath) {
  if (!filePath) return ''
  return `media://video/${encodeURIComponent(filePath)}`
}

function applyVideo(filePath) {
  if (!filePath) return
  videoUrl.value = toMediaUrl(filePath)
  videoError.value = ''
  isPlaying.value = false
  currentTime.value = 0
  duration.value = 0
}

function onVideoLoadedMetadata() {
  duration.value = videoEl.value?.duration ?? 0
  // 加载完成后定位到保存的播放进度
  if (pendingProgress.value != null && Number.isFinite(pendingProgress.value)) {
    const target = Math.max(0, Math.min(pendingProgress.value, duration.value || 0))
    videoEl.value.currentTime = target
    currentTime.value = target
  }
  pendingProgress.value = null
}

function onTimeUpdate() {
  currentTime.value = videoEl.value?.currentTime ?? 0
  // 记录播放进度并定时保存（避免频繁写文件）
  if (pendingProgress.value !== currentTime.value) {
    pendingProgress.value = currentTime.value
  }
  scheduleProgressSave()
}

// 保存播放进度（合并写入 lecture-state.json，不影响其他字段）
async function saveProgress() {
  const state = await window.api.loadLectureState()
  const merged = { ...(state || {}), videoProgress: currentTime.value }
  await window.api.saveLectureState(merged)
}

function scheduleProgressSave() {
  if (progressTimer) return
  progressTimer = setTimeout(() => {
    progressTimer = null
    void saveProgress()
  }, 1500)
}

function togglePlay() {
  const el = videoEl.value
  if (!el) return
  if (el.paused) {
    void el.play()
  } else {
    el.pause()
  }
}

function onPlay() {
  isPlaying.value = true
}

function onPause() {
  isPlaying.value = false
}

function onSeek() {
  const el = videoEl.value
  if (!el) return
  el.currentTime = currentTime.value
}

// 快进 / 快退（秒）
function seekBy(seconds) {
  const el = videoEl.value
  if (!el || !Number.isFinite(el.duration)) return
  el.currentTime = Math.max(0, Math.min(el.duration, el.currentTime + seconds))
}

// 倍速：↑/↓ 以 0.1 为单位增减
function adjustSpeed(delta) {
  const el = videoEl.value
  if (!el) return
  const next = Math.round((el.playbackRate + delta) * 10) / 10
  el.playbackRate = Math.max(0.1, Math.min(4, next))
  playbackRate.value = el.playbackRate
}

// 重置倍速为 1x
function resetSpeed() {
  const el = videoEl.value
  if (!el) return
  el.playbackRate = 1
  playbackRate.value = 1
}

// 截取当前视频帧并复制到剪贴板（PNG）
function captureFrame() {
  const el = videoEl.value
  if (!el || el.readyState < 2) return
  const w = el.videoWidth
  const h = el.videoHeight
  if (!w || !h) return

  try {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.drawImage(el, 0, 0, w, h)
    const dataUrl = canvas.toDataURL('image/png')
    window.api.copyImage(dataUrl)
  } catch (error) {
    console.error('Failed to capture video frame:', error)
  }
}

// 键盘控制：空格暂停/播放，左右方向键快进/快退，F1 截取当前帧
function onKeyDown(event) {
  // F1 截帧始终可用（不受焦点元素影响）
  if (event.code === 'F1') {
    event.preventDefault()
    captureFrame()
    return
  }

  if (!videoEl.value) return

  // 焦点在可交互控件上时交给控件原生处理（如进度条已聚焦时左右键调整进度条）
  const tag = event.target?.tagName
  if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return
  }

  if (event.code === 'Space') {
    event.preventDefault()
    togglePlay()
  } else if (event.code === 'ArrowLeft') {
    event.preventDefault()
    seekBy(-5)
  } else if (event.code === 'ArrowRight') {
    event.preventDefault()
    seekBy(5)
  } else if (event.code === 'ArrowUp') {
    event.preventDefault()
    adjustSpeed(0.1)
  } else if (event.code === 'ArrowDown') {
    event.preventDefault()
    adjustSpeed(-0.1)
  }
}

function onVideoError() {
  const el = videoEl.value
  const code = el?.error?.code
  const messages = {
    1: '视频加载被中止',
    2: '网络错误，视频无法加载',
    3: '视频解码失败，可能编码格式不受支持',
    4: '视频格式不受支持'
  }
  videoError.value = messages[code] ?? `视频播放错误（错误码 ${code}）`
}

onMounted(async () => {
  // 启动时恢复上次播放的视频、进度、不透明度与背景色
  const state = await window.api.loadLectureState()
  if (state) {
    if (state.videoPath) {
      applyVideo(state.videoPath)
      // 记录要恢复的播放进度（等视频元数据加载完成后定位）
      if (Number.isFinite(Number(state.videoProgress)) && Number(state.videoProgress) > 1) {
        pendingProgress.value = Number(state.videoProgress)
      }
    }
    // 兼容旧版本保存的统一 windowOpacity 字段
    const savedOpacity = state.videoOpacity ?? state.windowOpacity
    if (typeof savedOpacity === 'number') {
      windowOpacity.value = Math.min(100, Math.max(10, savedOpacity))
    }
    if (typeof state.videoBackground === 'string') {
      backgroundColor.value = state.videoBackground
    }
  }

  // 监听设置弹窗中选择的新视频
  disposeVideoChanged = window.api.onVideoChanged((filePath) => {
    applyVideo(filePath)
  })

  // 监听背景色变化（Alt+S 设置弹窗）
  disposeWindowBackground = window.api.onWindowBackground((color) => {
    backgroundColor.value = color
  })

  // 监听整窗不透明度变化
  disposeWindowOpacity = window.api.onWindowOpacity((value) => {
    windowOpacity.value = Math.round(Number(value) * 100)
  })

  // Alt+Q 隐藏/显示时暂停/恢复视频
  disposePauseVideo = window.api.onPauseVideo(() => {
    onPauseVideo()
  })
  disposeResumeVideo = window.api.onResumeVideo(() => {
    onResumeVideo()
  })

  window.addEventListener('keydown', onKeyDown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  // 停止定时保存并立即保存最终进度
  if (progressTimer) {
    clearTimeout(progressTimer)
    progressTimer = null
  }
  if (currentTime.value > 1) {
    void saveProgress()
  }
  disposeVideoChanged?.()
  disposeVideoChanged = null
  disposeWindowBackground?.()
  disposeWindowBackground = null
  disposeWindowOpacity?.()
  disposeWindowOpacity = null
  disposePauseVideo?.()
  disposePauseVideo = null
  disposeResumeVideo?.()
  disposeResumeVideo = null
})
</script>

<template>
  <div class="lecture-page" :style="{ background: effectiveBackground, opacity: windowOpacity / 100 }">
    <!-- 顶部隐形拖拽条（覆盖窗口边缘缩放区，保证有足够的可拖区域） -->
    <div class="drag-strip" title="按住此处拖动窗口"></div>

    <div
      class="video-area"
      @mouseenter="showControls = true"
      @mouseleave="showControls = false"
    >
      <video
        v-if="videoUrl"
        ref="videoEl"
        :src="videoUrl"
        preload="metadata"
        crossorigin="anonymous"
        class="video-player"
        @loadedmetadata="onVideoLoadedMetadata"
        @timeupdate="onTimeUpdate"
        @play="onPlay"
        @pause="onPause"
        @error="onVideoError"
      ></video>

      <div v-else class="video-placeholder">
        <p class="placeholder-icon">🎬</p>
        <p>尚未选择视频</p>
        <p class="hint">按 Alt+S 打开设置，选择本地视频</p>
      </div>

      <div v-if="videoError" class="video-error">{{ videoError }}</div>

      <!-- 自定义悬浮控制条 -->
      <div
        v-if="videoUrl && !videoError"
        class="video-controls"
        :class="{ visible: showControls }"
      >
        <button type="button" class="ctrl-btn" title="播放/暂停" @click="togglePlay">
          {{ isPlaying ? '⏸' : '▶' }}
        </button>
        <span class="time">{{ currentTimeText }}</span>
        <input
          v-model.number="currentTime"
          type="range"
          class="seek-bar"
          min="0"
          :max="duration || 0"
          step="0.1"
          @input="onSeek"
        />
        <span class="time">{{ durationText }}</span>
        <button
          type="button"
          class="ctrl-btn speed-btn"
          title="点击重置为 1x（↑/↓ 调整倍速）"
          @click="resetSpeed"
        >
          {{ playbackRate.toFixed(1) }}x
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lecture-page {
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
  background: #000;
  border-radius: 0;
  /* 窗口整体可拖拽 */
  -webkit-app-region: drag;
  /* 背景色和透明度变化平滑过渡 */
  transition: background 0.3s, opacity 0.3s;
}

/* 顶部隐形拖拽条 */
.drag-strip {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 20px;
  z-index: 100;
  -webkit-app-region: drag;
  cursor: move;
}

.video-area {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 透明，露出 .lecture-page 上设置的背景色 */
  background: transparent;
  border-radius: 0;
  overflow: hidden;
}

/* 视频画面按住即可拖动窗口（拖拽区域） */
.video-player {
  width: 100%;
  height: 100%;
  object-fit: contain;
  /* 透明，露出 .lecture-page 上设置的背景色 */
  background: transparent;
  display: block;
  -webkit-app-region: drag;
  user-select: none;
}

.video-placeholder {
  color: #888;
  text-align: center;
}

.placeholder-icon {
  font-size: 40px;
  margin: 0 0 8px;
}

.video-placeholder .hint {
  font-size: 12px;
  color: #666;
  margin-top: 4px;
}

.video-error {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  text-align: center;
  color: #ff8080;
  font-size: 13px;
  background: rgba(0, 0, 0, 0.6);
}

/* 自定义悬浮控制条（鼠标悬停显示） */
.video-controls {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.75));
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
  -webkit-app-region: no-drag;
}

.video-controls.visible {
  opacity: 1;
  pointer-events: auto;
}

.ctrl-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #fff;
  font-size: 14px;
  cursor: pointer;
}

.ctrl-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}

.speed-btn {
  width: auto;
  padding: 0 8px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.time {
  font-size: 11px;
  color: #fff;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.seek-bar {
  flex: 1;
  min-width: 0;
  accent-color: #007acc;
  cursor: pointer;
}
</style>
