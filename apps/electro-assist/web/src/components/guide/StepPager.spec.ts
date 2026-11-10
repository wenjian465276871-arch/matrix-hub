import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import StepPager from './StepPager.vue'
import PagerNav from './PagerNav.vue'
import { pageLabels } from '../../lib/paging'
import type { Step } from '../../types'

/**
 * 翻页器的行为契约。
 *
 * 要钉住的三件事，都是"错了但页面看起来正常"的那类：
 * 1. **页数**：封面 + 步骤 + 尾页，少算一页就会有一页永远翻不到；
 * 2. **只挂当前页与左右各一页**：多挂 = 多个 WebGL 上下文（浏览器上限 8 个），
 *    少挂 = 滑动时中间是白屏；
 * 3. **跳页**：键盘、圆点、按钮三条路都必须落到同一页。
 *
 * ## 为什么套一层 Host
 * `v-model:current` 的真值在父组件里。直接给 StepPager 传 `current` + 监听
 * `update:current`，在挂载期（onMounted 读回上次位置那一刻）`wrapper` 还没赋值，
 * 更新会丢——测出来的"没记住位置"是测试脚手架的问题，不是组件的问题。
 *
 * 2026-11-10 起翻页控件（‹ 3/9 › + 圆点）拆成 `PagerNav`、由顶栏渲染，
 * 所以 Host 同时挂两者——与真实页面结构一致，否则页码断言测的是不存在的元素。
 */

function step(seq: number): Step {
  return {
    id: `s${seq}`,
    seq,
    title: `第 ${seq} 步标题`,
    action: `第 ${seq} 步动作`,
    safety: [],
    tools: [],
    criteria: [],
    figures: [],
    assets: [],
    duration_s: null,
  }
}

const STEPS = [step(1), step(2), step(3)]

const Host = defineComponent({
  props: {
    tail: { type: Boolean, default: false },
    start: { type: Number, default: 0 },
  },
  setup(props) {
    const current = ref(props.start)
    return { current }
  },
  render() {
    const labels = pageLabels(STEPS, this.tail)
    return h('div', [
      h(PagerNav, {
        current: this.current,
        labels,
        // 与 GuideView 同一条路径：点圆点 → 调 StepPager 的 goTo（含滚动、播报与位置记忆）
        onGo: (index: number) => {
          ;(this.$refs.pager as { goTo?: (i: number) => void } | undefined)?.goTo?.(index)
        },
      }),
      h(
        StepPager,
        {
          ref: 'pager',
          current: this.current,
          'onUpdate:current': (value: number) => {
            this.current = value
          },
          guideId: 'g_test',
          steps: STEPS,
          status: 'published',
          numbers: {},
          tail: this.tail,
        },
        {
          cover: () => h('div', { class: 'cover-probe' }, '封面内容'),
          tail: () => h('div', { class: 'tail-probe' }, '素材内容'),
        },
      ),
    ])
  },
})

function mountHost(props: Record<string, unknown> = {}) {
  return mount(Host, { props })
}

const counter = (wrapper: ReturnType<typeof mountHost>) =>
  wrapper.get('.pager__count').text().replace(/\s+/g, '')

beforeEach(() => {
  sessionStorage.clear()
})

