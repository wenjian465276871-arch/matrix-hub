// 性能实测：Lighthouse（移动端模拟 4G + 4×CPU）
//
// 依赖不写进 package.json——lighthouse 有 100+ 包，装进 CI 会拖慢每次构建。
// 本地按需安装：npm i --no-save lighthouse
// 用法：node scripts/lighthouse.mjs <url> [out.json]
//   例：node scripts/lighthouse.mjs http://localhost:4173/apps/electro-assist/ lh.json
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
// 这两个包是 ESM：先按 CJS 规则解析出真实路径再 import，
// 否则 NODE_PATH / 全局安装场景下 ESM 解析器找不到。
const lighthouse = (await import(pathToFileURL(require.resolve('lighthouse')).href)).default
const { launch } = await import(pathToFileURL(require.resolve('chrome-launcher')).href)

const url = process.argv[2]
const out = process.argv[3] || 'lh.json'
if (!url) {
  console.error('用法：node scripts/lighthouse.mjs <url> [out.json]')
  process.exit(1)
}
// 用本机 Edge 即可：Lighthouse 需要的是 Chromium 内核，不是非 Chrome 不可。
const CHROME = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

const chrome = await launch({
  chromePath: CHROME,
  chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
})

try {
  const result = await lighthouse(
    url,
    { port: chrome.port, output: 'json', logLevel: 'error' },
    {
      extends: 'lighthouse:default',
      settings: {
        formFactor: 'mobile',
        screenEmulation: { mobile: true, width: 390, height: 844, deviceScaleFactor: 3, disabled: false },
        throttlingMethod: 'simulate',
      },
    },
  )
  fs.writeFileSync(out, result.report)
  const a = result.lhr.audits
  const c = result.lhr.categories
  const pick = (id) => (a[id] ? a[id].numericValue ?? a[id].displayValue ?? null : null)
  console.log(
    JSON.stringify(
      {
        url,
        fetchedAt: new Date().toISOString(),
        scores: {
          performance: Math.round((c.performance?.score ?? 0) * 100),
          accessibility: Math.round((c.accessibility?.score ?? 0) * 100),
          bestPractices: Math.round((c['best-practices']?.score ?? 0) * 100),
          seo: Math.round((c.seo?.score ?? 0) * 100),
        },
        metrics: {
          FCP: pick('first-contentful-paint'),
          LCP: pick('largest-contentful-paint'),
          CLS: pick('cumulative-layout-shift'),
          TBT: pick('total-blocking-time'),
          SI: pick('speed-index'),
          TTI: pick('interactive'),
          bytes: pick('total-byte-weight'),
        },
        a11yFailures: Object.values(a)
          .filter((x) => x.score !== null && x.score < 1 && x.scoreDisplayMode === 'binary')
          .filter((x) => (c.accessibility?.auditRefs ?? []).some((r) => r.id === x.id && r.weight > 0))
          .map((x) => x.id),
      },
      null,
      2,
    ),
  )
} finally {
  await chrome.kill()
}
