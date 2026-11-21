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
 * **2026-11-14 调整：单路由 CSS 6000 → 6400。**
 * 超的是 `ConfirmDialog-*.css` 这个 chunk —— 名字有误导性，它实际聚合了三块 MON
 * 面板（PantoMon / HvacMon / DoorMon）、作业台（OpsBoard / OpsBoard 的门控盘）
 * 与打印/放大层，是"交互作业面"这一整组组件的样式。本轮空调场景新增紧凑版 MON
 * （嵌在作业台左栏，见 `HvacMon.vue` 的 `.hmon--compact`）后到 6160 B。
 * 为什么是加预算而不是继续拆：这四块面板本来就该在一起（同一屏在不同场景下的三张脸），
 * 拆开只会让 `cssCodeSplit` 生成更多小文件而总量不变。**首屏预算不变**（5.01/6），
 * 那一条才是影响首屏成本的。再往上长（>6400）必须先说明哪一块是新的、能否懒加载。
 *
 * 撞线时先在输出里看是哪一份超了：首屏超 → 有东西不该在首屏；
 * 单路由超 → 那个视图该继续往下拆组件。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

/**
 * ## `--check-docs`（评审 R23-2，2026-11-15）
 * 首屏数字写在 README 的指标表里，而那张表**只有后端测试条数与端点数被机检**
 * （`scripts/check_metrics.py`）。结果就是：首屏 46.04、CSS 10.31、E2E 26 条
 * 在文档里躺了整整一个月，直到本轮 CI 红在另一条指标上才被发现。
 * 这个开关让"算出来的数字"和"写出去的数字"当场对上——CI 的构建作业跑一次即可。
 * 没有它，指标表迟早还会漂。
 */
const args = process.argv.slice(2)
const checkDocs = args.includes('--check-docs')
const root = args.find((a) => !a.startsWith('--')) ?? 'dist'
// kB = 1000，不是 1024：与 vite build 的 `gzip: xx kB` 同口径（见文件头）
const KB = 1000

const BUDGET = {
  firstCss: 6000,
  firstJs: 50000,
  routeCss: 6400,
}

/**
 * 预算用到这个比例就出声。**不改变退出码**——它不是门禁，是提前量。
 *
 * 2026-11-21 加：`ConfirmDialog-*.css` 实测 6.37/6.40（99.5%），**两行样式就能让构建变红**，
 * 而在它红之前没有任何地方会提醒；首屏 JS 也长期在 94%。这两个数每份构建输出里都算得出来，
 * 只是没人会在"通过"的输出里往后翻。这条把它顶到眼前。
 */
const NEAR = 0.9
const pct = (v, max) => `${Math.floor((v / max) * 100)}%`

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
/** 没超但已用掉 NEAR 以上的项：打 WARN，不影响退出码。 */
const near = []

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
} else if (firstCss >= BUDGET.firstCss * NEAR) {
  near.push(
    `首屏 CSS ${(firstCss / KB).toFixed(2)}KB / ${(BUDGET.firstCss / KB).toFixed(0)}KB（${pct(firstCss, BUDGET.firstCss)}）`,
  )
}
if (firstJs > BUDGET.firstJs) {
  fail.push(`首屏 JS ${(firstJs / KB).toFixed(2)}KB > ${(BUDGET.firstJs / KB).toFixed(0)}KB`)
} else if (firstJs >= BUDGET.firstJs * NEAR) {
  near.push(
    `首屏 JS ${(firstJs / KB).toFixed(2)}KB / ${(BUDGET.firstJs / KB).toFixed(0)}KB（${pct(firstJs, BUDGET.firstJs)}）`,
  )
}

