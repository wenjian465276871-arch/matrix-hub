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
  CylinderGeometry,
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
import { phaseFor } from '../../lib/devphase'

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
  /** 动触点：合闸时摆向静触点。它是「手柄动了以后电才通」的可见证据。 */
  arms: Group[]
  /** 触点压力弹簧：合闸后继续压缩的那一点，就是「超程」。 */
  springs: Mesh[]
  /** 双金属片的枢轴（绕下端弯，不是绕自身中心转）。 */
  bimetals: Object3D[]
  /** 脱扣杆的枢轴。 */
  trips: Object3D[]
}

/**
 * 造一台微型断路器。`poles` 决定极数，多极的由一根连杆把手柄锁在一起。
 *
 * ## 为什么是空壳 + 内部机构
 * 上一版是实心盒，切开只看到盒壁——剖切对断路器毫无意义。真机内部有四样东西，
 * 而且它们**恰好是电气调试最关心的**：
 * - 灭弧室：一叠钢片，负责把分断时的电弧拉长冷却
 * - 动静触点：手柄扳到位，触点才闭合；触点不到位就是「手柄合了但没通」
 * - 双金属片：过载时受热弯曲，顶开脱扣杆（本模型只做静态呈现）
 * - 手柄轴与联动杠杆：把拨杆的角度传成触点的位移
 *
 * ## 外壳做成六片薄壁
 * 左右侧板 + 上下盖 + 前后盖。这样剖切去掉前盖后，内部机构是**露出来**的，
 * 而不是被一块实心体挡着。
 *
 * ## 手柄与状态窗不参与裁剪
 * 它们挂在 `cutKeep` 组下：剖切时外壳被切开，手柄仍然完整地扳动。
 * 这是剖视图的常规画法（切外壳、留机构），不是取巧——否则刀一落，
 * 这个场景的主角（手柄）就没了。
 */
