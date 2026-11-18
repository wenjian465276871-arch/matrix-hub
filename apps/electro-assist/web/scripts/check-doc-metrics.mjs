/**
 * 文档指标机检：拿**真值**去比文档里写的条数。
 *
 * 为什么要有这个脚本（2026-11-18）：
 * `AGENTS.md` 把「前端单测 482 passed」写了三周，实际早已 632——差 150 条，
 * 期间没有任何东西会响。同一天还发现待办 R23-2 标着「文档指标扩到首屏/CSS/E2E
 * 两处机检」，但 `check-bundle.mjs` 只校验 README 首屏、`check_metrics.py` 只
 * 校验后端测试数与端点数，**E2E 与前端条数从来没人管**。
 *
 * 本脚本补的就是这两个缺口，真值来源分两条：
 *   1. 前端单测：vitest 的 JSON 报告（`--reporter=json --outputFile.json`）的
 *      `numTotalTests`。**报告不存在就是失败**——"产物没生成"不能等于"通过"，
 *      那正是门禁失效的标准形状。
 *   2. E2E 条数：`playwright test --list` 的 `Total: N tests`。选 `--list` 而不是
 *      跑一遍：它是静态收集，2 秒出结果、不需要起 API 与 preview、也不会因为
 *      配额或端口占用而波动。参数化循环生成的用例（render-grader 9 条）同样算得准。
 *
 * 用法（在 apps/electro-assist/web 下）：
 *   npx vitest run --coverage --reporter=json --outputFile.json=.vitest-report.json
 *   node scripts/check-doc-metrics.mjs
 *   node scripts/check-doc-metrics.mjs --agents=../../../AI2Work/AGENTS.md   # 本地审私有仓
 *
 * 退出码：0 一致 / 1 不一致或真值取不到 / 2 文档里找不到该写的行
 *
 * 刻意**不做 `--write`**：改哪个数字、怎么措辞是人的判断。脚本只负责让漂移变红。
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = resolve(HERE, '..')
const REPO_ROOT = resolve(WEB_ROOT, '../../..') // apps/electro-assist/web → matrix-hub

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const has = (name) => argv.includes(`--${name}`)

const vitestReport = resolve(WEB_ROOT, arg('vitest', '.vitest-report.json'))
const docs = [resolve(REPO_ROOT, 'README.md')]
const agents = arg('agents', '')
if (agents) docs.push(resolve(process.cwd(), agents))

const fail = []
const warn = []

/** 取真值①：vitest JSON 报告 */
function vitestTotal() {
  if (!existsSync(vitestReport)) {
    fail.push(
      `找不到 vitest 报告：${vitestReport}\n` +
        `     先跑：npx vitest run --reporter=json --outputFile.json=.vitest-report.json`
    )
    return null
  }
  const report = JSON.parse(readFileSync(vitestReport, 'utf8'))
  const total = report.numTotalTests
  if (typeof total !== 'number' || total <= 0) {
    fail.push(`vitest 报告里 numTotalTests 不是正整数：${JSON.stringify(total)}`)
    return null
  }
  // 报告是"跑过"的证据：没全过就别谈文档数字
  if (typeof report.numFailedTests === 'number' && report.numFailedTests > 0) {
    fail.push(`vitest 报告显示 ${report.numFailedTests} 条失败——先修测试，再谈文档数字`)
  }
  return total
}

/** 取真值②：playwright --list */
function e2eTotal() {
  if (has('skip-e2e')) return null
  try {
    const out = execSync('npx playwright test --list', {
      cwd: WEB_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    })
    const m = /Total:\s+(\d+)\s+tests?/i.exec(out)
    if (!m) {
      fail.push('playwright --list 的输出里找不到 "Total: N tests"')
      return null
    }
    return Number(m[1])
  } catch (error) {
    fail.push(`playwright --list 失败：${(error.stdout || error.message || '').slice(0, 300)}`)
    return null
  }
}

/** 在一份文档里找含 marker 的那一行，再从行内取第一个整数 */
function pickNumber(text, marker, docLabel) {
  const line = text
    .split(/\r?\n/)
    .find((l) => l.trimStart().startsWith('|') && l.includes(marker))
  if (!line) {
    fail.push(`${docLabel} 里找不到含「${marker}」的表格行（格式变了？）`)
    return null
  }
  const m = /\*\*(\d+)/.exec(line) || /(\d+)\s*条/.exec(line)
  if (!m) {
    fail.push(`${docLabel} 的「${marker}」行里读不出数字：${line.slice(0, 120)}`)
    return null
  }
  return Number(m[1])
}

const truth = { unit: vitestTotal(), e2e: e2eTotal() }

for (const doc of docs) {
  if (!existsSync(doc)) {
    fail.push(`文档不存在：${doc}`)
    continue
  }
  const text = readFileSync(doc, 'utf8')
  const label = doc.replace(REPO_ROOT, '').replace(/^[\\/]/, '') || doc

  // 两种文档措辞不同：README 用「前端单测 / 前端 E2E」，AGENTS.md 用「前端单测 / E2E」
  const isAgents = /AGENTS\.md$/i.test(doc)
  const unitMarker = isAgents ? '前端单测' : '前端单测'
  const e2eMarker = isAgents ? '| E2E |' : '前端 E2E'

  if (truth.unit !== null) {
    const documented = pickNumber(text, unitMarker, label)
    if (documented !== null) {
      if (documented === truth.unit) {
        console.log(`[OK  ] ${label.padEnd(24)} 前端单测 ${documented} / 实测 ${truth.unit}`)
      } else {
        fail.push(`${label} 前端单测：文档 ${documented} / 实测 ${truth.unit}（差 ${truth.unit - documented}）`)
      }
    }
  }

  if (truth.e2e !== null) {
    const documented = pickNumber(text, e2eMarker, label)
    if (documented !== null) {
      if (documented === truth.e2e) {
        console.log(`[OK  ] ${label.padEnd(24)} E2E 条数 ${documented} / 实测 ${truth.e2e}`)
      } else {
        fail.push(`${label} E2E 条数：文档 ${documented} / 实测 ${truth.e2e}（差 ${truth.e2e - documented}）`)
      }
    }
  }
}

if (warn.length) {
  for (const w of warn) console.warn(`[WARN] ${w}`)
}

if (fail.length) {
  console.error('\n[FAIL] 文档指标与实测不一致：')
  for (const f of fail) console.error(`  - ${f}`)
  console.error('\n改文档那一行，或者确认这次变化是有意的（有意的就写进决策记录）。')
  process.exit(1)
}

console.log(`\n一致：前端单测 ${truth.unit} 条、E2E ${truth.e2e ?? '（已跳过）'} 条。`)
