// 可访问性实测：axe-core 扫描 4 个页面 × 2 个视口
//
// 依赖按需安装：npm i --no-save axe-core
// 前置：后端 8001 + 前端 4173（vite preview 已把 /api 代理到 8001）
// 用法：node scripts/axe.mjs
//   环境变量：BASE（默认 http://localhost:4173/apps/electro-assist）
//             API（默认 http://localhost:8001）
//
// 注入方式用 page.evaluate 而不是 addScriptTag：CSP 为 script-src 'self'，
// 内联 <script> 会被拦；CDP 的 Runtime.evaluate 不受 script-src 约束。
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'

const require = createRequire(import.meta.url)
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')
const BASE = process.env.BASE || 'http://localhost:4173/apps/electro-assist'
const API = process.env.API || 'http://localhost:8001'

async function newSession() {
  const res = await fetch(`${API}/api/electro/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guide_id: 'g_door_switch_formal_001', device: 'axe 扫描' }),
  })
  const body = await res.json()
  return body.session.id
}

const sid = await newSession()
const pages = [
  ['库页', '/'],
  ['指导书', '/guide/g_door_switch_formal_001'],
  ['引导', `/run/${sid}`],
  ['排查', '/diagnose'],
]
const viewports = [
  ['mobile', { width: 390, height: 844 }],
  ['desktop', { width: 1280, height: 900 }],
]

const browser = await chromium.launch({ channel: 'msedge' })
const rows = []
for (const [vpName, viewport] of viewports) {
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  for (const [name, path] of pages) {
    await page.goto(BASE + path, { waitUntil: 'networkidle' })
    await page.evaluate(AXE)
    const result = await page.evaluate(async () =>
      await window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
      }),
    )
    const violations = result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.length,
      target: v.nodes[0]?.target?.[0] ?? '',
      help: v.help,
    }))
    rows.push({ viewport: vpName, page: name, path, count: violations.length, violations })
  }
  await ctx.close()
}
await browser.close()

const total = rows.reduce((n, r) => n + r.count, 0)
console.log(JSON.stringify({ scannedAt: new Date().toISOString(), total, rows }, null, 2))
if (total > 0) process.exitCode = 2
