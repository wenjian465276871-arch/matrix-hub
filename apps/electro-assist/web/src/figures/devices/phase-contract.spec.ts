/** 动作阶段文案与契约时刻的对齐门禁。
 *
 *  ## 这条门禁补的是哪一类漏洞
 *
 *  `api/models/visual.py` 的 `DEVICE_MOMENTS` 给每台设备钉了 5–6 个可拖动时刻，
 *  前端演示页把它们渲染成一排 chip。但"chip 上写的那一刻"与"三维画面 + 阶段文案
 *  在那一刻的样子"过去**没有任何断言**：两边各改各的，谁也不红。
 *
 *  2026-11-12 实测（写这条用例之前）一共找出 9 处不一致，比较典型的三个：
 *  - `cabinet` 的 `off@0.0`：文案说"主断路器合闸"，而同页读数说"手柄：断开位"，
 *    动画里主断 0.02 才开始动——0 时刻根本没合闸；
 *  - `feeler_gauge` 的三个时刻**正好落在阶段切换点上**（`<` 比较），于是
 *    "对准门缝"那一刻读到的是"插入门缝"，一个不落全部错开一段；
 *  - `warning_sign` 的 `seated@0.35`：挂绳 0.40 才滑到位，标签写的是"已滑入"。
 *
 *  ## 断言口径
 *
 *  1. 表里必须覆盖契约里的**每一个**时刻——后端加一个时刻，这里不补就红；
 *  2. 每个时刻的文案必须含表里的关键字（允许措辞不同，不允许"说到另一段去"）；
 *  3. `devices/*.ts` 的 `rig.phase` 必须与 `lib/devphase.ts` 逐字相同
 *     （防止哪天有人在设备文件里又手写一份）；
 *  4. 有读数面板的设备，界面上那句"动作阶段"也必须逐字相同。
 */
import { describe, expect, it } from 'vitest'

import CONTRACT from '../../contract/devices.json'
import { readoutsFor, type SceneKey } from '../../lib/demoreads'
import { phaseFor, type PhaseKey } from '../../lib/devphase'
import { buildCabinet } from './cabinet'
import { buildDoor } from './door'
import { buildFeelerGauge } from './feeler_gauge'
import { buildHvac } from './hvac'
import { buildMultimeter } from './multimeter'
import { buildPantograph } from './pantograph'
import { buildTorqueWrench } from './torque_wrench'
import { buildWarningSign } from './warning_sign'

const BUILDERS: Record<string, () => { phase: (t: number) => string; dispose: () => void }> = {
  door: buildDoor,
  pantograph: buildPantograph,
  cabinet: buildCabinet,
  hvac: buildHvac,
  multimeter: buildMultimeter,
  warning_sign: buildWarningSign,
  feeler_gauge: buildFeelerGauge,
  torque_wrench: buildTorqueWrench,
}

/** 每个时刻"此刻该说的话"里的关键字。
 *
 *  为什么不写整句：整句一改措辞就得同时改两处，久了大家会图省事把断言放宽成
 *  "非空"。关键字取的是**这一段独有的词**——"接触器吸合"不会出现在自检段，
 *  "咔嗒脱扣"不会出现在施力段，所以它能真的分辨出"说到另一段去了"。
 */
const KEYWORD: Record<string, Record<string, string>> = {
  door: {
    closed: '关闭锁定',
    unlocking: '门锁解锁',
    popping: '退出密封面',
    opening: '门扇开启',
    open: '完全开启',
  },
  pantograph: {
    lowered: '落弓锁定',
    pressurising: '气路建压',
    raising: '升弓中',
    contacting: '接触压力建立',
    raised: '升弓到位',
    lowering: '降弓中',
  },
  cabinet: {
    off: '未上电',
    closing: '主断路器合闸',
    pulled: '接触器吸合',
    ready: '系统就绪',
    tripped: '过载脱扣',
    restored: '重新合闸',
  },
  hvac: {
    closed: '机组停用',
    opened: '已拆下',
    powered: '断路器',
    ventilating: '通风模式',
    cooling: '制冷模式',
    stable: '稳定运行',
  },
  multimeter: {
    dialed: '直流电压档',
    probe_plus: '红表笔搭上',
    probe_minus: '黑表笔搭上',
    reading: '读数稳定 110.3',
    withdrawn: '撤笔',
  },
  warning_sign: {
    crooked: '尚未摆正',
    seated: '挂绳滑入',
    released: '离手',
    settled: '摆正',
    checked: '挂牌到位',
  },
  feeler_gauge: {
    fanned: '展开选片',
    aligned: '对准门缝',
    inserted: '插入门缝',
    sliding: '沿缝滑动',
    withdrawn: '判定间隙',
  },
  torque_wrench: {
    seated: '套筒套入',
    snug: '施力',
    loaded: '刻度到达设定值',
    clicked: '咔嗒脱扣',
    marked: '防松标记',
  },
}

type ContractDevice = { moments: Array<{ t: number; key: string; label: string }> }
const DEVICES = (CONTRACT as unknown as { devices: Record<string, ContractDevice> }).devices

describe.each(Object.keys(BUILDERS))('%s 的阶段文案', (name) => {
  const moments = DEVICES[name].moments
  const table = KEYWORD[name]

  it('关键字表覆盖契约里的每一个时刻', () => {
    expect(table, `${name} 没有关键字表`).toBeTruthy()
    expect(
      Object.keys(table).sort(),
      `${name} 的关键字表与契约时刻对不上（后端加了时刻就要在这里补一行）`,
    ).toEqual(moments.map((m) => m.key).sort())
  })

  it('每个时刻落在它自己那一段（文案含该段关键字）', () => {
    for (const m of moments) {
      const text = phaseFor(name as PhaseKey, m.t)
      expect(text, `${name}.${m.key}@${m.t}（契约标签：${m.label}）`).toContain(table[m.key])
    }
  })

  it('时刻递增且都落在 (0, 1]', () => {
    let prev = -1
    for (const m of moments) {
      expect(m.t, `${name}.${m.key}`).toBeGreaterThan(0 - 1e-9)
      expect(m.t, `${name}.${m.key}`).toBeLessThanOrEqual(1)
      expect(m.t, `${name}.${m.key} 没按顺序`).toBeGreaterThan(prev)
      prev = m.t
    }
  })

  it('三维侧的 phase 与唯一来源逐字一致', () => {
    const rig = BUILDERS[name]()
    for (let i = 0; i <= 100; i += 1) {
      const t = i / 100
      expect(rig.phase(t), `${name}@${t}`).toBe(phaseFor(name as PhaseKey, t))
    }
    rig.dispose()
  })

  it('全程都有阶段文案，不出现空串', () => {
    for (let i = 0; i <= 200; i += 1) {
      expect(phaseFor(name as PhaseKey, i / 200).length).toBeGreaterThan(0)
    }
  })
})

describe('读数面板与阶段文案同源', () => {
  const PANEL: Record<string, SceneKey> = {
    door: 'door',
    pantograph: 'pantograph',
    cabinet: 'cabinet',
    multimeter: 'multimeter',
    warning_sign: 'warning_sign',
    feeler_gauge: 'feeler_gauge',
    torque_wrench: 'torque_wrench',
  }

  it.each(Object.keys(PANEL))('%s 的「动作阶段」与 phaseFor 逐字一致', (scene) => {
    for (let i = 0; i <= 100; i += 1) {
      const t = i / 100
      const shown = readoutsFor(PANEL[scene], t).find((r) => r.label === '动作阶段')?.value
      expect(shown, `${scene}@${t}`).toBe(phaseFor(scene as PhaseKey, t))
    }
  })
})
