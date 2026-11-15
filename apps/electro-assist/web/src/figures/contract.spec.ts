/** 原语契约（R24-7）：demo 与期望都由后端导出，这里只负责**验**，不手抄。
 *
 * ## 两段，边界不同
 *
 * A. **参数层（5 个原语全查）**：demo 里的设备键 / 瞬间 / 场景 / view / act 必须能在
 *    `devices.json` 里找到。三维与作业台在 happy-dom 里渲染不出来（要 WebGL），
 *    但它们最容易出错的地方恰恰是**参数编错**——`t` 写成一个不存在的瞬间，
 *    图上停在别的工步，而 schema 完全合法。这一段就能抓住它。
 *
 * B. **渲染层（能渲染的 3 个）**：`table` / `meter` / `mon_panel` 真挂载，
 *    断言"参数里的文本出现在产物里"，并统一断言 `.figure__fallback` 不存在。
 *
 *    **为什么不用 fallback 文案做 `absent` 断言**：实测发现 `fallback_text` 同时被
 *    当成图的**无障碍标签**传下去，正常渲染时它也在 DOM 里（`table` 只把它当 label 不显示，
 *    `meter` 会显示成标题）。所以"文本里有没有它"判断不了降级——只有 `.figure__fallback`
 *    这个结构标记能。`absent` 这种期望类型保留着，但别拿它测 fallback。
 *
 * 三维与作业台的**真浏览器**渲染由 E2E 渲染 grader 负责（`tests/e2e/render-grader.spec.ts`），
 * 这里不假装能测。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import contract from '../contract/primitives.json'
import devices from '../contract/devices.json'
import GuideFigure from './GuideFigure.vue'
import type { VisualSpec } from '../types'

interface Expectation {
  kind: 'text' | 'absent' | 'node'
  value?: string
  selector?: string
  min?: number
}

const PRIMITIVES = (contract as unknown as {
  primitives: Record<string, { demo: VisualSpec; expectations: Expectation[] }>
}).primitives

const DEVICES = (devices as unknown as {
  devices: Record<string, { moments: { key: string; t: number }[] }>
  scenes: Record<string, { mon_tabs: string[]; mon_modes: string[]; ops_acts: string[]; ops_views: string[] }>
}).devices

const SCENES = (devices as unknown as {
  scenes: Record<string, { mon_tabs: string[]; mon_modes: string[]; ops_acts: string[]; ops_views: string[] }>
}).scenes

/** 场景类原语在 happy-dom 里渲染不出来，只走参数层。 */
const NEEDS_BROWSER = new Set(['device_scene', 'operation_scene'])

describe('原语契约：参数必须对得上设备/场景枚举', () => {
  it('契约里至少有那 5 个高风险原语', () => {
    for (const name of ['device_scene', 'mon_panel', 'operation_scene', 'meter', 'table']) {
      expect(Object.keys(PRIMITIVES), `缺 ${name} 的契约`).toContain(name)
    }
  })

  it.each(Object.keys(PRIMITIVES))('%s：demo 参数合法', (name) => {
    const params = (PRIMITIVES[name].demo.params ?? {}) as Record<string, unknown>

    if (name === 'device_scene') {
      const subject = String(params.subject)
      const device = DEVICES[subject]
      expect(device, `设备 ${subject} 不在契约里`).toBeTruthy()
      const t = Number(params.t)
      // ±0.02 是后端 prompt 里写死的容差；这里用同一口径
      const hit = device.moments.some((m) => Math.abs(m.t - t) <= 0.02)
      expect(hit, `t=${t} 不是 ${subject} 的任何一瞬间`).toBe(true)
    }

    if (name === 'mon_panel' || name === 'operation_scene') {
      const scene = SCENES[String(params.scene)]
      expect(scene, `场景 ${String(params.scene)} 不在契约里`).toBeTruthy()
      if (params.tab !== undefined) expect(scene.mon_tabs).toContain(params.tab)
      if (params.mode !== undefined) expect(scene.mon_modes).toContain(params.mode)
      if (params.view !== undefined) expect(scene.ops_views).toContain(params.view)
      if (params.act !== undefined) expect(scene.ops_acts).toContain(params.act)
    }

    if (name === 'table') {
      const headers = params.headers as string[]
      const rows = params.rows as string[]
      expect(headers.length).toBeGreaterThanOrEqual(2)
      for (const row of rows) {
        expect(row.split('|').length, `行「${row}」格数与表头不一致`).toBe(headers.length)
      }
    }

    if (name === 'meter') {
      expect(Number(params.max)).toBeGreaterThan(Number(params.min))
    }
  })
})

describe('原语契约：渲染层断言', () => {
  const renderable = Object.keys(PRIMITIVES).filter((name) => !NEEDS_BROWSER.has(name))

  it.each(renderable)('%s：文本出现、fallback 不出现', (name) => {
    const { demo, expectations } = PRIMITIVES[name]
    const wrapper = mount(GuideFigure, { props: { spec: demo } })
    const text = wrapper.text()

    for (const item of expectations) {
      if (item.kind === 'text') {
        expect(text, `期望出现的文本没出现：${item.value}`).toContain(item.value)
      }
      if (item.kind === 'absent') {
        expect(text, `不该出现的文本出现了：${item.value}`).not.toContain(item.value)
      }
      if (item.kind === 'node') {
        const found = wrapper.findAll(item.selector ?? '').length
        expect(found, `期望至少 ${item.min ?? 1} 个 ${item.selector}，实际 ${found}`)
          .toBeGreaterThanOrEqual(item.min ?? 1)
      }
    }

    // 渲染层统一兜底：任何原语都不该落到 fallback 分支
    expect(wrapper.find('.figure__fallback').exists()).toBe(false)
    wrapper.unmount()
  })
})
