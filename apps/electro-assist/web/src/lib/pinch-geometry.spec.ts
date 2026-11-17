import { describe, expect, it } from 'vitest'

import { BLOCK_AT_DOOR, BLOCK_SIZE, DIM } from '../figures/devices/door'
import { PINCH_AT } from './door-session'

/**
 * **把"试块位置"和"防夹开度"钉在一起。**
 *
 * 2026-11-17 的真实事故：试块从 `x=−0.405` 右移到 `−0.265`（`de83c9c`），
 * 而 `PINCH_AT` 还是按老位置算的 0.22 —— 于是门要收到"几乎全关"（行程只剩 3cm）
 * 才反开，现场看着就是"撞上了还继续关"。
 *
 * 这类耦合常量靠注释提醒不住（那条注释里写的就是旧坐标，还标着"单扇化后重算"）。
 * 所以用测试把它们绑死：改 `BLOCK_AT_DOOR` / `BLOCK_SIZE` / `DIM.slide` 而不同步
 * `PINCH_AT`，这里立刻红。
 */
describe('防夹开度与试块几何一致', () => {
  /** 与 `door.ts` 里的分段一致：`slide = seg(t, 0.2, 0.88)`，`travel = slide × DIM.slide` */
  const travelAt = (t: number): number => {
    const s = Math.min(1, Math.max(0, (t - 0.2) / (0.88 - 0.2)))
    return s * DIM.slide
  }

  it('PINCH_AT 对应的行程，正好等于"门扇前缘贴到试块 +X 面"', () => {
    const blockFaceX = BLOCK_AT_DOOR[0] + BLOCK_SIZE.w / 2
    const contactTravel = blockFaceX + DIM.leafW / 2
    expect(travelAt(PINCH_AT)).toBeCloseTo(contactTravel, 2)
  })

  it('容差不超过 2cm（软物压缩量级别，不能大到一个拳头的行程）', () => {
    const contactTravel = BLOCK_AT_DOOR[0] + BLOCK_SIZE.w / 2 + DIM.leafW / 2
    expect(Math.abs(travelAt(PINCH_AT) - contactTravel)).toBeLessThan(0.02)
  })

  it('反开点必须明显早于"几乎全关"——行程至少还剩 30%', () => {
    expect(travelAt(PINCH_AT) / DIM.slide).toBeGreaterThan(0.3)
  })
})
