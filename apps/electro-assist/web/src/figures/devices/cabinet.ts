/** 配电回路元件特写：断路器、接触器、继电器、指示灯的**动作**。
 *
 *  ## 视角
 *  柜体退成一块安装背板 + DIN 导轨，镜头推到元件上。这一页要讲的是
 *  **断路器怎么扳、触点怎么吸、灯怎么亮**，不是柜子长什么样。
 *
 *  ## 断路器的动作（本页主角）
 *  微型断路器（MCB）的手柄是绕水平轴转的拨杆：
 *  **向上扳 = 合闸（ON），向下扳 = 断开（OFF）**，中间没有稳定位。
 *  手柄旁有状态窗：合闸红色（带电），断开绿色（安全位）。
 *  三极断路器的手柄由一根连杆锁在一起，必须同时动作——这是「3P」的意义，
 *  也是现场判断「三相同步」的依据。
 *
 *  ## 为什么用长焦
 *  元件特写配中焦镜头，一块竖直背板会被透视拉成斜的，看起来像悬空。
 *  这里 fov 收到 22°（长焦），背板接近正投影，元件更「正」。
 *
 *  ## 尺度
 *  元件按真实比例放大到约 3 倍。1P MCB 实际宽 18mm，按真实尺寸
 *  在 860px 内容区里只有几个像素。演示要看得清动作，不是量得准。
 */
import {
  CatmullRomCurve3,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  TubeGeometry,
  Vector3,
} from 'three'

import type { DeviceRig } from './rig'
import {
  chromeMaterial,
  disposeTree,
  lampMaterial,
  paintedMaterial,
  roundedBox,
  seg,
  steelMaterial,
  withEdges,
} from './rig'

const OFF = 0x2b2d31
const RED = 0xd1483f
const GREEN = 0x2f9e6a
const AMBER = 0xd39a2a
const COPPER = 0xb87333

/** 状态窗/灯珠的开关。暗态留一颗深色，不能保留自发光，否则看不出时序。 */
function setLed(mesh: Mesh, color: number, on: boolean): void {
  const material = mesh.material as MeshStandardMaterial
  material.color.setHex(on ? color : OFF)
  material.emissive.setHex(on ? color : 0x000000)
  // 「keep emissive layers under 1.0」：超过就糊成一团，看不出哪颗在亮
  material.emissiveIntensity = on ? 0.75 : 0
}

function led(radius = 0.013): Mesh {
  const mesh = new Mesh(new SphereGeometry(radius, 16, 12), lampMaterial(OFF))
  ;(mesh.material as MeshStandardMaterial).emissiveIntensity = 0
  return mesh
}

/** 状态窗：一小块指示片，靠颜色 + 自发光表达通断。
 *  用有厚度的方块而不是平面——平面在斜视下会被本体边沿吃掉一半。 */
function windowPlate(w: number, h: number): Mesh {
  const material = new MeshStandardMaterial({ color: OFF, metalness: 0.05, roughness: 0.35 })
  return roundedBox(w, h, 0.01, material, 0, 0, 0, 0.002)
}

/**
 * 一根导线。用 Catmull-Rom 过控制点，导线本来就是软的，会有自然弧垂；
 * 用直棍折线反而不像。
 *
 * 走线的规矩和现场一样：从端子出来 → 进线槽 → 沿槽横走 → 再出槽到目标端子。
 * 直接两点连线会穿过元件，一眼假。
 */
function wire(points: Vector3[], radius: number, material: MeshStandardMaterial): Mesh {
  const curve = new CatmullRomCurve3(points, false, 'catmullrom', 0.35)
  const mesh = new Mesh(new TubeGeometry(curve, 40, radius, 8, false), material)
  mesh.castShadow = true
  return mesh
}

interface BreakerRig {
  group: Group
  handles: Group[]
  windows: Mesh[]
}

/**
 * 造一台微型断路器。`poles` 决定极数，多极的由一根连杆把手柄锁在一起。
 * 结构按真实 MCB：本体 + 前置拨杆 + 状态窗 + 上下接线螺钉 + 极间连杆。
 */
