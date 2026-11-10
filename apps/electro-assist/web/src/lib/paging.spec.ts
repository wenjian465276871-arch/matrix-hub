import { describe, expect, it } from 'vitest'
import {
  clampPage,
  loadPage,
  pageCount,
  pageIndexFromScroll,
  pageLabels,
  pageStorageKey,
  savePage,
} from './paging'

/**
 * 翻页逻辑的边界。
 *
 * 这些函数错一次的后果是「现场看到的是别的那一步」——页面本身完全正常，
 * 图画得对、判据也对，只是不是这一步。所以每一个边界都单独钉。
 */

describe('pageCount', () => {
  it('封面 + 步骤 + 可选尾页', () => {
    expect(pageCount(0, false)).toBe(1)
    expect(pageCount(8, false)).toBe(9)
    expect(pageCount(8, true)).toBe(10)
  })

  it('负数与小数都收敛成整数步数（向下取整：不存在半步）', () => {
    expect(pageCount(-3, false)).toBe(1)
    expect(pageCount(2.6, false)).toBe(3)
  })
})

describe('clampPage', () => {
  it('夹在 [0, count-1]', () => {
    expect(clampPage(0, 9)).toBe(0)
    expect(clampPage(8, 9)).toBe(8)
    expect(clampPage(99, 9)).toBe(8)
    expect(clampPage(-1, 9)).toBe(0)
  })

  it('空数据返回 0 而不是 -1（-1 会让下标取到 undefined）', () => {
    expect(clampPage(3, 0)).toBe(0)
  })

  it('非有限数一律回封面：宁可回封面，也不要跳到不知哪一页', () => {
    expect(clampPage(Number.NaN, 5)).toBe(0)
    expect(clampPage(Number.POSITIVE_INFINITY, 5)).toBe(0)
  })
})

describe('pageIndexFromScroll', () => {
  it('按页宽取整', () => {
    expect(pageIndexFromScroll(0, 800, 5)).toBe(0)
    expect(pageIndexFromScroll(790, 800, 5)).toBe(1)
    expect(pageIndexFromScroll(800, 800, 5)).toBe(1)
  })

  it('超过末尾夹到最后一页：惯性滑过头不能算出不存在的页', () => {
    expect(pageIndexFromScroll(9999, 800, 3)).toBe(2)
  })

  it('宽度为 0（首帧、隐藏容器）返回 0，不产生 NaN', () => {
    expect(pageIndexFromScroll(100, 0, 5)).toBe(0)
    expect(pageIndexFromScroll(Number.NaN, 800, 5)).toBe(0)
  })
})

describe('pageLabels', () => {
  it('封面 + 每步一行 + 可选尾页，页序与 pageCount 一致', () => {
    const labels = pageLabels([{ seq: 1, title: '挂牌' }, { seq: 2, title: '测量' }], true)
    expect(labels).toEqual(['封面', '第 1 步：挂牌', '第 2 步：测量', '现场素材'])
    expect(labels).toHaveLength(pageCount(2, true))
  })

  it('用 seq 而不是数组下标：步骤被删过之后，页码仍要对得上正文', () => {
    const labels = pageLabels([{ seq: 3, title: '复紧' }], false)
    expect(labels[1]).toBe('第 3 步：复紧')
  })
})

describe('位置记忆', () => {
  const store = () => {
    const map = new Map<string, string>()
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    }
  }

  it('每份指导书一个键', () => {
    expect(pageStorageKey('g_a')).not.toBe(pageStorageKey('g_b'))
    expect(pageStorageKey('g_a')).toContain('g_a')
  })

  it('存进去再读出来是同一页', () => {
    const s = store()
    savePage('k', 3, s)
    expect(loadPage('k', 9, s)).toBe(3)
  })

  it('没有值、空值、非整数都退回封面', () => {
    const s = store()
    expect(loadPage('k', 9, s)).toBe(0)
    s.setItem('k', '')
    expect(loadPage('k', 9, s)).toBe(0)
    s.setItem('k', '2.5')
    expect(loadPage('k', 9, s)).toBe(0)
  })

  it('页数变少（重新生成后步骤减少）时夹到最后一页', () => {
    const s = store()
    savePage('k', 7, s)
    expect(loadPage('k', 3, s)).toBe(2)
  })

  it('storage 抛异常不影响阅读', () => {
    const bad = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(loadPage('k', 9, bad)).toBe(0)
    expect(() => savePage('k', 2, bad)).not.toThrow()
  })
})
