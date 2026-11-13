/** 探索台的纯逻辑（R20-2）：把这些判断从 1,799 行的组件里搬出来，第一次能直接断言。
 *
 *  以前它们只能靠"点一遍看看"验：切到三维页签再翻到只有烘焙图的步骤会不会空白、
 *  搜"绝缘"能不能搜到判据里的字、右栏停在"安全"页而这一步没有安全项时显示什么。
 */
import { describe, expect, it } from 'vitest'

import {
  aidFiguresOf,
  effectiveTab,
  effectiveView,
  filterSteps,
  hasOpsFigure,
  heroFiguresOf,
  isSceneHero,
  kindOf,
  minutesOf,
  needsStageFocus,
  panelTabs,
  sumMinutes,
  viewGroupsOf,
} from './explorer'
import type { Step, VisualSpec } from '../types'

function step(partial: Partial<Step> & { title: string; id?: string }): Step {
  return {
    ...partial,
    id: partial.id ?? 's01',
    seq: partial.seq ?? 1,
    action: partial.action ?? '按工艺执行并确认',
    safety: partial.safety ?? [],
    tools: partial.tools ?? [],
    criteria: partial.criteria ?? [],
    figures: partial.figures ?? [],
    assets: partial.assets,
    duration_s: partial.duration_s,
  } as unknown as Step
}

const fig = (primitive: string): VisualSpec => ({ primitive }) as unknown as VisualSpec

describe('explorer / 步骤性质与耗时', () => {
  it('按标题动词归类，认不出来就是「作业」', () => {
    expect(kindOf({ title: '作业前安全确认' })).toBe('准备')
    expect(kindOf({ title: '测量绝缘电阻' })).toBe('测量')
    expect(kindOf({ title: '检查门锁外观' })).toBe('检查')
    expect(kindOf({ title: '填写作业记录' })).toBe('记录')
    expect(kindOf({ title: '拆除接地线' })).toBe('作业')
  })

  it('含「条件」的标题归「准备」（R20-7 修的是「确认条件」连写）', () => {
    // 2026-11-14 本人裁决：这一屏本质就是作业前的条件确认，显示「作业」太粗。
    // 改前扫过全部 7 份样例，只有这一条会变——其余标题的归类一字未动。
    expect(kindOf({ title: '升弓前必须满足的条件' })).toBe('准备')
    expect(kindOf({ title: '复位条件' })).toBe('准备')
  })

  it('耗时缺失返回 null，四舍五入到分钟', () => {
    expect(minutesOf({ duration_s: undefined as unknown as number | null })).toBeNull()
    expect(minutesOf({ duration_s: null })).toBeNull()
    expect(minutesOf({ duration_s: 150 })).toBe(3)
  })

  it('总耗时跳过没有估时的步骤', () => {
    expect(
      sumMinutes([{ duration_s: 120 }, { duration_s: null }, { duration_s: 61 }]),
    ).toBe(3) // 2 + 0 + 1
  })
})

describe('explorer / 目录筛选', () => {
  const steps = [
    step({ id: 's01', seq: 1, title: '准备', tools: ['万用表'] }),
    step({ id: 's02', seq: 2, title: '测电压', criteria: [{ id: 'c1', label: '绝缘电阻' }] as never }),
    step({ id: 's03', seq: 3, title: '记录', figures: [fig('table')] }),
  ]

  it('关键词命中标题 / 工具 / 判据标签', () => {
    expect(filterSteps(steps, '万用表', 'all').map((r) => r.index)).toEqual([0])
    expect(filterSteps(steps, '绝缘', 'all').map((r) => r.index)).toEqual([1])
  })

  it('「有图」与「有判据」是互斥的筛选项，且不看关键词时全留', () => {
    expect(filterSteps(steps, '', 'figure').map((r) => r.index)).toEqual([2])
    expect(filterSteps(steps, '', 'criteria').map((r) => r.index)).toEqual([1])
    expect(filterSteps(steps, '  ', 'all')).toHaveLength(3)
  })

  it('**保留原始下标**：筛掉第 1 步后，第 2 步的下标仍是 2（点目录靠它翻页）', () => {
    const only = filterSteps(steps, '绝缘', 'all')
    expect(only).toHaveLength(1)
    expect(only[0].index).toBe(1)
    expect(only[0].s.id).toBe('s02')
  })
})

