<script setup>
import { onMounted, ref } from 'vue'

const browserUrl = ref('')
const browserOpacity = ref(100)
const settingsError = ref('')

// 把用户输入规整为可加载的 URL
function normalizeUrl(input) {
  const trimmed = (input || '').trim()
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(trimmed)) return `https://${trimmed}`
  return `https://www.bing.com/search?q=${encodeURIComponent(trimmed)}`
}

function navigate() {
  const url = normalizeUrl(browserUrl.value)
  if (!url) {
    settingsError.value = '请输入有效的网址或搜索内容'
    return
  }
  settingsError.value = ''
  browserUrl.value = url
  window.api.navigateBrowser(url)
  void persistState()
}

// 调整浏览器窗口不透明度（原生 setOpacity）
function onOpacityInput() {
  window.api.setWindowOpacity('browser', browserOpacity.value / 100)
  void persistState()
}

async function persistState() {
  try {
    await window.api.saveBrowserState({
      browserUrl: browserUrl.value,
      browserOpacity: browserOpacity.value
    })
    settingsError.value = ''
  } catch (error) {
    settingsError.value = error instanceof Error ? error.message : String(error)
  }
}

function close() {
  window.api.closeBrowserSettingsWindow()
}

onMounted(async () => {
  const state = await window.api.loadBrowserState()
  if (state) {
    if (typeof state.browserUrl === 'string') {
      browserUrl.value = state.browserUrl
    }
    if (Number.isFinite(Number(state.browserOpacity))) {
      browserOpacity.value = Math.min(100, Math.max(10, Number(state.browserOpacity)))
    }
  }
})
</script>

<template>
  <main class="settings-page no-drag">
    <div class="settings-dialog">
      <h3 class="settings-title">浏览器设置</h3>

      <label class="field">
        <span>网址</span>
        <div class="url-row">
          <input
            v-model="browserUrl"
            type="text"
            placeholder="输入网址，如 www.bilibili.com"
            spellcheck="false"
            @keyup.enter="navigate"
          />
          <button type="button" class="action-btn" @click="navigate">前往</button>
        </div>
      </label>

      <label class="field">
        <span>窗口不透明度</span>
        <div class="opacity-row">
          <input
            v-model.number="browserOpacity"
            type="range"
            min="10"
            max="100"
            step="5"
            class="opacity-range"
            @input="onOpacityInput"
          />
          <span class="opacity-value">{{ browserOpacity }}%</span>
        </div>
      </label>

      <p class="hint">浏览器窗口为纯网页界面（无地址栏），在此输入网址后点击「前往」，窗口即可加载；不透明度通过 Alt+S 随时调整</p>

      <p v-if="settingsError" class="error">{{ settingsError }}</p>

      <div class="actions">
        <button type="button" class="action-btn" @click="close">关闭</button>
      </div>
    </div>
  </main>
</template>

<style scoped>
.url-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.url-row input {
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
