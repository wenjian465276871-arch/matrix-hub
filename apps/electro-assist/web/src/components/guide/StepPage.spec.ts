import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import StepPage from './StepPage.vue'
import type { Step, VisualSpec } from '../../types'

/**
 * 步骤页的排版契约。
 *
 * 这一层最要紧的不是"有没有渲染"，而是**图示怎么分栏**：
 * 三维是主图、2D 是辅图；两者永远不同列，所以不可能叠在一起。
 * 上一版挤在一列里，flex 把 2D 压成 26px、三维顶着 min-height 撑破容器，
 * 下一张图就画在三维上（用户 2026-11-10 截图：接线图盖住受电弓）。
 */

function fig(primitive: VisualSpec['primitive'], caption: string): VisualSpec {
  return { primitive, params: {}, caption, fallback_text: `${caption}兜底` }
}

function step(overrides: Partial<Step> = {}): Step {
  return {
    id: 's1',
    seq: 1,
    title: '确认升弓到位信号',
    action: '观察指示灯并记录',
    safety: ['确认接触网已停电'],
    tools: ['手电'],
    criteria: [],
    figures: [],
    assets: [],
    duration_s: 120,
    ...overrides,
  }
}

function mountPage(overrides: Partial<Step> = {}, attach = false) {
  return mount(StepPage, {
    props: { step: step(overrides), total: 5, numbers: {}, status: 'published' as const },
    global: { stubs: { GuideFigure: { template: '<div class="fig-stub" />' } } },
    // 测焦点必须挂进文档：游离 DOM 里 `el.focus()` 不生效，
    // activeElement 永远是 body —— 那是假红，不是组件的问题。
    ...(attach ? { attachTo: document.body } : {}),
  })
}

describe('图示分栏', () => {
  it('三维进主图列，2D 进辅图列，两者不同列', () => {
    const wrapper = mountPage({
      figures: [fig('device_scene', '弓头升弓到位'), fig('wiring', '信号回路'), fig('status_light', '状态指示')],
    })
    const hero = wrapper.findAll('.step__hero > .fig-stub')
    const aid = wrapper.findAll('.step__aid > .fig-stub')
    expect(hero).toHaveLength(1)
    expect(aid).toHaveLength(2)
    // 主图列里不允许出现辅图：那正是叠图的成因
    expect(wrapper.findAll('.step__hero > .fig-stub').length).toBe(1)
    wrapper.unmount()
  })

  it('没有三维时，2D 图示占左栏', () => {
    const wrapper = mountPage({ figures: [fig('checklist', '清单'), fig('meter', '读数')] })
    expect(wrapper.findAll('.step__figures > .fig-stub')).toHaveLength(2)
    expect(wrapper.find('.step__hero').exists()).toBe(false)
    wrapper.unmount()
  })

  it('既无图示也无素材时，明确说明而不是静默留白', () => {
    const wrapper = mountPage()
    expect(wrapper.get('.step__empty-text').text()).toContain('本步暂无可视化图示')
    wrapper.unmount()
  })

  it('只有素材、没有图示时不显示空态提示', () => {
    const wrapper = mountPage({ assets: [{ asset_id: 'a1', caption: '现场照片' }] })
    expect(wrapper.find('.step__empty').exists()).toBe(false)
    expect(wrapper.get('.asset__cap').text()).toContain('现场照片')
    wrapper.unmount()
  })
})

