import { describe, expect, it } from 'vitest'
import { TIP_GAP, TIP_PAD, placeTip, splitLabel } from './tooltip'

describe('splitLabel', () => {
  it('把括号里的解释拆到第二行', () => {
    expect(splitLabel('主控钥匙（插在制动控制器上，拔取位可取出）')).toEqual({
      name: '主控钥匙',
      note: '插在制动控制器上，拔取位可取出',
    })
  })

  it('没有括号时整句当名称', () => {
    expect(splitLabel('网压表')).toEqual({ name: '网压表', note: '' })
  })

  it('半角括号也认', () => {
    expect(splitLabel('升弓旋钮 PanUS (右旋保持)')).toEqual({
      name: '升弓旋钮 PanUS',
      note: '右旋保持',
    })
  })

  it('斜杠分隔的长名不拆——那是名称的一部分，不是备注', () => {
    // 后端把"制动控制器 / 制动手柄"写成一句话，两段都是设备名；
    // 拆掉任何一段都会让用户少看到一个叫法。
    const { name, note } = splitLabel('制动控制器 / 制动手柄（运行、B1–B7、快速、拔取位）')
    expect(name).toBe('制动控制器 / 制动手柄')
    expect(note).toBe('运行、B1–B7、快速、拔取位')
  })

  it('括号在开头时不当分隔符（避免名称被拆空）', () => {
    expect(splitLabel('（备用）')).toEqual({ name: '（备用）', note: '' })
  })

  it('空串与纯空白不炸', () => {
    expect(splitLabel('')).toEqual({ name: '', note: '' })
    expect(splitLabel('   ')).toEqual({ name: '', note: '' })
  })

  it('取最靠前的括号：后面的括号属于备注内容', () => {
    expect(splitLabel('左开关盘（受电弓 2U/3U（转换））')).toEqual({
      name: '左开关盘',
      note: '受电弓 2U/3U（转换）',
    })
  })
})

describe('placeTip', () => {
  const box = { w: 800, h: 400 }
  const tip = { w: 220, h: 64 }

  it('默认弹在光标右下', () => {
    const p = placeTip({ x: 100, y: 100 }, box, tip)
    expect(p).toEqual({ left: 100 + TIP_GAP, top: 100 + TIP_GAP, flipX: false, flipY: false })
  })

  it('右边放不下就翻到左侧', () => {
    const p = placeTip({ x: 700, y: 100 }, box, tip)
    expect(p.flipX).toBe(true)
    expect(p.left).toBe(700 - TIP_GAP - tip.w)
    expect(p.left + tip.w).toBeLessThan(box.w)
  })

  it('下边放不下就翻到上方', () => {
    const p = placeTip({ x: 100, y: 380 }, box, tip)
    expect(p.flipY).toBe(true)
    expect(p.top).toBe(380 - TIP_GAP - tip.h)
  })

  it('右下角同时翻两边', () => {
    const p = placeTip({ x: 780, y: 390 }, box, tip)
    expect(p.flipX).toBe(true)
    expect(p.flipY).toBe(true)
  })

  it('永远不越出容器', () => {
    for (const cursor of [
      { x: 0, y: 0 },
      { x: 800, y: 400 },
      { x: 799, y: 0 },
      { x: 0, y: 399 },
    ]) {
      const p = placeTip(cursor, box, tip)
      expect(p.left).toBeGreaterThanOrEqual(TIP_PAD)
      expect(p.top).toBeGreaterThanOrEqual(TIP_PAD)
      expect(p.left + tip.w).toBeLessThanOrEqual(box.w - TIP_PAD)
      expect(p.top + tip.h).toBeLessThanOrEqual(box.h - TIP_PAD)
    }
  })

  it('气泡比容器还大时退化成贴左上角，不返回负数', () => {
    const p = placeTip({ x: 10, y: 10 }, { w: 120, h: 60 }, { w: 260, h: 90 })
    expect(p.left).toBe(TIP_PAD)
    expect(p.top).toBe(TIP_PAD)
  })
})
