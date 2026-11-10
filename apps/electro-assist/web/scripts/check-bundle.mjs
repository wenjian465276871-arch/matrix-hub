#!/usr/bin/env node
/**
 * 首屏体积门禁（决策 #50，2026-11-10）。
 *
 * ## 为什么需要它
 * 「CSS 预算 14KB」在 AGENTS.md 里写了好几轮，**从没有任何脚本或 CI 检查过它**。
 * 2026-11-10 撞线（13.66/14KB）时，发现方式是有人临时手敲 `gzip -c`。
 * 写着不检查的预算等于没有预算——这一条把预算变成会红的东西。
 *
 * ## 口径（与 AGENTS.md 验收表一致）
 * - **只算首屏**：`dist/index.html` 里 `<link rel="stylesheet">`、
 *   `<script type="module">` 与 `<link rel="modulepreload">` 实际会请求的文件。
 *   懒加载路由的 chunk 不算——它们在进入那个路由时才下载，不属于首屏成本。
 * - **gzip 后，level 6，kB = 1000**——与 `vite build` 的输出**逐字节一致**。
 *   这条口径是 2026-11-10 定死的：实测 Vite 报 `gzip: 46.82 kB` 正好等于
 *   node `gzipSync(level 6)` 的 46820 字节 ÷ 1000，而此前文档里的
 *   「CSS 13.66KB」是 `gzip -c ÷ 1024`（KiB）。**同一张表里混了两套口径**，
 *   这就是"CI 说 45.72、构建说 46.82"那类对不上的来源。
 *   现在统一跟 Vite 走：它是每天被看到的那份输出，跟它一致才不会有两套数字。
 * - **单路由 CSS 也要卡**：拆了 CSS 之后风险从"总量"变成"某个路由偷偷长成新的巨石"，
 *   所以除首屏外，还逐个查所有 `dist/assets/*.css`。
 *
 * ## 阈值怎么定的（实测 − 约 2KB，不是拍脑袋）
 * | 项 | 2026-11-10 实测 | 阈值 | 余量 |
 * |---|---|---|---|
 * | 首屏 CSS | 3938 B | 6000 B | 2.06KB |
 * | 首屏 JS  | 46820 B | 50000 B | 3.18KB |
 * | 单路由 CSS | 3289 B（GuideView，最大） | 6000 B | 2.71KB |
 *
 * 撞线时先在输出里看是哪一份超了：首屏超 → 有东西不该在首屏；
 * 单路由超 → 那个视图该继续往下拆组件。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const root = process.argv[2] ?? 'dist'
// kB = 1000，不是 1024：与 vite build 的 `gzip: xx kB` 同口径（见文件头）
const KB = 1000

const BUDGET = {
  firstCss: 6000,
  firstJs: 50000,
  routeCss: 6000,
}

function gz(file) {
  return gzipSync(readFileSync(file), { level: 6 }).length
}

/** 从 index.html 里挑出浏览器首屏一定会请求的文件。 */
function firstScreenAssets(html) {
  const out = new Set()
  const add = (href) => {
    if (!href) return
    // `/apps/electro-assist/assets/x.css` → `dist/assets/x.css`
    const name = href.replace(/^\.?\//, '').replace(/^apps\/electro-assist\//, '')
    if (name.startsWith('assets/')) out.add(name)
  }
  for (const m of html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/gi)) {
    add(/href="([^"]+)"/i.exec(m[0])?.[1])
  }
  for (const m of html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*>/gi)) {
    add(/href="([^"]+)"/i.exec(m[0])?.[1])
  }
  for (const m of html.matchAll(/<script\b[^>]*\btype="module"[^>]*>/gi)) {
    add(/\bsrc="([^"]+)"/i.exec(m[0])?.[1])
  }
  return [...out]
}

let html
try {
  html = readFileSync(join(root, 'index.html'), 'utf8')
} catch (error) {
  // 目录不存在说明构建没跑，也要红——否则这个检查会静默通过
  console.error(`[FAIL] 读不到 ${root}/index.html：${error.message}`)
  console.error('先跑 npm run build。')
  process.exit(2)
}

const first = firstScreenAssets(html)
if (first.length === 0) {
  console.error('[FAIL] index.html 里没解析出任何首屏资源——解析规则与构建产物格式脱节了？')
  process.exit(2)
}

const rows = []
let firstCss = 0
let firstJs = 0
const fail = []

for (const rel of first) {
  const path = join(root, rel)
  const size = gz(path)
  const isCss = rel.endsWith('.css')
  if (isCss) firstCss += size
  else firstJs += size
  rows.push({ rel, size, kind: isCss ? '首屏 CSS' : '首屏 JS' })
}

if (firstCss > BUDGET.firstCss) {
  fail.push(`首屏 CSS ${(firstCss / KB).toFixed(2)}KB > ${(BUDGET.firstCss / KB).toFixed(0)}KB`)
}
if (firstJs > BUDGET.firstJs) {
  fail.push(`首屏 JS ${(firstJs / KB).toFixed(2)}KB > ${(BUDGET.firstJs / KB).toFixed(0)}KB`)
}

// 单路由 CSS：拆开之后真值散在各 chunk 里，逐个查
const assets = readdirSync(join(root, 'assets')).filter((f) => f.endsWith('.css'))
const firstSet = new Set(first)
for (const name of assets) {
  if (firstSet.has(`assets/${name}`)) continue
  const size = gz(join(root, 'assets', name))
  rows.push({ rel: `assets/${name}`, size, kind: '路由 CSS' })
  if (size > BUDGET.routeCss) {
    fail.push(`路由 CSS ${name} ${(size / KB).toFixed(2)}KB > ${(BUDGET.routeCss / KB).toFixed(0)}KB`)
  }
}

// 明细按体积降序：撞线时第一眼看的就是最大那份
rows.sort((a, b) => b.size - a.size)
for (const row of rows) {
  console.log(`  ${(row.size / KB).toFixed(2).padStart(7)}KB  ${row.kind.padEnd(8)} ${row.rel}`)
}
console.log(
  `  首屏合计：CSS ${(firstCss / KB).toFixed(2)}KB / ${(BUDGET.firstCss / KB).toFixed(0)}KB，` +
    `JS ${(firstJs / KB).toFixed(2)}KB / ${(BUDGET.firstJs / KB).toFixed(0)}KB（gzip -6）`,
)

if (fail.length > 0) {
  console.error(`[FAIL] 体积超预算（${fail.length} 项）：`)
  for (const line of fail) console.error(`  - ${line}`)
  console.error(
    '首屏超：先确认是不是有东西被打进了首屏（懒加载的视图不该在 index chunk 里）；' +
      '单路由超：把那个视图的样式继续往下拆组件，或调整预算并在决策里写清依据。',
  )
  process.exit(1)
}

console.log(`[OK] ${rows.length} 份产物，全部在预算内`)
