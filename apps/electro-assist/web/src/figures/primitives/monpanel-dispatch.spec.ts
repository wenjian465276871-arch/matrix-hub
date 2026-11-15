/** mon_panel 的场景分发：一块组件壳，三块屏。
 *
 *  锁的是"哪个场景出哪块屏"与两块新屏的**关键控件**：
 *  空调屏要能选模式、调温度、下发；车门屏要能逐项确认。
 *  这两条路径在 E2E 里也走，但 E2E 跑一次 20 秒——分支一出错，
 *  单测能在 20 毫秒里说清是哪一处。
 */
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'

import MonPanel from './MonPanel.vue'
import { insertKey, moveBrakeFast, resetPower, turnKey } from '../../lib/desk-power'
import { hvac, reset as resetHvac } from '../../lib/hvac-session'
import { door, reset as resetDoor } from '../../lib/door-session'
import { reset as resetPanto } from '../../lib/panto-session'

// 参数都是标量字符串，直接用 `Record<string, string>`：写成 unknown 会被
// `Record<string, ParamValue>` 的 props 拒掉（vue-tsc 会红，构建就停在类型检查那一步）。
function mountPanel(params: Record<string, string>) {
  return mount(MonPanel, { props: { params, label: 'MON' } })
}

function powerOn(): void {
  insertKey()
  turnKey()
  moveBrakeFast()
}

beforeEach(() => {
  resetHvac()
  resetDoor()
  resetPower()
  resetPanto()
})

describe('mon_panel 分发', () => {
  it('不带 scene 时仍走升弓那块屏（旧样例与旧测试的兼容口径）', () => {
    const w = mountPanel({ tab: 'power', mode: 'check' })
    expect(w.find('.mon__rows').exists()).toBe(true)
    expect(w.find('.hmon').exists()).toBe(false)
  })

  it('hvac_cooling 出空调屏，页签是空调设定 / 机组状态 / 客室温度', () => {
    const w = mountPanel({ scene: 'hvac_cooling', tab: 'set', mode: 'check' })
    const tabs = w.findAll('.hmon__tab').map((t) => t.text())
    expect(tabs).toEqual(['空调设定', '机组状态', '客室温度'])
  })

  it('door_switch 出车门屏，状态页有三项可确认 + 一行关门灯', () => {
    const w = mountPanel({ scene: 'door_switch', tab: 'status', mode: 'check' })
    expect(w.findAll('.dmon__hit:not(.dmon__hit--static)')).toHaveLength(3)
    expect(w.findAll('.dmon__row')).toHaveLength(4)
  })
})

describe('空调屏：设定控件', () => {
  it('未上电时点模式被拒绝，屏上给出原因', async () => {
    const w = mountPanel({ scene: 'hvac_cooling', tab: 'set', mode: 'check' })
    await w.findAll('.hmon__key')[0].trigger('click')
    expect(hvac.pending).toBe('off')
    expect(w.get('.hmon__foot-text').text()).toContain('MON 未上电')
  })

  it('上电后选制冷、调温、下发，状态牌跟着变', async () => {
    powerOn()
    const w = mountPanel({ scene: 'hvac_cooling', tab: 'set', mode: 'check' })
    const cool = w.findAll('.hmon__key').find((b) => b.text() === '制冷')!
    await cool.trigger('click')
    expect(hvac.pending).toBe('cool')

    await w.findAll('.hmon__key--step')[0].trigger('click')
    expect(hvac.pendingTemp).toBe(23.5)

    await w.get('.hmon__apply').trigger('click')
    expect(hvac.mode).toBe('cool')
    expect(hvac.setTemp).toBe(23.5)
    expect(w.get('.hmon__foot-text').text()).toContain('已下发')
  })

  it('新风门开关点得动，值在关闭 / 打开之间切换', async () => {
    powerOn()
    const w = mountPanel({ scene: 'hvac_cooling', tab: 'set', mode: 'check' })
    const fresh = w.findAll('.hmon__key').find((b) => b.text().includes('新风门'))!
    await fresh.trigger('click')
    expect(hvac.freshAir).toBe('open')
    expect(fresh.text()).toContain('打开')
  })
})

describe('车门屏：确认与只读', () => {
  it('点一行确认一行：行变绿、页脚先回执后计数', async () => {
    powerOn()
    const w = mountPanel({ scene: 'door_switch', tab: 'status', mode: 'check' })
    expect(w.get('.dmon__foot-text').text()).toContain('0/3')
    await w.findAll('.dmon__hit:not(.dmon__hit--static)')[0].trigger('click')
    expect(door.confirmed.closed).toBe(true)
    // 页脚优先显示回执（5 秒后回到计数）——这是刻意的：点完要有一句"做了什么"
    expect(w.get('.dmon__foot-text').text()).toContain('已确认一项')
    expect(w.findAll('.dmon__row')[0].classes()).toContain('is-done')
  })

  it('status 模式是只读的：同一页不再有可点的确认行', () => {
    powerOn()
    const w = mountPanel({ scene: 'door_switch', tab: 'status', mode: 'status' })
    expect(w.findAll('.dmon__hit:not(.dmon__hit--static)')).toHaveLength(0)
  })

  it('故障页把故障文案显示出来（不是只变红）', () => {
    powerOn()
    door.fault = '关门障碍物超次数：门停在全开位'
    const w = mountPanel({ scene: 'door_switch', tab: 'fault', mode: 'check' })
    expect(w.text()).toContain('关门障碍物超次数')
  })

  /* ---- 未知场景不再兜到升弓屏（评审 R23-1）----
     原来 `v-else` 会把任何未知场景画成升弓那块屏：页面上看着"有块屏"，
     实际是另一份数据。现在给一句能定位的提示。 */
  it('未知场景给明确提示，不冒充升弓屏', () => {
    const w = mountPanel({ scene: 'nope', tab: 'power', mode: 'check' })
    expect(w.find('.mon-unknown').exists()).toBe(true)
    expect(w.text()).toContain('未知的 MON 场景')
    expect(w.find('.mon__rows').exists()).toBe(false)
  })

  it('显式写 pantograph_raise 仍走升弓屏（兼容旧样例）', () => {
    const w = mountPanel({ scene: 'pantograph_raise', tab: 'power', mode: 'check' })
    expect(w.find('.mon-unknown').exists()).toBe(false)
    expect(w.find('.mon__rows').exists()).toBe(true)
  })
})
