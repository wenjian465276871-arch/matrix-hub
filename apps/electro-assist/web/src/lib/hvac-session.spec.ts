/** 空调制冷冷冻试验的会话状态：锁四条联锁与一组"推出来的读数"。
 *
 *  这些用例的价值不在"函数被调用"，而在三条**物理约束**真的会拦人：
 *  ① MON 没上电设参数是假动作；② 设定温度不低于回风时压缩机不启动；
 *  ③ 没起通风就起制冷，蒸发器会结霜。
 *  任何一条退化成"点了就过"，演示就成了贴纸——所以每条都正反各测一遍。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { moveBrakeFast, insertKey, resetPower, turnKey } from './desk-power'
import {
  HVAC_ITEMS,
  VENT_KEYS,
  applicable,
  applySettings,
  bumpTemp,
  compressorCurrent,
  confirmDone,
  confirmHvac,
  highPressure,
  lowPressure,
  reset,
  returnTemp,
  selectMode,
  stepCooling,
  supplySpeed,
  supplyTemp,
  tempDiff,
  toggleFreshAir,
  ventConfirmDone,
  hvac,
} from './hvac-session'

/** 完成上电：钥匙插入 → 右旋 → 手柄快速位。 */
function powerOn(): void {
  insertKey()
  turnKey()
  moveBrakeFast()
}

/** 直接进入制冷运行：上电 → 选制冷 → 下发（模式即起动）。 */
function toCooling(): void {
  powerOn()
  selectMode('cool')
  applySettings()
}

/** 直接推到稳态（等价 25 s）：原来产品模块里导出 `settleCooling()` 专供测试，
 *  评审 R23-4 之后改成本地 helper，生产代码里不再留测试入口。 */
function settleCooling(): void {
  stepCooling(25)
}

beforeEach(() => {
  reset()
  resetPower()
})

describe('hvac 会话：上电与设定', () => {
  it('未上电时选模式与下发都被拒绝，且给出原因', () => {
    const picked = selectMode('cool')
    expect(picked.ok).toBe(false)
    expect(picked.hint).toContain('MON 未上电')

    const applied = applySettings()
    expect(applied.ok).toBe(false)
    expect(applied.hint).toContain('MON 未上电')

    const bumped = bumpTemp(0.5)
    expect(bumped.ok).toBe(false)
  })

  it('只右旋钥匙还不够：手柄不在快速位时仍算未上电', () => {
    insertKey()
    turnKey()
    expect(selectMode('cool').ok).toBe(false)
  })

  it('上电后可选模式、调温度，下发才写入机组', () => {
    powerOn()
    expect(selectMode('cool').ok).toBe(true)
    expect(hvac.pending).toBe('cool')
    expect(hvac.mode).toBe('off')

    expect(bumpTemp(-0.5).ok).toBe(true)
    expect(hvac.pendingTemp).toBe(23.5)
    expect(hvac.setTemp).toBe(24)

    expect(applySettings().ok).toBe(true)
    expect(hvac.mode).toBe('cool')
    expect(hvac.setTemp).toBe(23.5)
  })

  it('设定温度有上下限：到限后拒绝并说明', () => {
    powerOn()
    for (let i = 0; i < 20; i += 1) bumpTemp(0.5)
    expect(hvac.pendingTemp).toBe(30)
    const over = bumpTemp(0.5)
    expect(over.ok).toBe(false)
    expect(over.hint).toContain('上限')
  })
})

describe('hvac 会话：模式即起动', () => {
  it('下发通风 = 风机运行、压缩机不工作', () => {
    powerOn()
    selectMode('vent')
    expect(applySettings().ok).toBe(true)
    expect(hvac.ventRunning).toBe(true)
    expect(hvac.cooling).toBe(false)
  })

  it('下发制冷 = 压缩机随即起动（没有独立的"起动制冷"按钮）', () => {
    powerOn()
    selectMode('cool')
    expect(applySettings().ok).toBe(true)
    expect(hvac.cooling).toBe(true)
    expect(hvac.ventRunning).toBe(true)
  })

  it('新风门未关闭时不允许下发制冷（温差测不准）', () => {
    powerOn()
    selectMode('cool')
    expect(toggleFreshAir().ok).toBe(true)
    expect(hvac.freshAir).toBe('open')
    const result = applySettings()
    expect(result.ok).toBe(false)
    expect(result.hint).toContain('新风门')
    expect(hvac.cooling).toBe(false)
    toggleFreshAir()
    expect(applySettings().ok).toBe(true)
  })

  it('设定温度不低于回风 2 ℃ 时压缩机不启动', () => {
    powerOn()
    selectMode('cool')
    // 回风 28.5 ℃：设定 27 ℃ 只低 1.5 ℃，不够
    for (let i = 0; i < 6; i += 1) bumpTemp(0.5)
    const result = applySettings()
    expect(result.ok).toBe(false)
    expect(result.hint).toContain('设定温度调低')
    expect(hvac.cooling).toBe(false)
  })

  it('从通风切到制冷：再次下发即切换，且制冷进程从头开始', () => {
    powerOn()
    selectMode('vent')
    applySettings()
    expect(hvac.mode).toBe('vent')
    selectMode('cool')
    expect(applySettings().ok).toBe(true)
    expect(hvac.mode).toBe('cool')
    expect(hvac.cooling).toBe(true)
    expect(hvac.coolT).toBe(0)
  })
})

