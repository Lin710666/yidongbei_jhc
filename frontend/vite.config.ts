import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 本地开发：前端 5173 端口，/api 代理到后端 8000 端口
export default defineConfig({
  plugins: [react()],
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
