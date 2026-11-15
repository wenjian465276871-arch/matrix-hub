/** operation_scene（空调 / 车门）：派发、按步裁剪与"底部只读"。
 *
 *  三维被替换成 stub（happy-dom 造不出 WebGL）。这里验四件事：
 *  1. **底部只读**：状态条是 `<span>`，不是按钮，点了没有任何反应；
 *  2. **动作只从三维 / MON 来**：part-click 派发到会话，走同一套联锁；
 *  3. **一页只做本页的事**：`act` 之外的件点了要被拒绝并说明本步做什么；
 *  4. **本步做完给出口**：三件做完出现「本步完成，进入下一步」。
 *  画面本身由 `tests/e2e/deskops.spec.ts` 在真浏览器里看。
 */
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'

import MonPanel from './MonPanel.vue'
import OperationScene from './OperationScene.vue'
import OpsBoard from './OpsBoard.vue'
import { power, resetPower } from '../../lib/desk-power'
import { reset as resetHvac } from '../../lib/hvac-session'
import { door, reset as resetDoor } from '../../lib/door-session'

const SceneStub = defineComponent({
  name: 'DeviceScene',
  props: { subject: String, t: Number, aux: String, label: String, pick: Boolean },
  emits: ['part-click', 'snapshot', 'cutable'],
  template: '<div class="scene-stub" />',
})

function mountOps(scene: 'hvac_cooling' | 'door_switch', act = 'all', view = 'both') {
  return mount(OpsBoard, {
    props: { params: { scene, view, act }, label: '作业台' },
    global: { stubs: { DeviceScene: SceneStub } },
  })
}

/** 点三维里的件（三维被 stub，直接发事件）。 */
async function clickPart(w: ReturnType<typeof mountOps>, key: string, pane = 0, label = '') {
  await w.findAllComponents(SceneStub)[pane].vm.$emit('part-click', key, label)
}

