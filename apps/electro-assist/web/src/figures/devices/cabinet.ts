/** 低压电气柜：柜体 + 元件布置 + 上电自检时序。
 *
 *  ## 为什么这个场景最重要
 *  车门看行程、受电弓看角度，都是**机电**动作；只有电气柜是纯 **电气逻辑**：
 *  合闸 → 控制回路得电 → 接触器吸合 → 继电器依次动作 → 运行指示。
 *  它的"动作"主要不是机械位移，而是**灯与触点的状态迁移**——
 *  这正是电气调试现场最需要被看见的东西。
 *
 *  ## 尺寸为什么不是 800×2000
 *  标准柜是 800×2000×500，但按真实尺寸建模，内部元件（MCB 宽 18mm）
 *  在 860px 的内容区里只剩几个像素，等于没做。这里缩到 660×1500×360，
 *  元件相对放大——**演示要的是「看得清结构关系」，不是「量得准」**。
 *
 *  ## 柜门为什么不画
 *  门一开，2m 高的板会在画面里投下一大片阴影并挡住半个柜内，
 *  而门能提供的信息（面板指示灯）已经挪到柜体顶部横梁上。
 *  少一块板，换来整个内部清楚，这笔账划算。
 */
import { Group, Mesh, MeshStandardMaterial, Object3D, SphereGeometry } from 'three'

import type { DeviceRig } from './rig'
import {
  chromeMaterial,
  disposeTree,
  lampMaterial,
  paintedMaterial,
  roundedBox,
  seg,
  steelMaterial,
} from './rig'

/** 柜体尺寸（米）。比标准 800×2000 缩了一档，理由见文件头。 */
const DIM = { w: 0.66, h: 1.5, d: 0.36, t: 0.018 }

const OFF = 0x2b2d31
const RED = 0xd1483f
const GREEN = 0x2f9e6a
const AMBER = 0xd39a2a

/** 暗态：灯不亮时是一颗深色塑料珠，不能留自发光，否则整柜"全亮"看不出时序。 */
function led(radius = 0.013): Mesh {
  const mesh = new Mesh(new SphereGeometry(radius, 16, 12), lampMaterial(OFF))
  const material = mesh.material as MeshStandardMaterial
  material.emissiveIntensity = 0
  return mesh
}

function setLed(mesh: Mesh, color: number, on: boolean): void {
  const material = mesh.material as MeshStandardMaterial
  material.color.setHex(on ? color : OFF)
  material.emissive.setHex(on ? color : 0x000000)
  material.emissiveIntensity = on ? 1.7 : 0
}

