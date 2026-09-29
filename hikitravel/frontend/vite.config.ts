import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 本地开发：前端 5173 端口，/api 代理到后端 8000 端口
export default defineConfig({
  plugins: [react()],
  // 把构建时间打进产物：页面底部会显示"前端构建时间"，
  // 用来一眼确认"浏览器加载的到底是不是最新前端"（避免缓存造成的误判）
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toLocaleString('zh-CN', { hour12: false })),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