// 单路由 CSS：拆开之后真值散在各 chunk 里，逐个查
const assets = readdirSync(join(root, 'assets')).filter((f) => f.endsWith('.css'))
const firstSet = new Set(first)
for (const name of assets) {
  if (firstSet.has(`assets/${name}`)) continue
  const size = gz(join(root, 'assets', name))
  rows.push({ rel: `assets/${name}`, size, kind: '路由 CSS' })
  if (size > BUDGET.routeCss) {
    // 阈值写成 6.4KB，不要 toFixed(0)——那会把 6400 显示成「6KB」，与实际的 6.4 差 400 字节
    fail.push(`路由 CSS ${name} ${(size / KB).toFixed(2)}KB > ${(BUDGET.routeCss / KB).toFixed(1)}KB`)
  } else if (size >= BUDGET.routeCss * NEAR) {
    near.push(
      `路由 CSS ${name} ${(size / KB).toFixed(2)}KB / ${(BUDGET.routeCss / KB).toFixed(1)}KB（${pct(size, BUDGET.routeCss)}）`,
    )
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

if (checkDocs) {
  const docFail = checkDocNumbers(firstCss, firstJs)
  if (docFail.length > 0) {
    console.error('[FAIL] README 的首屏指标与实测不一致：')
    for (const line of docFail) console.error(`  - ${line}`)
    console.error('改 README 那一行，或确认这次体积变化是有意的（改了就写进决策）。')
    process.exit(1)
  }
  console.log('[OK] README 的首屏指标与实测一致')
}

if (near.length > 0) {
  console.log('[WARN] 预算余量不足 10%（不算失败，退出码仍是 0）：')
  for (const line of near) console.log(`  - ${line}`)
  console.log(
    '  单路由超预算前先判断：是继续拆组件，还是加预算并写明新增的是哪一块（见文件头 2026-11-14 那段）。',
  )
}

console.log(`[OK] ${rows.length} 份产物，全部在预算内`)

/** README 指标表里的首屏一行与实测比对。返回不一致项（空数组 = 一致）。 */
function checkDocNumbers(css, js) {
  // 相对脚本自身定位（不能用 dist 的相对路径：`root` 可以被参数改掉）
  const readme = new URL('../../../../README.md', import.meta.url)
  let text
  try {
    text = readFileSync(readme, 'utf8')
  } catch (error) {
    return [`读不到 ${readme}：${error.message}`]
  }
  // | 前端首屏 | **46.42 KB** gzip（预算 50KB），CSS **5.01 KB**（预算 6KB） | … |
  const m = /\*\*([\d.]+) KB\*\* gzip（预算 (\d+)KB），CSS \*\*([\d.]+) KB\*\*（预算 (\d+)KB）/.exec(text)
  if (!m) return ['README 里没找到「前端首屏」那一行的标准写法（数字格式变了？）']
  const [, docJs, docJsBudget, docCss, docCssBudget] = m
  const want = {
    js: (js / KB).toFixed(2),
    css: (css / KB).toFixed(2),
    jsBudget: String(BUDGET.firstJs / KB),
    cssBudget: String(BUDGET.firstCss / KB),
  }
  /* 容差 0.06 kB（60 字节）：**同一个提交在 Windows 与 Linux 上构建出的字节数不同**。
     源文件在这台机器上是 CRLF、在 CI 上是 LF，压缩后的产物因此差十几到几十字节
     ——2026-11-15 第一次跑这条门禁就撞上了：本地 46.41、CI 46.42。
     0.06 的余量足以吸收这种平台差，又远小于任何真实回归（一次误引依赖就是几百字节）。
     真实回归仍会被拦：把 46.41 写成 46.00 → 差 0.41 > 0.06 → 红。 */
  const TOL = 0.06
  const off = (a, b) => Math.abs(Number(a) - Number(b)) > TOL
  const out = []
  if (off(docJs, want.js)) out.push(`首屏 JS：文档 ${docJs} / 实测 ${want.js}`)
  if (off(docCss, want.css)) out.push(`首屏 CSS：文档 ${docCss} / 实测 ${want.css}`)
  if (docJsBudget !== want.jsBudget) out.push(`JS 预算：文档 ${docJsBudget} / 脚本 ${want.jsBudget}`)
  if (docCssBudget !== want.cssBudget) out.push(`CSS 预算：文档 ${docCssBudget} / 脚本 ${want.cssBudget}`)
  return out
}
