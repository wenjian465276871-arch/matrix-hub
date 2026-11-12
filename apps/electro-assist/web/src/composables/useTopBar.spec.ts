/** 顶栏投稿口的单测。
 *
 *  钉的是一件事：**每次投稿都是一次整体替换**，没给的字段必须清空。
 *  2026-11-12 第五轮评审 R11-5：`kicker` 曾经用 `?? 旧值`，与注释相反；
 *  这个 bug 的表现是"上一页的小字跟着进了下一页"，只在换页那一瞬间可见，
 *  E2E 很难稳定抓到，所以只能在这里钉住语义。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { resetTopBar, setTopBar, useTopBar } from './useTopBar'

const bar = useTopBar()

beforeEach(() => resetTopBar())

describe('setTopBar', () => {
  it('给全四个字段时原样写进去', () => {
    setTopBar({
      kicker: '正在查看',
      title: '受电弓升弓检查',
      progress: { label: '阅读进度', value: 2, total: 5 },
      actions: [{ label: '开始作业', onClick: () => {}, primary: true }],
    })
    expect(bar.kicker).toBe('正在查看')
    expect(bar.title).toBe('受电弓升弓检查')
    expect(bar.progress).toEqual({ label: '阅读进度', value: 2, total: 5 })
    expect(bar.actions).toHaveLength(1)
  })

  it('第二次投稿不带 kicker 时，kicker 必须被清空（不沿用上一页的小字）', () => {
    setTopBar({ kicker: '正在查看', title: '受电弓升弓检查' })
    // 换成只给标题的页面（生成页 / 排查页就是这种形态）
    setTopBar({ title: '从一句话到一份指导书' })
    expect(bar.kicker).toBe('')
    expect(bar.title).toBe('从一句话到一份指导书')
  })

  it('省略 progress 与 actions 时一并清空', () => {
    setTopBar({
      kicker: '打印视图',
      title: 'A',
      progress: { label: '页码', value: 3, total: 5 },
      actions: [{ label: '返回探索台', onClick: () => {} }],
    })
    setTopBar({ title: 'B' })
    expect(bar.progress).toBeNull()
    expect(bar.actions).toEqual([])
  })

  it('只给 kicker 也不会留下上一页的标题', () => {
    setTopBar({ kicker: 'a', title: '上一本书' })
    setTopBar({ kicker: 'b' })
    expect(bar.title).toBe('')
  })

  it('resetTopBar 把四个字段都清空', () => {
    setTopBar({
      kicker: 'k',
      title: 't',
      progress: { label: 'l', value: 1, total: 2 },
      actions: [{ label: 'x', onClick: () => {} }],
    })
    resetTopBar()
    expect(bar.kicker).toBe('')
    expect(bar.title).toBe('')
    expect(bar.progress).toBeNull()
    expect(bar.actions).toEqual([])
  })
})