beforeEach(() => {
  resetHvac()
  resetDoor()
  resetPower()
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

describe('operation_scene 分发', () => {
  it('hvac_cooling 的右侧是空调机组，door_switch 的右侧是客室侧门', () => {
    const hv = mountOps('hvac_cooling')
    expect(hv.findAllComponents(SceneStub)[1].props('subject')).toBe('hvac')

    const dr = mountOps('door_switch')
    expect(dr.findAllComponents(SceneStub)[1].props('subject')).toBe('door')
    expect(dr.findAllComponents(SceneStub)[1].props('pick')).toBe(true)
  })

  it('读屏说明写清「三维只能鼠标点、MON 可用键盘」（决策 #62）', () => {
    const w = mountOps('door_switch')
    const note = w.get('.sr-only').text()
    // 只写"不能"是不够的：还要告诉键盘用户"还能做什么"
    expect(note).toContain('仅支持鼠标点击')
    expect(note).toContain('MON')
    // 这句不上屏：它是给读屏的，不是又一条页面提示
    expect(note).not.toContain('本步')
  })

  it('pantograph_raise 仍走升弓那台（不出 OpsBoard）', () => {
    const w = mount(OperationScene, {
      props: { params: { scene: 'pantograph_raise', view: 'desk' } },
      global: { stubs: { DeviceScene: SceneStub, MonPanel: true } },
    })
    expect(w.find('.ops__acts').exists()).toBe(true)
    expect(w.text()).not.toContain('试验前状态')
  })
})

describe('底部状态条：只读', () => {
  it('状态项是 span，不是 button；页面里没有动作按钮排', () => {
    const w = mountOps('door_switch', 'operate')
    const chips = w.findAll('.ops__st')
    expect(chips.length).toBeGreaterThan(0)
    for (const chip of chips) expect(chip.element.tagName).toBe('SPAN')
    expect(w.find('.ops__acts').exists()).toBe(false)
  })

  it('三件做完后状态灯变蓝，并给"进入下一步"的出口', async () => {
    const w = mountOps('hvac_cooling', 'power')
    expect(w.find('.ops__go').exists()).toBe(false)
    await clickPart(w, 'key')
    await clickPart(w, 'key') // 第二次点同一把钥匙 = 右旋
    await clickPart(w, 'brake')
    expect(power.brakeFast).toBe(true)
    expect(w.findAll('.ops__st.is-on')).toHaveLength(3)
    expect(w.find('.ops__go').exists()).toBe(true)
  })
})

describe('按步裁剪：一页只做本页的事', () => {
  it('上电步点门控按钮：被拒绝，并说明本步只做上电三件', async () => {
    const w = mountOps('door_switch', 'power')
    await clickPart(w, 'door_l_release')
    expect(door.released).toBe(false)
    expect(w.get('.ops__notice').text()).toContain('本步只做')
    expect(w.get('.ops__notice').text()).toContain('钥匙')
  })

  it('确认步（check）六个按钮一颗都不该动', async () => {
    const w = mountOps('door_switch', 'check')
    await clickPart(w, 'door_l_open')
    expect(door.openT).toBe(0)
  })

  it('pinch 步点试块：移到门洞；再点：移回门外', async () => {
    const w = mountOps('door_switch', 'pinch')
    await clickPart(w, 'block', 1)
    expect(door.blocked).toBe(true)
    expect(String(w.findAllComponents(SceneStub)[1].props('aux'))).toContain('block=1')
    await clickPart(w, 'block', 1)
    expect(door.blocked).toBe(false)
  })

  it('operate 步点关门：不在本步（只放开门）', async () => {
    const w = mountOps('door_switch', 'operate')
    door.openT = 1
    door.released = true
    await clickPart(w, 'door_l_close')
    // 关门不在"释放与开门"这一步：动作没发生（门仍开着、目标是开）
    expect(door.openT).toBe(1)
    expect(door.target).toBe(0)
    expect(w.get('.ops__notice').text()).toContain('释放与开门')
  })
})

describe('动作入口：三维与 MON', () => {
  it('未上电点 MON：不弹窗，提示先去插钥匙', async () => {
    const w = mountOps('hvac_cooling', 'power')
    await clickPart(w, 'mon')
    expect(w.find('.ops__mon').exists()).toBe(false)
    expect(w.get('.ops__notice').text()).toContain('钥匙')
  })

  it('空调上电后点 MON：左栏换成 MON 屏（不弹窗），并把本步 phase 传给面板', async () => {
    const w = mountOps('hvac_cooling', 'set')
    power.keyInserted = true
    power.keyTurned = true
    power.brakeFast = true
    await clickPart(w, 'mon')
    // 2026-11-14 本人要求：空调点屏 = 左栏换屏，右侧机组保留（要一边设一边看风机）
    expect(w.find('.ops__pane--mon').exists()).toBe(true)
    expect(w.find('.ops__mon').exists()).toBe(false)
    const panel = w.findComponent(MonPanel)
    expect(panel.exists()).toBe(true)
    expect(panel.props('params')).toMatchObject({ scene: 'hvac_cooling', phase: 'set', compact: '1' })
    // 能回到司机台
    expect(w.find('.ops__mon-back').exists()).toBe(true)
  })

  it('view=mon 的步骤一开始就只给 MON + 机组，没有司机台画布', () => {
    const w = mountOps('hvac_cooling', 'vent', 'mon')
    expect(w.find('.ops__pane--mon').exists()).toBe(true)
    expect(w.findAllComponents(SceneStub)).toHaveLength(1)
    expect(w.findAllComponents(SceneStub)[0].props('subject')).toBe('hvac')
  })

  it('释放后开门：门扇开始动（t 从 0 起走）', async () => {
    const w = mountOps('door_switch', 'operate')
    power.keyInserted = true
    power.keyTurned = true
    power.brakeFast = true
    await clickPart(w, 'door_l_release')
    expect(door.released).toBe(true)
    await clickPart(w, 'door_l_open')
    expect(door.target).toBe(1)
    expect(w.findAllComponents(SceneStub)[1].props('t')).toBe(0)
  })

  it('重新开始：状态复位，并调用"回到第一工步"的出口', async () => {
    const first = vi.fn(() => true)
    const w = mount(OpsBoard, {
      props: { params: { scene: 'door_switch', view: 'both', act: 'operate' }, label: '作业台' },
      global: { stubs: { DeviceScene: SceneStub }, provide: { 'guide-first': first } },
    })
    power.keyInserted = true
    power.keyTurned = true
    power.brakeFast = true
    await clickPart(w as ReturnType<typeof mountOps>, 'door_l_release')
    await w.get('.ops__reset').trigger('click')
    expect(door.released).toBe(false)
    expect(power.keyInserted).toBe(false)
    // 2026-11-14 本人要求：复位必须同时回到第一工步
    expect(first).toHaveBeenCalledOnce()
    expect(w.get('.ops__notice').text()).toContain('第一工步')
  })

  it('重新开始：已经在第一工步时如实说明（不谎称跳转）', async () => {
    const w = mount(OpsBoard, {
      props: { params: { scene: 'hvac_cooling', view: 'both', act: 'set' }, label: '作业台' },
      global: { stubs: { DeviceScene: SceneStub }, provide: { 'guide-first': () => false } },
    })
    await w.get('.ops__reset').trigger('click')
    expect(w.get('.ops__notice').text()).toContain('已在第一工步')
  })

  /* ---- 未知 act 必须拒绝（评审 R23-1，2026-11-15）----
     原来 `allowed()` 写的是 `table[phase] ?? table.all`：act 一写错，本步之外的件
     全部放行，而且没有任何提示。这条把方向钉成 fail-closed —— 真值表在
     `lib/ops-allowed.spec.ts`，这里验"组件真的会拒绝"。 */
  it('act 写成未知值时一律拒绝：点门控「释放」不生效，并说明本步范围', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    power.keyInserted = true
    power.keyTurned = true
    power.brakeFast = true
    const w = mountOps('door_switch', 'nope')
    await clickPart(w, 'door_l_release')
    expect(door.released).toBe(false)
    expect(w.get('.ops__notice').text()).toContain('本步只做')
    // 告警一次，不能刷屏
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('未知的 act')).length).toBe(1)
    warn.mockRestore()
  })
})