describe('explorer / 舞台分组与回落', () => {
  it('页签顺序固定：实物示意图 → 三维动作 → 操作台', () => {
    const groups = viewGroupsOf([
      fig('operation_scene'),
      fig('device_scene'),
      fig('baked_figure'),
      fig('table'),
    ])
    expect(groups.map((g) => g.id)).toEqual(['still', 'scene', 'ops'])
    expect(groups.map((g) => g.label)).toEqual(['实物示意图', '三维动作', '操作台'])
  })

  it('只有 2D 图时不分组', () => {
    expect(viewGroupsOf([fig('table'), fig('callout')])).toHaveLength(0)
  })

  it('选中的视图本步没有时回落到第一个（否则翻页看到一块空白）', () => {
    const groups = viewGroupsOf([fig('baked_figure'), fig('table')])
    expect(effectiveView('scene', groups)?.id).toBe('still')
    expect(effectiveView('still', groups)?.id).toBe('still')
    expect(effectiveView('scene', [])).toBeUndefined()
  })

  it('没有分组时把第一张 2D 图提为主图，其余进辅图列', () => {
    const figures = [fig('table'), fig('callout')]
    expect(heroFiguresOf(figures, [], 'still')).toHaveLength(1)
    expect(heroFiguresOf(figures, [], 'still')[0].primitive).toBe('table')
    expect(aidFiguresOf(figures, []).map((f) => f.primitive)).toEqual(['callout'])
  })

  it('有分组时主图跟着页签走，辅图只留 2D 图元', () => {
    const figures = [fig('baked_figure'), fig('device_scene'), fig('mon_panel'), fig('wiring')]
    const groups = viewGroupsOf(figures)
    expect(heroFiguresOf(figures, groups, 'scene').map((f) => f.primitive)).toEqual([
      'device_scene',
    ])
    // mon_panel 属于 ops 页签，不该重复出现在辅图里
    expect(aidFiguresOf(figures, groups).map((f) => f.primitive)).toEqual(['wiring'])
  })
})

describe('explorer / 右栏页签', () => {
  it('条数取自当前步', () => {
    const tabs = panelTabs(
      step({ title: 'x', safety: ['a', 'b'], tools: ['t'], criteria: [{ id: 'c1' }] as never }),
    )
    expect(tabs.map((t) => [t.id, t.n])).toEqual([
      ['safety', 2],
      ['tools', 1],
      ['criteria', 1],
      ['note', 0],
    ])
  })

  it('落在空页签上就跳到第一个有内容的；全空时落到「说明」', () => {
    const tabs = panelTabs(step({ title: 'x', criteria: [{ id: 'c1' }] as never }))
    expect(effectiveTab('safety', tabs)).toBe('criteria')
    expect(effectiveTab('criteria', tabs)).toBe('criteria')
    expect(effectiveTab('safety', panelTabs(step({ title: 'x' })))).toBe('note')
  })
})

describe('explorer / 聚焦判据', () => {
  it('只有操作台与 MON 屏要求整屏，静态三维只做低风险让位', () => {
    expect(needsStageFocus([fig('operation_scene')])).toBe(true)
    expect(needsStageFocus([fig('mon_panel')])).toBe(true)
    expect(needsStageFocus([fig('device_scene')])).toBe(false)
    expect(isSceneHero([fig('device_scene')])).toBe(true)
    expect(hasOpsFigure([fig('operation_scene')])).toBe(true)
    expect(hasOpsFigure([fig('mon_panel')])).toBe(false)
  })
})
