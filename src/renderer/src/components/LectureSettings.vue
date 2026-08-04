<script setup>
import { onMounted, ref } from 'vue'
import { ElColorPicker, ElMessage } from 'element-plus'

const videoPath = ref('')
const videoFileName = ref('')
const videoOpacity = ref(100)
const noteOpacity = ref(100)
// 使用 rgba 字符串以支持透明度（alpha 通道）
const videoBackground = ref('#000000FF')
const noteBackground = ref('#1E1E1EFF')
const editorColor = ref('#D4D4D4FF')
const editorFontSize = ref(14)
const settingsError = ref('')

// 将 rgba 颜色（如 #00000000 完全透明）转换为渲染用的 CSS 颜色值
function toCssColor(color) {
  if (!color) return 'transparent'
  // element-plus 返回 8 位 hex（#rrggbbaa）
  if (color.length === 9 && color[0] === '#') {
    const hex = color.slice(1, 7)
    const alpha = parseInt(color.slice(7, 9), 16) / 255
    return `rgba(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)}, ${alpha.toFixed(3)})`
  }
  return color
}

// 预设色板（含完全透明的黑）
const PREDEFINE_COLORS = [
  '#00000000',
  '#000000FF',
  '#1E1E1EFF',
  '#FFFFFF',
  '#FFFFFF00',
  '#007ACCF0',
  '#FFFFFF80',
  '#00000080'
]

// 编辑器字体颜色预设（常用高亮色/深浅文字）
const EDITOR_PREDEFINE_COLORS = [
  '#D4D4D4FF',
  '#FFFFFFFF',
  '#000000FF',
  '#9CDCFEFF',
  '#CE9178FF',
  '#B5CEA8FF',
  '#569CD6FF'
]

// 视频窗口背景色变化（element-plus 颜色选择器，alpha=0 即完全透明）
function onVideoBackgroundChange(color) {
  videoBackground.value = color || '#000000FF'
  window.api.setWindowBackground('video', toCssColor(videoBackground.value))
  void persistState()
}

// 笔记窗口背景色变化
function onNoteBackgroundChange(color) {
  noteBackground.value = color || '#1E1E1EFF'
  window.api.setWindowBackground('notes', toCssColor(noteBackground.value))
  void persistState()
}

