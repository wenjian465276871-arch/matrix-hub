/** operation_scene：升弓操作台。
 *
 *  重点不是"按钮点了有没有反应"，而是三件事：
 *  ① 点三维里的件与点按钮走同一套联锁（不存在"点模型能升、按钮不能升"）；
 *  ② 条件不满足时说出来缺什么，不是静默失败；
 *  ③ 升到位后松开旋钮，弓保持——"保持升弓状态"在 UI 上的表现。
 *
 *  `DeviceScene` 被替换成 stub：它要 WebGL，happy-dom 造不出渲染器；
 *  这里验的是**派发与文案**，画面本身由 E2E 在真实浏览器里看。
 */
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'

import PantoOps from './PantoOps.vue'
import { reset, session, stepRaise } from '../../lib/panto-session'

const SceneStub = defineComponent({
  name: 'DeviceScene',
  props: { subject: String, t: Number, label: String, pick: Boolean },
  emits: ['part-click', 'snapshot', 'cutable'],
  template: '<div class="scene-stub" />',
})

function mountOps(view = 'both', provide: Record<string, unknown> = {}) {
  return mount(PantoOps, {
    props: { params: { scene: 'pantograph_raise', view }, label: '升弓操作' },
    global: { stubs: { DeviceScene: SceneStub }, provide },
  })
}

function buttonByText(w: ReturnType<typeof mountOps>, text: string) {
  const btn = w.findAll('.ops__btn').find((b) => b.text().includes(text))
  if (!btn) throw new Error(`找不到按钮：${text}`)
  return btn
}

