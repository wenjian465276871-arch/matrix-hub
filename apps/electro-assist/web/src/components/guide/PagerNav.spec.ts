import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PagerNav from './PagerNav.vue'

/**
 * 翻页控件的契约。
 *
 * 它是纯展示组件：只认 `current` 与 `labels`，只发 `go`。所以这里钉的三件事
 * 都不涉及滚动或路由——那些在 `StepPager.spec.ts` 里。
 *
 * 为什么值得单独测：上一版这套控件和阅读器绑在一起，边界（第一页禁用「上一页」、
 * 最后一页禁用「下一页」）只能靠翻整份指导书才能碰到；现在一次 mount 就能覆盖。
 */

const LABELS = ['封面', '第 1 步：挂牌', '第 2 步：测量']

function mountNav(current = 1) {
  return mount(PagerNav, { props: { current, labels: LABELS } })
}

describe('页码与按钮', () => {
  it('显示「当前 / 总数」，1 基', () => {
    const wrapper = mountNav(1)
    expect(wrapper.get('.pager__count').text().replace(/\s+/g, '')).toBe('2/3')
    wrapper.unmount()
  })

  it('第一页禁用「上一页」，最后一页禁用「下一页」', () => {
    const first = mountNav(0)
    expect(first.get('button[aria-label="上一页"]').attributes('disabled')).toBeDefined()
    expect(first.get('button[aria-label="下一页"]').attributes('disabled')).toBeUndefined()
    first.unmount()

    const last = mountNav(2)
    expect(last.get('button[aria-label="下一页"]').attributes('disabled')).toBeDefined()
    expect(last.get('button[aria-label="上一页"]').attributes('disabled')).toBeUndefined()
    last.unmount()
  })
})

describe('跳页事件', () => {
  it('点上/下页发相邻页号', async () => {
    const wrapper = mountNav(1)
    await wrapper.get('button[aria-label="下一页"]').trigger('click')
    await wrapper.get('button[aria-label="上一页"]').trigger('click')
    expect(wrapper.emitted('go')).toEqual([[2], [0]])
    wrapper.unmount()
  })

  it('点圆点发对应页号，当前页带 aria-current', async () => {
    const wrapper = mountNav(1)
    const dots = wrapper.findAll('.pager__dot')
    expect(dots).toHaveLength(3)
    await dots[2].trigger('click')
    expect(wrapper.emitted('go')?.[0]).toEqual([2])
    expect(dots[1].attributes('aria-current')).toBe('page')
    expect(dots[0].attributes('aria-current')).toBeUndefined()
    wrapper.unmount()
  })

  it('圆点的读屏名称就是页名，不是"第 N 个点"', () => {
    const wrapper = mountNav(0)
    expect(wrapper.findAll('.pager__dot')[1].attributes('aria-label')).toBe('第 1 步：挂牌')
    wrapper.unmount()
  })
})
