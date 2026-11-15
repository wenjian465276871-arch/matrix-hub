#!/usr/bin/env node
/**
 * 产物层面两条硬检查（计划 §12.8 末条 + 2026-11-15 R24-4）。
 *
 * ① **内联 script**：CSP 是 `script-src 'self'`，任何内联 `<script>` 都会被浏览器拒绝执行。
 *    这类问题在开发机上不一定复现——`vite build` 只在特定插件/配置下注入内联脚本
 *    （典型来源是 `modulePreload.polyfill`），一旦注入，线上表现是"页面白屏 + 控制台
 *    一条 CSP 报错"，而构建本身是成功的。所以必须在构建产物上断言，不能靠 CSP 兜底。
 *    只查 `dist/**\/*.html`：JS 里的字符串不会被执行，HTML 里的才会。
 *
 * ② **裸 `z-index` 数字**：层叠次序的唯一来源是 `styles/tokens.css` 的 `--z-*`。
 *    组件里写 `z-index: 47` 这种数字，会让"为什么这个弹层被压住"变成考古题——
 *    2026-11-15 改造前全仓有 16 个互不相同的值。这条检查让第 17 个值写不进来。
 *    只查 `src/**\/*.{vue,css}`：`tokens.css` 自身定义 `--z-*: <数字>`，不含 `z-index:`，
 *    所以不会被自己绊倒；`z-index: var(--z-*)` 与 `z-index: auto` 都放行。
 *
 * 为什么两件事塞一个脚本：CI 里已经有一处 `npm run check:inline`（构建作业），
 * 新增一条检查若另起脚本就要改 workflow——而改 workflow 有它自己的坑（YAML 不合规时
 * 是"0 作业"而不是报错）。这个脚本因此保留旧名、扩了职责，并在输出里分别报两行。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] ?? 'dist'
const HTML_RE = /\.html?$/i
// 有 src 属性的 script 是外链，允许；没有 src 的才是内联
const INLINE_RE = /<script\b(?![^>]*\bsrc=)[^>]*>/gi

// 裸数字：`z-index: 12` / `z-index:12` / `z-index: 12 !important`。
// 放行 `var(--z-*)`、`auto`、`inherit`、`initial`、`unset`。
const Z_INDEX_RE = /z-index\s*:\s*(\d+)/gi

function* walk(dir, filter) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      yield* walk(full, filter)
    } else if (filter.test(entry.name)) yield full
  }
}

function checkInlineScripts() {
  let scanned = 0
  const offenders = []
  try {
    for (const file of walk(root, HTML_RE)) {
      scanned += 1
      const html = readFileSync(file, 'utf8')
      for (const match of html.matchAll(INLINE_RE)) {
        const snippet = html.slice(match.index, match.index + 120).split('\n')[0]
        offenders.push(`${file}: ${snippet}`)
      }
    }
  } catch (error) {
    // 目录不存在说明构建没跑，也要红——否则这个检查会静默通过
    console.error(`[FAIL] 读不到 ${root}：${error.message}`)
    process.exit(2)
  }

  if (offenders.length > 0) {
    console.error(`[FAIL] 产物里有 ${offenders.length} 处内联 script（CSP script-src 'self' 会拒绝执行）：`)
    for (const line of offenders) console.error(`  - ${line}`)
    console.error('常见来源：vite `modulePreload.polyfill` 未关、插件注入了 runtime 片段。')
    return false
  }
  console.log(`[OK] ${scanned} 个 HTML，0 处内联 script`)
  return true
}

function checkZIndexTokens() {
  const offenders = []
  let scanned = 0
  for (const file of walk('src', /\.(vue|css)$/i)) {
    scanned += 1
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n')
    lines.forEach((line, index) => {
      Z_INDEX_RE.lastIndex = 0
      if (Z_INDEX_RE.test(line)) {
        offenders.push(`${file}:${index + 1}: ${line.trim()}`)
      }
    })
  }

  if (offenders.length > 0) {
    console.error(`[FAIL] 有 ${offenders.length} 处裸 z-index 数字（层叠次序只认 styles/tokens.css 的 --z-*）：`)
    for (const line of offenders) console.error(`  - ${line}`)
    console.error('改法：在 tokens.css 选一档（--z-badge/float/step-hud/tip/bar/notice/nav/sheet/drawer/dialog/zoom/elevated/stage/ops/mon/skip）。')
    return false
  }
  console.log(`[OK] ${scanned} 个样式源文件，0 处裸 z-index 数字`)
  return true
}

const okInline = checkInlineScripts()
const okZ = checkZIndexTokens()
if (!okInline || !okZ) process.exit(1)
