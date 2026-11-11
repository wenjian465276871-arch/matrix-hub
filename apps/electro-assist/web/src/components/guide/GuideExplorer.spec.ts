import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import GuideExplorer from './GuideExplorer.vue'
import { resetTopBar, useTopBar } from '../../composables/useTopBar'
import type { Guide, Step } from '../../types'

/**
 * 探索台现在是**指导书的默认版式**（2026-11-11 本人裁决）：
 * `/guide/:id` 直接进这里，不再有"点阅读进度才进得来"的切换。
 *
 * 本文件只锁三件容易改坏、改坏了还不报错的事：
 * 1. 顶栏投稿——页面自己不再画头，投稿丢了整条顶栏就是空的；
 * 2. 卸载复位——不复位的话回到作业库还挂着上一本书的书名；
 * 3. 轨迹折叠开关的文案与 aria-expanded（它是"图更大"的唯一入口）。
 */

function step(seq: number, title: string): Step {
  return {
    id: `s${seq}`,
    seq,
    title,
    action: `${title}的动作`,
    tools: ['万用表'],
    duration_s: 120,
    safety: ['断电'],
    criteria: [
      {
        id: `c${seq}`,
        label: `${title}的判据`,
        kind: 'range',
        min: 5,
        max: 8,
        unit: 's',
        target: null,
        tolerance: null,
        provenance: null,
        expected: null,
      },
    ],
    figures: [],
    assets: [],
  } as unknown as Step
}

const guide: Guide = {
  schema_version: '1.2',
  id: 'g_test',
  title: '受电弓升弓功能检查',
  summary: '测试用摘要',
  meta: {
    system: 'pantograph',
    station: 'T1',
    source_note: '公开资料',
    generated_at: '2026-11-11T10:00:00+08:00',
    model: 'deepseek-flash',
  },
  steps: [step(1, '作业准备'), step(2, '检查弓头')],
  assets: [],
  disclaimers: ['演示数据'],
} as unknown as Guide

function mountExplorer() {
  return mount(GuideExplorer, {
    props: { guide, page: 1, assetNumbers: {}, actions: [{ label: '开始作业', onClick: () => {} }] },
    global: { stubs: { GuideFigure: true, RouterLink: true } },
  })
}

afterEach(() => resetTopBar())

describe('GuideExplorer 顶栏投稿', () => {
  it('把书名、进度与动作交给全站顶栏', () => {
    const wrapper = mountExplorer()
    const bar = useTopBar()

    expect(bar.title).toBe('受电弓升弓功能检查')
    expect(bar.kicker).toBe('正在查看')
    // page 是 0 起的下标，顶栏显示的是 1 起的页码
    expect(bar.progress).toEqual({ label: '阅读进度', value: 2, total: 2 })
    expect(bar.actions[0]?.label).toBe('开始作业')
    wrapper.unmount()
  })

  it('卸载时复位顶栏，不让书名粘到别的页面', () => {
    const wrapper = mountExplorer()
    wrapper.unmount()
    expect(useTopBar().title).toBe('')
    expect(useTopBar().progress).toBeNull()
  })
})

describe('GuideExplorer 轨迹折叠', () => {
  it('折叠开关带 aria-expanded，并在两种文案之间切换', async () => {
    const wrapper = mountExplorer()
    const toggle = wrapper.get('.trace-toggle')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(toggle.text()).toContain('收起')

    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(toggle.text()).toContain('展开')
    expect(wrapper.get('.ex__grid').classes()).toContain('trace-collapsed')
    wrapper.unmount()
  })
})
