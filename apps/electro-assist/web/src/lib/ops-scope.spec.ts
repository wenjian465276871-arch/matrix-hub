/** 交互状态的作用域：换一份指导书必须回到"什么都没做"。
 *
 *  2026-11-14 本人实测：从空调试验切到车门试验，还没插钥匙，司机台就显示已上电
 *  ——模块级单例跨指导书共享。`resetAllOps()` 是那条边界的唯一执行点。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { insertKey, moveBrakeFast, power, resetPower, turnKey } from './desk-power'
import { hvac, reset as resetHvac, selectMode } from './hvac-session'
import { door, reset as resetDoor, release } from './door-session'
import { session as panto, reset as resetPanto } from './panto-session'
import { resetAllOps } from './ops-scope'

beforeEach(() => {
  resetAllOps()
})

describe('resetAllOps', () => {
  it('四项状态一起清：司机台未上电、空调未设、车门未释放、受电弓未动', () => {
    insertKey()
    turnKey()
    moveBrakeFast()
    selectMode('cool')
    release()
    panto.raised = true

    resetAllOps()

    expect(power.keyInserted).toBe(false)
    expect(power.brakeFast).toBe(false)
    expect(hvac.pending).toBe('off')
    expect(door.released).toBe(false)
    expect(panto.raised).toBe(false)
  })

  it('不依赖调用顺序：先清一次再操作，仍然从零开始', () => {
    resetPower()
    resetHvac()
    resetDoor()
    resetPanto()
    insertKey()
    resetAllOps()
    expect(power.keyInserted).toBe(false)
    expect(hvac.mode).toBe('off')
  })
})