beforeEach(() => {
  reset()
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('operation_scene', () => {
  it('初始提示"插入主控钥匙"，并显示未上电', () => {
    const w = mountOps('desk')
    expect(w.get('.ops__next').text()).toContain('插入主控钥匙')
    expect(w.text()).toContain('未上电')
  })

  it('六个状态灯常驻：钥匙插入完不会把"钥匙右旋"顶出来', () => {
    // 2026-11-13 本人要求：按钮是状态灯，六个动作各占一个、位置与文案都不动。
    const w = mountOps()
    const labels = w.findAll('.ops__btn').map((b) => b.text())
    for (const want of ['钥匙插入', '钥匙右旋', '手柄快速位', '选弓 2U/3U', '按住升弓旋钮', 'VCB 合']) {
      expect(labels).toContain(want)
    }
  })

  it('做完的动作变蓝：keyInserted 后"钥匙插入"带 is-done', () => {
    const w = mountOps()
    expect(w.findAll('.ops__btn.is-done')).toHaveLength(0)
    return buttonByText(w, '钥匙插入')
      .trigger('click')
      .then(() => {
        expect(session.keyInserted).toBe(true)
        expect(buttonByText(w, '钥匙插入').classes()).toContain('is-done')
        expect(buttonByText(w, '钥匙插入').attributes('aria-pressed')).toBe('true')
        // 下一步的按钮不因上一步完成而"变蓝"，它只是可点了
        expect(buttonByText(w, '钥匙右旋').classes()).not.toContain('is-done')
      })
  })

  it('点"钥匙插入"再点"钥匙右旋"：两个独立动作', () => {
    const w = mountOps()
    return buttonByText(w, '钥匙插入')
      .trigger('click')
      .then(() => {
        expect(session.keyInserted).toBe(true)
        expect(session.keyTurned).toBe(false)
        return buttonByText(w, '钥匙右旋').trigger('click')
      })
      .then(() => {
        expect(session.keyTurned).toBe(true)
        expect(w.text()).toContain('司机室占用')
      })
  })

  it('没插钥匙就点右旋：拒绝并说明原因', () => {
    const w = mountOps()
    return buttonByText(w, '钥匙右旋')
      .trigger('click')
      .then(() => {
        expect(session.keyTurned).toBe(false)
        expect(w.get('.ops__toast').text()).toContain('先插入主控钥匙')
      })
  })

  it('没右旋钥匙时推手柄，提示里说清原因', () => {
    const w = mountOps()
    return buttonByText(w, '手柄快速位')
      .trigger('click')
      .then(() => {
        expect(session.brakeFast).toBe(false)
        expect(w.get('.ops__toast').text()).toContain('钥匙要先右旋')
      })
  })

  it('点三维里的钥匙件与点按钮等价', () => {
    const w = mountOps()
    const scene = w.findAllComponents({ name: 'DeviceScene' })[0]
    scene.vm.$emit('part-click', 'key')
    return w.vm.$nextTick().then(() => {
      expect(session.keyInserted).toBe(true)
    })
  })

  it('点 MON 屏且还有未确认项：调用跳转钩子', () => {
    let jumped = 0
    const w = mountOps('desk', { 'guide-goto-mon': () => { jumped += 1; return true } })
    session.keyInserted = true
    session.keyTurned = true
    session.brakeFast = true
    const scene = w.findAllComponents({ name: 'DeviceScene' })[0]
    scene.vm.$emit('part-click', 'mon')
    return w.vm.$nextTick().then(() => {
      expect(jumped).toBe(1)
      expect(w.get('.ops__toast').text()).toContain('已跳到确认页')
    })
  })

  it('点击 MON 屏且已上电但无跳转钩子时，给出中性提示', () => {
    const w = mountOps('desk')
    session.keyInserted = true
    session.keyTurned = true
    session.brakeFast = true
    const scene = w.findAllComponents({ name: 'DeviceScene' })[0]
    scene.vm.$emit('part-click', 'mon')
    return w.vm.$nextTick().then(() => {
      // 没有钩子（阅读器旧入口）时不能说"请点击 MON 屏"——那是空话
      expect(w.get('.ops__toast').text()).toContain('MON 屏还有确认项未完成')
    })
  })

  it('MON 未上电时点屏：拒绝并说明缺哪步', () => {
    const w = mountOps('desk')
    const scene = w.findAllComponents({ name: 'DeviceScene' })[0]
    scene.vm.$emit('part-click', 'mon')
    return w.vm.$nextTick().then(() => {
      expect(w.get('.ops__toast').text()).toContain('MON 未上电')
    })
  })

  it('MON 全部确认后点屏：打开放大层，Esc 收起', () => {
    const w = mountOps('desk')
    session.keyInserted = true
    session.keyTurned = true
    session.brakeFast = true
    session.mon = { voltage: true, mr: true, egs: true, vcb: true, panto_cut: true }
    const scene = w.findAllComponents({ name: 'DeviceScene' })[0]
    scene.vm.$emit('part-click', 'mon')
    return w.vm.$nextTick().then(() => {
      expect(w.find('.ops__mon').exists()).toBe(true)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      return w.vm.$nextTick().then(() => {
        expect(w.find('.ops__mon').exists()).toBe(false)
      })
    })
  })

  it('MON 没确认完就按升弓旋钮，拒绝并点名缺项', () => {
    const w = mountOps()
    session.keyInserted = true
    session.keyTurned = true
    session.brakeFast = true
    session.unit = '2U'
    return buttonByText(w, '按住升弓旋钮')
      .trigger('click')
      .then(() => {
        expect(session.raiseHeld).toBe(false)
        expect(w.get('.ops__toast').text()).toContain('MON 确认未完成')
      })
  })

  it('条件齐了按旋钮：开始升弓；到位后松开保持', () => {
    const w = mountOps()
    session.keyInserted = true
    session.keyTurned = true
    session.brakeFast = true
    session.unit = '2U'
    session.mon = { voltage: true, mr: true, egs: true, vcb: true, panto_cut: true }
    return buttonByText(w, '按住升弓旋钮')
      .trigger('click')
      .then(() => {
        expect(session.raiseHeld).toBe(true)
        // 手动把动画推到头（组件里的 rAF 在测试环境被 stub 掉了）
        for (let i = 0; i < 100; i += 1) stepRaise(0.05)
        return w.vm.$nextTick()
      })
      .then(() => {
        expect(session.raised).toBe(true)
        expect(w.text()).toContain('升弓到位')
        // 联动的那一刀：第二块画布（车顶受电弓）必须真的收到 0.72
        const scenes = w.findAllComponents({ name: 'DeviceScene' })
        expect(scenes[1].props('t')).toBeCloseTo(0.72, 5)
        return buttonByText(w, '松开旋钮').trigger('click')
      })
      .then(() => {
        expect(session.raiseHeld).toBe(false)
        expect(session.raised).toBe(true)
        expect(w.text()).toContain('保压')
      })
  })

  it('desk 视图只挂一台三维；both 挂两台', () => {
    expect(mountOps('desk').findAll('.ops__pane')).toHaveLength(1)
    expect(mountOps('both').findAll('.ops__pane')).toHaveLength(2)
  })

  it('放大操作：点开加类，Esc 退出', () => {
    const w = mountOps('both')
    // 这个按钮浮在画布上（.ops__float），不在底部按钮行里
    return w
      .get('.ops__float')
      .trigger('click')
      .then(() => {
        expect(w.get('.ops').classes()).toContain('ops--expanded')
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
        return w.vm.$nextTick()
      })
      .then(() => {
        expect(w.get('.ops').classes()).not.toContain('ops--expanded')
        w.unmount()
      })
  })

  it('重新开始把状态清回落弓', () => {
    const w = mountOps()
    session.keyInserted = true
    session.raiseT = 0.5
    return buttonByText(w, '重新开始')
      .trigger('click')
      .then(() => {
        expect(session.keyInserted).toBe(false)
        expect(session.raiseT).toBe(0)
      })
  })
})
