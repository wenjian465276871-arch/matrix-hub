/** 司机室操纵台上电状态机（三项试验共用那一层）。
 *
 * 2026-11-15 新增两条**行为**，各自都要有人守着，否则下次改动会静默跑偏：
 * 1. 钥匙插孔在**制动手柄的锁芯**里 ⇒ 手柄不在「拔取」位时插不进去（闸门）；
 * 2. 制动控制器是 **10 档**（拔取 / 运行 / B1–B7 / 快速），不是"一个快速位"。
 *
 * 这里只测状态机本身；三维里钥匙转多少度、指针指到哪，属于 `driver_desk` 的
 * `geometry.spec` 与 E2E 的事，不在这里重复断言。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  BRAKE_STOPS,
  deskT,
  insertKey,
  moveBrakeFast,
  nextPowerAction,
  power,
  powerStage,
  powered,
  resetPower,
  turnKey,
} from './desk-power'

beforeEach(() => {
  resetPower()
})

describe('制动档位表', () => {
  it('是 10 档，顺序为 拔取 → 运行 → B1…B7 → 快速', () => {
    expect(BRAKE_STOPS).toHaveLength(10)
    expect(BRAKE_STOPS[0]).toBe('拔取')
    expect(BRAKE_STOPS[1]).toBe('运行')
    expect([...BRAKE_STOPS.slice(2, 9)]).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7'])
    expect(BRAKE_STOPS[9]).toBe('快速')
  })

  it('初始停在拔取位（索引 0），不是快速位', () => {
    expect(power.brakePos).toBe(0)
    expect(power.brakeFast).toBe(false)
  })
})

describe('上电三件的顺序', () => {
  it('拔取位插钥匙 → 顺时针 90° → 手柄快速位，三步各自只推进一格', () => {
    expect(powered()).toBe(false)

    const ins = insertKey()
    expect(ins.ok).toBe(true)
    expect(power.keyInserted).toBe(true)
    // 插进去还没占用：MON 不亮
    expect(powered()).toBe(false)

    const turn = turnKey()
    expect(turn.ok).toBe(true)
    expect(turn.hint).toContain('顺时针')
    // 占用但手柄还在拔取位：MON 仍不亮
    expect(powered()).toBe(false)

    const move = moveBrakeFast()
    expect(move.ok).toBe(true)
    expect(power.brakePos).toBe(BRAKE_STOPS.length - 1)
    expect(powered()).toBe(true)
  })
})

describe('插钥匙的闸门：手柄必须在拔取位', () => {
  it('手柄不在拔取位时拒绝，并点名「拔取」，且不写入已插入状态', () => {
    // 模拟"手柄被扳到 B2 才想起插钥匙"——真实作业里最容易犯的错
    power.brakePos = 3
    const r = insertKey()
    expect(r.ok).toBe(false)
    expect(r.hint).toContain('拔取')
    expect(power.keyInserted).toBe(false)
    // 后续两步必须也走不动（闸门不是只拦住插钥匙这一个动作）
    expect(turnKey().ok).toBe(false)
    expect(moveBrakeFast().ok).toBe(false)
  })

  it('扳回拔取位后，同一动作就能插进去（闸门可复位）', () => {
    power.brakePos = 3
    expect(insertKey().ok).toBe(false)
    power.brakePos = 0
    expect(insertKey().ok).toBe(true)
  })

  it('未插钥匙时转不动锁芯、也推不动手柄', () => {
    const turn = turnKey()
    expect(turn.ok).toBe(false)
    expect(turn.hint).toContain('钥匙')
    expect(power.keyTurned).toBe(false)

    const move = moveBrakeFast()
    expect(move.ok).toBe(false)
    expect(move.hint).toContain('90')
    expect(power.brakeFast).toBe(false)
    expect(power.brakePos).toBe(0)
  })

  it('已插钥匙时再点钥匙＝直接转（幂等入口，不重复插）', () => {
    insertKey()
    const again = insertKey()
    expect(again.ok).toBe(true)
    expect(power.keyTurned).toBe(true)
  })
})

describe('三维进度与文案', () => {
  it('deskT 四档落在后端 DEVICE_MOMENTS 的 0 / 0.12 / 0.22 / 0.36', () => {
    expect(deskT()).toBe(0)
    insertKey()
    expect(deskT()).toBe(0.12)
    turnKey()
    expect(deskT()).toBe(0.22)
    moveBrakeFast()
    expect(deskT()).toBe(0.36)
  })

  it('powerStage 报出手柄所在档位；nextPowerAction 指向下一个动作', () => {
    expect(powerStage()).toBe('未上电')
    expect(nextPowerAction()).toContain('插入主控钥匙')

    insertKey()
    expect(powerStage()).toBe('钥匙已插入')
    expect(nextPowerAction()).toContain('顺时针')

    turnKey()
    expect(powerStage()).toContain('拔取')
    expect(nextPowerAction()).toContain('快速')

    moveBrakeFast()
    expect(powerStage()).toBe('上电完成')
    expect(nextPowerAction()).toBe('')
  })

  it('手柄不在拔取位时，nextPowerAction 先让人把它扳回去（而不是叫去插钥匙）', () => {
    power.brakePos = 5
    expect(nextPowerAction()).toContain('扳回')
  })

  it('resetPower 把四件事一起归零', () => {
    insertKey()
    turnKey()
    moveBrakeFast()
    resetPower()
    expect(power).toMatchObject({ keyInserted: false, keyTurned: false, brakeFast: false, brakePos: 0 })
    expect(powered()).toBe(false)
  })
})
