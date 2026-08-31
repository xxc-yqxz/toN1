import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    server: {
      // 显式绑定 IPv4 回环地址，避免 Windows 上 IPv6 (::1) 绑定权限错误
      host: '127.0.0.1',
      // 5173 落在系统保留端口范围（WSL2/Hyper-V），换用安全的 8080
      port: 8080,
      strictPort: true
    },
    plugins: [
      vue({
        template: {
          compilerOptions: {
            // 将 <webview> 视为原生自定义元素，避免 Vue 编译告警
            isCustomElement: (tag) => tag === 'webview'
          }
        }
      })
    ]
  }
})
