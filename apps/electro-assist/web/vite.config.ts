import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// CSP 约束（见开发计划 §12.8）：default-src 'self'，禁内联 script/style。
// - modulePreload.polyfill 默认会注入一段内联 script，必须关掉；
// - 不配置任何 vite-plugin 注入内联样式；
// - CSS 独立成文件，由 Vite 在 <head> 里插入 <link>（渲染阻塞，符合"首屏不闪"要求）。
export default defineConfig({
  base: '/apps/electro-assist/',
  plugins: [vue()],
  build: {
    target: 'es2020',
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
  // 本地开发与预览都走同源反代：前端代码里不出现绝对后端地址，
  // 与生产 Caddy 的同源反代保持一致。
  server: {
    proxy: { '/api': 'http://127.0.0.1:8001' },
  },
  preview: {
    proxy: { '/api': 'http://127.0.0.1:8001' },
  },
})
