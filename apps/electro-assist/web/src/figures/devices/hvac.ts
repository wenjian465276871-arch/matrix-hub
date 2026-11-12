/** 客室空调机组（顶置单元式）：壳体、冷凝风机、冷凝器、蒸发器、滤网、
 *  送风口、压缩机、控制盒、制冷剂管路、检修台。
 *
 *  ## 这一页要讲什么
 *  指导书五步：外观确认 → 控制电源 → 通风风速/送风温度 → 送回风温差 →
 *  压缩机电流/高压压力。前四步在二维图元里都只是"一个表读数"，
 *  看不出**读的是哪台设备、表笔/探头伸到哪儿**。所以这台机组的建模目标
 *  不是"像一张产品照"，而是让这五步各自有一个能看懂的取景：
 *  整机、控制盒、回风口滤网与送风口、蒸发器、压缩机与管路。
 *
 *  ## 形体参考（公开资料）
 *  顶置单元式空调机组装在车顶，外形是一台扁平的长方机柜，长约 2.4m、
 *  宽约 1.7m、高约 0.4m（CRH 系列客室空调机组的公开外形量级）。
 *  顶部一端是两台轴流冷凝风机（带防护网罩），侧面是进风百叶，
 *  中部是蒸发段（回风口 + 滤网 + 蒸发器 + 离心送风机），
 *  另一端是压缩机舱与控制盒；制冷剂为 R407C 一类中压制冷剂。
 *  尺寸、型号、参数都是**演示虚构值**，几何按上述量级自建。
 *
 *  ## 为什么架在检修台上
 *  顶置机组的回风口、送风口都在**底面**——直接摆在地上，第 3 步
 *  「测送风口风速」就没有可拍的东西。检修台上架高 0.52m，
 * 托架只留两根纵梁（不吃掉底面），从低机位才看得到滤网与送风格栅。
 *
 *  ## 时间轴（与后端 `DEVICE_MOMENTS["hvac"]` 的 t 一一对应）
 *  0.00 盖板关闭、机组停用 → 0.20 两块检修盖板掀开 → 0.36 控制电源接通、
 *  断路器合闸 → 0.55 通风模式（送风机 + 冷凝风机运行）→
 *  0.78 制冷模式（压缩机运行、蒸发器结露）→ 1.00 稳定运行。
 */
import {
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  Euler,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  TorusGeometry,
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
  rubberMaterial,
  seg,
  steelMaterial,
} from './rig'
import { canvasTexture, facePlate } from './print'
import { HVAC_T, phaseFor } from '../../lib/devphase'

/* ------------------------------------------------------------------ 尺寸 */

/** 机组外形（米）。L 沿 X（车长方向）、W 沿 Z、H 为壳体高度。 */
const U = {
  L: 2.4,
  W: 1.7,
  H: 0.38,
  /** 检修台上表面 = 机组底面 */
  deck: 0.52,
  /** 底盘厚度 */
  pan: 0.05,
  /** 板厚 */
  t: 0.018,
}

const BOTTOM = U.deck + U.pan // 0.57 内底
const TOP = BOTTOM + U.H // 0.95 壳顶
const TOP_T = 0.02
const X0 = -U.L / 2
const X1 = U.L / 2
const Z0 = -U.W / 2
const Z1 = U.W / 2
/** 三个舱的分界（X）：压缩机舱 | 蒸发段 | 冷凝段 */
const XC1 = -0.45
const XC2 = 0.45

const CASING = 0xb9c0c6
const CASING_DARK = 0x8b9298
const FRAME = 0x686f75
const FIN = 0x9a8c7c
/** 结露后的翅片色。
 *  不是"结霜"——制冷工况下翅片在露点以下、结的是**水膜**：比金属暗一档、
 *  偏冷灰蓝、而且很亮（水膜反光）。第一版刷成近白 `0xd2e2e8`，远看像一块
 *  白塑料板，翅片层次全糊了。 */
const FROST = 0x84979f
const FIN_COLOR = new Color(FIN)
const FROST_COLOR = new Color(FROST)

/* -------------------------------------------------------------- 小工具 */

/** 铆钉/螺栓：沿某根轴的小圆柱。钣金件没有铆钉就永远像一块塑料。 */
function rivet(
  parent: Group,
  x: number,
  y: number,
  z: number,
  axis: 'x' | 'y' | 'z' = 'y',
  r = 0.0055,
  h = 0.006,
): void {
  const bolt = new Mesh(new CylinderGeometry(r, r, h, 8), chromeMaterial())
  if (axis === 'y') bolt.position.set(x, y, z)
  else if (axis === 'z') {
    bolt.position.set(x, y, z)
    bolt.rotation.x = Math.PI / 2
  } else {
    bolt.position.set(x, y, z)
    bolt.rotation.z = Math.PI / 2
  }
  bolt.castShadow = true
  parent.add(bolt)
}

/** 一排铆钉：从 a 到 b 均分 n 个。`axis` 是铆钉自身的轴向。 */
function rivetRow(
  parent: Group,
  from: [number, number, number],
  to: [number, number, number],
  count: number,
  axis: 'x' | 'y' | 'z' = 'y',
): void {
  for (let i = 0; i < count; i += 1) {
    const k = count === 1 ? 0.5 : i / (count - 1)
    rivet(
      parent,
      from[0] + (to[0] - from[0]) * k,
      from[1] + (to[1] - from[1]) * k,
      from[2] + (to[2] - from[2]) * k,
      axis,
    )
  }
}

/** 铜管：给几个控制点，样条插值成一段弯管。空调机上到处是弯管，
 *  直角折线一眼就假。 */
function pipe(
  parent: Group,
  material: MeshStandardMaterial,
  points: Array<[number, number, number]>,
  radius = 0.0095,
): Mesh {
  const curve = new CatmullRomCurve3(points.map((p) => new Vector3(...p)))
  const mesh = new Mesh(new TubeGeometry(curve, Math.max(24, points.length * 10), radius, 10, false), material)
  mesh.castShadow = true
  mesh.receiveShadow = true
  parent.add(mesh)
  return mesh
}

/** 翅片盘管：一排薄板 + 两根集管。远看是一片"密齿"的块，近看有齿。 */
function finPack(
  parent: Group,
  width: number,
  height: number,
  depth: number,
  fins: number,
  material: MeshStandardMaterial,
  tube: MeshStandardMaterial,
): Group {
  const pack = new Group()
  const gap = depth / fins
  for (let i = 0; i < fins; i += 1) {
    const plate = roundedBox(width, height, 0.0016, material, 0, 0, -depth / 2 + gap * (i + 0.5), 0.0006)
    pack.add(plate)
  }
  // 上下集管（铜），翅片就穿在这两根管上
  const top = new Mesh(new CylinderGeometry(0.009, 0.009, depth * 0.92, 10), tube)
  top.rotation.x = Math.PI / 2
  top.position.set(width / 2 - 0.03, height / 2 - 0.02, 0)
  const bottom = top.clone()
  bottom.position.set(-width / 2 + 0.03, -height / 2 + 0.02, 0)
  pack.add(top, bottom)
  parent.add(pack)
  return pack
}