export function buildCabinet(): DeviceRig {
  const root = new Group()
  const parts: Record<string, Object3D> = {}

  /* 三层明度必须拉开，否则整个柜子会糊进画布底色（底色 #cfcec9）：
     外壳亮 → 背板中深 → 元件近黑。这是这一页能不能看懂的前提。 */
  const shellMat = paintedMaterial(0xe6e3dc)
  const innerMat = paintedMaterial(0x9a978f)
  const halfW = DIM.w / 2
  const halfD = DIM.d / 2
  const backZ = -halfD + DIM.t

  /* ---------------------------------------------------------------- 柜体 */
  const shell = new Group()
  shell.add(
    roundedBox(DIM.w, DIM.h, DIM.t, innerMat, 0, DIM.h / 2, -halfD + DIM.t / 2, 0.006),
    roundedBox(DIM.t, DIM.h, DIM.d, shellMat, -halfW + DIM.t / 2, DIM.h / 2, 0, 0.006),
    roundedBox(DIM.t, DIM.h, DIM.d, shellMat, halfW - DIM.t / 2, DIM.h / 2, 0, 0.006),
    roundedBox(DIM.w, DIM.t, DIM.d, shellMat, 0, DIM.h - DIM.t / 2, 0, 0.006),
    roundedBox(DIM.w, DIM.t, DIM.d, shellMat, 0, DIM.t / 2, 0, 0.006),
    // 前缘包边：没有它，柜子像个四面透风的架子
    roundedBox(0.026, DIM.h, 0.026, shellMat, -halfW + 0.013, DIM.h / 2, halfD - 0.013, 0.006),
    roundedBox(0.026, DIM.h, 0.026, shellMat, halfW - 0.013, DIM.h / 2, halfD - 0.013, 0.006),
  )
  // 顶部横梁：面板指示灯装在这里，从正面就能看到
  shell.add(
    roundedBox(DIM.w - 0.05, 0.1, 0.03, paintedMaterial(0xb4b1aa), 0, DIM.h - 0.075, halfD - 0.02, 0.008),
  )

  parts.shell = shell
  root.add(shell)

  /* ---------------------------------------------------------------- 线槽 */
  const ductMat = new MeshStandardMaterial({ color: 0x8e9297, metalness: 0, roughness: 0.62 })
  const ducts = new Group()
  for (const x of [-0.255, 0.255]) {
    ducts.add(roundedBox(0.04, 1.15, 0.03, ductMat, x, 0.82, backZ + 0.03, 0.008))
  }
  ducts.add(roundedBox(0.55, 0.04, 0.03, ductMat, 0, 1.42, backZ + 0.03, 0.008))
  root.add(ducts)

  /* ---------------------------------------------------------------- 断路器 */
  const plastic = new MeshStandardMaterial({ color: 0x2f3236, metalness: 0, roughness: 0.55 })
  const mcbFace = new MeshStandardMaterial({ color: 0xdedcd6, metalness: 0, roughness: 0.5 })
  const breakers = new Group()
  const handles: Group[] = []
  const mcbLeds: Mesh[] = []

  for (let i = 0; i < 3; i += 1) {
    const x = -0.2 + i * 0.075
    const body = roundedBox(0.056, 0.11, 0.07, mcbFace, x, 1.28, backZ + 0.05, 0.006)
    breakers.add(body)
    // 手柄：合闸时向下扳
    const handle = new Group()
    handle.add(roundedBox(0.02, 0.038, 0.022, plastic, 0, 0, 0, 0.004))
    handle.position.set(x, 1.31, backZ + 0.09)
    handle.rotation.x = 0.5
    handles.push(handle)
    breakers.add(handle)
    const indicator = led(0.009)
    indicator.position.set(x, 1.245, backZ + 0.09)
    mcbLeds.push(indicator)
    breakers.add(indicator)
  }
  parts.breakers = breakers
  root.add(breakers)

  /* ---------------------------------------------------------------- 接触器 */
  const contactor = new Group()
  contactor.add(
    roundedBox(0.16, 0.18, 0.12, plastic, 0.14, 1.18, backZ + 0.07, 0.008),
    // 顶部辅助触点块
    roundedBox(0.06, 0.055, 0.1, mcbFace, 0.09, 1.295, backZ + 0.07, 0.005),
  )
  // 衔铁：吸合时向前顶出（真实行程几毫米，这里夸大一点才看得见）
  const armature = roundedBox(0.11, 0.055, 0.032, chromeMaterial(), 0.14, 1.1, backZ + 0.145, 0.006)
  contactor.add(armature)
  const contactorLed = led(0.012)
  contactorLed.position.set(0.19, 1.24, backZ + 0.135)
  contactor.add(contactorLed)

  // 热继电器挂在接触器下方
  contactor.add(roundedBox(0.14, 0.11, 0.1, mcbFace, 0.14, 0.98, backZ + 0.06, 0.006))
  parts.contactor = contactor
  root.add(contactor)

  /* ---------------------------------------------------------------- 继电器 */
  const relays = new Group()
  const relayLeds: Mesh[] = []
  for (let i = 0; i < 3; i += 1) {
    const x = -0.2 + i * 0.085
    relays.add(roundedBox(0.055, 0.08, 0.08, plastic, x, 0.86, backZ + 0.05, 0.006))
    const indicator = led(0.011)
    indicator.position.set(x, 0.885, backZ + 0.095)
    relayLeds.push(indicator)
    relays.add(indicator)
  }
  parts.relays = relays
  root.add(relays)

  /* ---------------------------------------------------------------- 端子排 */
  const terminals = new Group()
  const termMat = new MeshStandardMaterial({ color: 0xb0b4b9, metalness: 0.2, roughness: 0.5 })
  for (let i = 0; i < 8; i += 1) {
    terminals.add(roundedBox(0.036, 0.06, 0.055, termMat, -0.2 + i * 0.042, 0.42, backZ + 0.04, 0.004))
  }
  terminals.add(roundedBox(0.38, 0.032, 0.032, steelMaterial(0xa8acb0), 0, 0.42, backZ + 0.02, 0.004))
  parts.terminals = terminals
  root.add(terminals)

  /* ---------------------------------------------------------------- 面板灯 */
  const panel = new Group()
  const powerLed = led(0.017)
  powerLed.position.set(-0.075, DIM.h - 0.075, halfD - 0.004)
  const runLed = led(0.017)
  runLed.position.set(0, DIM.h - 0.075, halfD - 0.004)
  const alarmLed = led(0.017)
  alarmLed.position.set(0.075, DIM.h - 0.075, halfD - 0.004)
  for (const lamp of [powerLed, runLed, alarmLed]) {
    const base = roundedBox(0.046, 0.046, 0.012, chromeMaterial(), 0, 0, 0, 0.006)
    base.position.set(lamp.position.x, lamp.position.y, lamp.position.z - 0.012)
    panel.add(base)
  }
  panel.add(powerLed, runLed, alarmLed)
  parts.panel = panel
  root.add(panel)

  /* ---------------------------------------------------------------- 动作 */
  const setT = (t: number): void => {
    // 段一：三只断路器依次合闸
    const closing = (i: number): number => seg(t, 0.03 + i * 0.03, 0.12 + i * 0.03)

    handles.forEach((handle, i) => {
      const p = closing(i)
      handle.rotation.x = 0.5 - 1.0 * p
      setLed(mcbLeds[i], GREEN, p >= 1)
    })

    // 段二：控制回路得电。未得电时电源灯是**红**的——这是现场的真实语义：
    // 红灯表示「主回路有电、控制回路没起来」，不是「不亮」。
    setLed(powerLed, t >= 0.3 ? GREEN : RED, true)

    // 段三：接触器吸合
    const pulled = seg(t, 0.34, 0.5)
    armature.position.z = backZ + 0.145 - 0.014 * pulled
    setLed(contactorLed, GREEN, pulled >= 1)

    // 段四：继电器依次动作——现场听声音就是「哒、哒、哒」
    for (let i = 0; i < relayLeds.length; i += 1) {
      setLed(relayLeds[i], AMBER, t >= 0.56 + i * 0.08)
    }

    // 段五：运行指示
    setLed(runLed, GREEN, t >= 0.86)
    setLed(alarmLed, RED, false)
  }

  const phase = (t: number): string => {
    if (t < 0.15) return '合闸送电'
    if (t < 0.34) return '控制回路得电'
    if (t < 0.52) return '接触器吸合'
    if (t < 0.82) return '继电器自检'
    return '系统就绪'
  }

  setT(0)

  return {
    root,
    setT,
    parts,
    phase,
    framing: { target: [0, 0.72, 0], distance: 2.75 },
    dispose: () => disposeTree(root),
  }
}
