import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// CSP 约束（见开发计划 §12.8）：default-src 'self'，禁内联 script/style。
// - modulePreload.polyfill 默认会注入一段内联 script，必须关掉；
// - 不配置任何 vite-plugin 注入内联样式；
// - CSS 独立成文件，由 Vite 在 <head> 里插入 <link>（渲染阻塞，符合"首屏不闪"要求）。
//
// `cssCodeSplit: true`（2026-11-10，决策见决策 #50）：不拆时全部样式打进一个
// style-*.css，13.66KB gzip 已经贴到 14KB 预算。拆开之后，懒加载路由
// （GuideView / DeviceDemoView / NewGuideView / DiagnoseView …）的 scoped 样式
// 跟着各自的 chunk 走，**首屏不再为读不到的路由付样式钱**。
// 代价与前提：① 异步 chunk 的 CSS 由 Vite 在运行时插 <link>，故各路由首帧可能
// 有一帧无样式——实测只在首次进入该路由发生，且骨架在全局样式里；② 每个
// chunk 多一个请求（HTTP/2 下可忽略，本站在 Caddy 后已开 h2）。
// 后端地址可用 API_TARGET 覆盖。为什么需要：本地 Windows 的 8001 端口落在
// 系统保留段（`netsh interface ipv4 show excludedportrange` 显示 7998–8097），
// 绑定时直接 WinError 10013，只能换个端口验证；生产仍走同源反代，与此无关。
const apiTarget = process.env.API_TARGET ?? 'http://127.0.0.1:8001'

export default defineConfig({
  base: '/apps/electro-assist/',
  plugins: [vue()],
  build: {
    target: 'es2020',
    cssCodeSplit: true,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
  // 本地开发与预览都走同源反代：前端代码里不出现绝对后端地址，
  // 与生产 Caddy 的同源反代保持一致。
  server: {
    proxy: { '/api': apiTarget },
  },
  preview: {
    proxy: { '/api': apiTarget },
  },
})
