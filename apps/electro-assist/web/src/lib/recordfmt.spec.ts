import { describe, expect, it } from 'vitest'
import { formatDuration, formatStepDuration, formatTime } from './recordfmt'

/**
 * 作业记录展示口径的测试。
 *
 * 三条都是"看起来显然"的格式化，但每条都对应一次现场误读：
 * 0 秒被当成真的测了 0 秒、00:42 显示成 24:42、未执行显示成 0 秒。
 */

describe('formatDuration：总耗时', () => {
  it('0 当"没有数据"，显示破折号而不是「0 秒」', () => {
    expect(formatDuration(0)).toBe('—')
  })

  it('不足 1 分钟只显示秒', () => {
    expect(formatDuration(45)).toBe('45 秒')
  })

  it('超过 1 分钟拆成「N 分 M 秒」', () => {
    expect(formatDuration(90)).toBe('1 分 30 秒')
    expect(formatDuration(3600)).toBe('60 分 0 秒')
  })
})

describe('formatStepDuration：单步耗时', () => {
  it('未执行为 null 时显示破折号', () => {
    expect(formatStepDuration(null)).toBe('—')
  })

  it('不足 1 秒说「不足 1 秒」，不显示「0 秒」', () => {
    // 显示 "0 秒" 会让现场以为计时坏了
    expect(formatStepDuration(0)).toBe('不足 1 秒')
    expect(formatStepDuration(0.4)).toBe('不足 1 秒')
  })

  it('满 1 秒才走正常格式', () => {
    expect(formatStepDuration(1)).toBe('1 秒')
    expect(formatStepDuration(75)).toBe('1 分 15 秒')
  })
})

describe('formatTime：时间戳', () => {
  it('null 显示破折号', () => {
    expect(formatTime(null)).toBe('—')
  })

  it('零点附近必须是 00 点，不能出现 24 点', () => {
    // 用本地时间构造，避免时区影响断言；关键是 h23 而不是 h24
    const local = new Date(2026, 10, 6, 0, 42, 45)
    const text = formatTime(local.toISOString())

    expect(text).toContain('00:42:45')
    // 这条真正要防的：hour12:false 在部分 ICU 实现里给出 "24:42:45"
    expect(text).not.toContain('24:42')
  })

  it('包含年月日，现场对时间要能看出是哪天', () => {
    const local = new Date(2026, 10, 6, 15, 3, 9)
    const text = formatTime(local.toISOString())

    expect(text).toContain('2026')
    expect(text).toContain('15:03:09')
  })
})
