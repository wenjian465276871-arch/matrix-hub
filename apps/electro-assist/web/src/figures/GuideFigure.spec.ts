import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import GuideFigure from './GuideFigure.vue'
import type { VisualSpec } from '../types'

/**
 * 实物渲染图（baked_figure）的"放大看"（2026-11-11 本人明确要求）：
 * 舞台里的图再大也只有 850px 宽，看不清碳滑板厚度与压力表读数，
 * 所以必须能像三维那样整屏看原分辨率。
 *
 * 锁三件事：按钮在、点开有层、Esc 关得掉。焦点归还由 openZoom/closeZoom 负责，
 * happy-dom 里 focus 行为不稳定，这里不牵进来（真实浏览器由 E2E 覆盖）。
 */

const spec: VisualSpec = {
  primitive: 'baked_figure',
  params: { src: '/figures/pantograph/step2.webp', alt: '弓头与碳滑板' },
  caption: '弓头与碳滑板',
  fallback_text: '弓头与碳滑板（图）',
} as unknown as VisualSpec

describe('GuideFigure 烘焙图放大', () => {
  it('默认就给出「放大看」，不等横屏短高', () => {
    const wrapper = mount(GuideFigure, { props: { spec } })
    const btn = wrapper.get('.figure__zoom')
    expect(btn.text()).toBe('放大看')
    wrapper.unmount()
  })

  it('点开后出现整页层，图片沿用同一份 src', async () => {
    const wrapper = mount(GuideFigure, { props: { spec } })
    await wrapper.get('.figure__zoom').trigger('click')

    const layer = wrapper.get('.figure__zoom-layer')
    expect(layer.classes()).toContain('figure__zoom-layer--baked')
    expect(layer.attributes('aria-modal')).toBe('true')
    expect(wrapper.get('.zoom-frame__body img').attributes('src')).toContain('/figures/pantograph/step2.webp')
    // 层里的标题就是图注，用户一眼知道自己在看哪张图
    expect(wrapper.get('.zoom-frame__label').text()).toBe('弓头与碳滑板')
    wrapper.unmount()
  })

  it('Esc 关闭（按键盘的手不用去找关闭按钮）', async () => {
    const wrapper = mount(GuideFigure, { props: { spec } })
    await wrapper.get('.figure__zoom').trigger('click')
    await wrapper.get('.figure__zoom-layer').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.figure__zoom-layer').exists()).toBe(false)
    wrapper.unmount()
  })
})
