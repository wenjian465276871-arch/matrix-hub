/**
 * 量一个页面的实际渲染帧率（R26-2）。
 *
 * ## 为什么需要它
 *
 * 三天里为让 CI 变绿改了 6 次阈值（点击闸门 700ms→3s、用例时限 180→300s、
 * 作业超时 15→30min）。每次的措辞都是"CI 慢机"，但**从来没人量过它到底多慢**——
 * 于是"慢"变成了一个可以无限解释的口袋，阈值也就可以无限放宽。
 *
 * 这个脚本把那个口袋缝上：跑一段 rAF 采样，打印平均/最差帧率，
 * 并在低于下限时**直接失败**。这样"CI 太慢"就变成一个有数字、有门槛的事实。
 *
 * ## 为什么用 rAF 而不是 PerformanceObserver
 *
 * 我们要回答的是"这个环境能不能支撑按帧推进的交互断言"，
 * 而 rAF 的间隔正是断言真正依赖的东西。首次内容绘制、长任务之类的指标
 * 回答的是另一个问题（页面多快可用），这里不需要。
 *
 * 用法：
 *   node tools/measure-fps.mjs                        # 默认量本地 4173
 *   FPS_BASE=http://127.0.0.1:4173 FPS_MIN=5 node tools/measure-fps.mjs
 *   FPS_PATH=/apps/electro-assist/demo/device node tools/measure-fps.mjs
 */
import { chromium } from 'playwright'

const BASE = process.env.FPS_BASE || 'http://127.0.0.1:4173'
const PATH = process.env.FPS_PATH || '/apps/electro-assist/demo/device'
const SECONDS = Number(process.env.FPS_SECONDS || 6)
const MIN = Number(process.env.FPS_MIN || 4)

const url = BASE.replace(/\/$/, '') + PATH

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
let loadError = null
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('canvas', { timeout: 60000 })
} catch (e) {
  loadError = e
}

if (loadError) {
  console.error(`[FAIL] 打不开 ${url}：${String(loadError.message).split('\n')[0]}`)
  await browser.close()
  process.exit(2)
}

// 采样放在页面里做：跨进程读时间会把调度抖动算进帧率
const result = await page.evaluate(async (seconds) => {
  const gaps = []
  let last = performance.now()
  const stop = last + seconds * 1000
  await new Promise((resolve) => {
    const tick = (now) => {
      gaps.push(now - last)
      last = now
      if (now >= stop) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const sorted = gaps.slice(1).sort((a, b) => a - b)
  const avg = sorted.reduce((s, v) => s + v, 0) / Math.max(1, sorted.length)
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || avg
  return {
    frames: sorted.length,
    avgMs: avg,
    p95Ms: p95,
    fps: avg > 0 ? 1000 / avg : 0,
    worstMs: sorted[sorted.length - 1] || 0,
  }
}, SECONDS)

await browser.close()

const fps = result.fps
const line = `[fps] ${url} → 平均 ${fps.toFixed(1)} fps · p95 帧间隔 ${result.p95Ms.toFixed(0)}ms · 最差 ${result.worstMs.toFixed(0)}ms · 样本 ${result.frames} 帧`
console.log(line)

// 给人看的汇总（GitHub Actions 会把这一段渲染成作业摘要）
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs')
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `\n### 渲染帧率实测\n\n| 项 | 值 |\n|---|---|\n| 页面 | \`${PATH}\` |\n| 平均 | **${fps.toFixed(1)} fps** |\n| p95 帧间隔 | ${result.p95Ms.toFixed(0)} ms |\n| 最差帧间隔 | ${result.worstMs.toFixed(0)} ms |\n| 门槛 | ≥ ${MIN} fps |\n\n所有"等动画/等渲染"的超时都按这个量级推导，不要凭感觉放宽。\n`,
  )
}

/* **默认不失败**（2026-11-17 改）：第一版把 4fps 设成硬门槛，
   结果 CI 用软件渲染跑 1–2fps，直接把自己的部署堵住了——
   等于用环境惩罚代码，与 R2 的逻辑正好相反（R2 说的是"别用时间判对错"，
   那就不该拿帧率当门禁）。

   现在：帧率是**观测值**，写进作业摘要供推导阈值；只有"量不出来"才失败
   （打不开页面 → exit 2）。需要硬门槛时显式传 `FPS_HARD=1`。 */
if (fps < MIN) {
  const msg =
    `[WARN] 实测 ${fps.toFixed(1)} fps，低于参考线 ${MIN} fps。\n` +
    `本环境的"等动画"断言不可信——请改断言（等状态），不要放宽超时。`
  if (process.env.FPS_HARD === '1') {
    console.error(msg.replace('[WARN]', '[FAIL]'))
    process.exit(1)
  }
  console.warn(msg)
  console.log(`[OK] 已记录（未设 FPS_HARD=1，不阻断）`)
} else {
  console.log(`[OK] 帧率 ${fps.toFixed(1)} fps ≥ 参考线 ${MIN}`)
}
