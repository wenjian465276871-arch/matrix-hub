/** 按步裁剪口径：前端表必须覆盖后端允许的每一个 `act`（评审 R23-1，2026-11-15）。
 *
 * ## 这条用例拦的是什么
 * 评审复现过一个 fail-open：`allowed()` 写成 `table[phase] ?? table.all`，`act` 取未知值
 * 时**本步之外的件全部放行**。而三份口径（后端 `INTERACTIVE_SCENES` / 前端表 / 样例）
 * 之间本来没有任何机检——只改后端的 `ops_acts`、前端没跟，页面看着正常，
 * 越界动作静默生效。
 *
 * 现在后端把口径导出到契约（`scenes`），这里逐键断言前端表**至少**覆盖它。
 * 前端多出的键（如 `all`）是允许的：它是"旧样例不带 act"的兜底。
 */
import { describe, expect, it, vi } from 'vitest'

import contract from '../contract/devices.json'
import {
  OPS_ALLOWED,
  PANTO_ALLOWED,
  allowList,
  resetWarnings,
  warnOnce,
  type AllowTable,
} from './ops-allowed'

type SceneSpec = { ops_acts: string[]; ops_views: string[] }
const SCENES = (contract as unknown as { scenes: Record<string, SceneSpec> }).scenes

/** 前端表 ↔ 契约场景的对应关系（场景键与组件内的简称不同，映射写在这里一处）。 */
const PAIRS: Array<[string, AllowTable]> = [
  ['pantograph_raise', PANTO_ALLOWED],
  ['hvac_cooling', OPS_ALLOWED.hvac],
  ['door_switch', OPS_ALLOWED.door],
]

describe('按步裁剪口径与后端契约一致', () => {
  it('契约里每个场景每个 act，前端都有对应的一行', () => {
    for (const [scene, table] of PAIRS) {
      const spec = SCENES[scene]
      expect(spec, `契约里没有 ${scene}`).toBeTruthy()
      for (const act of spec.ops_acts) {
        expect(allowList(table, act), `${scene} 的 act「${act}」前端表里缺一行`).not.toBeNull()
      }
    }
  })

  it('每一行的件名都非空、无重复', () => {
    for (const [scene, table] of PAIRS) {
      for (const [act, list] of Object.entries(table)) {
        expect(list.length, `${scene}.${act} 是空表`).toBeGreaterThan(0)
        for (const key of list) expect(key, `${scene}.${act} 里有空键`).not.toBe('')
        expect(new Set(list).size, `${scene}.${act} 有重复键`).toBe(list.length)
      }
    }
  })

  it('契约里每个 view 都是前端认得的三个之一（认不得就不该在契约里）', () => {
    // 前端的 view 归一化只认 desk / both / mon；契约多一个值就等于那一路永远走到 desk。
    for (const [scene, spec] of Object.entries(SCENES)) {
      for (const view of spec.ops_views) {
        expect(['desk', 'both', 'mon'], `${scene} 的 view「${view}」前端不认`).toContain(view)
      }
    }
  })
})

describe('fail-closed 判定', () => {
  it('未知 act / 未知场景都返回 null（调用方必须拒绝，不许兜底成全放开）', () => {
    expect(allowList(OPS_ALLOWED.door, 'nope')).toBeNull()
    expect(allowList(PANTO_ALLOWED, 'nope')).toBeNull()
    expect(allowList(undefined, 'power')).toBeNull()
  })

  it('已知 act 返回对应清单', () => {
    expect(allowList(OPS_ALLOWED.door, 'check')).toEqual(['mon'])
    expect(allowList(PANTO_ALLOWED, 'raise')).toContain('vcb')
  })

  it('warnOnce 同一 key 只响一次（渲染路径里刷屏比不告警更糟）', () => {
    resetWarnings()
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warnOnce('k', '第一次')
    warnOnce('k', '第二次')
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
    resetWarnings()
  })
})
