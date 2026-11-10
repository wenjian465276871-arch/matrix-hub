import { describe, expect, it } from 'vitest'

import { PANGLES, PDIM, PGAP, WIRE_Y, armAngles, armY, armZ, compression, freeTop } from './panto-kin'

const SAMPLES = Array.from({ length: 41 }, (_, i) => i / 40)

describe('受电弓运动学（唯一来源）', () => {
  it('摆角端点与常量表一致', () => {
    const lo = armAngles(0)
    const hi = armAngles(1)
    expect((lo.a1 * 180) / Math.PI).toBeCloseTo(PANGLES.a1lo, 6)
    expect((hi.a1 * 180) / Math.PI).toBeCloseTo(PANGLES.a1hi, 6)
    expect((lo.a2 * 180) / Math.PI).toBeCloseTo(PANGLES.a2lo, 6)
    expect((hi.a2 * 180) / Math.PI).toBeCloseTo(PANGLES.a2hi, 6)
  })

  it('臂尖高度单调上升，且落在两个端位之间', () => {
    // 这是"升弓"这件事唯一不可协商的性质：手柄往前推，弓头只能往上走。
    let prev = -Infinity
    for (const p of SAMPLES) {
      const y = armY(p)
      expect(y).toBeGreaterThan(prev)
      prev = y
    }
    // 端位按实拍标定：落弓约 0.5m、升到位约 2.7m（相对车顶面）
    expect(armY(0)).toBeGreaterThan(0.45)
    expect(armY(0)).toBeLessThan(0.65)
    expect(armY(1)).toBeGreaterThan(2.6)
    expect(armY(1)).toBeLessThan(2.85)
  })

  it('弓头的前后窜动被限制在十几厘米内（单臂机构的固有特性）', () => {
    // 不是"顺便量一下"：窜动越大，弓头越容易从接触线下面滑出去，
    // 三维里就会看到"线从弓头一侧划到另一侧"——那是明显的假。
    // 实测 108mm（中段最靠前）：接触线只有一根，这个量级仍在滑板宽度以内。
    const zs = SAMPLES.map((p) => armZ(p))
    const travel = Math.max(...zs) - Math.min(...zs)
    expect(travel).toBeGreaterThan(0)
    expect(travel).toBeLessThan(0.13)
  })

  it('接触线高度由满行程自由顶面反推，不是写死的数', () => {
    expect(freeTop(1) - WIRE_Y).toBeCloseTo(0.042, 6)
    // 满行程必须真的压到线：压缩量在 (0, maxComp] 之间
    const comp = compression(1)
    expect(comp).toBeGreaterThan(0.03)
    expect(comp).toBeLessThanOrEqual(PGAP.maxComp)
  })

  it('未接触时压缩量为 0，且永不超过最大压缩量', () => {
    expect(compression(0)).toBe(0)
    for (const p of SAMPLES) {
      const c = compression(p)
      expect(c).toBeGreaterThanOrEqual(0)
      expect(c).toBeLessThanOrEqual(PGAP.maxComp)
    }
  })

  it('弓头顶面 = 臂尖 + 间隙 + 弓头自身高度', () => {
    for (const p of SAMPLES) {
      const top = armY(p) + (PGAP.free - compression(p)) + PGAP.headTop
      // 没顶到线时等于自由顶面；顶到之后被压住，永远不超过它
      expect(top).toBeLessThanOrEqual(freeTop(p) + 1e-9)
      if (compression(p) > 0) expect(top).toBeCloseTo(WIRE_Y, 6)
    }
  })

  it('几何常量彼此自洽：弓头宽度能盖住两根上臂', () => {
    // 上臂偏出 0.12m（见 pantograph.ts 的 ARM_OUT）
    const upperArmX = PDIM.armX + 0.12
    expect(PDIM.headHalf).toBeGreaterThan(upperArmX)
    // 滑板比弓头短，羊角才有地方弯出去
    expect(PDIM.stripLen / 2).toBeLessThan(PDIM.headHalf)
  })
})
