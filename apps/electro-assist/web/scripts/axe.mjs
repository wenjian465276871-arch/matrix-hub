// 可访问性门禁：axe-core 扫描 4 个页面 × 2 个视口 × 2 套皮肤
//
// 依赖已在 devDependencies（axe-core + @playwright/test），无需 --no-save。
// 前置：后端 8001 + 前端 4173（vite preview 已把 /api 代理到 8001）
// 用法：npm run test:a11y
//   环境变量 BASE（默认 http://localhost:4173/apps/electro-assist）
//             API（默认 http://localhost:8001）
//             AXE_CHANNEL（默认 msedge，用系统 Edge 免下载浏览器；
//                          CI 里设 bundled，用 Playwright 自带 chromium）
//             AXE_THEMES（默认 "light,dark"，逗号分隔）
//
// 注入方式用 page.evaluate 而不是 addScriptTag：CSP 为 script-src 'self'，
// 内联 <script> 会被拦；CDP 的 Runtime.evaluate 不受 script-src 约束。
//
// 为什么带暗色（2026-11-08 加）：暗色是 10-23 之后才做的，之前只有亮色被扫过，
// 而暗色恰恰是"对比度最容易踩线"的那套令牌。只扫亮色等于把最容易坏的一半留在门外。
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'

const require = createRequire(import.meta.url)
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')
const BASE = process.env.BASE || 'http://localhost:4173/apps/electro-assist'
const API = process.env.API || 'http://localhost:8001'
const CHANNEL = process.env.AXE_CHANNEL || 'msedge'
const THEMES = (process.env.AXE_THEMES || 'light,dark')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

async function newSession() {
  const res = await fetch(`${API}/api/electro/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guide_id: 'g_door_switch_formal_001', device: 'axe 扫描' }),
  })
  if (!res.ok) throw new Error(`建会话失败 HTTP ${res.status}：${await res.text()}`)
  const body = await res.json()
  return body.session.id
}

const sid = await newSession()
// 每页除了扫描，还要**证明扫的是这一页**（2026-11-08 加，评审 P2-3 / 待办 R5-4）。
//
// 为什么必须加：原来只统计 `violations.length`，只要渲染出任何东西、没有违规就是绿。
// 而 router 有 `{ path: '/:pathMatch(.*)*', redirect: '/' }`——路径写错、路由改名、
// seed 缺数据导致页面走 error 分支时，脚本会把**重定向后的页面**（或错误态）当成目标页
// 扫一遍，输出照样是「16 次扫描 0 违规」。门禁就从"结论"退化成了"仪式"。
//
// 两道断言缺一不可：
//   ① 路径断言：URL 必须停在期望路径上（挡住 redirect）；
//   ② 内容断言：目标页的特征元素必须存在（挡住 loading/error/空壳）。
const pages = [
  // [名字, 路径, 页面就绪的判据（在浏览器里求值）]
  ['库页', '/', () => !!document.querySelector('.page-title')?.textContent?.includes('作业指导书')],
  [
    '指导书',
    '/guide/g_door_switch_formal_001',
    () => document.querySelectorAll('article.card .step').length > 0,
  ],
  ['引导', `/run/${sid}`, () => !!document.querySelector('.run-head')],
  ['排查', '/diagnose', () => !!document.querySelector('.page-title')?.textContent?.includes('故障排查')],
]

const BASE_PATH = new URL(BASE).pathname.replace(/\/+$/, '')
const expectPath = (path) => (BASE_PATH + path).replace(/\/+$/, '') || '/'

const viewports = [
  ['mobile', { width: 390, height: 844 }],
  ['desktop', { width: 1280, height: 900 }],
]

const startedAt = Date.now()
const browser = await chromium.launch(CHANNEL === 'bundled' ? {} : { channel: CHANNEL })
const rows = []
for (const [vpName, viewport] of viewports) {
  for (const theme of THEMES) {
    const ctx = await browser.newContext({ viewport })
    if (theme === 'dark') {
      // 与 src/lib/theme.ts 的 KEY 一致；那边"模块导入即上色"，所以只要在导航前
      // 写进 localStorage，首屏就是暗色，不用等 hydrate 再点开关。
      await ctx.addInitScript(() => {
        try {
          localStorage.setItem('electro-theme', 'dark')
        } catch {
          /* 写不进会在下面被断言抓住，不静默 */
        }
      })
    }
    const page = await ctx.newPage()
    for (const [name, path, ready] of pages) {
      await page.goto(BASE + path, { waitUntil: 'networkidle' })

      // ① 路径断言：SPA 的 catch-all 是 redirect /，路径错了不会 404，只会悄悄换成别的页。
      const landed = new URL(page.url()).pathname.replace(/\/+$/, '') || '/'
      if (landed !== expectPath(path)) {
        throw new Error(`页面没停在期望路径：${name} ${path} → 实际 ${landed}（被重定向了？）`)
      }

      // ② 内容断言：加载中、错误态、空壳都过得了 axe（没有违规），必须显式拒绝。
      if (!(await page.evaluate(ready))) {
        throw new Error(`页面没有渲染出目标内容：${name} ${path}（可能在 loading/error 分支）`)
      }

      if (theme === 'dark') {
        const isDark = await page.evaluate(() =>
          document.documentElement.classList.contains('theme-dark'),
        )
        if (!isDark) throw new Error(`暗色未生效：${path}（localStorage 写入失败或主题键改名）`)
      }
      await page.evaluate(AXE)
      const result = await page.evaluate(async () =>
        await window.axe.run(document, {
          runOnly: {
            type: 'tag',
            values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
          },
        }),
      )
      const violations = result.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.length,
        target: v.nodes[0]?.target?.[0] ?? '',
        help: v.help,
      }))
      rows.push({ theme, viewport: vpName, page: name, path, count: violations.length, violations })
    }
    await ctx.close()
  }
}
await browser.close()

const total = rows.reduce((n, r) => n + r.count, 0)
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
console.log(
  `扫描 ${rows.length} 次（${pages.length} 页 × ${viewports.length} 视口 × ${THEMES.length} 皮肤），耗时 ${seconds}s`,
)
if (total > 0) {
  for (const r of rows.filter((x) => x.count > 0)) {
    console.error(`  ✗ ${r.theme}/${r.viewport} ${r.page}：${r.count} 处 —— ${r.violations.map((v) => v.id).join(', ')}`)
  }
  console.log(JSON.stringify({ scannedAt: new Date().toISOString(), total, rows }, null, 2))
  console.error(`✗ 可访问性违规 ${total} 处`)
  process.exitCode = 2
} else {
  console.log(`✓ ${rows.length} 次扫描 0 违规（wcag2a/2aa/21a/21aa + best-practice）`)
}