describe('页数与圆点', () => {
  it('没有尾页时 = 封面 + 3 步', () => {
    const wrapper = mountHost()
    expect(counter(wrapper)).toBe('1/4')
    expect(wrapper.findAll('.pager__dot')).toHaveLength(4)
    wrapper.unmount()
  })

  it('有尾页时多一页，尾页渲染插槽内容', async () => {
    const wrapper = mountHost({ tail: true })
    expect(wrapper.findAll('.pager__dot')).toHaveLength(5)
    await wrapper.findAll('.pager__dot')[4].trigger('click')
    expect(counter(wrapper)).toBe('5/5')
    expect(wrapper.find('.tail-probe').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('按需挂载', () => {
  it('初始只渲染封面与第 1 步，第 3 步不渲染', () => {
    const wrapper = mountHost()
    expect(wrapper.find('.cover-probe').exists()).toBe(true)
    // 只看步骤页里的标题：页码下拉的 option 也带步骤名，不能拿整段 text 判断
    const titles = wrapper.findAll('.step__title').map((n) => n.text())
    expect(titles).toEqual(['第 1 步标题'])
    wrapper.unmount()
  })

  it('翻到第 2 步后，第 3 步进入窗口', async () => {
    const wrapper = mountHost()
    await wrapper.findAll('.pager__dot')[2].trigger('click')
    expect(wrapper.findAll('.step__title').map((n) => n.text())).toContain('第 3 步标题')
    wrapper.unmount()
  })
})

describe('跳页的三条路', () => {
  it('点「下一页」/「上一页」按钮', async () => {
    const wrapper = mountHost()
    await wrapper.get('button[aria-label="下一页"]').trigger('click')
    expect(counter(wrapper)).toBe('2/4')
    await wrapper.get('button[aria-label="上一页"]').trigger('click')
    expect(counter(wrapper)).toBe('1/4')
    wrapper.unmount()
  })

  it('键盘 → / ← 与 Home / End', async () => {
    const wrapper = mountHost()
    const track = wrapper.get('.pager__track')
    await track.trigger('keydown', { key: 'ArrowRight' })
    expect(counter(wrapper)).toBe('2/4')
    await track.trigger('keydown', { key: 'End' })
    expect(counter(wrapper)).toBe('4/4')
    await track.trigger('keydown', { key: 'ArrowLeft' })
    expect(counter(wrapper)).toBe('3/4')
    await track.trigger('keydown', { key: 'Home' })
    expect(counter(wrapper)).toBe('1/4')
    wrapper.unmount()
  })

  it('点圆点跳页，并把当前页写进 sessionStorage', async () => {
    const wrapper = mountHost()
    await wrapper.findAll('.pager__dot')[2].trigger('click')
    expect(counter(wrapper)).toBe('3/4')
    expect(sessionStorage.getItem('electro:guide-page:g_test')).toBe('2')
    wrapper.unmount()
  })

  it('第一页时「上一页」禁用，最后一页时「下一页」禁用', async () => {
    const wrapper = mountHost()
    expect(wrapper.get('button[aria-label="上一页"]').attributes('disabled')).toBeDefined()
    await wrapper.findAll('.pager__dot')[3].trigger('click')
    expect(wrapper.get('button[aria-label="下一页"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
})

describe('位置记忆', () => {
  it('挂载时读回上次位置', async () => {
    sessionStorage.setItem('electro:guide-page:g_test', '2')
    const wrapper = mountHost()
    await nextTick()
    expect(counter(wrapper)).toBe('3/4')
    expect(wrapper.findAll('.step__title').map((n) => n.text())).toContain('第 2 步标题')
    wrapper.unmount()
  })

  it('存的值超出页数时夹到最后一页', async () => {
    sessionStorage.setItem('electro:guide-page:g_test', '99')
    const wrapper = mountHost()
    await nextTick()
    expect(counter(wrapper)).toBe('4/4')
    expect(wrapper.findAll('.step__title').map((n) => n.text())).toContain('第 3 步标题')
    wrapper.unmount()
  })
})

describe('打印', () => {
  it('preparePrint 之后所有页内容都渲染出来', async () => {
    vi.useFakeTimers()
    const wrapper = mountHost()
    const ready = wrapper.findComponent(StepPager).vm.preparePrint()
    await nextTick()
    await vi.advanceTimersByTimeAsync(1000)
    await ready
    expect(wrapper.findAll('.step__title').map((n) => n.text())).toContain('第 3 步标题')
    expect(wrapper.find('.pager').classes()).toContain('pager--print')
    vi.useRealTimers()
    wrapper.unmount()
  })
})