describe('hvac 会话：推出来的读数', () => {
  it('制冷前所有差值都为 0，起动后随 coolT 上升', () => {
    expect(tempDiff()).toBe(0)
    toCooling()
    expect(hvac.cooling).toBe(true)
    expect(stepCooling(12.5)).toBe(true)
    expect(hvac.coolT).toBeCloseTo(0.5, 2)
    // 半程：温差 5 ℃、电流已到 12.4（3 秒内爬满）
    expect(tempDiff()).toBeCloseTo(5, 1)
    expect(compressorCurrent()).toBe(12.4)
  })

  /* ---- 重复下发幂等（评审 R23-3，2026-11-15）----
     原来运行中再点一次「下发设定」会掉进"设定温度不低于回风"分支，回一句
     「压缩机不会启动」——而屏上正写着「压缩机 12.4 A」。同一块屏否定自己的读数。 */
  it('同一份设定重复下发是幂等的：不重置制冷进程，也不说"不会启动"', () => {
    toCooling()
    settleCooling()
    expect(hvac.coolT).toBe(1)
    const again = applySettings()
    expect(again.ok).toBe(true)
    expect(again.hint).toContain('设定未变')
    expect(again.hint).not.toContain('不会启动')
    expect(hvac.coolT, '重复下发把 15 分钟的制冷进程打回了 0').toBe(1)
  })

  it('通风运行中重复下发同样幂等（风机不停）', () => {
    powerOn()
    selectMode('vent')
    expect(applySettings().ok).toBe(true)
    const again = applySettings()
    expect(again.ok).toBe(true)
    expect(hvac.ventRunning).toBe(true)
  })

  it('稳定后四项读数全部落在指导书的判据区间内', () => {
    toCooling()
    settleCooling()
    expect(supplySpeed()).toBeGreaterThanOrEqual(1.5)
    expect(supplySpeed()).toBeLessThanOrEqual(3.0)
    expect(tempDiff()).toBeGreaterThanOrEqual(6)
    expect(tempDiff()).toBeLessThanOrEqual(12)
    expect(compressorCurrent()).toBeGreaterThanOrEqual(10)
    expect(compressorCurrent()).toBeLessThanOrEqual(14)
    expect(highPressure()).toBeGreaterThanOrEqual(1.4)
    expect(highPressure()).toBeLessThanOrEqual(1.8)
    expect(lowPressure()).toBeGreaterThanOrEqual(0.2)
    expect(lowPressure()).toBeLessThanOrEqual(0.5)
    // 送风必须低于回风，否则"温差"这个概念就反了
    expect(supplyTemp()).toBeLessThan(returnTemp())
  })

  it('压缩机运行时不许改模式与设定温度', () => {
    toCooling()
    expect(selectMode('heat').ok).toBe(false)
    expect(bumpTemp(0.5).ok).toBe(false)
  })
})

describe('hvac 会话：MON 确认', () => {
  it('压缩机没起时不能确认电流与压力', () => {
    powerOn()
    const comp = confirmHvac('comp')
    expect(comp.ok).toBe(false)
    expect(comp.hint).toContain('压缩机')
    expect(confirmHvac('pressure').ok).toBe(false)
  })

  it('通风模式：只有三项可确认，压缩机与高压侧压力不适用', () => {
    powerOn()
    selectMode('vent')
    applySettings()
    expect(VENT_KEYS).toHaveLength(3)
    expect(applicable('comm')).toBe(true)
    expect(applicable('drain')).toBe(true)
    expect(applicable('comp')).toBe(false)
    expect(applicable('pressure')).toBe(false)
    // 点它要给"为什么"，而不是静默无视
    const r = confirmHvac('comp')
    expect(r.ok).toBe(false)
    expect(r.hint).toContain('通风模式')
    expect(ventConfirmDone()).toBe(0)
    for (const key of VENT_KEYS) expect(confirmHvac(key).ok).toBe(true)
    expect(ventConfirmDone()).toBe(3)
    // 三项确认完，五项计数只涨到 3
    expect(confirmDone()).toBe(3)
  })

  it('通风模式：切制冷之后两项才变成可确认', () => {
    powerOn()
    selectMode('vent')
    applySettings()
    expect(applicable('comp')).toBe(false)
    selectMode('cool')
    applySettings()
    expect(applicable('comp')).toBe(true)
    expect(applicable('pressure')).toBe(true)
  })

  it('排水与滤网的显示值是「—」而不是「未确认」', () => {
    powerOn()
    selectMode('vent')
    applySettings()
    const drain = HVAC_ITEMS.find((i) => i.key === 'drain')!
    expect(drain.value()).toBe('—')
    confirmHvac('drain')
    expect(drain.value()).toBe('畅通、清洁')
    // 压缩机在通风时同样显示「—」（不转就没有读数）
    expect(HVAC_ITEMS.find((i) => i.key === 'comp')!.value()).toBe('—')
  })

  it('风机没转时不能确认风机状态', () => {
    powerOn()
    expect(confirmHvac('fan').ok).toBe(false)
  })

  it('起机后逐项确认能累加', () => {
    toCooling()
    expect(confirmHvac('fan').ok).toBe(true)
    expect(confirmHvac('comp').ok).toBe(true)
    expect(hvac.confirmed.fan).toBe(true)
    expect(hvac.confirmed.comp).toBe(true)
  })
})