function fileNameFromPath(filePath) {
  if (!filePath) return ''
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

async function pickVideo() {
  settingsError.value = ''
  const filePath = await window.api.selectVideo()
  if (!filePath) return
  videoPath.value = filePath
  videoFileName.value = fileNameFromPath(filePath)
  // 通知视频窗口切换视频
  await window.api.setVideo(filePath)
  await persistState()
}

// 单独调整视频窗口的不透明度
function onVideoOpacityInput() {
  window.api.setWindowOpacity('video', videoOpacity.value / 100)
  void persistState()
}

// 单独调整笔记窗口的不透明度
function onNoteOpacityInput() {
  window.api.setWindowOpacity('notes', noteOpacity.value / 100)
  void persistState()
}

// 编辑器字体颜色变化
function onEditorColorChange(color) {
  editorColor.value = color || '#D4D4D4FF'
  window.api.setEditorStyle('color', toCssColor(editorColor.value))
  void persistState()
}

// 编辑器字体大小变化
function onEditorFontSizeInput() {
  window.api.setEditorStyle('fontSize', editorFontSize.value)
  void persistState()
}

// 提示：透明背景需配合透明窗口生效
function showTransparentHint() {
  ElMessage.info('已设为透明，视频/笔记内容将悬浮在桌面上')
}

async function persistState() {
  try {
    await window.api.saveLectureState({
      videoPath: videoPath.value,
      videoOpacity: videoOpacity.value,
      noteOpacity: noteOpacity.value,
      videoBackground: videoBackground.value,
      noteBackground: noteBackground.value,
      editorColor: editorColor.value,
      editorFontSize: editorFontSize.value
    })
    settingsError.value = ''
  } catch (error) {
    settingsError.value = error instanceof Error ? error.message : String(error)
  }
}

function close() {
  window.api.closeLectureSettingsWindow()
}

onMounted(async () => {
  const state = await window.api.loadLectureState()
  if (state) {
    if (state.videoPath) {
      videoPath.value = state.videoPath
      videoFileName.value = fileNameFromPath(state.videoPath)
    }
    // 兼容旧版本保存的统一 windowOpacity 字段
    const savedVideoOpacity = state.videoOpacity ?? state.windowOpacity
    const savedNoteOpacity = state.noteOpacity ?? state.windowOpacity
    if (typeof savedVideoOpacity === 'number') {
      videoOpacity.value = Math.min(100, Math.max(10, savedVideoOpacity))
    }
    if (typeof savedNoteOpacity === 'number') {
      noteOpacity.value = Math.min(100, Math.max(10, savedNoteOpacity))
    }
    // 恢复背景色：兼容旧版保存的 'transparent' 或纯 hex
    if (typeof state.videoBackground === 'string') {
      videoBackground.value = normalizeBackground(state.videoBackground)
    }
    if (typeof state.noteBackground === 'string') {
      noteBackground.value = normalizeBackground(state.noteBackground)
    }
    // 恢复编辑器字体颜色与大小
    if (typeof state.editorColor === 'string') {
      editorColor.value = normalizeBackground(state.editorColor)
    }
    if (Number.isFinite(Number(state.editorFontSize))) {
      editorFontSize.value = Math.min(48, Math.max(8, Number(state.editorFontSize)))
    }
  }
})

// 把保存的背景色规整为 element-plus 颜色选择器可用的格式
function normalizeBackground(color) {
  if (!color || color === 'transparent') return '#00000000'
  // 已是 8 位 hex 或 rgba 则保留
  if (color.startsWith('#') && (color.length === 9 || color.length === 7)) {
    return color.length === 7 ? `${color}FF` : color
  }
  if (color.startsWith('rgba')) return color
  return color
}
</script>

<template>
  <main class="settings-page no-drag">
    <div class="settings-dialog">
      <h3 class="settings-title">听课设置</h3>

      <label class="field">
        <span>选择视频</span>
        <div class="video-row">
          <input
            :value="videoFileName || '未选择视频'"
            type="text"
            readonly
            placeholder="未选择视频"
          />
          <button type="button" class="action-btn" @click="pickVideo">选择</button>
        </div>
      </label>

      <label class="field">
        <span>视频窗口不透明度</span>
        <div class="opacity-row">
          <input
            v-model.number="videoOpacity"
            type="range"
            min="10"
            max="100"
            step="5"
            class="opacity-range"
            @input="onVideoOpacityInput"
          />
          <span class="opacity-value">{{ videoOpacity }}%</span>
        </div>
      </label>

      <label class="field">
        <span>笔记窗口不透明度</span>
        <div class="opacity-row">
          <input
            v-model.number="noteOpacity"
            type="range"
            min="10"
            max="100"
            step="5"
            class="opacity-range"
            @input="onNoteOpacityInput"
          />
          <span class="opacity-value">{{ noteOpacity }}%</span>
        </div>
      </label>

      <label class="field">
        <span>视频窗口背景色</span>
        <div class="color-row">
          <el-color-picker
            :model-value="videoBackground"
            show-alpha
            :predefine="PREDEFINE_COLORS"
            @active-change="onVideoBackgroundChange"
          />
          <span class="color-value">{{ videoBackground }}</span>
        </div>
      </label>

      <label class="field">
        <span>笔记窗口背景色</span>
        <div class="color-row">
          <el-color-picker
            :model-value="noteBackground"
            show-alpha
            :predefine="PREDEFINE_COLORS"
            @active-change="onNoteBackgroundChange"
          />
          <span class="color-value">{{ noteBackground }}</span>
        </div>
      </label>

      <label class="field">
        <span>编辑器字体颜色</span>
        <div class="color-row">
          <el-color-picker
            :model-value="editorColor"
            :predefine="EDITOR_PREDEFINE_COLORS"
            @active-change="onEditorColorChange"
          />
          <span class="color-value">{{ editorColor }}</span>
        </div>
      </label>

      <label class="field">
        <span>编辑器字体大小</span>
        <div class="opacity-row">
          <input
            v-model.number="editorFontSize"
            type="range"
            min="10"
            max="32"
            step="1"
            class="opacity-range"
            @input="onEditorFontSizeInput"
          />
          <span class="opacity-value">{{ editorFontSize }}px</span>
        </div>
      </label>

      <p class="hint">背景色通过色板下方透明度条调为透明，即可让窗口内容悬浮在桌面上</p>

      <p v-if="settingsError" class="error">{{ settingsError }}</p>

      <div class="actions">
        <button type="button" class="action-btn" @click="close">关闭</button>
      </div>
    </div>
  </main>
</template>

<style scoped>
.video-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.video-row input {
  flex: 1;
  min-width: 0;
}

.opacity-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.opacity-range {
  flex: 1;
  accent-color: #007acc;
}

.opacity-value {
  min-width: 40px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.color-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.color-row :deep(.el-color-picker) {
  flex-shrink: 0;
}

.color-value {
  flex: 1;
  min-width: 0;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  color: #aaa;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: #888;
}

.action-btn {
  height: 32px;
  padding: 0 14px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  cursor: pointer;
  white-space: nowrap;
}

.action-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}
</style>
