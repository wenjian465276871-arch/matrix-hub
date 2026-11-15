/** 尺寸锚点门禁（R25-2）：模型的**关键尺寸**必须落在公开值的 ±5% 内。
 *
 * ## 这条门禁补的是哪一类漏洞
 * 9 台设备里只有受电弓标定过（弓头 1950 / 滑板 1576 / 中心距 597），其余尺寸都是"看着差不多"。
 * 2026-11-15 实测：空调机组 2.4×1.7×0.38 vs 公开 2800×2100×650（**高度差 −42%**），
 * 万用表厚 46 vs 49.5（−7.1%），塞尺片长 90 vs 100（−10%）——没有一条会被现有门禁拦住：
 * `geometry.spec.ts` 只查"件有没有飞出去"，查不出"整台设备矮了四成"。
 *
 * ## 为什么判据是 ±5%
 * 技能手册 §1.2 写的外观目标：「比例对（关键尺寸误差 ≤ 5%，用公开参数或图纸标定）」。
 * 5% 是"能看出比例对"的界，再宽就解释不了 2026-11-12 那次"空调像个小箱子"的反馈。
 *
 * ## 口径
 * - 只登记**有公开出处**的数；没有出处的设备（配电柜 / 扳手 / 警示牌 / 操纵台）**不编数**，
 *   在这张表里没有条目，等于明示"未标定"。
 * - 刻意放大的量（塞尺片厚 2.2mm vs 真实 0.5mm、门缝 8mm vs 1–2mm）不进锚点表——
 *   它们本来就该夸大，写进来只会逼着后续改坏。
 * - 模型值**一律取自设备模块的常量**，不在这里另抄一份：抄一份就等于给了两个真值，
 *   改一处漏一处，门禁反而会"绿着骗人"。
 */
import { describe, expect, it } from 'vitest'

import { DIM } from './door'
import { BLADE } from './feeler_gauge'
import { U } from './hvac'
import { BODY } from './multimeter'
import { PDIM } from '../../lib/panto-kin'

/** 允许的相对误差（默认 5%）。 */
export const TOL = 0.05

export interface Anchor {
  device: string
  item: string
  /** 模型里的值（mm），由设备常量算出。 */
  modelMm: number
  /** 公开值（mm）。 */
  publishedMm: number
  /** 出处（写清"哪份资料的哪一条"）。 */
  source: string
}

/** 公开锚点表。每条都要能指回原文；指不回去的不要往这里加。 */
export const ANCHORS: Anchor[] = [
  // 受电弓 TSG19A（CRH380A）
  { device: 'pantograph', item: '弓头宽度', modelMm: PDIM.headHalf * 2000, publishedMm: 1950,
    source: '《CRH380A 受电弓详解》/ 统型驾驶设施讲义：弓头长 1950 mm' },
  { device: 'pantograph', item: '碳滑板长度', modelMm: PDIM.stripLen * 1000, publishedMm: 1576,
    source: '同上：滑板长 1576 mm' },
  { device: 'pantograph', item: '两滑板中心距', modelMm: PDIM.stripZ * 2000, publishedMm: 597,
    source: '统型驾驶设施讲义：两根滑板中心线距离约 597 mm' },
  // 客室车门（CRH380A 单扇内藏式侧拉门，1010 宽门）
  { device: 'door', item: '净通过宽度', modelMm: DIM.openW * 1000, publishedMm: 1010,
    source: 'CRH380A 侧拉门课件：净通过 720(1010)×1850 mm（取宽门 1010）' },
  { device: 'door', item: '净通过高度', modelMm: DIM.openH * 1000, publishedMm: 1850,
    source: '同上：净通过 720(1010)×1850 mm' },
  { device: 'door', item: '拉门行程', modelMm: DIM.slide * 1000, publishedMm: 1061,
    source: '同上：拉门行程 771(1061) mm（取宽门 1061）' },
  // 客室空调机组（KLD-40 级）
  { device: 'hvac', item: '机组长度', modelMm: U.L * 1000, publishedMm: 2800,
    source: '《铁道客车空调机组暂行技术条件》表 4：KLD-40 2800×2100×650（不含安装座与护板）' },
  { device: 'hvac', item: '机组宽度', modelMm: U.W * 1000, publishedMm: 2100,
    source: '同上' },
  { device: 'hvac', item: '机组高度', modelMm: U.H * 1000, publishedMm: 650,
    source: '同上' },
  // 数字万用表（Fluke 15B MAX）
  { device: 'multimeter', item: '表体高度', modelMm: BODY.h * 1000, publishedMm: 183,
    source: 'Fluke 15B MAX 产品规格：183(H)×91(W)×49.5(D) mm' },
  { device: 'multimeter', item: '表体宽度', modelMm: BODY.w * 1000, publishedMm: 91,
    source: '同上' },
  { device: 'multimeter', item: '表体厚度', modelMm: BODY.d * 1000, publishedMm: 49.5,
    source: '同上' },
  // 塞尺（GB/T 22523-2008）——厚度刻意放大，不进表
  { device: 'feeler_gauge', item: '片长', modelMm: BLADE.len * 1000, publishedMm: 100,
    source: 'GB/T 22523-2008：长度 100/150/200 mm，片宽 13 mm' },
  { device: 'feeler_gauge', item: '片宽', modelMm: BLADE.w * 1000, publishedMm: 13,
    source: '同上' },
]