function buildBreaker(poles: number, poleW: number, height: number): BreakerRig {
  const group = new Group()
  const handles: Group[] = []
  const windows: Mesh[] = []
  const arms: Group[] = []
  const springs: Mesh[] = []
  const bimetals: Object3D[] = []
  const trips: Object3D[] = []

  // 断路器外壳压到中浅灰：0xdfdcd5 在环境光下发白，细节（模缝、手柄槽）全丢
  const faceMat = new MeshStandardMaterial({ color: 0xc7c4bd, metalness: 0, roughness: 0.42 })
  const darkMat = new MeshStandardMaterial({ color: 0x33363b, metalness: 0.05, roughness: 0.48 })
  const depth = 0.1
  const w = poleW * 0.9
  const shellT = 0.005

  // 内部件材质。区别于外壳：铜排、银触点、钢片、双金属各一种
  const copperMat = new MeshStandardMaterial({ color: COPPER, metalness: 0.85, roughness: 0.38 })
  const silverMat = new MeshStandardMaterial({ color: 0xcfd3d6, metalness: 0.95, roughness: 0.22 })
  const plateMat = new MeshStandardMaterial({ color: 0x7c8188, metalness: 0.9, roughness: 0.5 })
  const bimetalMat = new MeshStandardMaterial({ color: 0xa9743c, metalness: 0.75, roughness: 0.45 })

  for (let i = 0; i < poles; i += 1) {
    const x = (i - (poles - 1) / 2) * poleW

    /* ---- 外壳：六片薄壁，围出一个能装机构的空腔 ---- */
    group.add(
      roundedBox(shellT, height, depth, faceMat, x - w / 2, 0, 0, 0.002),
      roundedBox(shellT, height, depth, faceMat, x + w / 2, 0, 0, 0.002),
      roundedBox(w, shellT, depth, faceMat, x, height / 2 - shellT / 2, 0, 0.002),
      roundedBox(w, shellT, depth, faceMat, x, -height / 2 + shellT / 2, 0, 0.002),
      // 前盖：剖切默认就切在它前面，去掉它才看得到内部
      roundedBox(w * 0.92, height, 0.006, faceMat, x, 0, depth / 2 - 0.003, 0.002),
      roundedBox(w, height, 0.006, faceMat, x, 0, -depth / 2 + 0.003, 0.002),
    )

    /* ---- 内部机构 ----
       按**真实电流路径**从下往上排：下端子 → 双金属片 → 静触点 → 电弧区（灭弧室）
       → 上端子。位置不是随手摆的，是这条路径决定的；这样剖开以后，
       一眼能顺着看明白「电从哪进来、经过什么、从哪出去」。
       动触点的落点同样反算过：臂长 60mm、摆 0.5rad，尖端正好压在静触点银点上。 */
    /* 双金属片：下端固定、上端自由。过载时受热向脱扣杆一侧弯曲——
       绕下端转一个很小的角度就够了，真机也就是零点几毫米的位移。 */
    const bimetal = roundedBox(0.032, 0.05, 0.005, bimetalMat, 0, 0.025, 0, 0.002)
    const bimetalPivot = new Group()
    bimetalPivot.position.set(x, -0.087, -0.026)
    bimetalPivot.add(bimetal)
    bimetals.push(bimetalPivot)
    group.add(bimetalPivot)

    // 脱扣杆：被顶开后绕自身轴转，释放锁扣
    const trip = roundedBox(0.036, 0.006, 0.006, plateMat, 0, 0, 0, 0.001)
    const tripPivot = new Group()
    tripPivot.position.set(x, -0.03, -0.03)
    tripPivot.add(trip)
    trips.push(tripPivot)
    group.add(tripPivot)

    /* 触点压力弹簧：合闸后还要再压一点——这一点压缩量就是「超程」。
       没有它，动臂只是「碰到」静触点；有了它，才看得出「压紧」。
       用螺旋管做，缩放 Y 就是压缩。 */
    const helix: Vector3[] = []
    for (let k = 0; k <= 36; k += 1) {
      const a = (k / 36) * Math.PI * 2 * 3
      helix.push(new Vector3(Math.cos(a) * 0.006, (k / 36) * 0.02 - 0.01, Math.sin(a) * 0.006))
    }
    const spring = new Mesh(
      new TubeGeometry(new CatmullRomCurve3(helix), 60, 0.0011, 5, false),
      plateMat,
    )
    spring.position.set(x, -0.044, 0.016)
    springs.push(spring)
    group.add(spring)
    // 静触点铜排 + 银点
    group.add(roundedBox(0.02, 0.04, 0.013, copperMat, x, -0.03, -0.028, 0.002))
    group.add(roundedBox(0.018, 0.008, 0.012, silverMat, x, -0.007, -0.024, 0.002))
    // 灭弧室：一叠钢片，压住触点上方
    for (let k = 0; k < 7; k += 1) {
      group.add(roundedBox(w - 0.02, 0.0038, 0.032, plateMat, x, 0.004 + k * 0.0048, -0.018, 0.001))
    }
    // 上引排：从灭弧室顶接到上端子
    group.add(roundedBox(0.014, 0.028, 0.011, copperMat, x, 0.055, -0.028, 0.002))
    // 软连接：动触点臂到下端子的铜编织带，三股
    for (let k = -1; k <= 1; k += 1) {
      const braid = new Mesh(new CylinderGeometry(0.0022, 0.0022, 0.052, 6), copperMat)
      braid.position.set(x + k * 0.005, -0.075, -0.008)
      braid.rotation.x = 0.35
      group.add(braid)
    }

    /* ---- 动触点臂：绕下端铰点摆，合闸时压到静触点银点上 ---- */
    const arm = new Group()
    arm.position.set(x, -0.06, 0.005)
    arm.add(roundedBox(0.016, 0.06, 0.014, copperMat, 0, 0.03, 0, 0.002))
    arm.add(roundedBox(0.018, 0.009, 0.013, silverMat, 0, 0.058, 0, 0.002))
    arms.push(arm)
    group.add(arm)

    /* ---- 手柄轴：把拨杆的角度传进壳里 ---- */
    const shaft = new Mesh(new CylinderGeometry(0.006, 0.006, w - 0.008, 12), darkMat)
    shaft.rotation.z = Math.PI / 2
    shaft.position.set(x, height * 0.04, depth / 2 - 0.012)
    group.add(shaft)

    /* ---- 手柄与状态窗：挂在 cutKeep 下，刀落下时它们保持完整 ---- */
    const front = new Group()
    front.userData.cutKeep = true

    const hinge = new Group()
    hinge.position.set(x, height * 0.04, depth / 2 - 0.002)
    hinge.add(roundedBox(poleW * 0.46, height * 0.34, 0.028, darkMat.clone(), 0, height * 0.17, 0, 0.006))
    // 手柄顶端一道横向防滑纹，转起来更容易被看见
    hinge.add(roundedBox(poleW * 0.52, 0.012, 0.032, chromeMaterial(), 0, height * 0.33, 0, 0.004))
    hinge.rotation.x = 1.0
    handles.push(hinge)
    front.add(hinge)

    /* 状态窗**不**挂 cutKeep：它长在前盖上，前盖被切掉时应当跟着消失。
       只留手柄完整——手柄是动作的主角，窗是面板上的贴片。 */
    const plate = windowPlate(poleW * 0.56, 0.024)
    plate.position.set(x, -height * 0.16, depth / 2 + 0.003)
    windows.push(plate)
    group.add(plate)

    group.add(front)

    // 上下接线螺钉
    for (const sy of [1, -1]) {
      const screw = new Mesh(new SphereGeometry(0.01, 12, 8), chromeMaterial())
      screw.position.set(x, sy * height * 0.44, -0.016)
      group.add(screw)
    }
  }

  /* 极间连杆：这根杆是「3P 必须同时动作」的视觉证据。
     它和手柄一样长在前面，所以同样挂 cutKeep——剖切把手柄留下、却把连杆切掉，
     3P 就退化成三个独立的单极，正好把这一页要讲的点弄丢了。 */
  if (poles > 1) {
    const link = roundedBox(poleW * (poles - 1) + 0.026, 0.013, 0.015, darkMat.clone(), 0, height * 0.19, depth / 2 - 0.005, 0.004)
    link.userData.cutKeep = true
    group.add(link)
  }

  return { group, handles, windows, arms, springs, bimetals, trips }
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
  board.userData.cutKeep = true
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
  contactor.userData.cutKeep = true
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
  relayGroup.userData.cutKeep = true
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
  lampGroup.userData.cutKeep = true
  parts.lamps = lampGroup
  root.add(lampGroup)

  /* ------------------------------------------------------------ 端子排 */
  const terminals = new Group()
  const termMat = new MeshStandardMaterial({ color: 0x8d9196, metalness: 0.2, roughness: 0.55 })
  for (let i = 0; i < 10; i += 1) {
    terminals.add(roundedBox(0.034, 0.055, 0.05, termMat, -0.3 + i * 0.04, 0.065, 0.06, 0.003))
  }
  terminals.userData.cutKeep = true
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

  wireGroup.userData.cutKeep = true
  parts.wires = wireGroup
  root.add(wireGroup)

  /* ------------------------------------------------------------ 动作 */
  /**
   * 时间轴（与 DeviceDemoView 的读数同源，改一处要改两处）：
   *   0.02 主断路器合闸 │ 0.14 分路合闸 │ 0.28 控制回路得电 │ 0.30 接触器
   *   0.48 继电器自检   │ 0.72 系统就绪 │ 0.78 过载脱扣     │ 0.88 复位
   *   0.94 重新合闸
   *
   * 每台断路器只由四个量驱动：`closed` / `trip` / `reset` / `reclose`。
   * 手柄角度、触点、弹簧、双金属、脱扣杆全部从这四个量算出来——
   * 不给零件各写一套时间，否则脱扣时会出现「触点弹开了、手柄还在合闸位」这种错位。
   */
  const applyBreaker = (
    rig: BreakerRig,
    closed: number,
    trip: number,
    reset: number,
    reclose: number,
  ): void => {
    const OFF = 1.0
    const ON = -0.35
    const MID = 0.42

    /* 手柄的四段：合闸 → 脱扣落到中间位 → 扳到底复位 → 再推上去合闸。
       这四段就是现场处置顺序，缺一段「中间位」这个知识点就立不住。 */
    const base = OFF + (ON - OFF) * closed
    let angle = base + (MID - base) * trip
    angle += (OFF - angle) * reset
    angle += (ON - angle) * reclose
    for (const handle of rig.handles) handle.rotation.x = angle

    // 触点：合闸到位的进度；脱扣清零、再合闸恢复
    const contact = Math.max(closed * (1 - trip), reclose)
    for (const arm of rig.arms) arm.rotation.x = -0.5 * contact
    // 弹簧压缩量 = 超程，跟着触点走
    for (const spring of rig.springs) spring.scale.y = 1 - 0.18 * contact

    /* 热元件：脱扣时弯曲，复位时才回弹。真机要等双金属片冷却，
       这里跟复位同步，是为了让「复位」这个动作有可见的因果。 */
    const thermal = trip * (1 - reset)
    for (const hinge of rig.bimetals) hinge.rotation.x = 0.12 * thermal
    for (const bar of rig.trips) bar.rotation.x = -0.18 * thermal

    // 状态窗：触点闭合即带电（红），断开/脱扣/已复位都是绿（安全位）
    for (const plate of rig.windows) setLed(plate, contact >= 0.98 ? RED : GREEN, true)
  }

  const setT = (t: number): void => {
    /**
     * 手柄从 +1.0（指向前下 = 断开）转到 -0.35（指向上后 = 闭合）——
     * 方向不能反：现场看到手柄朝下就是断开，朝上才是合闸。
     * 行程取 1.35rad（约 77°），比真机的 ±25° 夸张——真机行程在屏幕上
     * 只有十几个像素，不夸张等于没动作。
     */
    const trip = seg(t, 0.78, 0.86)
    const reset = seg(t, 0.88, 0.93)
    const reclose = seg(t, 0.94, 1.0)

    applyBreaker(main, seg(t, 0.02, 0.12), trip, reset, reclose)

    // 单极断路器随后合上
    const sp = [sp1, sp2]
    sp.forEach((breaker, i) => {
      applyBreaker(breaker, seg(t, 0.14 + i * 0.04, 0.2 + i * 0.04), trip, reset, reclose)
    })

    // 控制回路得电。未得电时电源灯是红的——红灯表示
    // 「主回路有电、控制回路没起来」，这是现场语义，不是「不亮」。
    setLed(powerLed, t >= 0.28 ? GREEN : RED, true)

    // 接触器：吸合 → 脱扣释放 → 再合闸吸回
    const pulled = Math.max(seg(t, 0.3, 0.44) * (1 - seg(t, 0.82, 0.86)), seg(t, 0.97, 1.0))
    armature.position.z = 0.132 - 0.018 * pulled
    setLed(contactorLed, GREEN, pulled >= 0.98)

    // 继电器依次动作 → 脱扣全部释放 → 再合闸依次吸回
    for (let i = 0; i < relayLeds.length; i += 1) {
      const at = 0.48 + i * 0.06
      const active = Math.max(
        t >= at && t < 0.82 ? 1 : 0,
        t >= 0.97 + i * 0.01 ? 1 : 0,
      )
      setLed(relayLeds[i], AMBER, active === 1)
      relayArms[i].rotation.z = active === 1 ? -0.38 : 0
    }

    // 运行指示：就绪绿 → 脱扣灭 → 再合闸后恢复
    const running = (t >= 0.72 && t < 0.8) || t >= 0.99
    setLed(runLed, GREEN, running)
    setLed(alarmLed, RED, t >= 0.8 && t < 0.97)
  }

  /* 阶段文案的唯一来源在 `lib/devphase.ts`：同一句话不该在这里再写一遍。
     2026-11-12 评审 R11-6：三维侧与读数侧各写一份，`door` 已经漂成
     "三维说完全开启、界面说到位检测"。阈值改动请改 devphase 的常量。 */
  const phase = (t: number): string => phaseFor('cabinet', t)

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
    /* 元件特写：六个元件都算"要看的"，背板不算。 */
  focus: ['breakers', 'contactor', 'relays', 'lamps', 'terminals'],
  fitMargin: 1.18,
  framing: { target: [0.02, 0.35, 0.04], distance: 2.62 },
    /* 剖切沿 Z（从前往后切）：断路器外壳是六片薄壁，去掉前盖就露出
       灭弧室、动静触点、双金属片、手柄轴——这一刀切下去是有东西看的。
       默认位置落在前盖前面：外壳被切开，内部机构完整保留。
       其余元件（接触器、继电器、端子排、导线）挂 cutKeep，不参与裁剪，
       否则接触器那种实心盒会被切成一块黑板，反而挡视线。 */
    cut: { axis: 'z', from: -0.02, to: 0.1, cap: 0x4a433a },
    dispose: () => disposeTree(root),
  }
}