describe('判据与元信息', () => {
  it('按类型渲染判据值，并带上单位', () => {
    const wrapper = mountPage({
      criteria: [
        { id: 'c1', label: '升弓时间', type: 'range', min: 7.5, max: 9.5, unit: 's' },
        { id: 'c2', label: '到位信号', type: 'enum', options: ['正常', '异常'] },
        { id: 'c3', label: '目视', type: 'manual' },
      ],
    })
    const rows = wrapper.findAll('.criterion')
    expect(rows[0].text()).toContain('7.5 ~ 9.5')
    expect(rows[0].text()).toContain('s')
    expect(rows[1].text()).toContain('正常 / 异常')
    expect(rows[2].text()).toContain('人工确认')
    wrapper.unmount()
  })

  it('有 provenance 才出现来源标记，行号 0 基转 1 基', () => {
    const wrapper = mountPage({
      criteria: [
        {
          id: 'c1',
          label: '升弓时间',
          type: 'range',
          min: 7.5,
          max: 9.5,
          unit: 's',
          provenance: { asset_id: null, line: 4, raw_text: '升弓时间 8.5±1.0s', flag: 'suspect' },
        },
        { id: 'c2', label: '目视', type: 'manual' },
      ],
    })
    const marks = wrapper.findAll('.criterion__src')
    expect(marks).toHaveLength(1)
    expect(marks[0].text()).toBe('待核 · 第 5 行')
    expect(marks[0].classes()).toContain('criterion__src--suspect')
    wrapper.unmount()
  })

  it('耗时按分钟向上取整，最低 1 分钟', () => {
    const wrapper = mountPage({ duration_s: 20 })
    expect(wrapper.get('.step__duration').text()).toBe('1 分钟')
    wrapper.unmount()
  })
})

describe('沉浸态（宽而矮的窗口）', () => {
  const original = window.matchMedia

  function stubCompact(matches: boolean): void {
    window.matchMedia = ((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }

  afterEach(() => {
    window.matchMedia = original
  })

  it('命中时切到沉浸态：HUD 出现，动作描述只有一份且搬进抽屉', async () => {
    stubCompact(true)
    const wrapper = mountPage({ figures: [fig('device_scene', '万用表')] })
    await nextTick()

    expect(wrapper.find('.step').classes()).toContain('step--compact')
    expect(wrapper.find('.step__hud').exists()).toBe(true)
    // 判据常驻：它是「做到什么程度算对」，不能每次都翻开抽屉找
    expect(wrapper.find('.step__hud').text()).toContain('本步无判据')

    // 动作描述**只能有一份**：两份就是同一段话在 DOM 里出现两遍，
    // 读屏会念两次，打印会印两次
    expect(wrapper.findAll('.step__action')).toHaveLength(1)
    expect(wrapper.find('.step__side .step__action').exists()).toBe(true)
    wrapper.unmount()
  })

  it('未命中时保持常规布局：没有 HUD，动作描述在标题下', async () => {
    stubCompact(false)
    const wrapper = mountPage({ figures: [fig('device_scene', '万用表')] })
    await nextTick()

    expect(wrapper.find('.step').classes()).not.toContain('step--compact')
    expect(wrapper.find('.step__hud').exists()).toBe(false)
    expect(wrapper.find('.step__action').exists()).toBe(true)
    // 常规布局下动作描述不在 aside 里
    expect(wrapper.find('.step__side .step__action').exists()).toBe(false)
    wrapper.unmount()
  })

  it('抽屉：点按钮开、Esc 关，关闭后焦点回到按钮', async () => {
    stubCompact(true)
    const wrapper = mountPage({ figures: [fig('device_scene', '万用表')] }, true)
    await nextTick()

    const side = () => wrapper.find('.step__side')
    expect(side().classes()).not.toContain('step__side--open')

    await wrapper.find('.step__drawer-btn').trigger('click')
    await nextTick()
    expect(side().classes()).toContain('step__side--open')
    // 焦点要进抽屉：不进的话键盘用户按 Tab 会跑到后面的画布上
    expect(document.activeElement?.className).toContain('step__side')

    await wrapper.find('.step').trigger('keydown', { key: 'Escape' })
    await nextTick()
    expect(side().classes()).not.toContain('step__side--open')
    expect(document.activeElement?.className).toContain('step__drawer-btn')
    wrapper.unmount()
  })
})
