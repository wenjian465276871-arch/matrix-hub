#!/usr/bin/env node
/**
 * 产物内联 script 检查（计划 §12.8 末条）。
 *
 * 为什么需要它：CSP 是 `script-src 'self'`，任何内联 `<script>` 都会被浏览器拒绝执行。
 * 这类问题在开发机上不一定复现——`vite build` 只在特定插件/配置下注入内联脚本
 * （典型来源是 `modulePreload.polyfill`），一旦注入，线上表现是"页面白屏 + 控制台
 * 一条 CSP 报错"，而构建本身是成功的。所以必须在构建产物上断言，不能靠 CSP 兜底。
 *
 * 只查 `dist/**\/*.html`：JS 里的字符串不会被执行，HTML 里的才会。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] ?? 'dist'
const HTML_RE = /\.html?$/i
// 有 src 属性的 script 是外链，允许；没有 src 的才是内联
const INLINE_RE = /<script\b(?![^>]*\bsrc=)[^>]*>/gi

function* htmlFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* htmlFiles(full)
    else if (HTML_RE.test(entry.name)) yield full
  }
}

let scanned = 0
const offenders = []

try {
  for (const file of htmlFiles(root)) {
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
  process.exit(1)
}

console.log(`[OK] ${scanned} 个 HTML，0 处内联 script`)
