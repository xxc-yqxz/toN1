<script setup>
function selectMode(mode) {
  window.api.selectMode(mode)
}

function quit() {
  window.api.quitApp()
}
</script>

<template>
  <div class="mode-select-page">
    <h2 class="title">选择学习模式</h2>
    <p class="subtitle">启动后选择本次使用的模式，可随时通过托盘「切换模式…」或 Alt+M 切换</p>

    <div class="mode-grid">
      <button type="button" class="mode-card study" @click="selectMode('study')">
        <span class="mode-icon">📖</span>
        <span class="mode-text">
          <span class="mode-name">背词模式</span>
          <span class="mode-desc">透明悬浮置顶窗口，翻词 / 朗读 / 收藏 / TTS 发音</span>
        </span>
      </button>
      <button type="button" class="mode-card lecture" @click="selectMode('lecture')">
        <span class="mode-icon">🎬</span>
        <span class="mode-text">
          <span class="mode-name">听课模式</span>
          <span class="mode-desc">左侧播放本地视频（可调不透明度 / 窗口大小），右侧 JSON 笔记编辑</span>
        </span>
      </button>
      <button type="button" class="mode-card browser" @click="selectMode('browser')">
        <span class="mode-icon">🌐</span>
        <span class="mode-text">
          <span class="mode-name">浏览器模式</span>
          <span class="mode-desc">输入网址浏览网页，Alt+S 可调窗口不透明度</span>
        </span>
      </button>
    </div>

    <div class="footer">
      <span class="hint">背词模式下原有功能完全不变</span>
      <button type="button" class="quit-btn" @click="quit">退出应用</button>
    </div>
  </div>
</template>

<style scoped>
.mode-select-page {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 20px 24px;
  box-sizing: border-box;
  background: #0f0f10;
  color: #e8e8e8;
  font-family:
    Inter,
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    'Microsoft YaHei',
    sans-serif;
}

.title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.subtitle {
  margin: 0;
  font-size: 12px;
  color: #888;
}

.mode-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  margin-top: 8px;
}

.mode-card {
  flex: 1;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 12px;
  background: #17171a;
  color: #e8e8e8;
  cursor: pointer;
  text-align: left;
  transition:
    transform 0.15s ease,
    border-color 0.15s ease,
    background 0.15s ease;
}

.mode-card:hover {
  transform: translateY(-2px);
  border-color: rgba(255, 255, 255, 0.45);
  background: #1e1e22;
}

.mode-card:active {
  transform: translateY(0);
}

.mode-icon {
  font-size: 30px;
  line-height: 1;
  flex-shrink: 0;
}

.mode-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.mode-name {
  font-size: 15px;
  font-weight: 600;
}

.mode-desc {
  font-size: 12px;
  line-height: 1.4;
  color: #999;
}

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  margin-top: 4px;
}

.hint {
  font-size: 11px;
  color: #666;
}

.quit-btn {
  padding: 6px 14px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  color: #ccc;
  font-size: 12px;
  cursor: pointer;
}

.quit-btn:hover {
  background: rgba(255, 255, 255, 0.16);
}
</style>
