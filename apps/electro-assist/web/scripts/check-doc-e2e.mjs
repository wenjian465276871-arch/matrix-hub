#!/usr/bin/env node
/**
 * 文档里的 E2E 条数必须等于实际条数（评审 R23-2，2026-11-15）。
 *
 * ## 为什么单独一个脚本
 * 首屏数字由 `check-bundle.mjs --check-docs` 在**构建作业**里比（那里有 dist）；
 * E2E 条数只有**装了 playwright 之后**才数得出来，所以放在 E2E 作业里比。
 * 两个数字各自由"能测它的那个作业"校验，比塞进一个脚本更不容易漏。
 *
 * ## 为什么值得占 CI 时间
 * README 的指标表写着"全部可复现"，而 E2E 条数从 26 漂到 37 也没人发现——
 * 因为没有任何东西在数它。一个写着不检查的数字，比不写更糟：读者会以为它准。
 *
 * 用法：node scripts/check-doc-e2e.mjs
 * 退出码：0 一致 / 1 不一致 / 2 数不出来
 */
import { spawnSync } from 'node:child_process'

const README = new URL('../../../../README.md', import.meta.url)
const isWin = process.platform === 'win32'

const run = spawnSync(isWin ? 'npx.cmd' : 'npx', ['playwright', 'test', '--list'], {
  encoding: 'utf8',
  shell: isWin,
  env: { ...process.env, NO_COLOR: '1' },
})

if (run.status !== 0) {
  console.error('[FAIL] 数不出 E2E 条数：`npx playwright test --list` 失败')
  console.error((run.stderr || run.stdout || '').trim().split('\n').slice(-5).join('\n'))
  process.exit(2)
}

const total = /Total:\s+(\d+)\s+tests? in\s+(\d+)\s+files?/.exec(run.stdout)
if (!total) {
  console.error('[FAIL] 解析不到 "Total: N tests in M files"——playwright 输出格式变了？')
  console.error(run.stdout.trim().split('\n').slice(-5).join('\n'))
  process.exit(2)
}
const [, count, files] = total

let text
try {
  text = (await import('node:fs')).readFileSync(README, 'utf8')
} catch (error) {
  console.error(`[FAIL] 读不到 README：${error.message}`)
  process.exit(2)
}

// | 前端 E2E | **37 条**（本地 36 过 1 跳）：…
const m = /\*\*(\d+) 条\*\*（[^）]*）/.exec(text)
if (!m) {
  console.error('[FAIL] README 里没找到「前端 E2E」那一行的条数写法（**N 条**）')
  process.exit(1)
}
if (m[1] !== count) {
  console.error(`[FAIL] E2E 条数：文档 ${m[1]} / 实际 ${count}（${files} 个文件）`)
  console.error('改 README 那一行，或在报告里写明这次增删是有意的。')
  process.exit(1)
}

console.log(`[OK] README 的 E2E 条数与实际一致：${count} 条 / ${files} 个文件`)
