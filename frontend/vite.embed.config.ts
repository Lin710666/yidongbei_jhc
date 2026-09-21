import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 嵌入构建配置（与主构建 vite.config.ts 分开，互不影响）。
 *
 * 产物是 IIFE + 单个 CSS，给 AIRI 外壳（public/index.html）用
 * <script src="/planner-embed.js"> 和 <link rel="stylesheet" href="/planner-embed.css">
 * 直接加载，然后调 window.WenlvPlanner.mount('#wenlv-planner')。
 *
 * 为什么不做成一个完整页面再 iframe 进去：外壳是原生 JS + pixi.js 的一套设计系统，
 * iframe 里是另一个文档、另一套 body 样式，两边永远像两块拼在一起的板子。
 * 同一个 DOM 里挂载才能共用外壳的字体、配色和背景，看起来才是一体。
 */
export default defineConfig({
  plugins: [react()],
  // lib 模式（IIFE）下 Vite **不会**自动替换 process.env.NODE_ENV —— 它假设
  // 由使用者提供。而 React 与 antd 内部都要读它，不替换的话产物一加载就
  // 抛 `process is not defined`，整个工作台挂不上去（报错在浏览器控制台里，
  // 页面本身不报，很容易误判成"没渲染出来"）。所以这里显式定义成 production。
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: 'dist-embed',
    emptyOutDir: true,
    lib: {
      entry: 'src/embed.tsx',
      name: 'WenlvPlanner',
      formats: ['iife'],
      fileName: () => 'planner-embed.js',
    },
    // 只出一个 CSS 文件，外壳按固定路径 <link> 进来即可
    cssCodeSplit: false,
  },
})