/** 相对偏差；`publishedMm` 为 0 视作不合法（防止除零变成 Infinity 静默通过）。 */
export function deviation(modelMm: number, publishedMm: number): number {
  if (!Number.isFinite(modelMm) || !Number.isFinite(publishedMm) || publishedMm === 0) return Number.NaN
  return (modelMm - publishedMm) / publishedMm
}

/** 是否合格：偏差有限且绝对值 ≤ tol。NaN 一律判不合格（fail-closed）。 */
export function withinTol(modelMm: number, publishedMm: number, tol = TOL): boolean {
  const d = deviation(modelMm, publishedMm)
  return Number.isFinite(d) && Math.abs(d) <= tol
}

describe('尺寸锚点：模型关键尺寸 vs 公开值（±5%）', () => {
  it('锚点表至少覆盖 5 台设备（否则这条门禁形同虚设）', () => {
    const devices = new Set(ANCHORS.map((a) => a.device))
    expect(devices.size).toBeGreaterThanOrEqual(5)
  })

  it.each(ANCHORS.map((a) => [`${a.device} · ${a.item}`, a] as const))(
    '%s',
    (_name, a) => {
      const d = deviation(a.modelMm, a.publishedMm)
      // 失败信息要能直接照着改：给出两个值、偏差和出处
      expect(
        Math.abs(d),
        `${a.device} ${a.item}：模型 ${a.modelMm.toFixed(1)}mm vs 公开 ${a.publishedMm}mm` +
          `（偏差 ${(d * 100).toFixed(1)}%，容差 ±${TOL * 100}%）。出处：${a.source}`,
      ).toBeLessThanOrEqual(TOL)
    },
  )
})

describe('门禁本身能被证伪（负例）', () => {
  it('偏差 6% 必须判不合格（不能只证"能过"）', () => {
    expect(withinTol(1060, 1000)).toBe(false)
    expect(withinTol(940, 1000)).toBe(false)
  })

  it('差 5% 以内算合格（边界）', () => {
    expect(withinTol(1050, 1000)).toBe(true)
    expect(withinTol(950, 1000)).toBe(true)
  })

  it('NaN / 零基准必须判不合格（fail-closed）', () => {
    expect(withinTol(Number.NaN, 1000)).toBe(false)
    expect(withinTol(1000, 0)).toBe(false)
  })

  it('把空调长度改回 2.4m（−14.3%）会被这条门禁抓住', () => {
    expect(withinTol(2400, 2800)).toBe(false)
  })
})
