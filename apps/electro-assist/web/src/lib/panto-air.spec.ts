import { describe, expect, it } from 'vitest'

import { airState, phase, PANO_T, SWITCH_DIFF, travel } from './panto-air'

/**
 * 三种工况的**判据**，不是"跑一遍不报错"。
 *
 * 每条都对应公开资料里的一句原理，将来若有人改时序，这些断言会指出
 * "你把 ADD 降弓画得和正常降弓一样快"这类功能退化——那正是最难靠肉眼发现的。
 */
describe('受电弓气路：三种试验工况', () => {
  it('落弓锁定时无压：气囊与滑板气腔都是 0，开关断开', () => {
    const s = airState(0)
    expect(s.bag).toBe(0)
    expect(s.slide).toBe(0)
    expect(s.switchClosed).toBe(false)
    expect(s.travel).toBe(0)
  })

  it('建压时气囊与滑板气腔**同时**充气：压差恒为 0，开关闭合', () => {
    for (const t of [0.06, 0.09, 0.12]) {
      const s = airState(t)
      expect(s.bag).toBeGreaterThan(0)
      expect(s.diff).toBeCloseTo(0, 6)
      // 压力还很低时不闭合（阈值 0.08）
      if (s.bag > 0.08) expect(s.switchClosed).toBe(true)
    }
  })

  it('升弓到位后保压：行程满、开关闭合、仍在通气', () => {
    const s = airState(0.72)
    expect(s.travel).toBe(1)
    expect(s.bag).toBeCloseTo(0.62, 2)
    expect(s.switchClosed).toBe(true)
    expect(s.venting).toBe(false)
    expect(s.phase).toBe('升弓到位（开关闭合）')
  })

  it('正常降弓：靠自重 + 阻尼，落弓晚于 ADD，且全程不出现压差', () => {
    const half = airState(0.87, 'normal')
    expect(half.travel).toBeGreaterThan(0)
    expect(half.travel).toBeLessThan(1)
    expect(half.diff).toBeCloseTo(0, 6)
    expect(airState(0.95, 'normal').travel).toBe(0)
  })

  it('ADD：滑板破裂后出气口掉压、压差超过阈值、开关断开', () => {
    const held = airState(0.79, 'add')
    expect(held.switchClosed).toBe(true)

    // 破裂之后、开关动作之前：滑板压力低于气囊压力
    const leaking = airState(PANO_T.addRupture + 0.005, 'add')
    expect(leaking.slide).toBeLessThan(leaking.bag)
    expect(leaking.diff).toBeGreaterThan(0)

    // 开关断开之后：压差已超阈值，快排阀开始排气
    const tripped = airState(PANO_T.addSwitch + 0.005, 'add')
    expect(tripped.diff).toBeGreaterThan(SWITCH_DIFF)
    expect(tripped.switchClosed).toBe(false)
    expect(tripped.venting).toBe(true)
  })

  it('ADD 落弓明显快于正常降弓——同一时刻两者行程必须分得开', () => {
    const normal = travel(0.88, 'normal')
    const add = travel(0.88, 'add')
    expect(add).toBeLessThan(normal)
    // 到 0.90 时 ADD 已经落地，正常降弓还悬在半空
    expect(travel(0.9, 'add')).toBe(0)
    expect(travel(0.9, 'normal')).toBeGreaterThan(0.1)
  })

  it('ADD 完成后气囊排空、压差归零（排气口通大气）', () => {
    const s = airState(0.97, 'add')
    expect(s.travel).toBe(0)
    expect(s.bag).toBeLessThan(0.02)
    expect(s.switchClosed).toBe(false)
    expect(s.phase).toBe('ADD 动作完成（落弓）')
  })

  it('两种工况在 0.80 之前完全一致：升弓段不该被模式影响', () => {
    for (const t of [0.1, 0.3, 0.5, 0.7, 0.79]) {
      const a = airState(t, 'normal')
      const b = airState(t, 'add')
      expect(a.bag).toBeCloseTo(b.bag, 9)
      expect(a.travel).toBeCloseTo(b.travel, 9)
      expect(a.phase).toBe(b.phase)
    }
  })

  it('阶段名按现场说法给，不用抽象状态词', () => {
    expect(phase(0.01, 'normal')).toContain('落弓锁定')
    expect(phase(0.08, 'normal')).toContain('建压')
    expect(phase(0.3, 'normal')).toBe('升弓中')
    expect(phase(0.75, 'normal')).toContain('升弓到位')
    // 保压窗口只有 0.78→0.80，取窗口内一点
    expect(phase(0.79, 'normal')).toContain('保压')
    expect(phase(0.85, 'normal')).toContain('阻尼')
    expect(phase(0.86, 'add')).toContain('快排阀排气')
  })
})
