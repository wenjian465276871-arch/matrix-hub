import { describe, expect, it } from 'vitest'
import type { Criterion, Guide } from '../types'
import { buildPatch, numText, toEditDraft, toNumber } from './guidepatch'

/**
 * 草稿修正的纯逻辑测试。
 *
 * 为什么这批测试比组件测试更值：`buildPatch` 漏一个字段 = 用户改完保存成功、
 * 刷新又变回去，**不报错、不崩、日志里什么都看不到**。只能靠断言把每个字段钉死。
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

function guide(over: Partial<Guide> = {}): Guide {
  return {
    schema_version: '1.2',
    id: 'g_test',
    title: '客室侧门开关门功能试验',
    summary: '测试摘要',
    meta: {
      system: 'door',
      source_note: '测试',
      model: 'test-model',
      generated_at: '2026-11-06T00:00:00Z',
      is_demo: true,
    },
    steps: [
      {
        id: 's1',
        seq: 1,
        title: '检查门锁闭合',
        action: '手动关闭车门，观察锁扣',
        safety: [],
        tools: [],
        criteria: [crit()],
        figures: [],
        assets: [],
        duration_s: null,
      },
    ],
    assets: [],
    disclaimers: [],
    ...over,
  }
}

describe('numText：数值转输入框文本', () => {
  it('null 与 undefined 都变空串，不显示 "null"', () => {
    expect(numText(null)).toBe('')
    expect(numText(undefined)).toBe('')
  })

  it('0 要保留，不能当成空', () => {
    // 这条容易写错成 `value || ''`，那样 0 会消失
    expect(numText(0)).toBe('0')
  })
})

describe('toEditDraft：服务端数据转编辑态', () => {
  it('判据的 min/max 转字符串、options 用 " / " 拼起来', () => {
    const draft = toEditDraft(
      guide({
        steps: [
          {
            ...guide().steps[0]!,
            criteria: [
              crit(),
              crit({ id: 'c2', label: '指示灯', type: 'enum', min: null, max: null, options: ['亮', '灭'] }),
            ],
          },
        ],
      }),
    )

    expect(draft.title).toBe('客室侧门开关门功能试验')
    expect(draft.steps[0]!.criteria[0]).toMatchObject({ min: '2', max: '5', unit: 'mm' })
    expect(draft.steps[0]!.criteria[1]).toMatchObject({ min: '', max: '', options: '亮 / 灭' })
  })
})

describe('toNumber：空串不改，非法值报错', () => {
  it('空串返回 undefined（含义是"不改"，不是"清空"）', () => {
    expect(toNumber('', '下限')).toBeUndefined()
    expect(toNumber('   ', '下限')).toBeUndefined()
  })

  it('非法数字抛错，错误信息带上字段名', () => {
    expect(() => toNumber('abc', '门锁间隙 的下限')).toThrow('门锁间隙 的下限不是合法数字')
  })

  it('合法数字带前后空白也能解析', () => {
    expect(toNumber(' 3.5 ', '下限')).toBe(3.5)
  })
})

describe('buildPatch：只发真的改过的字段', () => {
  it('什么都没改时返回空对象', () => {
    const g = guide()
    expect(buildPatch(g, toEditDraft(g))).toEqual({})
  })

  it('只改标题时，patch 里只有 title，steps 整个不出现', () => {
    const g = guide()
    const draft = toEditDraft(g)
    draft.title = '客室侧门开关门功能试验（修订）'

    const patch = buildPatch(g, draft)
    expect(patch).toEqual({ title: '客室侧门开关门功能试验（修订）' })
    // 关键：不是 `steps: []`，而是键根本不存在 —— 后端据此不碰任何步骤
    expect('steps' in patch).toBe(false)
  })

  it('只改下限时，只带 min，不带 max / unit / label', () => {
    const g = guide()
    const draft = toEditDraft(g)
    draft.steps[0]!.criteria[0]!.min = '3'

    const patch = buildPatch(g, draft)
    expect(patch.steps).toHaveLength(1)
    const c = patch.steps![0]!.criteria![0]!
    expect(c).toEqual({ id: 'c1', min: 3 })
    expect('max' in c).toBe(false)
    expect('unit' in c).toBe(false)
  })

  it('清空下限输入框不算改动（空串 = 不改）', () => {
    const g = guide()
    const draft = toEditDraft(g)
    draft.steps[0]!.criteria[0]!.min = ''

    // 用户可能是把 "2" 删掉准备重打，这个中间态不能当成"想删掉下限"
    expect(buildPatch(g, draft)).toEqual({})
  })

  it('标题前后空白被 trim，但只改空白不算改动', () => {
    const g = guide()
    const draft = toEditDraft(g)
    draft.steps[0]!.title = '  检查门锁闭合  '
    expect(buildPatch(g, draft)).toEqual({})

    draft.steps[0]!.title = '  检查门锁闭合状态  '
    expect(buildPatch(g, draft).steps![0]!.title).toBe('检查门锁闭合状态')
  })

  it('改枚举选项时归一化成数组（拆分、trim、丢空段）', () => {
    const g = guide({
      steps: [
        {
          ...guide().steps[0]!,
          criteria: [crit({ type: 'enum', min: null, max: null, options: ['亮', '灭'] })],
        },
      ],
    })
    const draft = toEditDraft(g)
    draft.steps[0]!.criteria[0]!.options = '亮 / 灭 / 闪烁'
    expect(buildPatch(g, draft).steps![0]!.criteria![0]!.options).toEqual(['亮', '灭', '闪烁'])

    // 顺序变了也算改动 —— 现场按顺序核对，顺序是内容的一部分
    const reordered = toEditDraft(g)
    reordered.steps[0]!.criteria[0]!.options = '灭 / 亮'
    expect(buildPatch(g, reordered).steps![0]!.criteria![0]!.options).toEqual(['灭', '亮'])
  })

  it('未改动的步骤不进 patch（多步只发改动那一步）', () => {
    const base = guide()
    const g = guide({
      steps: [
        base.steps[0]!,
        {
          ...base.steps[0]!,
          id: 's2',
          seq: 2,
          title: '检查指示灯',
          criteria: [crit({ id: 'c2', label: '指示灯状态' })],
        },
      ],
    })
    const draft = toEditDraft(g)
    draft.steps[1]!.action = '观察门顶指示灯由红转绿'

    const patch = buildPatch(g, draft)
    expect(patch.steps).toHaveLength(1)
    expect(patch.steps![0]!.id).toBe('s2')
  })

  it('非法数字会让 buildPatch 抛错，而不是发一个 NaN 出去', () => {
    const g = guide()
    const draft = toEditDraft(g)
    draft.steps[0]!.criteria[0]!.min = '大概三毫米'
    expect(() => buildPatch(g, draft)).toThrow('不是合法数字')
  })
})