/* ------------------------------------------------------------ 单台风机 */

/** 轴流冷凝风机：导风圈 + 叶轮 + 防护网罩。
 *
 *  网罩是这台设备最好认的一处（停机坪上一眼就是"空调"），
 *  所以同心圆用真几何（细环），不是贴图。叶轮单独成组，`setT` 里转它。
 */
function axialFan(material: MeshStandardMaterial): { group: Group; rotor: Group } {
  const group = new Group()
  const R = 0.225

  // 导风圈：短圆筒，开口两端
  const shroud = new Mesh(new CylinderGeometry(R, R, 0.085, 32, 1, true), material)
  shroud.castShadow = true
  shroud.receiveShadow = true
  group.add(shroud)

  // 叶轮：轮毂 + 5 片扭曲叶片
  const rotor = new Group()
  const hub = new Mesh(new CylinderGeometry(0.052, 0.062, 0.07, 20), paintedMaterial(0x2b2e31))
  hub.castShadow = true
  rotor.add(hub)
  for (let i = 0; i < 5; i += 1) {
    const blade = roundedBox(0.155, 0.006, 0.095, paintedMaterial(0x33373b), 0, 0, 0, 0.002)
    blade.position.set(0.128, -0.028, 0)
    // 绕径向（X）先给一个桨距角，再绕轴（Y）分布
    blade.rotation.x = 0.62
    const arm = new Group()
    arm.rotation.y = (i / 5) * Math.PI * 2
    arm.add(blade)
    rotor.add(arm)
  }
  rotor.position.y = 0.005
  group.add(rotor)

  // 防护网罩：4 道同心环 + 8 根辐条 + 中心圆盘
  const wire = steelMaterial(0xc4c9cd)
  for (const r of [0.062, 0.115, 0.168, 0.216]) {
    const ring = new Mesh(new TorusGeometry(r, 0.0028, 6, 44), wire)
    ring.rotation.x = Math.PI / 2
    ring.position.y = 0.05
    group.add(ring)
  }
  for (let i = 0; i < 8; i += 1) {
    const spoke = roundedBox(0.2, 0.0045, 0.0045, wire, 0.11, 0.05, 0, 0.001)
    const arm = new Group()
    arm.rotation.y = (i / 8) * Math.PI * 2
    arm.add(spoke)
    group.add(arm)
  }
  const cap = new Mesh(new CylinderGeometry(0.032, 0.032, 0.012, 18), wire)
  cap.position.y = 0.054
  group.add(cap)

  return { group, rotor }
}

/* ------------------------------------------------------------- 离心风机 */

/** 离心送风机：蜗壳 + 出口接片。叶轮在壳里，转不转看不出来——
 *  所以只把蜗壳与出口做对，转速体现为"运行指示灯"和风阀。
 *  出口朝 Z 外侧，正对底面的送风口。 */
function blower(material: MeshStandardMaterial, z: number): Group {
  const g = new Group()
  const drum = new Mesh(new CylinderGeometry(0.115, 0.115, 0.2, 24), material)
  drum.rotation.x = Math.PI / 2
  g.add(drum)
  // 蜗壳：把圆筒包住的一段外壳 + 切向出口
  const shell = new Mesh(new CylinderGeometry(0.135, 0.135, 0.21, 24, 1, true), material)
  shell.rotation.x = Math.PI / 2
  g.add(shell)
  const duct = roundedBox(0.16, 0.13, 0.16, material, 0, 0, Math.sign(z) * 0.17, 0.006)
  g.add(duct)
  g.position.set(0, 0, z)
  return g
}

/* ------------------------------------------------------------------ 主函数 */

