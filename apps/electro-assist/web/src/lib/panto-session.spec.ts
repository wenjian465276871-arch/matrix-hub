/** 升弓会话状态机：联锁、缺项提示、升弓推进。
 *
 *  这些断言不是在测"函数会不会返回 true"，而是在钉住三条现场规则：
 *  ① 不满足条件就发不出升弓指令，且原因说得出来；
 *  ② 提前松手，弓要回落，不能停在半空；
 *  ③ 升到位后松手，弓要保持——这是"保持升弓状态"在代码里的定义。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  RAISE_T,
  closeVcb,
  deskT,
  holdRaise,
  insertKey,
  monDone,
  moveBrakeFast,
  nextAction,
  releaseRaise,
  reset,
  selectUnit,
  session,
  stageText,
  stepRaise,
  turnKey,
  type MonKey,
} from './panto-session'

const ALL: MonKey[] = ['voltage', 'mr', 'egs', 'vcb', 'panto_cut']

function confirmAll(): void {
  for (const key of ALL) session.mon[key] = true
}

/** 把动作推到指定进度（秒）。 */
function advance(seconds: number, step = 0.05): void {
  for (let t = 0; t < seconds; t += step) stepRaise(step)
}

describe('升弓推进与帧率无关', () => {
  beforeEach(() => reset())

  it('一大步 dt 按真实时间算，不按帧数算', () => {
    // 组件把每帧 dt 钳到 1s（`PantoOps` 的 MAX_DT）。CI 的软件渲染只有 1–2fps，
    // 若仍按"每帧 0.1s"推进，4.6 秒的动作会被拉成 46 秒——run 43460025005 就是这么挂的。
    session.keyInserted = true
    session.keyTurned = true
    session.brakeFast = true
    session.unit = '2U'
    confirmAll()
    expect(holdRaise().ok).toBe(true)

    // 1 帧 = 1 秒：应推进 0.72/4.6 ≈ 0.156
    stepRaise(1)
    expect(session.raiseT).toBeCloseTo(RAISE_T / 4.6, 3)

    // 5 帧走满
    for (let i = 0; i < 4; i += 1) stepRaise(1)
    expect(session.raiseT).toBeCloseTo(RAISE_T, 3)
    expect(session.raised).toBe(true)
  })
})

describe('升弓联锁', () => {
  beforeEach(() => reset())

  it('没插钥匙就转不动锁芯', () => {
    const r = turnKey()
    expect(r.ok).toBe(false)
    expect(r.hint).toContain('先插入主控钥匙')
  })

  it('没右旋钥匙，手柄推到快速位也无效', () => {
    insertKey()
    const r = moveBrakeFast()
    expect(r.ok).toBe(false)
    expect(r.hint).toContain('钥匙要先右旋')
  })

  it('MCR 没励磁就选不了单元', () => {
    expect(selectUnit('2U').ok).toBe(false)
  })

  it('MON 五项没确认完，升弓指令被拒绝并点名缺哪几项', () => {
    insertKey()
    turnKey()
    moveBrakeFast()
    selectUnit('2U')
    const r = holdRaise()
    expect(r.ok).toBe(false)
    expect(r.hint).toContain('MON 确认未完成')
    expect(r.hint).toContain('蓄电池/控制电压')
  })

  it('逐项确认后能发出升弓指令', () => {
    insertKey()
    turnKey()
    moveBrakeFast()
    selectUnit('2U')
    confirmAll()
    expect(monDone()).toBe(5)
    const r = holdRaise()
    expect(r.ok).toBe(true)
    expect(session.raiseHeld).toBe(true)
  })

  it('受电弓没升起，VCB 合不上', () => {
    const r = closeVcb()
    expect(r.ok).toBe(false)
    expect(r.hint).toContain('联锁')
  })
})

describe('升弓动作', () => {
  beforeEach(() => {
    reset()
    insertKey()
    turnKey()
    moveBrakeFast()
    selectUnit('2U')
    confirmAll()
  })

  it('按住旋钮约 4.6 秒到 0.72，并把 raised 置真', () => {
    holdRaise()
    advance(4.7)
    expect(session.raiseT).toBeCloseTo(RAISE_T, 5)
    expect(session.raised).toBe(true)
    expect(stageText()).toContain('升弓到位')
  })

  it('提前松手，弓回落而不是停在半空', () => {
    holdRaise()
    advance(2)
    expect(session.raiseT).toBeGreaterThan(0)
    const r = releaseRaise()
    expect(r.ok).toBe(true)
    advance(3)
    expect(session.raiseT).toBe(0)
    expect(session.raised).toBe(false)
    expect(r.hint).toContain('回落')
  })

  it('升到位后松手，保持升弓状态', () => {
    holdRaise()
    advance(4.7)
    releaseRaise()
    advance(3)
    expect(session.raiseT).toBeCloseTo(RAISE_T, 5)
    expect(session.raised).toBe(true)
    expect(stageText()).toContain('保压')
  })

  it('升到位后合 VCB，状态推进到送电完成', () => {
    holdRaise()
    advance(4.7)
    releaseRaise()
    expect(closeVcb().ok).toBe(true)
    expect(stageText()).toContain('VCB 闭合')
    expect(deskT()).toBe(1)
  })
})

describe('操作台进度映射', () => {
  beforeEach(() => reset())

  it('八拍按顺序对齐：0 → 0.12 → 0.22 → 0.36 → 0.5 → 0.64 → 0.8', () => {
    expect(deskT()).toBe(0)
    insertKey()
    expect(deskT()).toBe(0.12)
    turnKey()
    expect(deskT()).toBe(0.22)
    moveBrakeFast()
    expect(deskT()).toBe(0.36)
    selectUnit('2U')
    expect(deskT()).toBe(0.5)
    confirmAll()
    holdRaise()
    expect(deskT()).toBe(0.64)
    advance(4.7)
    expect(deskT()).toBe(0.8)
    releaseRaise()
    closeVcb()
    expect(deskT()).toBe(1)
  })

  it('nextAction 随状态推进，始终只说下一步', () => {
    expect(nextAction()).toContain('插入主控钥匙')
    insertKey()
    expect(nextAction()).toContain('右旋')
    turnKey()
    expect(nextAction()).toContain('快速')
    moveBrakeFast()
    expect(nextAction()).toContain('MON')
    confirmAll()
    expect(nextAction()).toContain('单元')
    selectUnit('3U')
    expect(nextAction()).toContain('按住升弓旋钮')
    holdRaise()
    advance(4.7)
    expect(nextAction()).toContain('已升起')
  })
})
