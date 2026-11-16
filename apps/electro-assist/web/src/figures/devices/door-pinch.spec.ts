import { describe, expect, it } from 'vitest'

import { BLOCK_AT_DOOR, BLOCK_SIZE, DIM, REBOUND_MAX, TRAVEL_STOP_AT_BLOCK } from './door'

/**
 * 防夹：门扇**必须被试块挡住**，不能越过去继续关。
 *
 * 为什么写成断言：2026-11-17 本人截图指出"碰到试块直接继续关门越过了试块"——
 * 当时试块只改自己的位置，门扇照常走到 0。这类"两件该碰撞却没碰撞"的错误，
 * 靠看单帧截图很难发现（门和块都在动），但用行程关系一算就清楚。
 */
describe('防夹行程约束', () => {
  const leafHalf = DIM.leafW / 2
  const blockFaceX = BLOCK_AT_DOOR[0] + BLOCK_SIZE.w / 2

  it('停在试块 +X 面：此时门扇前缘正好贴住块面', () => {
    // 前缘 x = travel − leafW/2
    expect(TRAVEL_STOP_AT_BLOCK - leafHalf).toBeCloseTo(blockFaceX, 6)
  })

  it('试块在工位时，门扇**到不了**全关位（travel > 0）', () => {
    expect(TRAVEL_STOP_AT_BLOCK).toBeGreaterThan(0.15)
  })

  it('撞到后反开的量大于 10cm，画面上看得出来"退回去了"', () => {
    expect(REBOUND_MAX).toBeGreaterThan(0.1)
    // 反开后前缘离块面的净空 = REBOUND_MAX
    const edgeAfter = TRAVEL_STOP_AT_BLOCK + REBOUND_MAX - leafHalf
    expect(edgeAfter - blockFaceX).toBeCloseTo(REBOUND_MAX, 6)
  })

  it('试块宽度小于门洞一半，仍是"夹到异物"不是"门洞被堵"', () => {
    expect(BLOCK_SIZE.w).toBeLessThan(DIM.openW / 2)
  })
})
