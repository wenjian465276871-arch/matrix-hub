/** 车门开关门会话：锁三条联锁、两条时序与防夹分支。
 *
 *  这套用例要能证明的只有一件事：**"关门"不是一个按钮，是一条有后果的流程**。
 *  - 未释放就不能开门（集控的真实顺序）；
 *  - 门没开到位不能测关门时间；
 *  - 中缝有试块时门必须反开，满 3 次必须报故障——而不是"关上门了"。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { insertKey, moveBrakeFast, resetPower, turnKey } from './desk-power'
import {
  CLOSE_SECONDS,
  OPEN_SECONDS,
  close,
  confirmDoor,
  door,
  doorState,
  open,
  release,
  reset,
  selectSide,
  stepDoor,
  toggleBlock,
} from './door-session'

function powerOn(): void {
  insertKey()
  turnKey()
  moveBrakeFast()
}

/** 一步跑到位：等价于按住 3.2 / 3.6 秒。
 *
 * 原来产品模块里导出一个 `settleDoor()` 专供测试（注释还写着"E2E 与讲解用"，
 * 实际只有本文件引用）。评审 R23-4 之后改成**在测试里用真实推进函数跑到停**——
 * 顺手让这几条用例多走一遍 `stepDoor`，少一个只在测试里存在的出口。
 */
function settleDoor(): void {
  for (let i = 0; i < 80; i += 1) {
    if (!stepDoor(0.2)) return
  }
}

/** 上电 → 释放 → 开门 → 跑到位。 */
function toOpen(): void {
  powerOn()
  release()
  open()
  settleDoor()
}

/** 一直跑到门停下（反开是两段：先收到 PINCH_AT、再回全开）。 */
function runToRest(): void {
  for (let i = 0; i < 60; i += 1) {
    if (!stepDoor(0.2)) return
  }
  throw new Error('门扇 12 秒内没停下')
}

beforeEach(() => {
  reset()
  resetPower()
})

describe('door 会话：集控三步', () => {
  it('未上电时释放被拒绝', () => {
    const result = release()
    expect(result.ok).toBe(false)
    expect(result.hint).toContain('MON 未上电')
  })

  it('未投入集控就开门，被拒绝并点名集控开关', () => {
    powerOn()
    const result = open()
    expect(result.ok).toBe(false)
    expect(result.hint).toContain('集控')
  })

  it('门关闭时再按一次释放 = 复位（灯灭）', () => {
    powerOn()
    release()
    expect(door.released).toBe(true)
    const reset = release()
    expect(reset.ok).toBe(true)
    expect(door.released).toBe(false)
    expect(reset.hint).toContain('复位')
  })

  it('开门过程中关门灯必须灭（不能在第一帧被重新点亮）', () => {
    powerOn()
    release()
    expect(door.closedLed).toBe(true)
    open()
    expect(door.closedLed).toBe(false)
    // 起开的第一帧：openT 还近似 0
    stepDoor(0.02)
    expect(door.closedLed).toBe(false)
    // 走完整段仍然灭
    for (let i = 0; i < 40; i += 1) stepDoor(0.1)
    expect(door.openT).toBe(1)
    expect(door.closedLed).toBe(false)
  })

  it('释放后开门，门扇从关闭位开始动作', () => {
    powerOn()
    expect(release().ok).toBe(true)
    expect(door.released).toBe(true)
    expect(open().ok).toBe(true)
    expect(door.target).toBe(1)
    expect(door.closedLed).toBe(false)
    expect(stepDoor(0.5)).toBe(true)
    expect(door.openT).toBeGreaterThan(0)
  })

  it('开门到位耗时 3.2 s：3.1 s 没到、3.3 s 到了', () => {
    powerOn()
    release()
    open()
    stepDoor(OPEN_SECONDS - 0.1)
    expect(door.openT).toBeLessThan(1)
    stepDoor(0.2)
    expect(door.openT).toBe(1)
    expect(doorState()).toBe('完全开启')
  })

  it('门没开到位时不能测关门', () => {
    powerOn()
    release()
    open()
    stepDoor(0.4)
    const result = close()
    expect(result.ok).toBe(false)
    expect(result.hint).toContain('开到位')
  })

  it('关门到位耗时 3.6 s，到位后关门灯亮、状态回到关闭锁闭', () => {
    toOpen()
    expect(close().ok).toBe(true)
    stepDoor(CLOSE_SECONDS - 0.1)
    expect(door.openT).toBeGreaterThan(0)
    stepDoor(0.2)
    expect(door.openT).toBe(0)
    expect(doorState()).toBe('关闭锁闭')
    expect(door.closedLed).toBe(true)
  })
})

describe('door 会话：防夹', () => {
  it('中缝有试块时关门会反开，且不亮关门灯', () => {
    toOpen()
    toggleBlock()
    const result = close()
    expect(result.ok).toBe(false)
    expect(result.hint).toContain('碰到试块')
    expect(result.hint).toContain('反向开门')
    expect(door.bumps).toBe(1)

    // 单扇门扇前缘碰到关闭边的试块（开度 0.22）判定受阻，然后反向回到全开
    stepDoor(1)
    expect(door.openT).toBeLessThan(1)
    runToRest()
    expect(door.openT).toBe(1)
    expect(door.closedLed).toBe(false)
  })

  it('连续 3 次受阻报故障，停在全开位', () => {
    toOpen()
    toggleBlock()
    close()
    runToRest()
    close()
    runToRest()
    const third = close()
    expect(third.ok).toBe(false)
    expect(door.bumps).toBe(3)
    expect(door.fault).toContain('关门障碍物超次数')
    runToRest()
    expect(door.openT).toBe(1)
  })

  it('撤除试块后复测能正常关门，反开次数与故障清零', () => {
    toOpen()
    toggleBlock()
    close()
    runToRest()
    toggleBlock()
    expect(door.bumps).toBe(0)
    expect(door.fault).toBe('')
    expect(close().ok).toBe(true)
    settleDoor()
    expect(door.openT).toBe(0)
  })

  it('有故障时不能确认「无故障」', () => {
    powerOn()
    door.fault = '关门障碍物超次数：门停在全开位'
    const result = confirmDoor('nofault')
    expect(result.ok).toBe(false)
    expect(result.hint).toContain('复位')
  })
})

describe('door 会话：状态与确认', () => {
  it('门开着时不能确认「全列关闭锁闭」', () => {
    toOpen()
    const result = confirmDoor('closed')
    expect(result.ok).toBe(false)
    expect(result.hint).toContain('关到位')
  })

  it('门关闭时三项确认都能过', () => {
    powerOn()
    expect(confirmDoor('closed').ok).toBe(true)
    expect(confirmDoor('isolated').ok).toBe(true)
    expect(confirmDoor('nofault').ok).toBe(true)
  })

  it('门未关闭时换侧被拒绝（避免试验侧串台）', () => {
    toOpen()
    const result = selectSide('R')
    expect(result.ok).toBe(false)
    expect(result.hint).toContain('关门')
  })

  it('关门灯在门打开时灭、关闭时亮', () => {
    expect(door.closedLed).toBe(true)
    toOpen()
    expect(door.closedLed).toBe(false)
    close()
    settleDoor()
    expect(door.closedLed).toBe(true)
  })
})
