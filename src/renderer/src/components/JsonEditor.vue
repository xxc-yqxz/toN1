<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CodeMirror from 'codemirror'
import 'codemirror/lib/codemirror.css'
import 'codemirror/mode/javascript/javascript'

const props = defineProps({
  modelValue: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue'])

const containerEl = ref(null)
let cm = null
let isApplyingExternal = false

// Alt+Shift+F 格式化（格式化后恢复光标位置，不跳回开头）
function formatJson() {
  if (!cm) return
  const raw = cm.getValue().trim()
  if (!raw) return
  try {
    const parsed = JSON.parse(raw)
    const formatted = JSON.stringify(parsed, null, 2)
    if (formatted === cm.getValue()) return

    // 记录格式化前光标位置
    const cursor = cm.getCursor()

    isApplyingExternal = true
    cm.setValue(formatted)
    isApplyingExternal = false

    // 恢复光标位置（行号对应，列不超出行长度）
    const maxLine = cm.lineCount() - 1
    const newLine = Math.min(cursor.line, maxLine)
    const newCh = Math.min(cursor.ch, cm.getLine(newLine).length)
    cm.setCursor({ line: newLine, ch: newCh })
    cm.scrollIntoView({ line: newLine, ch: newCh }, 0)

    // 主动同步格式化结果给父组件（触发自动保存）
    emit('update:modelValue', formatted)
  } catch (error) {
    console.error('JSON 解析失败:', error)
  }
}

// 窗口级监听 Alt+Shift+F（比 CodeMirror extraKeys 更可靠，不受焦点/键名匹配影响）
function onWindowKeyDown(event) {
  if (event.altKey && event.shiftKey && (event.key === 'F' || event.key === 'f')) {
    event.preventDefault()
    formatJson()
  }
}

// 背景色（跟随窗口背景色，支持透明）
function setBackground(color) {
  if (!containerEl.value) return
  const bg = color && color !== 'transparent' ? color : 'transparent'
  containerEl.value.style.background = bg
  const cmEl = containerEl.value.querySelector('.CodeMirror')
  if (cmEl) {
    cmEl.style.background = bg
  }
}

// 设置默认字体大小（px）
function setFontSize(size) {
  const px = Math.max(8, Math.min(48, Number(size) || 14))
  if (containerEl.value) {
    containerEl.value.style.setProperty('--editor-font-size', `${px}px`)
  }
  cm?.refresh()
}

// 设置文字颜色：覆盖所有文字（含语法高亮 token 统一变色）
function setColor(color) {
  const c = color && color !== 'transparent' ? color : '#d4d4d4'
  if (containerEl.value) {
    containerEl.value.style.setProperty('--editor-color', c)
  }
}

onMounted(() => {
  cm = CodeMirror(containerEl.value, {
    value: props.modelValue,
    mode: 'application/json',
    lineNumbers: false,
    lineWrapping: true,
    theme: 'json-dark',
    tabSize: 2,
    indentUnit: 2,
    indentWithTabs: false,
    scrollbarStyle: 'null',
    autofocus: false,
    cursorHeight: 0.85
  })

  // 内容变化时同步到父组件（自动保存）
  cm.on('change', () => {
    if (isApplyingExternal) return
    emit('update:modelValue', cm.getValue())
  })

  // 快捷键：Tab 缩进（格式化用窗口级 keydown 监听）
  cm.setOption('extraKeys', {
    Tab: (cmInstance) => {
      cmInstance.replaceSelection('  ')
    }
  })

  // 打开时默认跳到文档末尾
  scrollToEnd()

  window.addEventListener('keydown', onWindowKeyDown)
})

watch(
  () => props.modelValue,
  (value) => {
    if (!cm) return
    if (value !== cm.getValue()) {
      isApplyingExternal = true
      cm.setValue(value ?? '')
      isApplyingExternal = false
      // 外部内容替换（如异步加载笔记内容）→ 光标与滚动跳到末尾
      scrollToEnd()
    }
  }
)

// 跳到文档末尾
function scrollToEnd() {
  if (!cm) return
  const lastLine = Math.max(0, cm.lineCount() - 1)
  cm.setCursor({ line: lastLine, ch: cm.getLine(lastLine).length })
  cm.scrollTo(null, cm.getScrollInfo().height)
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeyDown)
  cm?.save()
  cm = null
})

defineExpose({ formatJson, setBackground, setFontSize, setColor, scrollToEnd })
</script>

<template>
  <div ref="containerEl" class="json-editor"></div>
</template>

<style scoped>
.json-editor {
  width: 100%;
  height: 100%;
  min-height: 0;
  background: #1e1e1e;
}

/* CodeMirror 深色透明主题（VS Code 风格配色） */
.json-editor :deep(.CodeMirror) {
  font-family: Consolas, 'Courier New', 'Microsoft YaHei', monospace;
  font-size: var(--editor-font-size, 13px);
  line-height: 1.6;
  height: 100%;
  background: transparent;
  color: var(--editor-color, #d4d4d4);
}

/* 隐藏滚动条（滚轮仍可滚动） */
.json-editor :deep(.CodeMirror-vscrollbar),
.json-editor :deep(.CodeMirror-hscrollbar) {
  display: none !important;
}

/* 光标颜色 */
.json-editor :deep(.CodeMirror-cursor) {
  border-left: 1px solid #000000;
}

/* 选中文字 */
.json-editor :deep(.CodeMirror-selected) {
  background: #264f78 !important;
}

/* 当前行无高亮 */
.json-editor :deep(.CodeMirror-activeline-background) {
  background: transparent !important;
}

/* 语法高亮配色（VS Code 风格）；设置字体颜色后所有 token 统一使用 --editor-color */
.json-editor :deep(.cm-property) {
  color: var(--editor-color, #9cdcfe);
}

.json-editor :deep(.cm-string) {
  color: var(--editor-color, #ce9178);
}

.json-editor :deep(.cm-number) {
  color: var(--editor-color, #b5cea8);
}

.json-editor :deep(.cm-atom),
.json-editor :deep(.cm-keyword) {
  color: var(--editor-color, #569cd6);
}

.json-editor :deep(.cm-punctuation) {
  color: var(--editor-color, #d4d4d4);
}
</style>
