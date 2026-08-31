<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import JsonEditor from './JsonEditor.vue'

const notes = ref('')
const backgroundColor = ref('#1e1e1e')
const windowOpacity = ref(100)

// 避免降低透明度时背景色产生颜色污染（灰幕效果）
const effectiveBackground = computed(() => {
  if (windowOpacity.value >= 100) return backgroundColor.value
  return 'transparent'
})
// 按住 Ctrl 进入拖动模式，松开恢复编辑
const isDragging = ref(false)
const editorRef = ref(null)
let saveTimer = null
let disposeWindowBackground = null
let disposeWindowOpacity = null
let disposeEditorStyle = null

function onKeyDown(event) {
  if (event.key === 'Control') {
    isDragging.value = true
  }
}

function onKeyUp(event) {
  if (event.key === 'Control') {
    isDragging.value = false
  }
}

function onBlur() {
  // 窗口失焦时重置拖动状态，避免 Ctrl 状态卡住
  isDragging.value = false
}

function onNotesChange(value) {
  notes.value = value
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void saveNotes()
  }, 600)
}

async function saveNotes() {
  try {
    await window.api.saveNotes(notes.value)
  } catch (error) {
    console.error('Failed to save notes:', error)
  }
}

onMounted(async () => {
  const savedNotes = await window.api.loadNotes()
  if (savedNotes != null) notes.value = savedNotes

  // 恢复保存的不透明度与背景色
  const state = await window.api.loadLectureState()
  if (state) {
    const savedOpacity = state.noteOpacity ?? state.windowOpacity
    if (typeof savedOpacity === 'number') {
      windowOpacity.value = Math.min(100, Math.max(10, savedOpacity))
    }
    if (typeof state.noteBackground === 'string') {
      backgroundColor.value = state.noteBackground
    }
  }

  // 应用初始背景色与字体样式到编辑器
  editorRef.value?.setBackground(backgroundColor.value)
  if (typeof state?.editorColor === 'string') {
    editorRef.value?.setColor(state.editorColor)
  }
  if (Number.isFinite(Number(state?.editorFontSize))) {
    editorRef.value?.setFontSize(Number(state.editorFontSize))
  }

  // capture 阶段监听，避免被 CodeMirror 内部的键盘处理拦截
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('blur', onBlur)

  // 监听背景色变化（Alt+S 设置弹窗）
  disposeWindowBackground = window.api.onWindowBackground((color) => {
    backgroundColor.value = color
    editorRef.value?.setBackground(color)
  })

  // 监听编辑器样式变化（字体颜色/大小）
  disposeEditorStyle = window.api.onEditorStyle((key, value) => {
    if (key === 'color') {
      editorRef.value?.setColor(value)
    } else if (key === 'fontSize') {
      editorRef.value?.setFontSize(value)
    }
  })

  // 监听整窗不透明度变化
  disposeWindowOpacity = window.api.onWindowOpacity((value) => {
    windowOpacity.value = Math.round(Number(value) * 100)
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown, true)
  window.removeEventListener('keyup', onKeyUp, true)
  window.removeEventListener('blur', onBlur)
  disposeWindowBackground?.()
  disposeWindowBackground = null
  disposeWindowOpacity?.()
  disposeWindowOpacity = null
  disposeEditorStyle?.()
  disposeEditorStyle = null
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  void saveNotes()
})
</script>

<template>
  <!-- 默认：正常编辑；按住 Ctrl：整窗系统拖拽，可随意移动窗口 -->
  <div
    class="lecture-page"
    :class="{ dragging: isDragging }"
    :style="{ background: effectiveBackground, opacity: windowOpacity / 100 }"
  >
    <JsonEditor
      ref="editorRef"
      :model-value="notes"
      @update:model-value="onNotesChange"
    />
  </div>
</template>

<style scoped>
.lecture-page {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: #1e1e1e;
  border-radius: 0;
  /* 默认编辑模式：编辑器完全可交互 */
  -webkit-app-region: no-drag;
  /* 背景色和透明度变化平滑过渡 */
  transition: background 0.3s, opacity 0.3s;
}

/* 按住 Ctrl：整窗变为系统拖拽区，按住任意位置即可移动窗口 */
.lecture-page.dragging {
  -webkit-app-region: drag;
}
</style>