export function buildHvac(): DeviceRig {
  const root = new Group()
  const parts: Record<string, Object3D> = {}

  const casing = paintedMaterial(CASING)
  const casingDark = paintedMaterial(CASING_DARK)
  const frameMat = paintedMaterial(FRAME)
  const finMat = new MeshStandardMaterial({
    color: FIN,
    metalness: 0.85,
    roughness: 0.62,
    envMapIntensity: 0.9,
  })
  /* 蒸发器**单独一份**翅片材质：制冷时它要结露变白。
     共用 `finMat` 会把冷凝器也一起染白（那是散热侧，本来就不该结露）。 */
  const evapFinMat = finMat.clone()
  const copper = new MeshStandardMaterial({
    color: 0xb26b3c,
    metalness: 1,
    roughness: 0.34,
    envMapIntensity: 0.95,
  })

  /* ============================================================ 检修台 */
  const stand = new Group()
  root.add(stand)
  parts.stand = stand

  /* 两台**端部马凳**，不是两根通长纵梁。
     第 3 步要仰视底面（回风滤网与送风格栅都在机腹），通长纵梁会正好架在
     镜头与底面之间，把整个画面切成两条。马凳只落在 x=±0.95，
     机腹中线整段敞着，仰视时才看得见滤网的折页。 */
  for (const x of [-0.95, 0.95]) {
    // 横梁（沿 Z）
    stand.add(roundedBox(0.12, 0.1, 1.62, steelMaterial(0x8b9297), x, U.deck - 0.05, 0, 0.005))
    // 梁下加强板
    stand.add(roundedBox(0.09, 0.016, 1.5, steelMaterial(0x767d82), x, U.deck - 0.108, 0, 0.003))
    for (const z of [-0.7, 0.7]) {
      // 支腿：略外撇（马凳的真实姿势），用两段拼一个 A 形
      const leg = roundedBox(0.07, U.deck - 0.12, 0.07, steelMaterial(0x8b9297), x, (U.deck - 0.12) / 2, z, 0.004)
      stand.add(leg)
      stand.add(roundedBox(0.13, 0.014, 0.13, steelMaterial(0x767d82), x, 0.007, z, 0.003))
      // 斜撑：从梁端斜到腿脚
      const brace = roundedBox(0.05, 0.05, 0.5, steelMaterial(0x8b9297), x, U.deck - 0.2, z * 0.55, 0.004)
      brace.rotation.x = z > 0 ? -0.5 : 0.5
      stand.add(brace)
    }
  }

  /* ============================================================== 壳体 */
  const shell = new Group()
  root.add(shell)
  parts.shell = shell

  /* 底盘：**必须开回风孔**。
     回风口是没有格栅的"大洞"（格栅是拆下来的滤网），底盘若是一整块板，
     从低机位看过去就是一块铁皮，第 3 步「测送风口风速」无从取景。
     所以底盘由四块拼成：中间让出 0.62 × 1.02 的回风开口。 */
  const RF = { x: 0.31, z: 0.51 }
  // 左右两条：从端板到开口边（-RF.x .. RF.x 才是开口），宽度 = 端到开口边
  shell.add(roundedBox(-RF.x - X0, U.pan, U.W, paintedMaterial(0x8c9399), (X0 - RF.x) / 2, U.deck + U.pan / 2, 0, 0.006))
  shell.add(roundedBox(X1 - RF.x, U.pan, U.W, paintedMaterial(0x8c9399), (RF.x + X1) / 2, U.deck + U.pan / 2, 0, 0.006))
  for (const z of [-1, 1]) {
    shell.add(
      roundedBox(RF.x * 2, U.pan, (U.W / 2 - RF.z), paintedMaterial(0x8c9399), 0, U.deck + U.pan / 2, z * (RF.z + U.W / 2) / 2, 0.006),
    )
  }

  // 侧板（长边）：冷凝段做成可进风的百叶，其余是整板
  for (const z of [Z0 + U.t / 2, Z1 - U.t / 2]) {
    // 压机段 + 蒸发段整板
    shell.add(
      roundedBox(XC2 - X0, U.H, U.t, casing, (X0 + XC2) / 2, BOTTOM + U.H / 2, z, 0.003),
    )
    // 冷凝段：上下横档 + 两侧立柱，中间让给百叶
    shell.add(roundedBox(X1 - XC2, 0.05, U.t, casing, (XC2 + X1) / 2, TOP - 0.025, z, 0.003))
    shell.add(roundedBox(X1 - XC2, 0.045, U.t, casing, (XC2 + X1) / 2, BOTTOM + 0.0225, z, 0.003))
    for (const x of [XC2 + 0.02, X1 - 0.02]) {
      shell.add(roundedBox(0.04, U.H, U.t, casing, x, BOTTOM + U.H / 2, z, 0.003))
    }
    // 进风百叶：9 片斜叶
    for (let i = 0; i < 9; i += 1) {
      const slat = roundedBox(X1 - XC2 - 0.08, 0.02, 0.005, casingDark, (XC2 + X1) / 2, BOTTOM + 0.075 + i * 0.034, z - Math.sign(z) * 0.006, 0.0015)
      // 叶片向外下倾：看到的是"缝"，不是一大片黑
      slat.rotation.x = Math.sign(z) * -0.55
      shell.add(slat)
    }
  }

  // 端板（短边）
  for (const x of [X0 + U.t / 2, X1 - U.t / 2]) {
    shell.add(roundedBox(U.t, U.H, U.W, x < 0 ? casing : casingDark, x, BOTTOM + U.H / 2, 0, 0.003))
  }

  // 四角立柱：真实机柜的角上有折边立柱，也是铆钉的落脚点
  for (const x of [X0 + 0.014, X1 - 0.014]) {
    for (const z of [Z0 + 0.014, Z1 - 0.014]) {
      shell.add(roundedBox(0.032, U.H + 0.01, 0.032, frameMat, x, BOTTOM + U.H / 2, z, 0.004))
    }
  }

  /* 内衬：舱内壁压一层深一档的内衬板。
     外壳 0xb9c0c6 是"洗过的"外表面，舱内是镀锌原色 + 灰，差一档才有"打开盖子"的感觉。
     不做内衬时，打开盖板后四周全是白墙，部件反而看不见。 */
  const liner = paintedMaterial(0x7e858b)
  for (const z of [Z0 + 0.03, Z1 - 0.03]) {
    shell.add(roundedBox(U.L - 0.06, U.H - 0.03, 0.004, liner, 0, BOTTOM + (U.H - 0.03) / 2, z, 0.001))
  }
  for (const x of [X0 + 0.03, X1 - 0.03]) {
    shell.add(roundedBox(0.004, U.H - 0.03, U.W - 0.06, liner, x, BOTTOM + (U.H - 0.03) / 2, 0, 0.001))
  }

  // 舱内隔板（两处），把三舱分开
  for (const x of [XC1, XC2]) {
    shell.add(roundedBox(0.016, U.H - 0.02, U.W - 0.05, casingDark, x, BOTTOM + (U.H - 0.02) / 2, 0, 0.003))
  }

  // 冷凝段顶面：风机平台。四边框条 + 两个风机开口的环
  const deckPlateY = TOP - TOP_T / 2
  shell.add(roundedBox(X1 - XC2, TOP_T, 0.06, casing, (XC2 + X1) / 2, deckPlateY, Z0 + 0.03, 0.003))
  shell.add(roundedBox(X1 - XC2, TOP_T, 0.06, casing, (XC2 + X1) / 2, deckPlateY, Z1 - 0.03, 0.003))
  shell.add(roundedBox(0.05, TOP_T, U.W, casing, XC2 + 0.025, deckPlateY, 0, 0.003))
  shell.add(roundedBox(0.05, TOP_T, U.W, casing, X1 - 0.025, deckPlateY, 0, 0.003))
  shell.add(roundedBox(X1 - XC2 - 0.1, TOP_T, 0.05, casing, (XC2 + X1) / 2, deckPlateY, 0, 0.003))
  for (const z of [-0.42, 0.42]) {
    const ring = new Mesh(new TorusGeometry(0.233, 0.012, 8, 40), casing)
    ring.rotation.x = Math.PI / 2
    ring.position.set(0.885, TOP, z)
    shell.add(ring)
  }

  /* 顶盖压框：真实机组顶部不是"一块平板盖在箱子上"，而是四周有一圈
     折边压框、盖板嵌在框里用螺栓压紧。不加这圈，整机读起来像一个浅托盘。 */
  for (const z of [Z0 + 0.02, Z1 - 0.02]) {
    shell.add(roundedBox(XC2 - X0, 0.03, 0.04, casingDark, (X0 + XC2) / 2, TOP + 0.005, z, 0.003))
  }
  for (const x of [X0 + 0.02, XC2 - 0.02]) {
    shell.add(roundedBox(0.04, 0.03, U.W, casingDark, x, TOP + 0.005, 0, 0.003))
  }

  /* 吊耳：四角各一只（顶置机组靠它整机吊装上下车顶），是最好认的形体特征之一 */
  for (const x of [X0 + 0.08, X1 - 0.08]) {
    for (const z of [Z0 + 0.07, Z1 - 0.07]) {
      const lug = roundedBox(0.07, 0.075, 0.018, frameMat, x, TOP + 0.04, z, 0.006)
      shell.add(lug)
      const hole = new Mesh(new CylinderGeometry(0.017, 0.017, 0.024, 14), paintedMaterial(0x2e3338))
      hole.rotation.x = Math.PI / 2
      hole.position.set(x, TOP + 0.052, z)
      shell.add(hole)
    }
  }

  // 顶盖上的铆钉：沿三块盖板与风机平台的边缘
  rivetRow(shell, [X0 + 0.06, TOP, Z0 + 0.04], [XC2 - 0.03, TOP, Z0 + 0.04], 9)
  rivetRow(shell, [X0 + 0.06, TOP, Z1 - 0.04], [XC2 - 0.03, TOP, Z1 - 0.04], 9)
  rivetRow(shell, [XC2 + 0.05, TOP, Z0 + 0.05], [X1 - 0.05, TOP, Z0 + 0.05], 5)
  rivetRow(shell, [XC2 + 0.05, TOP, Z1 - 0.05], [X1 - 0.05, TOP, Z1 - 0.05], 5)

  // 铭牌与警示标（贴在 -X 端板外侧）
  const plateTex = canvasTexture(512, 300, (ctx, w, h) => {
    ctx.fillStyle = '#dde1e4'
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = '#7b8288'
    ctx.lineWidth = 7
    ctx.strokeRect(12, 12, w - 24, h - 24)
    ctx.fillStyle = '#1b2530'
    ctx.font = 'bold 44px "Microsoft YaHei", sans-serif'
    ctx.fillText('客室空调机组', 34, 84)
    ctx.font = '28px "Microsoft YaHei", sans-serif'
    ctx.fillText('KLD-40A  顶置单元式', 34, 130)
    ctx.font = '24px "Microsoft YaHei", sans-serif'
    ctx.fillStyle = '#33404d'
    ctx.fillText('制冷剂 R407C   电源 DC110V', 34, 182)
    ctx.fillText('制冷量 40 kW   质量 420 kg', 34, 220)
    ctx.fillStyle = '#7b8288'
    ctx.font = '20px "Microsoft YaHei", sans-serif'
    ctx.fillText('演示虚构铭牌 · 非实际设备参数', 34, 264)
  })
  const nameplate = facePlate(0.2, 0.117, plateTex)
  nameplate.rotation.y = -Math.PI / 2
  nameplate.position.set(X0 - 0.002, BOTTOM + 0.2, 0.34)
  shell.add(nameplate)

  /* ======================================================= 检修盖板 ×2 */
  /* 盖板**拆下**，不是掀开。
     铰链在长边上：盖板 1.65m 宽，绕铰链掀 100° 会立成一堵 1.5m 高的白墙，
     把整个机舱挡死；而现场检修本来就是拆盖板放一边。所以动画只做
     "抬起 9cm → 消失"，视觉上就是被人搬走了。 */
  const coverA = new Group()
  coverA.position.set(0, TOP, Z1 - 0.02)
  const coverB = new Group()
  coverB.position.set(0, TOP, Z1 - 0.02)
  shell.add(coverA, coverB)

  const lidA = roundedBox(XC1 - X0 - 0.05, TOP_T, U.W - 0.05, casing, (X0 + 0.03 + XC1 - 0.02) / 2, 0, -(U.W - 0.05) / 2, 0.004)
  const lidB = roundedBox(XC2 - XC1 - 0.05, TOP_T, U.W - 0.05, casing, (XC1 + 0.02 + XC2 - 0.02) / 2, 0, -(U.W - 0.05) / 2, 0.004)
  coverA.add(lidA)
  coverB.add(lidB)
  // 掀开时能看到的内侧加强筋
  for (const [lid, x0, x1] of [
    [coverA, X0 + 0.05, XC1 - 0.04],
    [coverB, XC1 + 0.04, XC2 - 0.04],
  ] as const) {
    for (let i = 0; i < 4; i += 1) {
      const k = (i + 0.5) / 4
      lid.add(
        roundedBox(0.03, 0.018, U.W - 0.12, frameMat, x0 + (x1 - x0) * k, -TOP_T / 2 - 0.009, -(U.W - 0.05) / 2, 0.002),
      )
    }
  }
  // 铰链：三节合页
  for (const x of [(X0 + XC1) / 2 - 0.34, (X0 + XC1) / 2, (X0 + XC1) / 2 + 0.34]) {
    const h = new Mesh(new CylinderGeometry(0.009, 0.009, 0.11, 10), frameMat)
    h.rotation.z = Math.PI / 2
    h.position.set(x, 0.006, 0)
    coverA.add(h)
  }
  for (const x of [(XC1 + XC2) / 2 - 0.2, (XC1 + XC2) / 2 + 0.2]) {
    const h = new Mesh(new CylinderGeometry(0.009, 0.009, 0.1, 10), frameMat)
    h.rotation.z = Math.PI / 2
    h.position.set(x, 0.006, 0)
    coverB.add(h)
  }
  /* 板缝：沿两块盖板的外沿压一圈 4mm 的深色接缝。
     白钣金件在影棚光下会糊成一整块，接缝是唯一能"分出块"的便宜手段。 */
  for (const [y0, xa, xb] of [
    [TOP + 0.001, X0 + 0.02, XC1 - 0.03],
    [TOP + 0.001, XC1 + 0.03, XC2 - 0.03],
  ] as const) {
    shell.add(roundedBox(xb - xa, 0.004, 0.014, frameMat, (xa + xb) / 2, y0, Z0 + 0.038, 0.001))
    shell.add(roundedBox(xb - xa, 0.004, 0.014, frameMat, (xa + xb) / 2, y0, Z1 - 0.038, 0.001))
  }

  // 盖板螺栓孔（掀开后露出的边条）
  rivetRow(coverA, [X0 + 0.08, 0.012, -0.04], [XC1 - 0.06, 0.012, -0.04], 7, 'y')
  rivetRow(coverB, [XC1 + 0.06, 0.012, -0.04], [XC2 - 0.06, 0.012, -0.04], 5, 'y')

  /* ========================================================== 冷凝器组 */
  const condenser = new Group()
  root.add(condenser)
  parts.condenser = condenser
  for (const z of [Z0 + 0.10, Z1 - 0.10]) {
    // 翅片盘管：贴两侧内壁
    const pack = finPack(condenser, X1 - XC2 - 0.16, U.H - 0.14, 0.075, 13, finMat, copper)
    pack.position.set((XC2 + X1) / 2, BOTTOM + (U.H - 0.14) / 2 + 0.05, z)
    // 盘管背后的挡风板，挡住"透过去看见另一侧百叶"
    /* 挡风板贴在盘管背面（盘管半深 0.0375 + 板半厚 0.004）：
       原来退 0.05，离盘管 10.6mm，自检判它悬空。 */
    condenser.add(
      roundedBox(
        X1 - XC2 - 0.14,
        U.H - 0.12,
        0.008,
        casingDark,
        (XC2 + X1) / 2,
        BOTTOM + 0.24,
        z - Math.sign(z) * 0.0415,
        0.002,
      ),
    )
  }
  // 冷凝段中间的风道隔板，把两侧进风分成两路
  condenser.add(roundedBox(X1 - XC2 - 0.05, U.H - 0.10, 0.02, casingDark, (XC2 + X1) / 2, BOTTOM + 0.24, 0, 0.003))

  /* ========================================================== 冷凝风机 */
  const fanPart = new Group()
  root.add(fanPart)
  parts.fans = fanPart
  const fanRig = [
    axialFan(casingDark),
    axialFan(casingDark),
  ]
  fanRig[0].group.position.set(0.885, TOP, -0.42)
  fanRig[1].group.position.set(0.885, TOP, 0.42)
  for (const f of fanRig) fanPart.add(f.group)

  /* ============================================================ 蒸发段 */
  const evaporator = new Group()
  root.add(evaporator)
  parts.evaporator = evaporator

  // 接水盘：浅盘 + 排水口
  evaporator.add(roundedBox(XC2 - XC1 - 0.06, 0.02, U.W - 0.08, steelMaterial(0xa8adb1), (XC1 + XC2) / 2, BOTTOM + 0.02, 0, 0.004))
  const drainPan = roundedBox(XC2 - XC1 - 0.1, 0.05, 0.34, steelMaterial(0x9aa0a5), (XC1 + XC2) / 2, BOTTOM + 0.055, 0, 0.006)
  evaporator.add(drainPan)

  // V 形蒸发器：两片斜置翅片盘管，上缘相接
  const evapPacks: Array<{ sign: number; pack: Group }> = []
  for (const sign of [-1, 1]) {
    const pack = finPack(evaporator, 0.8, 0.28, 0.07, 12, evapFinMat, copper)
    pack.position.set(0, BOTTOM + 0.2, sign * 0.19)
    pack.rotation.x = sign * 0.34
    pack.rotation.z = 0
    evapPacks.push({ sign, pack })
  }
  /* 原来这里有一块"挡水板"横在 V 形盘管上方——第 4 步要看的就是盘管，
     一块白板把整个蒸发段盖死，图里只剩白板。真实机组的挡水板贴在盘管
     上缘、只有几厘米宽，这里改成两条窄压条。 */
  for (const z of [-0.24, 0.24]) {
    evaporator.add(roundedBox(0.82, 0.01, 0.05, steelMaterial(0xa8adb1), 0, BOTTOM + 0.315, z, 0.002))
  }

  /* 结露（制冷段才出现）：翅片外侧挂水珠 + 接水盘积水。
     2026-11-12 R11-7：0.68 之后画面原本一动不动，而阶段文案已经在说
     "制冷模式起动 / 稳定运行"——文案在说、画面不动。真实机组制冷时
     蒸发器翅片挂满凝水、水顺着落进接水盘，这是"制冷"唯一看得见的证据。
     水珠挂在外侧面（`sign` 决定哪一侧是外侧），否则会被另一片盘管挡住。 */
  const condensate = new Group()
  evaporator.add(condensate)
  const waterMat = paintedMaterial(0xb9d3dc)
  waterMat.roughness = 0.18
  /* 水珠：**小、多、错落**。第一版是 7 颗 ø28mm 排成一条直线，看着像装饰铆钉，
     不像凝水。真实结露是密密麻麻的小珠子，越往下越大。位置用下标算出来的
     伪随机（不能用 Math.random——导出要可复现，每次烘图必须一模一样）。 */
  for (const { sign, pack } of evapPacks) {
    /* 位置用哈希式伪随机（`sin*43758` 取小数位）：
       用 `(i*37)%13` 那种线性取模会排出斜向的珠链——上一版就是这样，
       远看像粘了一条条珠串，反而不像水。 */
    const h = (n: number): number => {
      const v = Math.sin(n * 127.1) * 43758.5453
      return v - Math.floor(v)
    }
    for (let i = 0; i < 34; i += 1) {
      const x = -0.33 + h(i * 1.7) * 0.66
      const y = -0.09 + h(i * 3.1 + 11) * 0.18
      // 越往下越大：凝水顺着翅片往下聚
      const r = 0.0038 + h(i * 5.7 + 3) * 0.0026 + (y < -0.04 ? 0.0012 : 0)
      for (const face of [-1, 1]) {
        const local = new Vector3(x, y, face * 0.042)
        local.applyEuler(new Euler(sign * 0.34, 0, 0)).add(pack.position)
        const drop = new Mesh(new SphereGeometry(r, 8, 6), waterMat)
        drop.position.copy(local)
        // 扁一点、竖着拉长：贴面挂着的水珠不是正球
        drop.scale.set(1, 1.55, 0.42)
        condensate.add(drop)
      }
    }
  }
  // 接水盘积水：一块薄水面，随制冷进度上升一点（0.68 起 0，0.9 到顶）
  const water = roundedBox(XC2 - XC1 - 0.16, 0.008, 0.3, waterMat, (XC1 + XC2) / 2, BOTTOM + 0.082, 0, 0.002)
  condensate.add(water)

  // 两台离心送风机：分列蒸发器两侧，出口朝 Z 外侧
  for (const z of [-0.57, 0.57]) {
    const b = blower(casingDark, z)
    b.position.set(0, BOTTOM + 0.16, z)
    evaporator.add(b)
  }
  // 风机与送风口之间的软接（帆布接头）
  for (const z of [-0.69, 0.69]) {
    evaporator.add(roundedBox(0.2, 0.15, 0.1, rubberMaterial(0x3b3f43), 0, BOTTOM + 0.16, z, 0.006))
  }

  /* 底盘分缝：底面由多块镀锌板拼成，接缝是底面唯一的结构线 */
  for (const x of [-1.0, -0.62, 0.62, 1.0]) {
    shell.add(roundedBox(0.008, 0.002, U.W - 0.06, frameMat, x, U.deck + 0.001, 0, 0.001))
  }
  shell.add(roundedBox(U.L - 0.08, 0.002, 0.008, frameMat, 0, U.deck + 0.001, 0, 0.001))

  /* ============================================================ 送风口 */
  const supply = new Group()
  root.add(supply)
  parts.supply = supply
  for (const z of [-0.66, 0.66]) {
    // 衬板：叶片背后一块深色板，叶片才有剪影
    supply.add(roundedBox(0.5, 0.006, 0.15, paintedMaterial(0x3c4247), 0, U.deck - 0.002, z, 0.002))
    /* 送风格栅**吊在底盘下面**（不是嵌进底盘）：客室里看到的就是这条凸出的
       铝合金格栅。放在 U.deck 之上会被底盘吞掉，从低机位什么都看不到。 */
    supply.add(roundedBox(0.52, 0.018, 0.17, casingDark, 0, U.deck - 0.009, z, 0.004))
    for (let i = 0; i < 5; i += 1) {
      const slat = roundedBox(0.5, 0.006, 0.03, casing, 0, U.deck - 0.017, z - 0.056 + i * 0.028, 0.002)
      slat.rotation.x = Math.sign(z) * 0.4
      supply.add(slat)
    }
  }

  /* ============================================================ 回风口 */
  const filters = new Group()
  root.add(filters)
  parts.filters = filters
  // 回风口框（RF 与底盘开孔同源，改一处两边一起变）
  filters.add(roundedBox(RF.x * 2 + 0.06, 0.018, 0.05, casingDark, 0, U.deck + 0.004, -RF.z - 0.02, 0.003))
  filters.add(roundedBox(RF.x * 2 + 0.06, 0.018, 0.05, casingDark, 0, U.deck + 0.004, RF.z + 0.02, 0.003))
  filters.add(roundedBox(0.05, 0.018, RF.z * 2, casingDark, -RF.x - 0.02, U.deck + 0.004, 0, 0.003))
  filters.add(roundedBox(0.05, 0.018, RF.z * 2, casingDark, RF.x + 0.02, U.deck + 0.004, 0, 0.003))
  // 滤网：细密的折页，横竖各一组细条
  /* 滤网不能给高金属度：朝下的金属面在影棚里没有可反射的东西，整个变成黑片 */
  const meshMat = new MeshStandardMaterial({ color: 0x9ea5aa, metalness: 0.25, roughness: 0.62 })
  for (let i = 0; i < 26; i += 1) {
    const k = -RF.x + (i / 25) * RF.x * 2
    filters.add(roundedBox(0.004, 0.01, RF.z * 2, meshMat, k, U.deck + 0.012, 0, 0.001))
  }
  for (let i = 0; i < 20; i += 1) {
    const k = -RF.z + (i / 19) * RF.z * 2
    filters.add(roundedBox(RF.x * 2, 0.008, 0.004, meshMat, 0, U.deck + 0.006, k, 0.001))
  }
  // 滤网边框
  filters.add(roundedBox(RF.x * 2, 0.024, 0.02, frameMat, 0, U.deck + 0.008, -RF.z, 0.003))
  filters.add(roundedBox(RF.x * 2, 0.024, 0.02, frameMat, 0, U.deck + 0.008, RF.z, 0.003))
  filters.add(roundedBox(0.02, 0.024, RF.z * 2, frameMat, -RF.x, U.deck + 0.008, 0, 0.003))
  filters.add(roundedBox(0.02, 0.024, RF.z * 2, frameMat, RF.x, U.deck + 0.008, 0, 0.003))

  /* ============================================================ 压缩机舱 */
  const compressor = new Group()
  root.add(compressor)
  parts.compressor = compressor

  /* 压缩机摆在舱的**右后**（x -0.68 / z +0.05），控制盒在左前（x -1.02 / z -0.5）：
     两个主体错开一条对角线，第 2 步与第 5 步各自的取景框里都不会互相挡住。
     （上一版两者都在左前，压机特写里永远压着一个黄标签的控制盒。） */
  const CP = { x: -0.68, z: 0.05 }
  /* 筒高 0.18 + 半球顶半径 0.115 = 0.355，顶面 0.925 < 壳顶 0.95。
     原来筒高 0.26 时，半球顶的**半径**也加在筒顶之上，总高到 1.005，
     整只半球顶从盖板里钻出来——顶盖正中那个"黑洞"就是它。 */
  const bodyH = 0.18
  const cylY = BOTTOM + 0.06 + bodyH / 2
  const cyl = new Group()
  cyl.position.set(CP.x, cylY, CP.z)
  const bodyMesh = new Mesh(new CylinderGeometry(0.115, 0.115, bodyH, 28), paintedMaterial(0x2a2c2e))
  const dome = new Mesh(new SphereGeometry(0.115, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), paintedMaterial(0x2a2c2e))
  dome.position.y = bodyH / 2
  const base = new Mesh(new CylinderGeometry(0.12, 0.12, 0.03, 24), paintedMaterial(0x33373a))
  base.position.y = -bodyH / 2 + 0.015
  cyl.add(bodyMesh, dome, base)
  compressor.add(cyl)

  // 减振脚：四个橡胶垫
  for (const [dx, dz] of [
    [-0.08, -0.08],
    [0.08, -0.08],
    [-0.08, 0.08],
    [0.08, 0.08],
  ]) {
    const foot = new Mesh(new CylinderGeometry(0.02, 0.022, 0.03, 12), rubberMaterial())
    foot.position.set(CP.x + dx, BOTTOM + 0.045, CP.z + dz)
    compressor.add(foot)
  }
  // 接线盒（朝 -Z，接线盒盖在镜头这一侧）
  compressor.add(roundedBox(0.11, 0.09, 0.07, paintedMaterial(0x3a3e41), CP.x, BOTTOM + 0.25, CP.z - 0.12, 0.008))
  // 气液分离器：压在压机右侧
  const accum = new Mesh(new CylinderGeometry(0.055, 0.055, 0.24, 20), paintedMaterial(0x8a5b3a))
  accum.position.set(-0.5, BOTTOM + 0.19, 0.2)
  compressor.add(accum)
  const accumTop = new Mesh(new SphereGeometry(0.055, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), paintedMaterial(0x8a5b3a))
  accumTop.position.set(-0.5, BOTTOM + 0.31, 0.2)
  compressor.add(accumTop)
  // 固定横梁
  compressor.add(roundedBox(0.46, 0.04, 0.05, steelMaterial(0x8f959a), CP.x, BOTTOM + 0.03, CP.z - 0.05, 0.004))
  compressor.add(roundedBox(0.05, 0.04, 0.42, steelMaterial(0x8f959a), CP.x, BOTTOM + 0.03, CP.z, 0.004))

  /* ============================================================ 控制盒 */
  /* **顶开盖式**，不是侧开门。
     侧开门的盒子装在舱内、开口朝 -Z，而 -Z 侧是一整块侧板——
     镜头只能从外面看，永远看不到盒内（第一版第 2 步就是这么拍成一堵白墙的）。
     真实顶置机组的控制盒也是掀顶盖检修：拆掉机组顶盖后，再掀开盒盖就看到
     断路器与端子排。所以这里把盖做成"抬起→取下"，俯视机位直接看进去。 */
  const control = new Group()
  root.add(control)
  parts.control = control
  const CB = { x: -0.98, y: BOTTOM + 0.17, z: -0.54, w: 0.44, h: 0.34, d: 0.3 }
  // 盒体：底板、后壁、两侧、前壁（前壁朝 -Z 装铭牌），顶面敞口
  control.add(roundedBox(CB.w, 0.018, CB.d, casingDark, CB.x, CB.y - CB.h / 2, CB.z, 0.003))
  control.add(roundedBox(CB.w, CB.h, 0.018, casingDark, CB.x, CB.y, CB.z + CB.d / 2, 0.003))
  control.add(roundedBox(0.018, CB.h, CB.d, casingDark, CB.x - CB.w / 2, CB.y, CB.z, 0.003))
  control.add(roundedBox(0.018, CB.h, CB.d, casingDark, CB.x + CB.w / 2, CB.y, CB.z, 0.003))
  control.add(roundedBox(CB.w, CB.h, 0.018, casingDark, CB.x, CB.y, CB.z - CB.d / 2, 0.003))

  // 导轨 + 三只断路器（靠前壁，俯视时最先看到）+ 接触器 + 端子排
  control.add(roundedBox(CB.w - 0.04, 0.012, 0.02, steelMaterial(0xb2b7bb), CB.x, CB.y + 0.06, CB.z + 0.05, 0.002))
  const breakers: Mesh[] = []
  for (let i = 0; i < 3; i += 1) {
    const bx = CB.x - 0.11 + i * 0.062
    control.add(roundedBox(0.05, 0.11, 0.055, paintedMaterial(0xdfe2e5), bx, CB.y + 0.01, CB.z + 0.05, 0.004))
    const toggle = roundedBox(0.02, 0.03, 0.02, paintedMaterial(0x2a2d30), bx, CB.y + 0.015, CB.z + 0.02, 0.004)
    control.add(toggle)
    breakers.push(toggle)
  }
  // 接触器
  control.add(roundedBox(0.09, 0.095, 0.07, paintedMaterial(0x33373a), CB.x + 0.1, CB.y + 0.005, CB.z + 0.04, 0.006))
  // 端子排（靠近后壁）
  for (let i = 0; i < 6; i += 1) {
    control.add(roundedBox(0.028, 0.032, 0.032, paintedMaterial(0xd8b24a), CB.x - 0.13 + i * 0.032, CB.y - 0.09, CB.z + 0.07, 0.003))
  }
  /* 盒内指示灯（电源 / 运行 / 故障）：装在底板前缘，俯视可见。
     2026-11-12 几何自检发现：三只灯悬空 26mm——它们下面是空的。
     真实电控盒的灯焊在小板上，补一块 PCB 把它们接住。 */
  control.add(
    roundedBox(CB.w - 0.06, 0.006, 0.09, paintedMaterial(0x1f4a3c), CB.x, CB.y - 0.155, CB.z - 0.09, 0.002),
  )
  const leds: Mesh[] = []
  for (let i = 0; i < 3; i += 1) {
    const led = new Mesh(new CylinderGeometry(0.009, 0.009, 0.01, 12), lampMaterial(0x2f9e6a))
    // PCB 顶面在 CB.y-0.152；灯的底沿坐在它上面
    led.position.set(CB.x - 0.05 + i * 0.05, CB.y - 0.147, CB.z - 0.09)
    control.add(led)
    leds.push(led)
  }

  // 前壁铭牌（从机外低机位也读得出来）
  const labelTex = canvasTexture(256, 128, (ctx, w, h) => {
    ctx.fillStyle = '#f0d24a'
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = '#2a2a2a'
    ctx.lineWidth = 6
    ctx.strokeRect(8, 8, w - 16, h - 16)
    ctx.fillStyle = '#1e1e1e'
    ctx.font = 'bold 34px "Microsoft YaHei", sans-serif'
    ctx.fillText('控制电源', 40, 56)
    ctx.font = 'bold 40px "Microsoft YaHei", sans-serif'
    ctx.fillText('DC 110V', 56, 104)
  })
  const doorLabel = facePlate(0.15, 0.075, labelTex)
  doorLabel.position.set(CB.x, CB.y + 0.02, CB.z - CB.d / 2 - 0.011)
  doorLabel.rotation.y = Math.PI
  control.add(doorLabel)

  // 盒盖：0.26–0.36 抬起后取下（与机组检修盖板同一套手法）
  const boxLid = new Group()
  boxLid.position.set(CB.x, CB.y + CB.h / 2 + 0.012, CB.z)
  control.add(boxLid)
  boxLid.add(roundedBox(CB.w + 0.02, 0.018, CB.d + 0.02, casing, 0, 0, 0, 0.004))
  // 盖上的四只压紧螺栓
  for (const dx of [-0.14, 0.14]) {
    for (const dz of [-0.09, 0.09]) {
      rivet(boxLid, dx, 0.012, dz, 'y', 0.005, 0.008)
    }
  }

  /* ============================================================ 制冷剂管路 */
  const piping = new Group()
  root.add(piping)
  parts.piping = piping
  const INSUL = rubberMaterial(0x34383c)

  // 排气管：压缩机顶 → 上翻 → 沿 Z 内侧走 → 穿隔板 → 冷凝器集管
  pipe(piping, copper, [
    [CP.x, BOTTOM + 0.28, CP.z - 0.02],
    [CP.x, BOTTOM + 0.345, CP.z - 0.08],
    [-0.4, BOTTOM + 0.365, -0.2],
    [0.0, BOTTOM + 0.365, -0.34],
    [0.42, BOTTOM + 0.35, -0.44],
    [0.58, BOTTOM + 0.3, -0.46],
  ], 0.011)
  // 隔板穿孔处的橡胶护圈
  for (const x of [XC1, XC2]) {
    const grommet = new Mesh(new TorusGeometry(0.018, 0.006, 8, 16), INSUL)
    grommet.position.set(x, BOTTOM + 0.365, -0.34)
    grommet.rotation.y = Math.PI / 2
    piping.add(grommet)
  }

  // 液管：冷凝器 → 干燥过滤器 → 膨胀阀 → 蒸发器
  pipe(piping, copper, [
    [0.58, BOTTOM + 0.2, -0.52],
    [0.1, BOTTOM + 0.12, -0.58],
    [-0.18, BOTTOM + 0.14, -0.58],
    [-0.28, BOTTOM + 0.2, -0.44],
    [-0.3, BOTTOM + 0.26, -0.3],
  ], 0.008)
  const drier = new Mesh(new CylinderGeometry(0.028, 0.028, 0.16, 16), paintedMaterial(0x9aa0a5))
  drier.rotation.z = Math.PI / 2
  drier.position.set(-0.04, BOTTOM + 0.13, -0.58)
  piping.add(drier)
  // 膨胀阀
  piping.add(roundedBox(0.06, 0.07, 0.05, chromeMaterial(), -0.29, BOTTOM + 0.23, -0.36, 0.006))

  // 吸气管：蒸发器下集管 → 气液分离器 → 压缩机侧
  pipe(piping, copper, [
    [0.05, BOTTOM + 0.09, -0.24],
    [-0.2, BOTTOM + 0.07, -0.3],
    [-0.5, BOTTOM + 0.1, -0.28],
    [-0.5, BOTTOM + 0.16, 0.1],
    [-0.52, BOTTOM + 0.24, 0.19],
  ], 0.011)
  // 吸气管保温：低压管必须包保温，这一段包成深色海绵
  pipe(piping, INSUL, [
    [0.06, BOTTOM + 0.09, -0.24],
    [-0.22, BOTTOM + 0.07, -0.3],
    [-0.46, BOTTOM + 0.095, -0.28],
  ], 0.017)

  /* 高压检修阀接口：**放在压缩机排气管上**（不是在冷凝器那头）。
     第 5 步同时量"压缩机电流"和"高压侧压力"，两个测点在实机上就在一处；
     放到冷凝段去，这一张图就装不下"压缩机 + 接表的地方"两件事。 */
  pipe(piping, copper, [
    [-0.4, BOTTOM + 0.365, -0.2],
    [-0.42, BOTTOM + 0.355, -0.14],
    [-0.44, BOTTOM + 0.35, -0.08],
  ], 0.01)
  // 阀口**横着**接（沿 Z 出），不是竖着装：竖着装阀帽顶到 1.01，会从盖板里穿出去
  const port = new Mesh(new CylinderGeometry(0.016, 0.016, 0.03, 12), chromeMaterial())
  port.rotation.x = Math.PI / 2
  port.position.set(-0.44, BOTTOM + 0.35, -0.075)
  piping.add(port)
  const portCap = new Mesh(new CylinderGeometry(0.013, 0.013, 0.024, 12), paintedMaterial(0x2f5fa8))
  portCap.rotation.x = Math.PI / 2
  portCap.position.set(-0.44, BOTTOM + 0.35, -0.052)
  piping.add(portCap)
  // 阀上挂一小段压力表软管，交代"这里能接表"
  pipe(piping, rubberMaterial(0x1f2224), [
    [-0.44, BOTTOM + 0.35, -0.045],
    [-0.4, BOTTOM + 0.33, 0.04],
    [-0.34, BOTTOM + 0.32, 0.12],
  ], 0.008)

  // 排水管：从蒸发段接水盘引出、从底盘侧面穿出（挂在 piping 上，
  // 否则它伸到机外 0.8m，会把第 4 步蒸发器的取景框整个拉大）
  pipe(piping, rubberMaterial(0x2f3134), [
    [(XC1 + XC2) / 2, BOTTOM + 0.04, -0.2],
    [0.1, BOTTOM + 0.02, -0.32],
    [0.36, BOTTOM + 0.01, -0.62],
    [0.5, BOTTOM - 0.02, -0.8],
  ], 0.012)

  // 线束：控制盒 → 压缩机接线盒 / 风机 / 冷凝风机
  for (const [color, pts] of [
    [0x9b3b34, [[-1.0, BOTTOM + 0.26, -0.42], [-0.95, BOTTOM + 0.2, -0.3], [-0.88, BOTTOM + 0.26, -0.18]]],
    [0x2f3b4a, [[-1.06, BOTTOM + 0.3, -0.44], [-1.1, BOTTOM + 0.18, -0.2], [-1.02, BOTTOM + 0.1, 0.1], [-0.9, BOTTOM + 0.12, 0.44]]],
    [0x3f6b46, [[-1.05, BOTTOM + 0.34, -0.46], [-0.6, BOTTOM + 0.34, -0.78], [0.3, BOTTOM + 0.34, -0.8], [0.8, BOTTOM + 0.3, -0.78]]],
  ] as const) {
    const wire = new MeshStandardMaterial({ color, metalness: 0, roughness: 0.72 })
    pipe(piping, wire, pts.map((p) => [...p] as [number, number, number]), 0.0065)
  }
  // 线束的线卡
  for (const x of [-0.75, -0.2, 0.5]) {
    piping.add(roundedBox(0.02, 0.02, 0.012, rubberMaterial(), x, BOTTOM + 0.34, -0.8, 0.004))
  }

  /* ================================================================ 动作 */

  const setT = (tIn: number): void => {
    const t = tIn < 0 ? 0 : tIn > 1 ? 1 : tIn

    // 检修盖板：0.10–0.20 抬起 → 拆下（隐藏）。见上方注释：不能掀。
    const open = seg(t, 0.1, 0.2)
    for (const cover of [coverA, coverB]) {
      cover.position.y = TOP + open * 0.09
      cover.visible = open < 0.55
    }

    // 控制盒盖：0.24–0.34 抬起然后取下
    const lidOpen = seg(t, 0.24, 0.34)
    boxLid.position.y = CB.y + CB.h / 2 + 0.012 + lidOpen * 0.07
    boxLid.visible = lidOpen < 0.55

    // 断路器合闸：三只依次在 0.3–0.4 之间拨上
    for (let i = 0; i < breakers.length; i += 1) {
      const on = seg(t, 0.3 + i * 0.03, 0.36 + i * 0.03)
      // 手柄是"从里往外拨"，起点必须用它自己的位置——
      // 上一版这里写死 -0.01，三只手柄全被拉到盒外 60cm（盒在 z=-0.56）
      breakers[i].position.z = CB.z + 0.02 + on * 0.012
      ;(breakers[i].material as MeshStandardMaterial).color.setHex(on > 0.5 ? 0x8d2f2a : 0x2a2d30)
    }

    // 指示灯：电源（红）0.36 起；运行（绿）0.5 起；故障（黄）只在 0.62–0.66 闪一下自检
    const powered = t >= 0.36
    const running = t >= 0.5
    const selfTest = t >= 0.62 && t < 0.66
    const ledMat = (i: number, on: boolean, color: number): void => {
      const m = leds[i].material as MeshStandardMaterial
      m.color.setHex(on ? color : 0x1d1f21)
      m.emissive.setHex(on ? color : 0x000000)
      m.emissiveIntensity = on ? 0.9 : 0
    }
    ledMat(0, powered, 0xd1483f)
    ledMat(1, running, 0x2f9e6a)
    ledMat(2, selfTest, 0xd39a2a)

    // 风机：0.5 起加速（送风机与冷凝风机同时），0.58 后满速
    const spin = t >= 0.5 ? 0.2 + smoothStep(seg(t, 0.5, 0.58)) * 1.8 : 0
    for (const f of fanRig) f.rotor.rotation.y = spin * Math.PI

    /* 制冷段：翅片结露 + 接水盘积水（2026-11-12 R11-7）。
       这一段原来画面**完全不动**——盖板/盒盖/断路器/指示灯/风机都在 0.5 之前
       动完，而文案从「通风模式运行」切到「制冷模式起动」。真实机组制冷时
       蒸发器翅片挂满凝水，是"制冷"唯一看得见的证据。
       翅片只换色不动形：金属度降、粗糙度升，看着像挂了一层水膜。 */
    const cool = smoothStep(seg(t, HVAC_T.cool, HVAC_T.cool + 0.1))
    evapFinMat.color.copy(FIN_COLOR).lerp(FROST_COLOR, cool)
    // 水膜：金属感降一档（水是介质）、粗糙度大幅降（反光），颜色走冷灰蓝
    evapFinMat.metalness = 0.85 - 0.35 * cool
    evapFinMat.roughness = 0.62 - 0.4 * cool
    evapFinMat.envMapIntensity = 0.9 + 0.5 * cool
    condensate.visible = cool > 0.02
    // 接水盘的水位：0.68 起涨，0.92 到顶（对应"制冷稳定"那一段）
    const wet = smoothStep(seg(t, HVAC_T.cool, 0.92))
    water.scale.y = 0.4 + 0.6 * wet
    water.position.y = BOTTOM + 0.078 + 0.012 * wet
  }

  /* 阶段文案的唯一来源在 `lib/devphase.ts`：同一句话不该在这里再写一遍。
     2026-11-12 评审 R11-6：三维侧与读数侧各写一份，`door` 已经漂成
     "三维说完全开启、界面说到位检测"。阈值改动请改 devphase 的常量。 */
  const phase = (t: number): string => phaseFor('hvac', t)

  setT(0)

  return {
    root,
    setT,
    parts,
    phase,
    /* 触屏演示用的整机机位：镜头在 -Z 侧前上方，与五张烘焙图同一侧。
       不声明 `focus`：整机类要的是"看全"，声明 focus 会让自动取景按部件包围盒
       重新算距离，把机器顶到画面外（第一版就是这样，底部被切掉）。 */
    framing: { target: [0, 0.8, 0], distance: 3.6 },
    viewDir: [0.42, 0.52, -0.75],
    fov: 30,
    // 浅色钣金为主：环境压到 0.9，否则顶盖大片反光糊成白
    envIntensity: 0.9,
    dispose: () => disposeTree(root),
  }
}

/** 再包一层：`seg` 已经平滑，再乘一次会把加速段压得太靠后，
 *  这里只是给转速一个可见的"起来"的过程。 */
function smoothStep(v: number): number {
  return v * v * (3 - 2 * v)
}