function buildBreaker(poles: number, poleW: number, height: number): BreakerRig {
  const group = new Group()
  const handles: Group[] = []
  const windows: Mesh[] = []

  // 断路器外壳压到中浅灰：0xdfdcd5 在环境光下发白，细节（模缝、手柄槽）全丢
  const faceMat = new MeshStandardMaterial({ color: 0xc7c4bd, metalness: 0, roughness: 0.42 })
  const darkMat = new MeshStandardMaterial({ color: 0x33363b, metalness: 0.05, roughness: 0.48 })
  const depth = 0.1

  for (let i = 0; i < poles; i += 1) {
    const x = (i - (poles - 1) / 2) * poleW

    // 本体分两段，中间留一道模缝，比一整块像工业件
    group.add(
      roundedBox(poleW * 0.9, height * 0.58, depth, faceMat, x, height * 0.21, 0, 0.005),
      roundedBox(poleW * 0.9, height * 0.34, depth, faceMat, x, -height * 0.3, 0, 0.005),
    )

    // 拨杆：轴心在本体前上方，杆身向上偏，绕 X 轴转就是「向上扳/向下扳」
    const hinge = new Group()
    hinge.position.set(x, height * 0.04, depth / 2 - 0.002)
    hinge.add(roundedBox(poleW * 0.5, height * 0.34, 0.028, darkMat, 0, height * 0.17, 0, 0.006))
    // 手柄顶端一道横向防滑纹，转起来更容易被看见
    hinge.add(roundedBox(poleW * 0.56, 0.012, 0.032, chromeMaterial(), 0, height * 0.33, 0, 0.004))
    hinge.rotation.x = 1.0
    handles.push(hinge)
    group.add(hinge)

    // 状态窗：拨杆下方，合闸亮红（带电），断开变绿（安全）
    const plate = windowPlate(poleW * 0.56, 0.024)
    plate.position.set(x, -height * 0.16, depth / 2 + 0.003)
    windows.push(plate)
    group.add(plate)

    // 上下接线螺钉
    for (const sy of [1, -1]) {
      const screw = new Mesh(new SphereGeometry(0.01, 12, 8), chromeMaterial())
      screw.position.set(x, sy * height * 0.44, -0.016)
      group.add(screw)
    }
  }

  // 极间连杆：这根杆是「3P 必须同时动作」的视觉证据
  if (poles > 1) {
    group.add(
      roundedBox(poleW * (poles - 1), 0.012, 0.014, darkMat, 0, height * 0.24, depth / 2 - 0.004, 0.004),
    )
  }

  return { group, handles, windows }
}

