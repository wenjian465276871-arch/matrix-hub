import { describe, expect, it } from 'vitest'
import type { Criterion, CriterionResult, Step } from '../types'
import { buildPayload, formatResult, rangeWarning, verdictLabel } from './runeval'

/**
 * A1 判据求值的纯逻辑测试。
 *
 * 这批断言盯的都是"静默出错"：不合格的被判合格、该填的没拦住、
 * 数值变成字符串被后端拒。现场不会给第二次机会，所以口径必须钉死。
 */

function crit(over: Partial<Criterion> = {}): Criterion {
  return {
    id: 'c1',
    label: '门锁间隙',
    type: 'range',
    unit: 'mm',
    min: 2,
    max: 5,
    options: null,
    ...over,
  }
}

function step(criteria: Criterion[]): Step {
  return {
    id: 's1',
    seq: 1,
    title: '检查门锁闭合',
    action: '手动关闭车门',
    safety: [],
    tools: [],
    criteria,
    figures: [],
    assets: [],
    duration_s: null,
  }
}

describe('rangeWarning：超差只提示，不阻断', () => {
  it('非 range 判据不产生数值提示', () => {
    expect(rangeWarning(crit({ type: 'text' }), '随便写')).toBe('')
  })

  it('空值不提示（没填 ≠ 测得 0）', () => {
    // 这条最容易被写成"空就当 0"，那会让所有下限大于 0 的判据一进来就报超差
    expect(rangeWarning(crit(), '')).toBe('')
    expect(rangeWarning(crit(), undefined)).toBe('')
  })

  it('非法数字给明确提示，不是沉默', () => {
    expect(rangeWarning(crit(), 'abc')).toBe('请输入有效数值')
  })

  it('低于下限 / 超出上限，文案带数值与单位', () => {
    expect(rangeWarning(crit(), '1.5')).toBe('低于下限 2 mm')
    expect(rangeWarning(crit(), '5.5')).toBe('超出上限 5 mm')
  })

  it('边界值是合格的（闭区间）', () => {
    // min/max 是"要求 2–5"，测到 2 或 5 都算合格
    expect(rangeWarning(crit(), '2')).toBe('')
    expect(rangeWarning(crit(), '5')).toBe('')
  })

  it('没有上下限时不误报', () => {
    expect(rangeWarning(crit({ min: null, max: null }), '999')).toBe('')
  })

  it('缺单位时不留多余空格', () => {
    expect(rangeWarning(crit({ unit: null }), '1')).toBe('低于下限 2 ')
  })
})

describe('buildPayload：填什么算填完整', () => {
  it('range 合法时载荷里是数字，不是字符串', () => {
    // 传字符串会被后端按类型拒（422），现场表现成"提交失败"但不知为何
    const { payload, missing } = buildPayload(step([crit()]), { c1: '3.5' })
    expect(missing).toHaveLength(0)
    expect(payload.c1).toBe(3.5)
    expect(typeof payload.c1).toBe('number')
  })

  it('range 填空串或非数字都算未填', () => {
    expect(buildPayload(step([crit()]), { c1: '' }).missing).toHaveLength(1)
    expect(buildPayload(step([crit()]), {}).missing).toHaveLength(1)
    expect(buildPayload(step([crit()]), { c1: 'x' }).missing).toHaveLength(1)
  })

  it('range 测得 0 是合法值，不能当成没填', () => {
    // `if (!raw)` 会把这个 0 吃掉
    const { payload, missing } = buildPayload(step([crit({ min: null, max: null })]), { c1: '0' })
    expect(missing).toHaveLength(0)
    expect(payload.c1).toBe(0)
  })

  it('manual 必须勾选才算填了，载荷是布尔 true', () => {
    const s = step([crit({ id: 'm1', type: 'manual' })])
    expect(buildPayload(s, {}).missing).toHaveLength(1)
    expect(buildPayload(s, { m1: '' }).missing).toHaveLength(1)
    const { payload, missing } = buildPayload(s, { m1: 'true' })
    expect(missing).toHaveLength(0)
    expect(payload.m1).toBe(true)
  })

  it('enum / text 去掉首尾空白后为空算未填', () => {
    const s = step([crit({ id: 'e1', type: 'enum', options: ['亮', '灭'] })])
    expect(buildPayload(s, { e1: '' }).missing).toHaveLength(1)
    expect(buildPayload(s, { e1: '   ' }).missing).toHaveLength(1)
    expect(buildPayload(s, { e1: '亮' }).payload.e1).toBe('亮')
  })

  it('文本载荷会被 trim', () => {
    const s = step([crit({ id: 't1', type: 'text' })])
    expect(buildPayload(s, { t1: '  门锁已复位  ' }).payload.t1).toBe('门锁已复位')
  })

  it('missing 按步骤里的判据顺序返回，供"请先填写：A、B"使用', () => {
    const s = step([
      crit({ id: 'a', label: '甲' }),
      crit({ id: 'b', label: '乙', type: 'manual' }),
      crit({ id: 'c', label: '丙', type: 'text' }),
    ])
    const { missing } = buildPayload(s, { b: 'true' })
    expect(missing.map((c) => c.label)).toEqual(['甲', '丙'])
  })

  it('只收集未填项，已填项照常进载荷', () => {
    const s = step([crit({ id: 'a' }), crit({ id: 'b', type: 'text' })])
    const { payload, missing } = buildPayload(s, { a: '3' })
    expect(payload.a).toBe(3)
    expect(missing.map((c) => c.id)).toEqual(['b'])
  })
})

describe('formatResult / verdictLabel：展示口径', () => {
  it('布尔值说人话', () => {
    const base: CriterionResult = {
      criterion_id: 'c1',
      label: '外观',
      type: 'manual',
      value: true,
      unit: null,
      verdict: 'pass',
      message: '',
    }
    expect(formatResult(base)).toBe('已确认')
    expect(formatResult({ ...base, value: false })).toBe('未确认')
  })

  it('数值带单位，不带单位时不拖空格', () => {
    const base: CriterionResult = {
      criterion_id: 'c1',
      label: '间隙',
      type: 'range',
      value: 3.5,
      unit: 'mm',
      verdict: 'pass',
      message: '',
    }
    expect(formatResult(base)).toBe('3.5 mm')
    expect(formatResult({ ...base, unit: null })).toBe('3.5')
  })

  it('五种判定都有中文标签，未判定显示"未执行"', () => {
    expect(verdictLabel('pass')).toBe('通过')
    expect(verdictLabel('warn')).toBe('需复测')
    expect(verdictLabel('fail')).toBe('异常')
    expect(verdictLabel('manual')).toBe('已记录')
    expect(verdictLabel('skipped')).toBe('未执行')
    expect(verdictLabel(undefined)).toBe('未执行')
  })
})
