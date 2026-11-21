import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GuideList, GuideSummary } from '../types'

/**
 * LibraryView（已发布指导书列表）的行为测试。之前是 0 覆盖。
 *
 * 这页看着简单，但有两个容易改坏的点：
 * 1. **搜索防抖**：清空要立刻生效、打字要等 250ms。搞反了是"每敲一个字打一次接口"，
 *    或者"清空后还显示旧结果"。
 * 2. **加载更多失败不能把已看到的列表换成错误页**——用户已经在读第三页了，
 *    一个翻页失败就清空屏幕是最糟的处理。
 */

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  announce: vi.fn(),
}))

vi.mock('../lib/http', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public kind: string,
      public status?: number,
      public code?: string,
      message?: string,
      public ref?: string,
      public retryAfter?: number,
    ) {
      super(message ?? code ?? kind)
      this.name = 'ApiError'
    }
  },
  getJson: mocks.getJson,
}))
vi.mock('../lib/announce', () => ({ announce: mocks.announce }))

import LibraryView from './LibraryView.vue'
import { ApiError } from '../lib/http'

function item(over: Partial<GuideSummary> = {}): GuideSummary {
  return {
    id: 'g1',
    title: '客室侧门开关门功能试验',
    summary: '检查门锁闭合与指示灯',
    system: 'door',
    step_count: 5,
    estimated_s: 300,
    ...over,
  } as GuideSummary
}

function page(items: GuideSummary[], total = items.length, hasMore = false): GuideList {
  return { items, total, has_more: hasMore } as GuideList
}

function mountView() {
  return mount(LibraryView, {
    global: {
      // RouterLink 必须渲染 slot：默认的 `true` stub 是空标签，
      // 卡片标题与摘要会整个消失，测出来的只是空壳。
      // `data-to` 把目标 route 也带出来——首屏主按钮指向哪一份是行为，不是样式。
      stubs: { RouterLink: { props: ['to'], template: '<a :data-to="JSON.stringify(to)"><slot /></a>' } },
    },
  })
}

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset())
  window.history.replaceState(null, '', '/apps/electro-assist/')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('LibraryView 列表渲染', () => {
  it('渲染标题、子系统中文名、步数与估算时长', async () => {
    mocks.getJson.mockResolvedValue(page([item()]))
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('客室侧门开关门功能试验')
    expect(wrapper.text()).toContain('车门')
    expect(wrapper.text()).toContain('5 步')
    // 300 秒要显示成"约 5 分钟"，不摊秒数
    expect(wrapper.text()).toContain('约 5 分钟')
    expect(wrapper.text()).toContain('已全部显示（共 1 份）')
    wrapper.unmount()
  })

  it('空列表给出下一步动作，不是一句"暂无数据"', async () => {
    mocks.getJson.mockResolvedValue(page([]))
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('还没有已发布的指导书')
    wrapper.unmount()
  })

  it('服务错误带状态码，排查时 503 和 500 意义不同', async () => {
    mocks.getJson.mockRejectedValue(new ApiError('server', 503, 'unavailable'))
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('服务暂不可用（503）')
    wrapper.unmount()
  })
})

describe('LibraryView 首屏入口（2026-11-21）', () => {
  it('旗舰样例在库里时，主按钮指向它，且全页只有一颗主按钮', async () => {
    mocks.getJson.mockResolvedValue(
      page([
        item({ id: 'g_other', title: '别的一份' }),
        item({ id: 'g_door_switch_desk', title: '客室车门开关门试验（司机室操纵台操作）' }),
      ]),
    )
    const wrapper = mountView()
    await flushPromises()

    const start = wrapper.find('.lib__start')
    expect(start.exists()).toBe(true)
    expect(start.text()).toBe('从车门开始看 →')
    expect(start.attributes('data-to')).toContain('g_door_switch_desk')
    // 首屏只能有一颗主按钮：生成那颗 2026-11-21 降级成次级了
    expect(wrapper.findAll('.btn--primary')).toHaveLength(1)
    wrapper.unmount()
  })

  it('旗舰样例下架了就退回第一条，文案跟着实际落点走', async () => {
    mocks.getJson.mockResolvedValue(
      page([item({ id: 'g_hvac_cooling_check', system: 'hvac', title: '客室空调机组制冷功能检查' })]),
    )
    const wrapper = mountView()
    await flushPromises()

    const start = wrapper.find('.lib__start')
    expect(start.text()).toBe('从空调开始看 →')
    expect(start.attributes('data-to')).toContain('g_hvac_cooling_check')
    wrapper.unmount()
  })

  it('列表为空时不渲染主按钮——不造一条点进去是空的死链', async () => {
    mocks.getJson.mockResolvedValue(page([]))
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.find('.lib__start').exists()).toBe(false)
    wrapper.unmount()
  })

  it('首屏配图拼 BASE_URL，且必须有 alt', async () => {
    // 用探针值而不是真值：写 `/apps/electro-assist/` 断言时，代码里写死同一个字符串
    // 也能过。换成 /probe-base/ 才能证明它真的读了 env（同 bakedfigure.spec 的做法）。
    vi.stubEnv('BASE_URL', '/probe-base/')
    mocks.getJson.mockResolvedValue(page([item()]))
    const wrapper = mountView()
    await flushPromises()

    const img = wrapper.find('.lib__hero img')
    expect(img.exists()).toBe(true)
    // 写死 `/figures/...` 在本地 dev 能看、线上必 404（站点挂在 /apps/electro-assist/ 下）。
    // 这类错只有部署后才暴露，所以钉在单测里。
    expect(img.attributes('src')).toBe('/probe-base/figures/door/leaf-half-open.webp')
    expect(img.attributes('alt')).toBeTruthy()
    wrapper.unmount()
  })
})

