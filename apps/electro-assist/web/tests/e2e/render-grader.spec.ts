import { expect, test } from '@playwright/test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 渲染 grader（R24-6）：把**指导书 JSON** 真的放进浏览器渲染一遍。
 *
 * ## 为什么需要它
 *
 * `eval_generate.py` 只证明"过得了 schema"。过得了 schema ≠ 页面能用：
 * 某张图参数合法、渲染器却抛错 → 现场只看到一段 fallback 文字；
 * 某一步图太多 → 窄屏横向溢出，判据被挤到屏幕外。
 * 这两类问题以前全靠人眼看。
 *
 * ## 怎么拿到"任意 JSON 的页面"
 *
 * 不造测试页：拦 `GET /api/electro/guides/<id>` 返回 JSON，走**真实路由与真实组件**。
 * 测的是线上那套渲染，不是影子链路。
 *
 * ## 数据来源
 *
 * 默认 `api/data/samples/*.json`（9 份样例、118 张图，覆盖全部 17 个原语）。
 * 跑完 `eval_generate.py --out-dir <dir>` 之后可以把生成产物也喂进来：
 * `RENDER_GRADER_DIR=<dir> npx playwright test render-grader`。
 * **这才是它叫 grader 的原因**——评的是产出，不是样例。
 *
 * ## 断言四件事
 *
 * 1. 每步渲染出的图数 == JSON 里的 `figures.length`（少一张就是静默丢图）；
 * 2. 任何地方都不出现 `.figure__fallback`（出现即某张图渲染失败）；
 * 3. 页面没有横向溢出（手机 390 / 平板 1024 各测一次）；
 * 4. `device_scene` 的 `t` 落在契约枚举的瞬间上（±0.02）——**代码审查抓不到这条**，
 *    t 编错时图画得出来，只是停在别的工步。
 *
 * 打印态（`beforeprint`）会把全部页铺开，顺带利用那个行为：不点翻页也能一次看完全部步骤。
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SAMPLES = join(HERE, '..', '..', '..', 'api', 'data', 'samples')
const DIR = process.env.RENDER_GRADER_DIR ?? SAMPLES
const CONTRACT = join(HERE, '..', '..', 'src', 'contract', 'devices.json')

interface Spec {
  primitive: string
  params?: Record<string, unknown>
}
interface Step {
  seq: number
  title?: string
  figures?: Spec[]
  safety?: unknown[]
  tools?: unknown[]
}
interface Guide {
  id: string
  steps: Step[]
}

/**
 * 把 `data/samples/*.json` 补成**接口实际返回的形状**。
 *
 * 实测发现：样例 JSON 会省略空数组（`safety` / `tools`），而接口返回的是 pydantic
 * 归一化后的结果（`safety: []`）。前端 `StepPage` 直接读 `step.safety.length`，
 * 喂未归一化的 JSON 会整页抛 TypeError——那是**喂错数据**，不是页面有 bug
 * （生产路径永远走接口）。所以这里按接口口径补齐，只加缺的键，不改内容。
 */
function normalize(guide: Guide): Guide {
  return {
    ...guide,
    steps: guide.steps.map((step) => ({
      ...step,
      figures: step.figures ?? [],
      safety: step.safety ?? [],
      tools: step.tools ?? [],
    })),
  }
}

const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as {
  devices: Record<string, { moments: { t: number }[] }>
}

const files = readdirSync(DIR).filter((name) => name.endsWith('.json'))

/* 单条 60s 太紧：S3 细节包（螺栓/压缝/铭牌）后每台设备的网格数明显上升，
   打印态一次要挂 15 张 3D 图，实测单条 **45s** 左右（本地 headless Chromium）。
   CI 更慢，60s 会偶发踩线 → 提到 120s。**这不是放宽判据**：断言一条没改，
   只是给"把 15 张图挂起来"这件事留够时间。 */
test.describe.configure({ timeout: 120_000 })

