<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'

const webviewRef = ref(null)
const currentUrl = ref('')
let disposeNavigate = null

// 移动端 UA：让网页以手机布局渲染
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

const ZOOM_MSG_PREFIX = '__TO_N1_ZOOM__'
const ZOOM_MIN = 0.3
const ZOOM_MAX = 5
const ZOOM_STEP = 0.1

function loadUrl(url) {
  if (!url) return
  currentUrl.value = url
  webviewRef.value?.loadURL(url)
}

function onDidNavigate(event) {
  const url = event.url || ''
  if (url && url !== 'about:blank') {
    currentUrl.value = url
    void persistState()
  }
}

async function persistState() {
  try {
    await window.api.saveBrowserState({ browserUrl: currentUrl.value })
  } catch (error) {
    console.error('保存浏览器状态失败:', error)
  }
}

// 注入滚轮缩放监听脚本到 guest 页面。
// 由于 before-input-event 不触发 webview 的滚轮事件，改为在 guest 内监听
// DOM wheel 事件，检测 Ctrl，通过 console.log 特殊前缀把 delta 传回宿主。
function injectZoomHandler() {
  const wv = webviewRef.value
  if (!wv) return
  wv.executeJavaScript(
    `
    (function() {
      if (window.__toN1ZoomInstalled) return
      window.__toN1ZoomInstalled = true
      window.addEventListener('wheel', function(e) {
        if (e.ctrlKey) {
          e.preventDefault()
          console.log('${ZOOM_MSG_PREFIX}' + e.deltaY)
        }
      }, { passive: false })
    })()
  `,
    true
  ).catch(() => {})
}

// 解析 guest 发来的缩放指令并应用
function onConsoleMessage(event) {
  const msg = event && typeof event.message === 'string' ? event.message : ''
  if (!msg.startsWith(ZOOM_MSG_PREFIX)) return
  const delta = Number(msg.slice(ZOOM_MSG_PREFIX.length)) || 0
  if (!delta) return
  const wv = webviewRef.value
  if (!wv) return
  const current = wv.getZoomFactor() || 1
  // DOM wheel deltaY：向上滚为负（放大）、向下滚为正（缩小）
  const step = delta < 0 ? ZOOM_STEP : -ZOOM_STEP
  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, current + step))
  wv.setZoomFactor(next)
}

function onDidFinishLoad() {
  injectZoomHandler()
  const wv = webviewRef.value
  const url = wv?.getURL?.()
  if (url && url !== 'about:blank') {
    currentUrl.value = url
  }
  void persistState()
}

onMounted(async () => {
  // 监听 Alt+S 设置弹窗发来的导航指令
  disposeNavigate = window.api.onBrowserNavigate((url) => {
    loadUrl(url)
  })

  // 恢复上次浏览的网址
  const state = await window.api.loadBrowserState()
  if (state && typeof state.browserUrl === 'string' && state.browserUrl) {
    currentUrl.value = state.browserUrl
  } else {
    currentUrl.value = 'https://www.bing.com'
  }
})

onBeforeUnmount(() => {
  disposeNavigate?.()
  disposeNavigate = null
})
</script>

<template>
  <div class="browser-page">
    <!-- 顶部隐形拖拽条：完全透明，仅用于拖动窗口，不影响网页界面 -->
    <div class="drag-strip" title="按住此处拖动窗口"></div>

    <webview
      v-if="currentUrl"
      ref="webviewRef"
      :src="currentUrl"
      :useragent="MOBILE_USER_AGENT"
      class="browser-view"
      allowpopups
      @did-navigate="onDidNavigate"
      @did-navigate-in-page="onDidNavigate"
      @did-finish-load="onDidFinishLoad"
      @console-message="onConsoleMessage"
    ></webview>
  </div>
</template>

<style scoped>
.browser-page {
  position: relative;
  width: 100%;
  height: 100%;
  background: #ffffff;
}

/* 顶部隐形拖拽条：透明、极细，仅提供窗口拖动能力 */
.drag-strip {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 8px;
  z-index: 100;
  -webkit-app-region: drag;
  cursor: move;
  background: transparent;
}

.browser-view {
  width: 100%;
  height: 100%;
  border: none;
}
</style>
