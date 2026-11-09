/** 演示页的交互逻辑（`DeviceDemoView.vue`）。
 *
 * 这一页以前是 0 覆盖：它挂 `DeviceScene`，而后者要 WebGL。但**真正会出错的不是
 * 渲染**，是这些点击行为——切场景没重置时间轴、暂停后还在跑、剖切按钮点了没反应。
 * 所以把子组件换成 stub，测脚本这一层。
 *
 * rAF 也换成可控队列：不 stub 的话"播放"会真的启动一个 4.6 秒的动画，测试变成
 * 等待，且结果依赖机器速度。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, onMounted } from 'vue'

// 子组件 stub：只声明 props/emits 并回报"本设备可剖切"，不碰 three。
vi.mock('../figures/DeviceScene.vue', () => ({
  default: defineComponent({
    name: 'DeviceScene',
    props: ['subject', 't', 'focus', 'label', 'cut', 'cutAt'],
    emits: ['cutable'],
    setup(_props, { emit }) {
      onMounted(() => emit('cutable', true))
      return () => h('div', { class: 'scene-stub' })
    },
  }),
}))

import DeviceDemoView from './DeviceDemoView.vue'

/** 手动驱动的动画帧队列：测试自己决定"过了多久"。 */
let frames: FrameRequestCallback[] = []

beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames = []
  })
})

const mountView = () => mount(DeviceDemoView, { attachTo: document.body })

const percentText = (wrapper: ReturnType<typeof mountView>): string =>
  wrapper.find('.demo__slider-label').text()

const seekTo = async (wrapper: ReturnType<typeof mountView>, value: number): Promise<void> => {
  const input = wrapper.find('.demo__controls input[type="range"]')
  await input.setValue(String(value))
}

describe('时间轴', () => {
  it('拖动滑块改变进度，读数跟着走', async () => {
    const wrapper = mountView()
    await flushPromises()

    await seekTo(wrapper, 800)
    expect(percentText(wrapper)).toContain('时间轴 80%')
    // 80% 处门已滑到底：行程是上限值，说明读数与三维同一时刻
    expect(wrapper.text()).toContain('660')

    wrapper.unmount()
  })

  it('播放 → 帧推进 → 暂停，按钮文案随之切换', async () => {
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('.demo__play').trigger('click')
    expect(wrapper.find('.demo__play').text()).toBe('暂停')
    expect(frames.length).toBeGreaterThan(0)

    // 手动喂一帧：模拟过了 1 秒（全程 4.6 秒）。不依赖真实时钟。
    const cb = frames.shift()
    expect(cb).toBeTypeOf('function')
    cb?.(performance.now() + 1000)
    // 手动调帧不在 Vue 的事件循环里，DOM 不会自动更新——必须显式等一拍。
    await nextTick()

    const percent = Number(percentText(wrapper).replace(/\D/g, ''))
    expect(percent).toBeGreaterThan(18)
    expect(percent).toBeLessThan(26)

    await wrapper.find('.demo__play').trigger('click')
    expect(wrapper.find('.demo__play').text()).toBe('播放动作')
    // 暂停后不再排队新帧
    expect(frames).toHaveLength(0)

    wrapper.unmount()
  })

  it('播到末尾再点播放，从头开始', async () => {
    const wrapper = mountView()
    await flushPromises()

    await seekTo(wrapper, 1000)
    expect(percentText(wrapper)).toContain('时间轴 100%')

    await wrapper.find('.demo__play').trigger('click')
    // 从 100% 直接播会"一帧都不动"，所以必须回绕到 0
    expect(percentText(wrapper)).toContain('时间轴 0%')

    await wrapper.find('.demo__play').trigger('click') // 停掉，避免残留 rAF
    wrapper.unmount()
  })

  it('复位把进度清零并停下来', async () => {
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('.demo__play').trigger('click')
    await seekTo(wrapper, 500)
    const reset = wrapper.findAll('button').find((b) => b.text() === '复位')
    await reset?.trigger('click')

    expect(percentText(wrapper)).toContain('时间轴 0%')
    expect(wrapper.find('.demo__play').text()).toBe('播放动作')

    wrapper.unmount()
  })
})

describe('场景切换', () => {
  it('切到另一台设备：时间轴归零、高亮清空', async () => {
    const wrapper = mountView()
    await flushPromises()

    await seekTo(wrapper, 600)
    // 先在车门上点亮一个部件，验证切场景会清掉它
    const chip = wrapper.findAll('.demo__chip')[0]
    await chip.trigger('click')
    expect(chip.attributes('aria-pressed')).toBe('true')

    await wrapper.findAll('[role="tab"]')[1].trigger('click')
    expect(percentText(wrapper)).toContain('时间轴 0%')
    // 受电弓的部件表里没有"左门扇"，切场景后按钮组必须换掉
    expect(wrapper.text()).toContain('弓头')
    expect(wrapper.text()).not.toContain('左门扇')

    wrapper.unmount()
  })

  it('点当前场景不做任何事（不重置进度）', async () => {
    const wrapper = mountView()
    await flushPromises()

    await seekTo(wrapper, 400)
    await wrapper.findAll('[role="tab"]')[0].trigger('click')
    expect(percentText(wrapper)).toContain('时间轴 40%')

    wrapper.unmount()
  })
})

describe('部件高亮与剖切', () => {
  it('点部件芯片切换高亮，再点取消', async () => {
    const wrapper = mountView()
    await flushPromises()

    const chip = wrapper.findAll('.demo__chip')[1]
    await chip.trigger('click')
    expect(chip.attributes('aria-pressed')).toBe('true')
    await chip.trigger('click')
    expect(chip.attributes('aria-pressed')).toBe('false')

    wrapper.unmount()
  })

  it('设备声明可剖切时按钮出现，点击后出现切面滑块', async () => {
    const wrapper = mountView()
    await flushPromises()

    const open = wrapper.findAll('button').find((b) => b.text() === '剖开看内部')
    expect(open, '可剖切时应有「剖开看内部」按钮').toBeTruthy()
    await open?.trigger('click')

    const close = wrapper.findAll('button').find((b) => b.text() === '关闭剖切')
    expect(close?.attributes('aria-pressed')).toBe('true')
    expect(wrapper.text()).toContain('切面位置')

    // 切面滑块独立于时间轴：拖它不能改变动作进度
    const cutSlider = wrapper.findAll('.demo__controls--cut input[type="range"]')[0]
    await cutSlider.setValue('300')
    expect(wrapper.text()).toContain('切面位置 30%')

    wrapper.unmount()
  })

  it('切场景会关掉剖切（新设备不一定支持）', async () => {
    const wrapper = mountView()
    await flushPromises()

    const open = wrapper.findAll('button').find((b) => b.text() === '剖开看内部')
    await open?.trigger('click')

    await wrapper.findAll('[role="tab"]')[1].trigger('click')
    // stub 每次挂载都回报 cutable=true，所以按钮会在；关键是状态已被重置为"未剖切"
    const openAgain = wrapper.findAll('button').find((b) => b.text() === '剖开看内部')
    expect(openAgain?.attributes('aria-pressed')).toBe('false')

    wrapper.unmount()
  })
})

describe('工艺文本区', () => {
  it('每台设备的判据都渲染出来，且标注了演示虚构值', async () => {
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('锁闭信号丢失后才允许动门')
    expect(wrapper.text()).toContain('演示虚构值')

    await wrapper.findAll('[role="tab"]')[1].trigger('click')
    expect(wrapper.text()).toContain('升弓时间 8.5 ± 1.0 s')

    wrapper.unmount()
  })
})
