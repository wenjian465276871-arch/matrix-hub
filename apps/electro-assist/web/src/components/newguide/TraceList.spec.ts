import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import TraceList from './TraceList.vue'
import type { ExtractResult, ExtractedStep, TraceRef } from '../../types'

function trace(flag: TraceRef['flag'], line: number | null, text = '第 2 行原文：开关门各 3 次'): TraceRef {
  return { line, text: flag === 'unverified' ? null : text, flag }
}

function step(overrides: Partial<ExtractedStep> = {}): ExtractedStep {
  return {
    seq: 1,
    action: '开关门各 3 次，开门时间 2.0–3.5s',
    criterion: '2.0–3.5s',
    criterion_trace: trace('ok', 2),
    source_line: 2,
    trace: trace('ok', 2),
    verified: true,
    ...overrides,
  }
}

function result(steps: ExtractedStep[], located = 1): ExtractResult {
  return {
    lines: ['工序：客室侧门开关门功能试验', '工位：3 号车门', '开关门各 3 次，开门时间 2.0–3.5s'],
    fields: { name: '客室侧门开关门功能试验', station: '3 号车门', tools: [], safety: [], steps },
    warnings: [],
    unverified: [],
    needs_review: true,
    stats: { lines: 3, steps: steps.length, verified_steps: steps.length, located_steps: located },
    channels: {
      mode: 'dual',
      fallback: null,
      calls: 2,
      model: 'stub',
      latency_ms: 1000,
    },
    disclaimer: '识别结果仅供录入',
  }
}

describe('TraceList', () => {
  it('行号按 1 基显示：内部 0 基的第 2 行给人看是「第 3 行」', () => {
    const wrapper = mount(TraceList, { props: { result: result([step()]) } })
    const chip = wrapper.get('.trace__chip--ok')
    expect(chip.text()).toContain('第 3 行')
  })

  it('统计只报 located_steps，不拿 verified_steps 冒充', () => {
    const wrapper = mount(TraceList, {
      props: { result: result([step(), step({ seq: 2 })], 1) },
    })
    expect(wrapper.get('.trace__stat').text()).toContain('2 步中 1 步能指回原文具体行')
  })

  it('点 chip 展开那一行原文，再点收起', async () => {
    const wrapper = mount(TraceList, { props: { result: result([step()]) } })
    const chip = wrapper.get('.trace__chip--ok')
    expect(wrapper.find('.trace__source').exists()).toBe(false)
    await chip.trigger('click')
    expect(wrapper.get('.trace__source-text').text()).toContain('第 2 行原文')
    expect(chip.attributes('aria-expanded')).toBe('true')
    await chip.trigger('click')
    expect(wrapper.find('.trace__source').exists()).toBe(false)
  })

  it('suspect 必须显示「待核」，不能被渲染成绿色', () => {
    const wrapper = mount(TraceList, {
      props: {
        result: result([
          step({ criterion: null, criterion_trace: null, trace: trace('suspect', 2) }),
        ]),
      },
    })
    const chip = wrapper.get('.trace__chip--suspect')
    expect(chip.text()).toContain('待核')
    expect(wrapper.find('.trace__chip--ok').exists()).toBe(false)
  })

  it('unverified 不是按钮——点不开的东西不该长得像按钮', () => {
    const wrapper = mount(TraceList, {
      props: { result: result([step({ trace: trace('unverified', null), criterion_trace: null })]) },
    })
    expect(wrapper.text()).toContain('指不回原文')
    expect(wrapper.findAll('button')).toHaveLength(0)
  })

  it('判据有自己的展开位，与动作互不干扰', async () => {
    const wrapper = mount(TraceList, {
      props: {
        result: result([
          step({ criterion_trace: trace('ok', 0, '工序：客室侧门开关门功能试验') }),
        ]),
      },
    })
    const chips = wrapper.findAll('.trace__chip--ok')
    expect(chips).toHaveLength(2)
    await chips[1].trigger('click')
    expect(wrapper.get('.trace__source-text').text()).toContain('工序')
    expect(wrapper.findAll('.trace__source')).toHaveLength(1)
  })

  it('判据被清空时不渲染判据行', () => {
    const wrapper = mount(TraceList, {
      props: { result: result([step({ criterion: null, criterion_trace: null })]) },
    })
    expect(wrapper.find('.trace__row--criterion').exists()).toBe(false)
  })
})