for (const file of files) {
  const guide = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Guide
  const steps = guide.steps ?? []
  const total = steps.reduce((sum, step) => sum + (step.figures?.length ?? 0), 0)

  test(`渲染 grader：${file}（${steps.length} 步 / ${total} 图）`, async ({ page }) => {
    await page.route(new RegExp(`/api/electro/guides/${guide.id}$`), (route) =>
      route.fulfill({
        json: { status: 'published', guide: normalize(guide), process_id: null, repairs: [] },
      }),
    )

    await page.goto(`./guide/${guide.id}/read`)
    await expect(page.locator('.pager')).toBeVisible()

    // 打印态铺开全部页：一次拿到所有步骤，不用逐页点
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')))
    /* 等页数齐：**显式轮询状态**，预算按 CI 实测给。
       2026-11-17：原来写死 `timeout: 10_000`，hvac 这份（6 步 / 15 图，最重）
       在 CI 上 15.3s 才铺完 → 每轮都红。CI 的 `渲染帧率实测（观测）` 打印
       **最差帧 2417ms**，6 页 × 2.4s ≈ 15s，留 2× 余量取 30s。
       要改这个数，先去看那一步打印的实测值，别凭感觉。 */
    let pageCount = 0
    const pageDeadline = Date.now() + 30_000
    while (Date.now() < pageDeadline) {
      pageCount = await page.locator('.pager__page').count()
      if (pageCount >= steps.length) break
      await page.waitForTimeout(200)
    }
    expect(pageCount, `页数停在 ${pageCount}/${steps.length}（打印态没铺开）`).toBeGreaterThanOrEqual(
      steps.length,
    )

    // 三维/烘焙图是异步 chunk，挂载要几帧；等总数齐了再逐页比，
    // 否则会误报"页面 0 张"（实测：door_clearance 与 door_power_selfcheck 就栽在这）
    /* 这里的用途只是"等挂载完"，**不是**证明图数正确——逐页精确比对在下面（①②）。
       2026-11-16 实测：打印态铺开时 `.figure` 会**短暂多出一张**（页面切换时新旧节点并存），
       用 `toBe(total)` 等就是永远等不到它落回精确值，超时后误报"图没出来"。
       改成 `>=` 之后，多一张/少一张仍会被下面的逐步断言抓住。 */
    /* 等挂载完：**显式循环**而不是 expect.poll。
       2026-11-16 实测：`expect.poll(...).toBeGreaterThanOrEqual(total)` 在计数已经等于 total
       时仍然超时失败（打印出来是"停在 15/15"），换成直白的轮询后稳定通过。
       这里只负责"等够数"，多一张/少一张由下面的逐步断言负责。 */
    let figCount = 0
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      figCount = await page.locator('.figure').count()
      if (figCount >= total) break
      await page.waitForTimeout(200)
    }
    expect(figCount, `图数停在 ${figCount}/${total}（打印态未铺开或图没挂载）`).toBeGreaterThanOrEqual(
      total,
    )

    // ① 逐页比对图数（按 aria-label 的「第 N 步」认页，不靠下标）
    const pages = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.pager__page')).map((el) => {
        const hit = /第\s*(\d+)\s*步/.exec(el.getAttribute('aria-label') ?? '')
        return {
          seq: hit ? Number(hit[1]) : 0,
          figures: el.querySelectorAll('.figure').length,
          fallbacks: el.querySelectorAll('.figure__fallback').length,
        }
      }),
    )

    for (const step of steps) {
      const expected = step.figures?.length ?? 0
      const found = pages.find((p) => p.seq === step.seq)
      expect(found, `第 ${step.seq} 步没渲染出来（容器 aria-label 里没有「第 N 步」）`).toBeTruthy()
      expect(
        found?.figures,
        `第 ${step.seq} 步图数不符：JSON ${expected} 张，页面 ${found?.figures} 张`,
      ).toBe(expected)
      expect(found?.fallbacks, `第 ${step.seq} 步有图走了 fallback`).toBe(0)
    }

    // ② 整页兜底：任何地方都不该出现 fallback
    await expect(page.locator('.figure__fallback')).toHaveCount(0)

    // ③ 横向溢出（手机上最常见：宽表格/长判据把页面撑宽）
    for (const [name, width] of [
      ['手机', 390],
      ['平板', 1024],
    ] as const) {
      await page.setViewportSize({ width, height: 800 })
      const box = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }))
      expect(
        box.scroll,
        `${name}（${width}px）横向溢出：scrollWidth ${box.scroll} > clientWidth ${box.client}`,
      ).toBeLessThanOrEqual(box.client)
    }

    // ④ 三维的 t 必须落在契约瞬间上（JSON 合法但图会停在别的工步）
    for (const step of steps) {
      for (const figure of step.figures ?? []) {
        if (figure.primitive !== 'device_scene') continue
        const subject = String(figure.params?.subject ?? '')
        const device = contract.devices[subject]
        expect(device, `第 ${step.seq} 步 device_scene 用了不存在的设备 ${subject}`).toBeTruthy()
        const t = Number(figure.params?.t)
        const hit = device.moments.some((m) => Math.abs(m.t - t) <= 0.02)
        expect(hit, `第 ${step.seq} 步 device_scene 的 t=${t} 不是 ${subject} 的任何一瞬间`).toBe(true)
      }
    }
  })
}