export function buildCabinet(): DeviceRig {
  const root = new Group()
  const parts: Record<string, Object3D> = {}

  /* ------------------------------------------------------------ 安装背板 */
  const board = new Group()
  board.add(
    roundedBox(0.92, 0.72, 0.02, paintedMaterial(0x9c9992), 0, 0.36, 0, 0.006),
    roundedBox(0.86, 0.03, 0.014, steelMaterial(0xb6babe), 0, 0.55, 0.018, 0.004),
    roundedBox(0.86, 0.03, 0.014, steelMaterial(0xb6babe), 0, 0.14, 0.018, 0.004),
  )
  parts.board = board
  root.add(board)

  /* ------------------------------------------------------------ 三极断路器 */
  const main = buildBreaker(3, 0.082, 0.2)
  main.group.position.set(-0.26, 0.55, 0.07)
  parts.breakers = main.group
  root.add(main.group)

  /* ------------------------------------------------------------ 单极断路器 */
  const sp1 = buildBreaker(1, 0.082, 0.2)
  sp1.group.position.set(-0.085, 0.55, 0.07)
  const sp2 = buildBreaker(1, 0.082, 0.2)
  sp2.group.position.set(0.01, 0.55, 0.07)
  root.add(sp1.group, sp2.group)

  /* ------------------------------------------------------------ 接触器 */
  const contactor = new Group()
  const ctrlMat = new MeshStandardMaterial({ color: 0x33363b, metalness: 0.04, roughness: 0.52 })
  const ctrlFace = new MeshStandardMaterial({ color: 0xbdbab3, metalness: 0, roughness: 0.45 })
  contactor.add(
    roundedBox(0.15, 0.165, 0.115, ctrlMat, 0.32, 0.53, 0.062, 0.006),
    roundedBox(0.1, 0.058, 0.1, ctrlFace, 0.29, 0.645, 0.062, 0.005),
    roundedBox(0.12, 0.07, 0.1, ctrlMat, 0.32, 0.425, 0.062, 0.005),
  )
  // 线圈：铜色，从线圈腔露出
  contactor.add(
    roundedBox(
      0.082,
      0.05,
      0.055,
      new MeshStandardMaterial({ color: COPPER, metalness: 0.8, roughness: 0.42 }),
      0.32,
      0.425,
      0.112,
      0.004,
    ),
  )
  // 衔铁：吸合时向前顶出
  const armature = roundedBox(0.11, 0.048, 0.03, chromeMaterial(), 0.32, 0.472, 0.132, 0.005)
  contactor.add(armature)
  const contactorLed = led(0.013)
  contactorLed.position.set(0.385, 0.632, 0.115)
  contactor.add(contactorLed)
  parts.contactor = contactor
  root.add(contactor)

  /* ------------------------------------------------------------ 中间继电器 */
  /* 透明外壳是关键：能看见里面的线圈和触点片在动，
     比「一个黑盒子 + 一盏灯」有说服力得多。 */
  const shellMat = new MeshPhysicalMaterial({
    color: 0xdfe6ec,
    metalness: 0,
    roughness: 0.05,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    clearcoat: 1,
  })
  const relayGroup = new Group()
  const relayLeds: Mesh[] = []
  const relayArms: Mesh[] = []
  const copperMat = new MeshStandardMaterial({ color: COPPER, metalness: 0.8, roughness: 0.45 })

  for (let i = 0; i < 3; i += 1) {
    const x = -0.3 + i * 0.15
    const cell = new Group()
    // 底座
    cell.add(roundedBox(0.1, 0.028, 0.09, ctrlMat, x, 0.168, 0.075, 0.004))
    // 内部线圈
    cell.add(roundedBox(0.062, 0.062, 0.05, copperMat, x, 0.225, 0.075, 0.004))
    // 触点片：动作时摆一个角度
    const arm = roundedBox(0.014, 0.062, 0.009, chromeMaterial(), x + 0.032, 0.24, 0.098, 0.002)
    relayArms.push(arm)
    cell.add(arm)
    // 透明外罩。必须描一道边，否则全透明材质在浅色背板上几乎看不见，
    // 等于白做「能看到内部」这件事。
    cell.add(withEdges(roundedBox(0.098, 0.125, 0.09, shellMat, x, 0.235, 0.075, 0.006), 0.22))
    // 顶部状态灯
    const indicator = led(0.015)
    indicator.position.set(x, 0.305, 0.075)
    relayLeds.push(indicator)
    cell.add(indicator)
    relayGroup.add(cell)
  }
  parts.relays = relayGroup
  root.add(relayGroup)

  /* ------------------------------------------------------------ 指示灯 */
  const lampGroup = new Group()
  const powerLed = led(0.026)
  powerLed.position.set(0.17, 0.24, 0.085)
  const runLed = led(0.026)
  runLed.position.set(0.29, 0.24, 0.085)
  const alarmLed = led(0.026)
  alarmLed.position.set(0.41, 0.24, 0.085)
  for (const lamp of [powerLed, runLed, alarmLed]) {
    // 灯座：一段圆柱 + 一圈压边，不能只是一颗球
    lampGroup.add(
      roundedBox(0.056, 0.038, 0.056, ctrlMat, lamp.position.x, lamp.position.y - 0.028, lamp.position.z, 0.006),
    )
    lampGroup.add(
      roundedBox(0.066, 0.01, 0.066, chromeMaterial(), lamp.position.x, lamp.position.y - 0.049, lamp.position.z, 0.004),
    )
  }
  lampGroup.add(powerLed, runLed, alarmLed)
  parts.lamps = lampGroup
  root.add(lampGroup)

  /* ------------------------------------------------------------ 端子排 */
  const terminals = new Group()
  const termMat = new MeshStandardMaterial({ color: 0x8d9196, metalness: 0.2, roughness: 0.55 })
  for (let i = 0; i < 10; i += 1) {
    terminals.add(roundedBox(0.034, 0.055, 0.05, termMat, -0.3 + i * 0.04, 0.065, 0.06, 0.003))
  }
  parts.terminals = terminals
  root.add(terminals)


  /* ------------------------------------------------------------ 导线 */
  /* 配电柜最有「电气味」的东西是线。没有线，一排元件只是零件展柜。
     走法照现场：端子出来 → 下到走线高度 → 横走 → 再上去进目标端子。
     三相按 GB 相色：A 黄、B 绿、C 红，饱和度压一档免得花。 */
  const phaseColors = [0xb8992a, 0x2a7d58, 0xa83c33]
  const wireGroup = new Group()

  // 3P 断路器下端子（世界坐标）= group 位置 + (极偏移, -height*0.44, -0.016)
  const poleX = [-0.082, 0, 0.082]
  // 接触器上端子三个位置
  const landingX = [0.28, 0.32, 0.36]

  poleX.forEach((dx, i) => {
    const x0 = -0.26 + dx
    const y0 = 0.462
    const x1 = landingX[i]
    const dropY = 0.37 - i * 0.022
    const material = new MeshStandardMaterial({
      color: phaseColors[i],
      metalness: 0.05,
      roughness: 0.62,
    })
    wireGroup.add(
      wire(
        [
          new Vector3(x0, y0, 0.054),
          new Vector3(x0, y0 - 0.035, 0.05),
          new Vector3(x0, dropY, 0.05),
          new Vector3((x0 + x1) / 2, dropY - 0.012, 0.055),
          new Vector3(x1 - 0.03, dropY, 0.07),
          new Vector3(x1, 0.5, 0.1),
          new Vector3(x1, 0.605, 0.108),
        ],
        0.007,
        material,
      ),
    )
  })

  // 控制回路：单极断路器 → 中间继电器。细、深色，不与主回路抢眼
  const controlMat = new MeshStandardMaterial({ color: 0x3a4a5c, metalness: 0.05, roughness: 0.66 })
  const controlRuns: [number, number][] = [
    [-0.085, -0.3],
    [0.01, -0.15],
  ]
  for (const [fromX, toX] of controlRuns) {
    wireGroup.add(
      wire(
        [
          new Vector3(fromX, 0.462, 0.054),
          new Vector3(fromX, 0.42, 0.05),
          new Vector3(fromX, 0.39, 0.045),
          new Vector3(toX + 0.04, 0.36, 0.045),
          new Vector3(toX, 0.31, 0.05),
          new Vector3(toX, 0.24, 0.062),
        ],
        0.0036,
        controlMat,
      ),
    )
  }

  // 接地：黄绿，从背板下沿拉到端子排
  wireGroup.add(
    wire(
      [
        // 起端压在背板左下角：接地线不会凭空出现在半空
        new Vector3(-0.42, 0.03, 0.022),
        new Vector3(-0.4, 0.075, 0.045),
        new Vector3(-0.34, 0.062, 0.055),
        new Vector3(-0.3, 0.065, 0.062),
      ],
      0.005,
      new MeshStandardMaterial({ color: 0x7f9c2a, metalness: 0.05, roughness: 0.6 }),
    ),
  )

  parts.wires = wireGroup
  root.add(wireGroup)

  /* ------------------------------------------------------------ 动作 */
  const setT = (t: number): void => {
    /**
     * 段一：三极断路器合闸。
     * 手柄从 +1.0（指向前下 = 断开）转到 -0.35（指向上后 = 闭合）——
     * 方向不能反：现场看到手柄朝下就是断开，朝上才是合闸。
     * 行程取 1.35rad（约 77°），比真机的 ±25° 夸张——真机行程在屏幕上
     * 只有十几个像素的位移，不夸张等于没动作。
     */
    const on = seg(t, 0.02, 0.14)
    for (const handle of main.handles) handle.rotation.x = 1.0 - 1.35 * on
    for (const plate of main.windows) setLed(plate, on >= 0.98 ? RED : GREEN, true)

    // 段二：两只单极断路器随后合上
    const sp = [sp1, sp2]
    sp.forEach((breaker, i) => {
      const p = seg(t, 0.16 + i * 0.05, 0.24 + i * 0.05)
      for (const handle of breaker.handles) handle.rotation.x = 1.0 - 1.35 * p
      for (const plate of breaker.windows) setLed(plate, p >= 0.98 ? RED : GREEN, true)
    })

    // 段三：控制回路得电。未得电时电源灯是红的——红灯表示
    // 「主回路有电、控制回路没起来」，这是现场语义，不是「不亮」。
    setLed(powerLed, t >= 0.3 ? GREEN : RED, true)

    // 段四：接触器吸合（衔铁动作 + 线圈腔可见）
    const pulled = seg(t, 0.34, 0.5)
    armature.position.z = 0.132 - 0.018 * pulled
    setLed(contactorLed, GREEN, pulled >= 1)

    // 段五：继电器依次动作——触点片摆动 + 顶部灯亮
    for (let i = 0; i < relayLeds.length; i += 1) {
      const active = t >= 0.56 + i * 0.08
      setLed(relayLeds[i], AMBER, active)
      relayArms[i].rotation.z = active ? -0.38 : 0
    }

    // 段六：运行指示
    setLed(runLed, GREEN, t >= 0.86)
    setLed(alarmLed, RED, false)
  }

  const phase = (t: number): string => {
    if (t < 0.15) return '主断路器合闸'
    if (t < 0.3) return '分路断路器合闸'
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
    // 长焦 22°：竖直背板接近正投影，不会被透视拉成斜的
    fov: 18,
    // 浅背板 + 浅元件：环境压到 0.8，否则断路器会烧成一块白
    envIntensity: 0.8,
    framing: { target: [0.02, 0.35, 0.04], distance: 2.62 },
    dispose: () => disposeTree(root),
  }
}
