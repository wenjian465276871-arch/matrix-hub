import { describe, expect, it } from 'vitest'

import { BLOCK_AT_DOOR, BLOCK_SIZE, DIM } from './door'

/**
 * 防夹试块必须**跨在门页的滑移面上**，否则"门被它顶住"在画面上不成立。
 *
 * 为什么用断言验而不是截图验（2026-11-16）：
 * 试块要**点一下**才从原位挪到工位，而截图工里的投影点击在指导书那种三列布局下
 * 会点到视口外（canvas.left 实测 1836 > 视口 1800）。与其修那条点击链路，
 * 不如把"它到底挡不挡得住"写成几何断言——可复算、可回归。
 */
describe('防夹试块的位置', () => {
  const [bx, , bz] = BLOCK_AT_DOOR
  const halfW = BLOCK_SIZE.w / 2
  const halfD = BLOCK_SIZE.d / 2

  it('跨在门页的滑移面上（Z 方向与门页厚度有重叠）', () => {
    const leafFront = DIM.leafZ + DIM.leafT / 2
    const leafBack = DIM.leafZ - DIM.leafT / 2
    const blockFront = bz + halfD
    const blockBack = bz - halfD
    // 试块的 Z 区间必须与门页厚度区间相交，否则门扇会从它旁边滑过去
    expect(blockBack).toBeLessThan(leafFront)
    expect(blockFront).toBeGreaterThan(leafBack)
  })

  it('落在门洞范围内（不压门框）', () => {
    const openLeft = -DIM.openW / 2
    const openRight = DIM.openW / 2
    expect(bx - halfW).toBeGreaterThan(openLeft - 0.02)
    expect(bx + halfW).toBeLessThan(openRight + 0.02)
  })

  it('不在门框边上——离左门框至少 0.12m（单扇化后夹人点在门扇前缘，但贴着框就看不出挡）', () => {
    const openLeft = -DIM.openW / 2
    expect(bx - halfW - openLeft).toBeGreaterThan(0.12)
  })

  it('宽度不超过门洞的 1/3（否则整扇门都被占满，不像"夹到异物"）', () => {
    expect(BLOCK_SIZE.w).toBeLessThan(DIM.openW / 3)
  })
})