describe('LibraryView 搜索', () => {
  it('打字只触发一次请求（250ms 防抖）', async () => {
    vi.useFakeTimers()
    mocks.getJson.mockResolvedValue(page([item()]))
    const wrapper = mountView()
    await flushPromises()
    mocks.getJson.mockClear()

    await wrapper.find('#guide-search').setValue('门')
    await wrapper.find('#guide-search').setValue('门锁')
    await wrapper.find('#guide-search').setValue('门锁间隙')
    await flushPromises()

    // 还没到 250ms：一个字都不该发出去
    expect(mocks.getJson).not.toHaveBeenCalled()

    vi.advanceTimersByTime(300)
    await flushPromises()

    expect(mocks.getJson).toHaveBeenCalledTimes(1)
    expect(String(mocks.getJson.mock.calls[0]![0])).toContain('q=%E9%97%A8%E9%94%81')
    wrapper.unmount()
  })

  it('清空搜索立即生效，不等防抖', async () => {
    vi.useFakeTimers()
    mocks.getJson.mockResolvedValue(page([item()]))
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('#guide-search').setValue('门锁')
    vi.advanceTimersByTime(300)
    await flushPromises()
    mocks.getJson.mockClear()

    await wrapper.find('#guide-search').setValue('')
    await flushPromises()

    // 按 Esc 或点 × 之后应该立刻恢复全部，不能再等 250ms
    expect(mocks.getJson).toHaveBeenCalledTimes(1)
    expect(String(mocks.getJson.mock.calls[0]![0])).not.toContain('q=')
    wrapper.unmount()
  })

  it('搜索无结果时给出「没有匹配」并保留清空入口', async () => {
    vi.useFakeTimers()
    mocks.getJson.mockResolvedValueOnce(page([item()]))
    const wrapper = mountView()
    await flushPromises()

    mocks.getJson.mockResolvedValueOnce(page([]))
    await wrapper.find('#guide-search').setValue('不存在的工序')
    vi.advanceTimersByTime(300)
    await flushPromises()

    expect(wrapper.text()).toContain('没有匹配「不存在的工序」')
    expect(wrapper.text()).toContain('清空搜索')
    wrapper.unmount()
  })
})

describe('LibraryView 加载更多', () => {
  it('点「加载更多」追加到列表，按 id 去重', async () => {
    mocks.getJson.mockResolvedValueOnce(page([item()], 2, true))
    const wrapper = mountView()
    await flushPromises()

    // 服务端把第一份又给了一次（翻页偏移错位的真实情况）
    mocks.getJson.mockResolvedValueOnce(page([item(), item({ id: 'g2', title: '空调制冷试验' })], 2, false))
    const more = wrapper.findAll('button').find((b) => b.text().includes('加载更多'))
    await more!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('空调制冷试验')
    // 同一份不能出现两次
    expect(wrapper.text().split('客室侧门开关门功能试验').length - 1).toBe(1)
    expect(wrapper.text()).toContain('已全部显示（共 2 份）')
    wrapper.unmount()
  })

  it('加载更多失败时保留已有列表，只提示重试', async () => {
    mocks.getJson.mockResolvedValueOnce(page([item()], 2, true))
    const wrapper = mountView()
    await flushPromises()

    mocks.getJson.mockRejectedValueOnce(new ApiError('server', 500, 'boom'))
    const more = wrapper.findAll('button').find((b) => b.text().includes('加载更多'))
    await more!.trigger('click')
    await flushPromises()

    // 关键：不能在用户读到一半时把列表换成错误页
    expect(wrapper.text()).toContain('客室侧门开关门功能试验')
    expect(wrapper.text()).toContain('加载更多失败，请重试')
    wrapper.unmount()
  })
})

describe('LibraryView 从 URL 恢复', () => {
  it('URL 带 q 时预填搜索框并直接带上查询', async () => {
    window.history.replaceState(null, '', '/apps/electro-assist/?q=%E9%97%A8%E9%94%81')
    mocks.getJson.mockResolvedValue(page([item()]))
    const wrapper = mountView()
    await flushPromises()

    expect((wrapper.find('#guide-search').element as HTMLInputElement).value).toBe('门锁')
    expect(String(mocks.getJson.mock.calls[0]![0])).toContain('q=')
    wrapper.unmount()
  })
})
