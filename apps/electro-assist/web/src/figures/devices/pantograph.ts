/** 单臂受电弓（TSG19A）：参数化几何 + 气囊驱动 + ADD 工况 + 两根导杆。
 *
 *  ## 形体依据（2026-11-11 按公开资料逐条核对后重做）
 *  蓝本 TSG19A（CRH380A 用）。这一版把上一轮**做错的四处**按来源改回来了：
 *
 *  1. **支撑绝缘子是三个，不是四个**。三处来源一致："刚性固定在三个专用绝缘子上"。
 *     2013 年起改为 **400mm 高**支持绝缘子（太原动车所《动车组受电弓》）。
 *  2. **两根滑板中心线距约 597mm**。上一版按 200mm 做，弓头因此又窄又薄；
 *     实拍里弓头是一个很宽的框（弓头 1950、滑板 1576）。
 *  3. **阀板（气路板）整个漏了**。TSG19A 的气路与控制都在这一块板上：
 *     过滤阀 / 两位五通电磁阀 MV5/2 / 精密调压阀 DM3·DM2 / 压力开关 DS3·DS2 /
 *     梭阀 / 节流阀 / 安全阀 / 压力表 / 快排电磁阀 SA。没有它，"升弓指令怎么变成气压"
 *     就无从解释——这正是用户说的"漏了供气管路与控制电路"。
 *  4. **两根导杆漏了**。下导杆（底架 → 上臂）限制最大升弓高度与滑板轨迹；
 *     上导杆（下臂 → 弓头支架）保证滑板在全工作高度上水平。
 *
 *  ## 三条"看起来假"的根因（2026-11-10 已修，这里保留结论）
 *  - 臂用 `metalness = 1` 不锈钢 → 金属无漫反射，正面照抄暗墙、顶面照抄灯带，
 *    屏幕上就是"黑板上贴一条白条"。实机是**喷铝漆的焊接箱体**，漆膜是电介质。
 *  - 上臂落弓角 +10° → 两臂接近水平且同高，弓头吊在 0.84m，整机缩成一摞平板。
 *    实机收起时**肘部最高、弓头落到肘点下方**，所以上臂必须是负角。
 *  - 关节是一块暗色实心方块 → 改成**两块耳板夹一根销轴**，这是"这根杆会转"的唯一依据。
 *
 *  ## 看不见的内部变化怎么表达
 *  气囊、快排阀、压力开关三件，内部变化在实物外面看不见。用**剖切**（把壳体切掉一角，
 *  露出内腔、膜片、触点、阀芯）而不是半透明——半透明在 WebGL 里要处理排序、叠在金属上
 *  会发灰，而"切开"本来就是检修培训件的通行做法。
 */
import {
  CanvasTexture,
  CatmullRomCurve3,
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  EdgesGeometry,
  Group,
  LatheGeometry,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SRGBColorSpace,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three'

import type { DeviceRig } from './rig'
import {
  chromeMaterial,
  disposeTree,
  paintedMaterial,
  rubberMaterial,
  roundedBox,
  steelMaterial,
} from './rig'
import {
  LOWER_ROD,
  PDIM,
  PGAP,
  UPPER_ROD,
  WIRE_Y,
  armAngles,
  compression,
} from '../../lib/panto-kin'
import { PANO_T, airState, phase as airPhase, travel, type PantoMode } from '../../lib/panto-air'

/** 接触线所在的前后位置：正对**前侧那根滑板**（升到位时弓头 z≈0.33）。 */
const HEAD_Z = 0.43
/** 底架梁中心高度：绝缘子 400mm + 60mm 垫板 */
const INS_H = 0.4
const DECK_Y = INS_H + 0.06
/** 下臂根部**弧形调整板**的半径。钢索锚点就在这块板的弧上（见 setT）。 */
const ARC_R = 0.17

const deg = (v: number): number => (v * Math.PI) / 180

/* ---------------------------------------------------------------- 几何工具 */

const _x = new Vector3()
const _y = new Vector3()
const _z = new Vector3()
const _m = new Matrix4()
const _q = new Quaternion()
/**
 * 把对象摆到两点之间，**滚转是确定的**。
 *
 * `setFromUnitVectors` 只保证轴向，绕轴的滚转是任意的——对圆柱无所谓，对矩形截面的梁
 * 就是"宽面朝天还是朝侧面"的差别，也就是"看着像梁"和"看着像板"的差别。
 * 这里用 `xRef = (1,0,0)` 构造正交基，保证局部 X 永远贴着世界 X。
 */
function placeAxis(obj: Object3D, from: Vector3, to: Vector3): number {
  _y.subVectors(to, from)
  const len = _y.length()
  if (len < 1e-6) return 0
  _y.divideScalar(len)
  _z.crossVectors(_x.set(1, 0, 0), _y)
  if (_z.lengthSq() < 1e-8) _z.set(0, 0, 1)
  _z.normalize()
  _x.crossVectors(_y, _z).normalize()
  _m.makeBasis(_x, _y, _z)
  _q.setFromRotationMatrix(_m)
  obj.quaternion.copy(_q)
  obj.position.copy(from)
  return len
}

/** 变截面焊接箱体：局部 +Y 从 0 到 `len`，根部 (w0×d0) 收到头部 (w1×d1)。 */
function boxBeam(
  len: number,
  w0: number,
  d0: number,
  w1: number,
  d1: number,
  material: Material,
  edgeOpacity = 0.22,
): Mesh {
  const geo = new BoxGeometry(1, len, 1, 1, 1, 1)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i += 1) {
    const top = pos.getY(i) > 0
    pos.setX(i, pos.getX(i) * (top ? w1 : w0))
    pos.setZ(i, pos.getZ(i) * (top ? d1 : d0))
  }
  pos.needsUpdate = true
  geo.translate(0, len / 2, 0)
  geo.computeVertexNormals()
  const mesh = new Mesh(geo, material)
  mesh.castShadow = true
  mesh.receiveShadow = true
  if (edgeOpacity > 0) {
    const edges = new LineSegments(
      new EdgesGeometry(geo, 20),
      new LineBasicMaterial({ color: 0x1a1d21, transparent: true, opacity: edgeOpacity }),
    )
    mesh.add(edges)
  }
  return mesh
}

/** 软管：走 Catmull-Rom，管子本来就是软的，折线反而不像。 */
function hose(points: Vector3[], radius: number, material: MeshStandardMaterial): Mesh {
  const curve = new CatmullRomCurve3(points, false, 'catmullrom', 0.4)
  const mesh = new Mesh(new TubeGeometry(curve, 44, radius, 7, false), material)
  mesh.castShadow = true
  return mesh
}

/** 螺旋弹簧：轴向单位高度为 1，用时按实际长度缩放 Y。 */
function helix(radius: number, wire: number, turns: number, material: Material): Mesh {
  const pts: Vector3[] = []
  const n = Math.round(turns * 16)
  for (let k = 0; k <= n; k += 1) {
    const a = (k / n) * Math.PI * 2 * turns
    pts.push(new Vector3(Math.cos(a) * radius, k / n, Math.sin(a) * radius))
  }
  return new Mesh(new TubeGeometry(new CatmullRomCurve3(pts), n, wire, 6, false), material)
}

/**
 * 接地铜编织带：跨过铰点，把电流从转动件旁路掉（不然轴承会被电蚀）。
 *
 * 为什么必须画：它是受电弓上**唯一的高饱和色**，实拍里一眼就能看到几道橙铜色的辫子
 * 挂在肘部和底架铰点上。少了它，整台设备只剩灰和红，认不出是电气设备。
 */
function braid(from: Vector3, to: Vector3, sag: number, mat: MeshStandardMaterial): Mesh {
  const mid = from.clone().add(to).multiplyScalar(0.5)
  const dir = to.clone().sub(from)
  const perp = new Vector3(0, -1, 0).multiplyScalar(sag)
  const curve = new CatmullRomCurve3([
    from,
    mid.clone().add(perp).addScaledVector(dir, -0.12),
    mid.clone().add(perp),
    mid.clone().add(perp).addScaledVector(dir, 0.12),
    to,
  ])
  const mesh = new Mesh(new TubeGeometry(curve, 26, 0.016, 6, false), mat)
  mesh.castShadow = true
  return mesh
}

/* ------------------------------------------------------------- 气动元件 */

interface Linear {
  group: Group
  set: (from: Vector3, to: Vector3) => void
}

/** 气缸 / 阻尼器：缸体定长，只有活塞杆伸缩。整根缩放会看到缸径变粗，一眼假。 */
function cylinderActuator(opts: {
  barrelLen: number
  barrelR: number
  rodR: number
  barrelMat: Material
  rodMat: Material
}): Linear {
  const group = new Group()
  const barrel = new Mesh(
    new CylinderGeometry(opts.barrelR, opts.barrelR, opts.barrelLen, 18),
    opts.barrelMat,
  )
  barrel.position.y = opts.barrelLen / 2
  barrel.castShadow = true
  const rod = new Mesh(new CylinderGeometry(opts.rodR, opts.rodR, 1, 12), opts.rodMat)
  const foot = new Mesh(
    new CylinderGeometry(opts.barrelR * 1.5, opts.barrelR * 1.5, 0.02, 14),
    opts.barrelMat,
  )
  foot.position.y = -0.008
  const clevis = roundedBox(opts.rodR * 4.6, 0.03, opts.rodR * 3.4, opts.rodMat, 0, 0, 0, 0.006)
  const knob = new Mesh(new CylinderGeometry(0.017, 0.017, 0.018, 12), chromeMaterial())
  knob.position.y = opts.barrelLen - 0.01
  group.add(barrel, rod, foot, clevis, knob)

  const dir = new Vector3()
  return {
    group,
    set(from, to) {
      dir.subVectors(to, from)
      const len = dir.length()
      if (len < 1e-4) return
      placeAxis(group, from, to)
      const rodLen = Math.max(len - opts.barrelLen, 0.006)
      rod.scale.y = rodLen
      rod.position.y = opts.barrelLen + rodLen / 2
      clevis.position.y = len
    },
  }
}

/**
 * 空气弹簧（气囊气缸）。**气囊本体定长，只有活塞杆伸缩**。
 * 上一版把整根波纹管按两点距离缩放：升弓时它被拉成 0.9m 长的一根细肠子，
 * 还从车顶面下一直穿到臂上（底座写在 y=0.04，比车顶还低）——这是画面上最假的一处。
 * 真机的气囊是短粗的一段（Ø200×220 量级），行程靠中间的活塞杆给出。
 */
function airSpring(len: number, color: number, plateMat: Material, inner: Material): Linear {
  const group = new Group()
  const L = len
  const profile: Vector2[] = []
  const steps = 30
  for (let i = 0; i <= steps; i += 1) {
    const y = i / steps
    const wave = 0.5 + 0.5 * Math.cos(y * Math.PI * 2 * 3)
    const mouth = Math.min(1, Math.min(y, 1 - y) * 10)
    profile.push(new Vector2(0.088 + 0.026 * wave * mouth + 0.004, y * L))
  }
  const shell = new Mesh(
    new LatheGeometry(profile, 26, deg(18), deg(270)),
    new MeshStandardMaterial({ color, metalness: 0, roughness: 0.94, side: DoubleSide }),
  )
  shell.castShadow = true
  const bladder = new Mesh(new CylinderGeometry(0.072, 0.08, 1, 20, 1, true), inner)
  bladder.scale.y = L * 0.92
  bladder.position.y = L * 0.48
  const foot = new Mesh(new CylinderGeometry(0.118, 0.118, 0.024, 22), plateMat)
  foot.position.y = -0.012
  const cap = new Mesh(new CylinderGeometry(0.104, 0.104, 0.022, 22), plateMat)
  cap.position.y = L + 0.011
  // 活塞杆：从气囊顶盖伸出去，行程全在这根杆上
  const rod = new Mesh(new CylinderGeometry(0.028, 0.028, 1, 14), chromeMaterial())
  const eye = roundedBox(0.075, 0.055, 0.06, plateMat, 0, 0, 0, 0.008)
  group.add(shell, bladder, foot, cap, rod, eye)

  const dir = new Vector3()
  return {
    group,
    set(from, to) {
      dir.subVectors(to, from)
      const l = dir.length()
      if (l < 1e-4) return
      placeAxis(group, from, to)
      const rodLen = Math.max(l - L, 0.02)
      rod.scale.y = rodLen
      rod.position.y = L + rodLen / 2
      eye.position.y = l
    },
  }
}

/**
 * ADD 快排阀（剖切）。三个接口：进气口 P1（气囊侧）、出气口 P2（滑板气腔 + 压力开关侧）、
 * 排气口（通大气，带喷嘴）。压差建立后阀芯离座，P1 与排气口连通，气囊直排大气。
 */
function quickReleaseValve(): {
  group: Group
  set: (diff: number, venting: boolean) => void
} {
  const group = new Group()
  const bodyMat = new MeshStandardMaterial({
    color: 0x6c7378,
    metalness: 0,
    roughness: 0.42,
    side: DoubleSide,
  })
  const body = new Mesh(
    new CylinderGeometry(0.052, 0.056, 0.15, 22, 1, false, deg(40), deg(260)),
    bodyMat,
  )
  body.position.y = 0.075
  body.castShadow = true
  const seat = new Mesh(new CylinderGeometry(0.03, 0.034, 0.012, 18), steelMaterial(0x9aa0a6))
  seat.position.y = 0.05
  const spool = new Mesh(new CylinderGeometry(0.021, 0.021, 0.042, 16), chromeMaterial())
  spool.position.y = 0.078
  const spring = helix(0.018, 0.0032, 4.5, chromeMaterial())
  spring.scale.y = 0.034
  spring.position.y = 0.1
  const nozzle = new Mesh(new CylinderGeometry(0.014, 0.018, 0.05, 14), bodyMat)
  nozzle.rotation.z = deg(-52)
  nozzle.position.set(0.05, 0.028, 0)
  const p1 = new Mesh(new CylinderGeometry(0.012, 0.012, 0.05, 12), chromeMaterial())
  p1.position.y = 0.012
  const p2 = new Mesh(new CylinderGeometry(0.011, 0.011, 0.045, 12), chromeMaterial())
  p2.rotation.z = deg(90)
  p2.position.set(-0.042, 0.115, 0)
  group.add(body, seat, spool, spring, nozzle, p1, p2)

  const jet = new Mesh(
    new CylinderGeometry(0.01, 0.085, 0.62, 14, 1, true),
    new MeshBasicMaterial({ color: 0xdce9f4, transparent: true, opacity: 0, depthWrite: false }),
  )
  jet.position.set(0.17, -0.05, 0)
  jet.rotation.z = deg(126)
  group.add(jet)

  return {
    group,
    set(diff, venting) {
      const open = venting ? 1 : Math.min(1, diff / 0.05)
      spool.position.y = 0.078 + 0.02 * open
      spring.scale.y = 0.034 - 0.016 * open
      ;(jet.material as MeshBasicMaterial).opacity = venting ? 0.62 : 0
    },
  }
}

/** ADD 压力开关（剖切）。常开触点：有压且无压差才闭合。 */
function pressureSwitch(): {
  group: Group
  set: (closed: boolean) => void
} {
  const group = new Group()
  const bodyMat = new MeshStandardMaterial({
    color: 0x2f3438,
    metalness: 0.12,
    roughness: 0.55,
    side: DoubleSide,
  })
  const cap = new Mesh(
    new CylinderGeometry(0.042, 0.042, 0.056, 20, 1, false, deg(35), deg(270)),
    bodyMat,
  )
  cap.position.y = 0.028
  cap.castShadow = true
  const dia = new Mesh(new CylinderGeometry(0.033, 0.033, 0.004, 18), rubberMaterial(0x3a3f44))
  dia.position.y = 0.03
  const blade = new Mesh(new BoxGeometry(0.03, 0.003, 0.01), steelMaterial(0xc8ccd0))
  blade.position.set(0.012, 0.05, 0)
  const fixed = new Mesh(new BoxGeometry(0.016, 0.004, 0.01), steelMaterial(0xcf9b45))
  fixed.position.set(-0.008, 0.056, 0)
  for (const z of [-0.028, 0.028]) {
    const t = new Mesh(new CylinderGeometry(0.005, 0.005, 0.014, 10), chromeMaterial())
    t.position.set(-0.024, 0.072, z)
    group.add(t)
  }
  group.add(cap, dia, blade, fixed)

  return {
    group,
    set(closed) {
      blade.rotation.z = closed ? 0 : deg(-14)
      blade.position.y = closed ? 0.054 : 0.046
    },
  }
}

/* ------------------------------------------------------------------ 主体 */

export function buildPantograph(): DeviceRig {
  const root = new Group()
  const parts: Record<string, Object3D> = {}
  const textures: CanvasTexture[] = []

  /* ---------------------------------------------------------------- 材质 */
  /* 纪律：`metalness` 只在 0 与 1 之间选。臂与底架是喷漆件 → 0（见文件头）。 */
  /* 臂色：0x7f858b 在渲染里读成"接近白"，实拍 CRH380A 的铝合金臂是中灰。压一档到 0x6e747a */
  const armPaint = new MeshStandardMaterial({ color: 0x6e747a, metalness: 0, roughness: 0.46 })
  const armDark = paintedMaterial(0x51565c)
  const frameMat = paintedMaterial(0x7a352a)
  const fitting = steelMaterial(0x9aa0a6)
  const chrome = chromeMaterial()
  const hoseMat = rubberMaterial(0x23262a)
  const copper = new MeshStandardMaterial({ color: 0xb5703a, metalness: 1, roughness: 0.42 })
  const carbon = new MeshStandardMaterial({ color: 0x3a3d42, metalness: 0.08, roughness: 0.66 })
  /* 釉面陶瓷：粗糙度必须压到 0.5 以上。0.34 时环境反射太强，一堆薄伞裙会读成
       "铜线圈"而不是瓷瓶——这是连续两轮截图里最扎眼的一处。 */
  const ceramic = new MeshStandardMaterial({ color: 0x5d372e, metalness: 0, roughness: 0.52 })

  /* ---------------------------------------------------------------- 车顶 */
  const roof = new Group()
  const roofSlab = roundedBox(2.9, 0.13, 2.2, paintedMaterial(0x6c7176), 0, -0.075, 0, 0.012)
  roofSlab.receiveShadow = true
  roof.add(roofSlab)
  for (const z of [-0.82, 0.82]) {
    roof.add(roundedBox(2.2, 0.014, 0.5, paintedMaterial(0x7d8287), -0.1, -0.004, z, 0.006))
  }
  /* 车顶钣金拼缝：真车顶是几块板拼的，缝里是暗的。
     没有这几道缝，车顶就是一块 2.9×2.2 的白板——它现在占画面面积最大，最伤真实感。 */
  for (const x of [-0.34, 0.3, 0.86]) {
    roof.add(roundedBox(0.014, 0.008, 2.16, paintedMaterial(0x4e5358), x, -0.003, 0, 0.002))
  }
  for (const x of [-0.62, 0.42]) {
    for (const z of [-0.82, 0.82]) {
      for (const dz of [-0.2, 0.2]) {
        const bolt = new Mesh(new CylinderGeometry(0.011, 0.011, 0.01, 8), steelMaterial(0x8a9096))
        bolt.position.set(x, 0.004, z + dz)
        roof.add(bolt)
      }
    }
  }
  // 车顶线槽：电缆从这里走，避开受电弓的转动范围
  roof.add(roundedBox(0.16, 0.03, 2.1, paintedMaterial(0x63686d), -1.24, 0.006, 0, 0.008))
  /* 车顶接线盒：3 个电源引线的**下游**。没有它，铜排上的线就成了"凭空消失"。
     位置按实拍放在受电弓侧后方，与底架的 3 个引线点对齐。 */
  const roofBox = new Group()
  roofBox.add(roundedBox(0.26, 0.16, 0.3, paintedMaterial(0x585e64), -0.98, 0.1, -0.62, 0.01))
  roofBox.add(roundedBox(0.2, 0.02, 0.24, paintedMaterial(0x4c5258), -0.98, 0.19, -0.62, 0.005))
  for (const dz of [-0.1, 0, 0.1]) {
    const gland = new Mesh(new CylinderGeometry(0.016, 0.02, 0.03, 12), fitting)
    gland.rotation.x = deg(90)
    gland.position.set(-0.98, 0.1, -0.62 + dz)
    roofBox.add(gland)
  }
  roof.add(roofBox)
  roof.name = 'panto-roof'
  root.add(roof)

  /* ---------------------------------------------------------- 支撑绝缘子 */
  /* **三个**（不是四个）：底架被刚性固定在三个 400mm 高支持绝缘子上。
     布置取"前二后一"的等腰三角——前两点在弓头侧，后一点在受电弓重心下方。 */
  const deck = new Group()
  const INSULATORS: Array<[number, number]> = [
    [-0.5, 0.72],
    [0.5, 0.72],
    [0, -0.72],
  ]
  for (const [x, z] of INSULATORS) {
    const post = new Group()
    const core = new Mesh(new CylinderGeometry(0.038, 0.038, INS_H, 16), ceramic)
    core.position.y = INS_H / 2
    core.castShadow = true
    post.add(core)
    /* 伞裙：**薄而宽、边沿锐、间隙深**。这三点合起来才是瓷绝缘子。
       我在这上面来回改了三次，规律很清楚：
       - 厚 + 间隙小 → 一摞铜钱（第一版）
       - 锥套 + 叠压  → 一根弹簧（上一版，更糟）
       - 薄 + 宽 + 深缝 → 才有"瓷"的硬边和暗影
       400mm 支持绝缘子大致 9 片伞、伞径 Ø170、伞厚 14mm、间距 38mm。 */
    for (let i = 0; i < 9; i += 1) {
      const skirt = new Mesh(new CylinderGeometry(0.086, 0.086, 0.014, 22), ceramic)
      skirt.position.y = 0.045 + i * 0.038
      skirt.castShadow = true
      post.add(skirt)
      // 伞根倒角：没有它，伞片像插在柱子上的垫圈
      const fillet = new Mesh(new CylinderGeometry(0.05, 0.062, 0.022, 20), ceramic)
      fillet.position.y = skirt.position.y + 0.008
      post.add(fillet)
    }
    for (const [y, r] of [[0.01, 0.05], [INS_H - 0.01, 0.05]] as const) {
      const flange = new Mesh(new CylinderGeometry(r, r, 0.02, 16), fitting)
      flange.position.y = y
      post.add(flange)
    }
    post.position.set(x, 0, z)
    deck.add(post)
  }

  /* 底架：两根纵梁 + 三根横梁 + 四角加强板。梁要有厚度，
     原来 90×100mm 的方管做 1.7m 跨距，看着像个相框。 */
  const chassis = new Group()
  for (const x of [-0.5, 0.5]) {
    chassis.add(roundedBox(0.1, 0.11, 1.86, frameMat, x, DECK_Y, 0, 0.008))
  }
  for (const z of [-0.72, 0.06, 0.72]) {
    chassis.add(roundedBox(1.1, 0.1, 0.09, frameMat, 0, DECK_Y, z, 0.008))
  }
  for (const x of [-0.5, 0.5]) {
    for (const z of [-0.72, 0.72]) {
      chassis.add(roundedBox(0.16, 0.024, 0.16, frameMat, x, DECK_Y - 0.078, z, 0.006))
      // 角撑：把纵梁与横梁连成刚体，缺了它底架就是一摞方管
      const gus = roundedBox(0.02, 0.16, 0.16, frameMat, x, DECK_Y - 0.01, z + (z > 0 ? -0.12 : 0.12), 0.005)
      gus.rotation.x = deg(z > 0 ? 38 : -38)
      chassis.add(gus)
    }
  }
  /* 铰座：每根下臂一对耳板 + 一根销轴。
     耳板必须夹在臂的两侧，销轴横穿过去——这是"这根杆会转"的唯一视觉依据。 */
  for (const x of [-PDIM.armX, PDIM.armX]) {
    for (const dz of [-0.078, 0.078]) {
      chassis.add(
        roundedBox(0.034, 0.15, 0.03, armDark, x, DECK_Y + 0.06, PDIM.pivotZ + dz, 0.005),
      )
    }
    const pin = new Mesh(new CylinderGeometry(0.028, 0.028, 0.2, 14), fitting)
    pin.rotation.z = Math.PI / 2
    pin.position.set(x, PDIM.pivotY, PDIM.pivotZ)
    chassis.add(pin)
  }
  /* 下导杆的底架支座：从纵梁外伸一块凸耳板，导杆下耳板铰在这里。
     实物上它铰在底架凸耳上；没有这块板，下导杆下端就是悬空的。 */
  for (const sx of [-1, 1]) {
    chassis.add(
      roundedBox(0.24, 0.11, 0.075, armDark, sx * 0.565, DECK_Y + 0.07, LOWER_ROD.base.z, 0.006),
    )
  }
  /* 3 个橡胶减振器：落弓时受电弓靠在它们上面（实机就是三个）。
     位置避开了气囊与阻尼器的行程。 */
  for (const [x, z] of [
    [-0.34, 0.24],
    [0.34, 0.24],
    [0, -0.34],
  ] as const) {
    const pad = new Mesh(new CylinderGeometry(0.045, 0.05, 0.06, 14), rubberMaterial(0x24262a))
    pad.position.set(x, DECK_Y + 0.075, z)
    chassis.add(pad)
    chassis.add(roundedBox(0.12, 0.012, 0.12, frameMat, x, DECK_Y + 0.045, z, 0.004))
  }
  /* **弓装配**：落弓时弓头搁在这两个 V 形托上，形状保证弓头不受损。 */
  for (const x of [-0.36, 0.36]) {
    chassis.add(roundedBox(0.07, 0.05, 0.12, armDark, x, DECK_Y + 0.08, 0.24, 0.006))
    const cradle = roundedBox(0.05, 0.09, 0.1, rubberMaterial(0x26282c), x, DECK_Y + 0.13, 0.24, 0.008)
    cradle.rotation.x = deg(12)
    chassis.add(cradle)
  }
  /* 3 个**电源引线连接点**：铜排从底架接到车顶接线盒，是"取到的电怎么下去"的答案。
     位置挪到**后梁外侧**（z≈-0.85）：原来放在 z=0.72，正好在前横梁与臂的行程里，
     三根铜编织带像三根木棍插在底架中间。 */
  for (const x of [-0.28, 0, 0.28]) {
    const stud = new Mesh(new CylinderGeometry(0.018, 0.018, 0.05, 12), copper)
    stud.position.set(x, DECK_Y + 0.075, -0.86)
    chassis.add(stud)
    const nut = new Mesh(new CylinderGeometry(0.026, 0.026, 0.012, 6), fitting)
    nut.position.set(x, DECK_Y + 0.1, -0.86)
    chassis.add(nut)
    // 引线从底架落到车顶：给足垂度，一根笔直的竖线在画面上就是一根杆
    chassis.add(braid(new Vector3(x, DECK_Y + 0.04, -0.88), new Vector3(x, 0.02, -0.98), 0.12, copper))
  }
  /* 2 个**空气管路接口**：车顶管路从这里进底架，再分给气囊与 ADD。 */
  for (const x of [-0.18, 0.18]) {
    const port = new Mesh(new CylinderGeometry(0.014, 0.014, 0.06, 12), fitting)
    port.rotation.x = deg(90)
    port.position.set(x, DECK_Y - 0.01, -0.78)
    chassis.add(port)
  }
  deck.add(chassis)
  parts.frame = deck
  root.add(deck)

  /* ---------------------------------------------------------------- 阀板 */
  /* TSG19A 的气路与控制都集中在**气阀板**上。按公开资料的元件编号做齐 11 件：
      1 过滤阀 / 2 两位五通电磁阀 MV5/2 / 3 精密调压阀 DM3 / 4 压力开关 DS3 /
      5 精密调压阀 DM2 / 6 梭阀 / 7 节流阀 / 8 安全阀 / 9 压力表 /
      10 快排电磁阀 SA / 11 压力开关 DS2
     元件本身是示意比例（真实尺寸不可能从公开资料拿到），但**数量、类别、相邻关系**照原件。 */
  const drive = new Group()
  const panelX = 0.96
  const panelY = 0.28
  const panelZ = 0.46
  const panelFace = roundedBox(0.03, 0.42, 0.62, paintedMaterial(0x6a7076), panelX, panelY, panelZ, 0.008)
  panelFace.name = 'panto-panel-face'
  drive.add(panelFace)
  /* 支架：板不是浮在车顶上的——两根立柱落到车顶，一根横撑连回底架。 */
  for (const z of [panelZ - 0.24, panelZ + 0.24]) {
    drive.add(roundedBox(0.07, panelY + 0.2, 0.04, frameMat, panelX - 0.02, (panelY + 0.2) / 2, z, 0.005))
  }
  drive.add(roundedBox(0.42, 0.05, 0.05, frameMat, panelX - 0.22, DECK_Y + 0.03, panelZ, 0.006))
  // 汇流排：所有阀都挂在同一根气路上
  drive.add(roundedBox(0.05, 0.05, 0.54, paintedMaterial(0x7c8288), panelX + 0.02, panelY + 0.16, panelZ, 0.008))

  const coil = (x: number, y: number, z: number, c: number): Mesh => {
    const m = new Mesh(new CylinderGeometry(0.02, 0.02, 0.05, 14), paintedMaterial(c))
    m.rotation.z = Math.PI / 2
    m.position.set(x, y, z)
    return m
  }
  const knob = (x: number, y: number, z: number): Mesh => {
    const m = new Mesh(new CylinderGeometry(0.022, 0.026, 0.03, 6), paintedMaterial(0x2f3438))
    m.rotation.z = Math.PI / 2
    m.position.set(x, y, z)
    return m
  }
  const body = (w: number, h: number, d: number, x: number, y: number, z: number, c = 0x9aa0a6): Mesh =>
    roundedBox(w, h, d, paintedMaterial(c), x, y, z, 0.006)

  // 1 过滤阀（带透明杯）
  drive.add(body(0.07, 0.1, 0.07, panelX + 0.05, panelY + 0.11, -0.22, 0x8b9197))
  const bowl = new Mesh(
    new CylinderGeometry(0.032, 0.028, 0.07, 16),
    new MeshStandardMaterial({
      color: 0xaeb8c0,
      metalness: 0.05,
      roughness: 0.18,
      transparent: true,
      opacity: 0.55,
    }),
  )
  bowl.rotation.z = Math.PI / 2
  bowl.position.set(panelX + 0.09, panelY + 0.06, -0.22)
  drive.add(bowl)
  // 2 两位五通电磁阀（阀体 + 两个线圈）
  drive.add(body(0.06, 0.06, 0.15, panelX + 0.05, panelY - 0.08, -0.06, 0x3f444a))
  drive.add(coil(panelX + 0.09, panelY - 0.08, -0.12, 0x2f3438))
  drive.add(coil(panelX + 0.09, panelY - 0.08, 0.0, 0x2f3438))
  // 3 / 5 精密调压阀（两只，带调节旋钮）
  for (const [z, y] of [
    [-0.22, 0.1],
    [0.14, 0.1],
  ] as const) {
    drive.add(body(0.06, 0.09, 0.06, panelX + 0.05, y - 0.05, z, 0xb0b6bb))
    drive.add(knob(panelX + 0.1, y - 0.05, z))
  }
  // 4 / 11 压力开关（两只，小的方形盒，顶部两个端子）
  for (const [z, y] of [
    [-0.22, -0.02],
    [0.14, -0.02],
  ] as const) {
    drive.add(body(0.055, 0.05, 0.05, panelX + 0.05, y, z, 0x2f3438))
    for (const dz of [-0.012, 0.012]) {
      const t = new Mesh(new CylinderGeometry(0.004, 0.004, 0.012, 8), fitting)
      t.rotation.z = Math.PI / 2
      t.position.set(panelX + 0.08, y + 0.03, z + dz)
      drive.add(t)
    }
  }
  // 6 梭阀（三通）
  const shuttle = new Group()
  shuttle.add(body(0.05, 0.05, 0.05, panelX + 0.05, panelY - 0.02, 0.06, 0x9aa0a6))
  for (const dz of [-0.05, 0.05]) {
    const b = new Mesh(new CylinderGeometry(0.012, 0.012, 0.05, 10), fitting)
    b.rotation.x = deg(90)
    b.position.set(panelX + 0.05, panelY - 0.02, 0.06 + dz)
    shuttle.add(b)
  }
  drive.add(shuttle)
  // 7 节流阀（两只单向调速，升/降各一）
  for (const z of [-0.3, 0.22]) {
    drive.add(body(0.045, 0.06, 0.045, panelX + 0.05, panelY + 0.03, z, 0xb0b6bb))
    const screw = new Mesh(new CylinderGeometry(0.008, 0.008, 0.03, 8), chrome)
    screw.rotation.z = Math.PI / 2
    screw.position.set(panelX + 0.075, panelY + 0.03, z)
    drive.add(screw)
  }
  // 8 安全阀
  drive.add(body(0.04, 0.07, 0.04, panelX + 0.05, panelY - 0.12, 0.22, 0xb23b32))
  // 10 快排电磁阀 SA
  drive.add(body(0.06, 0.06, 0.09, panelX + 0.05, panelY - 0.1, -0.2, 0x3f444a))
  drive.add(coil(panelX + 0.09, panelY - 0.1, -0.2, 0x2f3438))

  /* 9 压力表：表盘用画布画，刻度才看得清。 */
  const gaugeR = 0.058
  const dialCanvas = document.createElement('canvas')
  dialCanvas.width = 256
  dialCanvas.height = 256
  const dctx = dialCanvas.getContext('2d')
  if (dctx) {
    const c = 128
    dctx.fillStyle = '#f2f0ea'
    dctx.beginPath()
    dctx.arc(c, c, 126, 0, Math.PI * 2)
    dctx.fill()
    dctx.strokeStyle = '#3a3f45'
    dctx.lineWidth = 5
    dctx.stroke()
    dctx.lineWidth = 3
    for (let i = 0; i <= 8; i += 1) {
      const a = Math.PI * 0.75 + (i / 8) * Math.PI * 1.5
      const r0 = i % 2 === 0 ? 88 : 100
      dctx.strokeStyle = i >= 7 ? '#b23b32' : '#3a3f45'
      dctx.beginPath()
      dctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0)
      dctx.lineTo(c + Math.cos(a) * 112, c + Math.sin(a) * 112)
      dctx.stroke()
    }
    dctx.fillStyle = '#4a5058'
    dctx.font = 'bold 26px sans-serif'
    dctx.textAlign = 'center'
    dctx.fillText('MPa', c, c + 62)
  }
  const dialTex = new CanvasTexture(dialCanvas)
  dialTex.colorSpace = SRGBColorSpace
  dialTex.needsUpdate = true
  textures.push(dialTex)
  /* 材质组顺序是 [侧面, 顶盖, 底盖]。表盘必须挂在顶盖上，
     挂到索引 0 会把表盘卷在圆柱侧面上——第一版就是这样。 */
  const dial = new Mesh(new CylinderGeometry(gaugeR, gaugeR, 0.012, 32), [
    chromeMaterial(),
    new MeshStandardMaterial({ color: 0xffffff, metalness: 0, roughness: 0.55, map: dialTex }),
    chromeMaterial(),
  ])
  dial.rotation.z = deg(-90)
  dial.position.set(panelX + 0.05, panelY + 0.24, 0.08)
  drive.add(dial)
  const bezel = new Mesh(new CylinderGeometry(gaugeR + 0.01, gaugeR + 0.01, 0.018, 28), chromeMaterial())
  bezel.rotation.z = deg(-90)
  bezel.position.copy(dial.position)
  drive.add(bezel)
  const needlePivot = new Group()
  needlePivot.position.set(panelX + 0.046, panelY + 0.24, 0.08)
  needlePivot.add(
    roundedBox(0.003, gaugeR * 0.76, 0.005, paintedMaterial(0xb23b32), 0, gaugeR * 0.3, 0, 0.001),
  )
  drive.add(needlePivot)

  /* 接近开关 ×2（升弓到位 / 落弓到位）。真机没有"到位指示灯"，状态由读数面板表达。 */
  const lampGroup = new Group()
  for (const [x, kind] of [
    [0.24, 'rise'],
    [-0.24, 'low'],
  ] as const) {
    const probe = new Group()
    const barrel = new Mesh(new CylinderGeometry(0.016, 0.016, 0.05, 16), chromeMaterial())
    barrel.rotation.x = Math.PI / 2
    probe.add(barrel)
    const nut = new Mesh(new CylinderGeometry(0.024, 0.024, 0.011, 6), fitting)
    nut.rotation.x = Math.PI / 2
    nut.position.z = 0.008
    probe.add(nut)
    const face = new Mesh(
      new CylinderGeometry(0.015, 0.015, 0.005, 16),
      new MeshStandardMaterial({ color: 0xd8d2c4, metalness: 0.05, roughness: 0.62 }),
    )
    face.rotation.x = Math.PI / 2
    face.position.z = 0.027
    probe.add(face)
    probe.position.set(x, DECK_Y + 0.14, 0.6)
    probe.userData.kind = kind
    lampGroup.add(probe)
  }
  drive.add(lampGroup)
  parts.lamp = lampGroup

  /* 总风管：车顶 → 绝缘软管 → 阀板进气口。
     绝缘软管是**橡胶+织物**的粗管，实拍里在受电弓旁边很显眼。 */
  drive.add(
    hose(
      [
        new Vector3(1.24, 0.06, -0.86),
        new Vector3(1.18, 0.16, -0.5),
        new Vector3(1.1, 0.24, -0.1),
        new Vector3(panelX + 0.02, panelY + 0.17, panelZ - 0.3),
      ],
      0.019,
      hoseMat,
    ),
  )
  // 阀板 → 底架 2 个空气接口
  for (const x of [-0.18, 0.18]) {
    drive.add(
      hose(
        [
          new Vector3(panelX - 0.02, panelY - 0.16, panelZ - 0.28),
          new Vector3(0.66, 0.3, 0.5),
          new Vector3(0.3, 0.24, -0.55),
          new Vector3(x, DECK_Y - 0.01, -0.8),
        ],
        0.011,
        hoseMat,
      ),
    )
  }
  drive.name = 'panto-panel'
  parts.drive = drive
  root.add(drive)

  /* ------------------------------------------------------- 气囊 / 阻尼器 */
  const plateMat = paintedMaterial(0x4a5058)
  const innerMat = rubberMaterial(0x2a2e33)
  /* 升弓气囊做成**卧式**：真机（DSA-350 / TSG19A 一脉）是"气囊胀大 → 推动导盘 →
     导盘上的钢索绕过下臂根部的定滑轮 → 把下臂拉起来"。
     上一版把它做成竖着装在下臂 32% 处的长杆，底座还写在车顶面以下（y=0.04），
     结果是一根 0.9m 长的细肠子从车顶穿出来顶到臂上——三处都错。 */
  const bag = airSpring(0.22, 0x3a3f45, plateMat, innerMat)
  const BAG_Y = DECK_Y + 0.14
  const BAG_Z0 = -0.6

  const driveMech = new Group()
  driveMech.add(bag.group)
  /* 气囊支座：两道抱箍把它架在底架上。没有它，气囊是一段悬空的圆筒——
     上一版它更糟，整根从车顶面以下穿上来。 */
  for (const z of [BAG_Z0 + 0.04, BAG_Z0 + 0.2]) {
    driveMech.add(
      roundedBox(0.15, BAG_Y - DECK_Y - 0.04, 0.05, frameMat, 0, (BAG_Y + DECK_Y) / 2 - 0.01, z, 0.005),
    )
  }

  // 导盘：一块横跨左右的滑块，两端各一个小滑轮，钢索从这里出去
  const carriage = new Group()
  carriage.add(roundedBox(1.0, 0.05, 0.14, armDark, 0, 0, 0, 0.008))
  for (const sx of [-1, 1]) {
    const sheave = new Mesh(new CylinderGeometry(0.055, 0.055, 0.03, 18), armDark)
    sheave.rotation.z = Math.PI / 2
    sheave.position.set(sx * PDIM.armX, 0.02, 0)
    carriage.add(sheave)
  }
  // 导盘坐在两根导轨上（没有导轨，它就是悬在空中的一块板）
  for (const sx of [-1, 1]) {
    driveMech.add(
      roundedBox(0.03, 0.03, 0.72, frameMat, sx * PDIM.armX, BAG_Y - 0.03, -0.42, 0.005),
    )
  }
  driveMech.add(carriage)

  /* 两根钢索：导盘滑轮 → 下臂根部的定滑轮。长度随行程变，但永远连着两端；
     这一根线才是"气压怎么变成升弓动作"的答案，比任何文字都直白。 */
  const cables: Mesh[] = []
  for (let i = 0; i < 2; i += 1) {
    const c = new Mesh(new CylinderGeometry(0.0065, 0.0065, 1, 8), steelMaterial(0x9aa0a6))
    cables.push(c)
    driveMech.add(c)
  }

  const dampers = [0, 1].map(() =>
    cylinderActuator({
      barrelLen: 0.26,
      barrelR: 0.032,
      rodR: 0.014,
      barrelMat: paintedMaterial(0x555b62),
      rodMat: chrome,
    }),
  )
  const valve = quickReleaseValve()
  const switchBox = pressureSwitch()

  driveMech.add(dampers[0].group, dampers[1].group)
  driveMech.add(valve.group, switchBox.group)
  /* 阀与开关挂在底架**外侧**的悬臂上，不在臂的摆动平面内。
     第一版放在 x=0.36：默认机位在 +X，近侧那根臂把它们整个挡住。 */
  driveMech.add(
    roundedBox(0.46, 0.014, 0.2, paintedMaterial(0x3f444a), 0.72, DECK_Y + 0.06, -0.34, 0.005),
  )
  // 悬臂必须坐回纵梁上，否则是两块板浮在车顶
  driveMech.add(roundedBox(0.06, 0.09, 0.06, frameMat, 0.5, DECK_Y + 0.03, -0.34, 0.006))
  valve.group.position.set(0.84, DECK_Y + 0.07, -0.34)
  valve.group.rotation.z = deg(-6)
  switchBox.group.position.set(0.64, DECK_Y + 0.07, -0.34)
  driveMech.name = 'panto-pneumatic'
  parts.drive2 = driveMech
  root.add(driveMech)

  /* ---------------------------------------------------------------- 臂 */
  const lowerArms = [new Group(), new Group()]
  const upperArms = [new Group(), new Group()]
  const arms = new Group()
  for (const g of [...lowerArms, ...upperArms]) arms.add(g)

  const buildLower = (g: Group, side: 1 | -1): void => {
    g.add(boxBeam(PDIM.lower, 0.15, 0.195, 0.095, 0.13, armPaint))
    /* 中段拼接板 + 螺栓：真机下臂由两段箱体拼接，
       这是**最好认的比例线索**——没有它，一根 1.5m 光板在屏幕上分不出是 1m 还是 3m。 */
    g.add(roundedBox(0.168, 0.28, 0.212, armPaint, 0, PDIM.lower * 0.46, 0, 0.008))
    for (const bx of [-0.086, 0.086]) {
      for (const by of [-0.09, 0, 0.09]) {
        const bolt = new Mesh(new CylinderGeometry(0.009, 0.009, 0.012, 8), fitting)
        bolt.rotation.z = Math.PI / 2
        bolt.position.set(bx, PDIM.lower * 0.46 + by, 0)
        g.add(bolt)
      }
    }
    /* 第二道拼缝：上段与中段的对接箍。
       真实箱形梁是几段钢板拼焊的，拼缝处会夹一圈衬板——它比画一条黑线可信，
       因为有厚度、会投影。全机原本是"一整块塑料"，就是缺这些。 */
    g.add(roundedBox(0.134, 0.024, 0.174, armDark, 0, PDIM.lower * 0.75, 0, 0.003))
    /* 纵向焊道：箱形梁两条棱上的焊缝。位置按下臂在 f=0.23 处的实际截面算，
       不能拿根部的宽度一路量到梢部——那是锥形梁，越往上越窄。 */
    for (const sx of [-1, 1]) {
      const bead = new Mesh(new BoxGeometry(0.011, PDIM.lower * 0.42, 0.008), armPaint)
      bead.position.set(sx * 0.066, PDIM.lower * 0.235, 0.09)
      bead.castShadow = true
      g.add(bead)
    }
    // 肘部：两块耳板夹一根销轴（关节是"会动"的唯一线索，做成实心块等于藏起来）
    for (const bx of [-0.062, 0.062]) {
      g.add(roundedBox(0.02, 0.15, 0.135, armPaint, bx, PDIM.lower - 0.05, 0, 0.006))
    }
    const pin = new Mesh(new CylinderGeometry(0.026, 0.026, 0.16, 14), fitting)
    pin.rotation.z = Math.PI / 2
    pin.position.set(0, PDIM.lower - 0.05, 0)
    g.add(pin)
    /* **弧形调整板（凸轮板）**：钢索贴着它的边缘绕，末端锚在弧上。
       它的作用不是好看——气囊推力随行程增大，弧板半径随转角减小，力矩 M=F·r
       才能基本不变，接触压力才稳得住（实机下臂根部那块扇形板就是干这个的）。
       上一版这里只有一个 Ø220 的圆滑轮，等于把"压力恒定"这层机构整个省略了。 */
    const arcGeo = new CylinderGeometry(ARC_R, ARC_R, 0.022, 28, 1, false, deg(140), deg(120))
    arcGeo.rotateZ(Math.PI / 2)
    const arc = new Mesh(arcGeo, armDark)
    arc.position.y = 0.03
    arc.castShadow = true
    g.add(arc)
    // 辐板：弧板不是悬空的一片，要有一根筋连回臂体
    const rib = roundedBox(ARC_R * 0.92, 0.05, 0.014, armDark, 0.012, 0.03, 0, 0.004)
    rib.rotation.y = deg(20)
    g.add(rib)
    // 轮毂：弧板与臂的销轴之间要有过渡件
    const hub = new Mesh(new CylinderGeometry(0.055, 0.055, 0.05, 16), armDark)
    hub.rotation.z = Math.PI / 2
    hub.position.y = 0.03
    g.add(hub)
    // 外侧伸出耳板：上臂挂在这里
    g.add(roundedBox(0.026, 0.17, 0.12, armPaint, side * 0.075, PDIM.lower - 0.05, 0, 0.006))
    const outPin = new Mesh(new CylinderGeometry(0.024, 0.024, 0.09, 12), fitting)
    outPin.rotation.z = Math.PI / 2
    outPin.position.set(side * (PDIM.armOut - 0.02), PDIM.lower - 0.05, 0)
    g.add(outPin)
    // 气囊 / 阻尼器挂点耳板
    g.add(roundedBox(0.06, 0.07, 0.05, armDark, 0, PDIM.lower * 0.32, -0.1, 0.008))
    g.add(roundedBox(0.05, 0.06, 0.045, armDark, 0, PDIM.lower * 0.5, -0.09, 0.007))
    // 铰点轴套
    const boss = new Mesh(new CylinderGeometry(0.045, 0.045, 0.14, 16), armDark)
    boss.rotation.z = Math.PI / 2
    boss.position.y = 0.02
    g.add(boss)
    /* 接地铜编织带：跨过底架铰点，把电流旁路掉（不然轴承电蚀）。
       橙铜色是整台设备上唯一的高饱和色，实拍里一眼就能看到。 */
    g.add(
      braid(new Vector3(0, 0.02, -0.04), new Vector3(0, 0.16, -0.13), 0.05, copper),
    )
  }

  const buildUpper = (g: Group): void => {
    g.add(boxBeam(PDIM.upper, 0.11, 0.145, 0.068, 0.09, armPaint))
    // 纵向焊道：上臂同样有两条，位置按 f=0.2 处的截面给
    for (const sx of [-1, 1]) {
      const bead = new Mesh(new BoxGeometry(0.01, PDIM.upper * 0.36, 0.007), armPaint)
      bead.position.set(sx * 0.048, PDIM.upper * 0.21, 0.066)
      bead.castShadow = true
      g.add(bead)
    }
    // 抱箍：气管与配重的安装面
    for (const f of [0.34, 0.62]) {
      g.add(roundedBox(0.124, 0.022, 0.158, armDark, 0, PDIM.upper * f, 0, 0.006))
    }
    // 头部托架
    g.add(roundedBox(0.1, 0.11, 0.1, armDark, 0, PDIM.upper - 0.04, 0, 0.01))
    // 肘部接地编织带
    g.add(braid(new Vector3(0, 0.04, -0.06), new Vector3(0, 0.15, -0.02), 0.04, copper))
    /* 沿上臂走的 ADD 气管：快排阀 → 弓头滑板气腔。
       这是"滑板破裂为什么会触发降弓"的唯一物证，必须画出来。 */
    g.add(
      hose(
        [
          new Vector3(0.03, 0.02, 0.085),
          new Vector3(0.05, PDIM.upper * 0.35, 0.09),
          new Vector3(0.045, PDIM.upper * 0.72, 0.085),
          new Vector3(0.02, PDIM.upper - 0.01, 0.055),
        ],
        0.0072,
        hoseMat,
      ),
    )
    for (const y of [PDIM.upper * 0.3, PDIM.upper * 0.66]) {
      g.add(roundedBox(0.028, 0.016, 0.03, armDark, 0.03, y, 0.088, 0.004))
    }
  }

  buildLower(lowerArms[0], -1)
  buildLower(lowerArms[1], 1)
  buildUpper(upperArms[0])
  buildUpper(upperArms[1])

  // 横向联结：没有它，左右两片臂像两块独立的板
  const braceLow = roundedBox(0.92, 0.05, 0.06, armDark, 0, 0, 0, 0.008)
  const braceUp = roundedBox(1.14, 0.042, 0.05, armDark, 0, 0, 0, 0.007)
  arms.add(braceLow, braceUp)

  /* 两根导杆（**每侧一组**，与臂同一平面）。
     实机是 Ø25–30 的钢管，两端**叉形耳板 + 销轴**，颜色接近臂漆（不是镀铬亮杆）。
     上一版三处错，都在这一块：
     ① 上导杆的弓头端写在 **x=0（机身中轴）**——杆从侧面臂斜插到中间，末端悬在空气里，
        这就是截图里"穿过去又没了"的那根；
     ② 下导杆外套 Ø52 配 Ø32 内杆，台阶太大，端面在斜视角下读成"断开的管口"；
     ③ 两根都用镀铬亮杆，实拍里是深灰漆管。 */
  const rodMat = paintedMaterial(0x4e545b)
  const pinMat = paintedMaterial(0x8b9197)

  /** 叉形耳板 + 销轴：局部 +Y 是杆的伸向，两片耳板夹在 ±X。 */
  const rodEnd = (): Group => {
    const g = new Group()
    for (const sx of [-1, 1]) {
      g.add(roundedBox(0.013, 0.062, 0.046, rodMat, sx * 0.021, 0, 0, 0.004))
    }
    const pin = new Mesh(new CylinderGeometry(0.011, 0.011, 0.062, 10), pinMat)
    pin.rotation.z = Math.PI / 2
    g.add(pin)
    return g
  }

  interface Rod {
    grp: Group
    tube: Mesh
    a: Group
    b: Group
    sleeve?: Mesh
    collar?: Mesh
  }

  const upperRods: Rod[] = []
  const lowerRods: Rod[] = []
  for (const side of [-1, 1] as const) {
    // 上导杆：定长刚杆（全行程差 0.5%，所以两端都是真耳板，不假装伸缩）
    const ug = new Group()
    const uTube = new Mesh(new CylinderGeometry(0.017, 0.017, 1, 12), rodMat)
    uTube.position.y = 0.5
    const uA = rodEnd()
    const uB = rodEnd()
    ug.add(uTube, uA, uB)
    ug.userData.side = side
    arms.add(ug)
    upperRods.push({ grp: ug, tube: uTube, a: uA, b: uB })

    /* 下导杆：底架 → 上臂。杆长随行程变 90%，做不成定长杆（见 `panto-kin` 的说明），
       所以是**导向杆**：外套 + 滑杆 + 套口压盖。压盖是关键——没有它，外套端面
       在斜视角下就是一个圆孔，看着像被锯断的管子。 */
    const lg = new Group()
    const lSleeve = new Mesh(new CylinderGeometry(0.021, 0.021, 1, 14), rodMat)
    lSleeve.position.y = 0.5
    const lCollar = new Mesh(new CylinderGeometry(0.0245, 0.0245, 1, 14), pinMat)
    const lSlide = new Mesh(new CylinderGeometry(0.017, 0.017, 1, 12), pinMat)
    const lA = rodEnd()
    const lB = rodEnd()
    lg.add(lSleeve, lCollar, lSlide, lA, lB)
    lg.userData.side = side
    arms.add(lg)
    lowerRods.push({ grp: lg, tube: lSlide, a: lA, b: lB, sleeve: lSleeve, collar: lCollar })
  }
  arms.name = 'panto-arms'
  parts.arms = arms
  root.add(arms)

  /* ---------------------------------------------------------------- 弓头 */
  /* 弓头是一个**很宽的框**：两根碳滑板中心距 597mm、长 1576mm，两端端板连成闭合框，
     四条弓角向下向外弯，端部有翼片（跑高速时用来压住弓头、抑制气动抬升）。 */
  const head = new Group()
  const STRIP_HALF = PDIM.stripLen / 2
  const SZ = PDIM.stripZ
  // 弓头横梁（上臂销接梁）
  head.add(roundedBox(1.24, 0.06, 0.1, armDark, 0, 0.008, 0, 0.009))
  /* 上导杆的顶部挂座：横梁下缘两块耳板，位置就是杆所在的 x（上臂外侧）。
     少了它，上导杆上端没有"落点"，看起来还是浮在梁下面（这正是上一版的样子）。 */
  for (const hx of [-1, 1]) {
    head.add(
      roundedBox(0.055, 0.07, 0.08, armDark, hx * (PDIM.armX + PDIM.armOut + 0.07), -0.04, 0, 0.006),
    )
  }
  // 中央托架
  head.add(roundedBox(0.3, 0.085, 0.3, armDark, 0, 0.02, 0, 0.01))
  // 两根铝托架（沿 X）
  for (const z of [-SZ, SZ]) {
    head.add(roundedBox(STRIP_HALF + 0.02, 0.026, 0.05, paintedMaterial(0x9ba1a7), 0, 0.062, z, 0.006))
  }
  // 端板：把两根滑板连成闭合框
  for (const x of [-STRIP_HALF, STRIP_HALF]) {
    head.add(roundedBox(0.028, 0.07, SZ * 2 + 0.07, armDark, x, 0.062, 0, 0.008))
  }
  // 中间两处支撑座
  for (const x of [-0.52, 0.52]) {
    head.add(roundedBox(0.05, 0.035, SZ * 2 + 0.02, armDark, x, 0.045, 0, 0.005))
  }
  // 碳滑板（整根 / 破裂后的两截）
  const stripWhole = new Mesh(new BoxGeometry(PDIM.stripLen, 0.05, 0.062), carbon)
  stripWhole.position.set(0, 0.09, SZ)
  stripWhole.castShadow = true
  head.add(stripWhole)
  const stripBack = new Mesh(new BoxGeometry(PDIM.stripLen, 0.05, 0.062), carbon)
  stripBack.position.set(0, 0.09, -SZ)
  stripBack.castShadow = true
  head.add(stripBack)
  const halves: Mesh[] = []
  for (const sign of [-1, 1]) {
    const half = new Mesh(new BoxGeometry(STRIP_HALF - 0.02, 0.05, 0.062), carbon)
    half.position.set(sign * (STRIP_HALF / 2 + 0.012), 0.09, SZ)
    half.userData.sign = sign
    half.visible = false
    halves.push(half)
    head.add(half)
  }
  // 磨耗到限线
  for (const z of [-SZ, SZ]) {
    head.add(
      roundedBox(STRIP_HALF * 1.96, 0.005, 0.004, paintedMaterial(0xd8d2c4), 0, 0.078, z + 0.034, 0.001),
    )
  }
  /* 弓角：四条，向下向外弯。材质用喷铝而不是镀铬——镀铬在浅底上会炸成一根白线。 */
  const hornMat = paintedMaterial(0x9aa1a8)
  for (const sign of [-1, 1]) {
    for (const z of [-SZ, SZ]) {
      const curve = new CatmullRomCurve3([
        new Vector3(sign * (STRIP_HALF - 0.01), 0.098, z),
        new Vector3(sign * (STRIP_HALF + 0.075), 0.085, z),
        new Vector3(sign * (PDIM.headHalf - 0.015), 0.008, z),
        new Vector3(sign * PDIM.headHalf, -0.082, z),
      ])
      const horn = new Mesh(new TubeGeometry(curve, 26, 0.0145, 9, false), hornMat)
      horn.castShadow = true
      head.add(horn)
    }
  }
  /* 翼片：弓头两端的下伸板。它不是为了好看——高速时靠气动压住弓头、抑制抬升。 */
  for (const sign of [-1, 1]) {
    const fin = roundedBox(0.012, 0.14, 0.3, armDark, sign * (STRIP_HALF + 0.02), 0.0, 0, 0.004)
    fin.rotation.z = sign * deg(8)
    head.add(fin)
  }
  /* 横向弹簧：4 只水平布置的拉簧，吸收横向冲击、让滑板在运行方向上有弹性。 */
  for (const sign of [-1, 1]) {
    for (const z of [-SZ * 0.55, SZ * 0.55]) {
      const s = helix(0.014, 0.0035, 4, chrome)
      s.rotation.z = deg(90)
      s.scale.y = 0.13
      s.position.set(sign * (STRIP_HALF - 0.12), 0.055, z)
      head.add(s)
    }
  }
  // ADD 气动软管接头：气管从托架接到滑板端头
  for (const sign of [-1, 1]) {
    const fit = new Mesh(new CylinderGeometry(0.009, 0.009, 0.03, 10), fitting)
    fit.rotation.z = deg(90)
    fit.position.set(sign * (STRIP_HALF - 0.03), 0.075, SZ - 0.02)
    head.add(fit)
  }
  head.name = 'panto-head'
  parts.head = head
  root.add(head)

  /* ------------------------------------------------------------ 弓头悬挂 */
  /* 弓头不是焊在臂上的，它坐在两根弹簧上。这是"接触压力"能存在的前提：
     臂继续上行、弓头被接触线挡住、弹簧被压缩，压力才建立起来。 */
  const susp = new Group()
  const springs: Mesh[] = []
  for (const x of [-0.3, 0.3]) {
    const s = helix(0.028, 0.0062, 5, chrome)
    s.position.x = x
    springs.push(s)
    susp.add(s)
    const rod = new Mesh(new CylinderGeometry(0.011, 0.011, 1, 12), chrome)
    rod.position.x = x
    rod.userData.rod = true
    susp.add(rod)
  }
  susp.add(roundedBox(0.72, 0.026, 0.12, armDark, 0, 0.005, 0, 0.006))
  const guideRods = susp.children.filter((c) => c.userData.rod === true) as Mesh[]
  root.add(susp)

  /* ---------------------------------------------------------------- 接触线 */
  /* 线沿 **Z**（车行方向），滑板横在它下面。画成沿 X 就正好与滑板平行，行内人一眼看出错。 */
  const wireMat = new MeshStandardMaterial({ color: 0x33352f, metalness: 0.12, roughness: 0.74 })
  const wireGroup = new Group()
  /* 命名不是为了好看：导出 glb 时节点名会被带出去，Blender 侧要按名字把这组
     「接触线 + 吊弦」排除在取景包围盒之外——它长 9m，混进去会把整机压成巴掌大。 */
  wireGroup.name = 'catenary'
  const wire = new Mesh(new CylinderGeometry(0.012, 0.012, 9, 10), wireMat)
  wire.rotation.x = Math.PI / 2
  wire.position.set(0, WIRE_Y + 0.008, HEAD_Z - 2.2)
  wire.name = 'catenary'
  wireGroup.add(wire)
  for (const z of [-3.6, 3.2]) {
    const dropper = new Mesh(new CylinderGeometry(0.003, 0.003, 0.85, 6), wireMat)
    dropper.position.set(0, WIRE_Y + 0.42, z)
    dropper.name = 'catenary'
    wireGroup.add(dropper)
  }
  root.add(wireGroup)

  /* ---------------------------------------------------------------- 机构 */
  const pivots = [new Vector3(-PDIM.armX, PDIM.pivotY, PDIM.pivotZ), new Vector3(PDIM.armX, PDIM.pivotY, PDIM.pivotZ)]
  const bagBase0 = new Vector3(0, BAG_Y, BAG_Z0)
  const cA = new Vector3()
  const cB = new Vector3()
  const cU = new Vector3()
  const dmpBase = [
    new Vector3(-PDIM.armX, DECK_Y + 0.05, 0.06),
    new Vector3(PDIM.armX, DECK_Y + 0.05, 0.06),
  ]
  const p1 = [new Vector3(), new Vector3()]
  const p2 = [new Vector3(), new Vector3()]
  const attach = new Vector3()
  const outA = new Vector3()
  const outB = new Vector3()
  const rodEndA = new Vector3()
  const rodEndB = new Vector3()
  const upA = new Vector3()
  const upB = new Vector3()
  let mode: PantoMode = 'normal'
  let lastT = 0

  /** 下臂上距铰点 f 比例处。气囊与阻尼器的杆端都挂在这条线上。 */
  const onLower = (out: Vector3, i: number, f: number, a1: number): Vector3 =>
    out.set(
      pivots[i].x,
      pivots[i].y + PDIM.lower * f * Math.sin(a1),
      pivots[i].z - PDIM.lower * f * Math.cos(a1),
    )

  const setT = (t: number): void => {
    lastT = t
    const p = travel(t, mode)
    const { a1, a2 } = armAngles(p)

    for (let i = 0; i < 2; i += 1) {
      p1[i].set(
        pivots[i].x,
        pivots[i].y + PDIM.lower * Math.sin(a1),
        pivots[i].z - PDIM.lower * Math.cos(a1),
      )
      p2[i].set(
        pivots[i].x,
        p1[i].y + PDIM.upper * Math.sin(a2),
        p1[i].z + PDIM.upper * Math.cos(a2),
      )
      placeAxis(lowerArms[i], pivots[i], p1[i])
      const off = i === 0 ? -PDIM.armOut : PDIM.armOut
      outA.copy(p1[i]).setX(p1[i].x + off)
      outB.copy(p2[i]).setX(p2[i].x + off)
      placeAxis(upperArms[i], outA, outB)
    }

    /* 横撑跟着两根臂的中点走。它们是横跨左右的联结件，只给位置，不参与臂的滚转。 */
    braceLow.position.set(0, (pivots[0].y + p1[0].y) / 2, (pivots[0].z + p1[0].z) / 2)
    braceUp.position.set(0, (p1[0].y + p2[0].y) / 2, (p1[0].z + p2[0].z) / 2)

    /* 升弓链路：气囊伸长 → 导盘前移 → 钢索缩短 → 下臂转。
       角度仍由 `panto-kin` 给（那是唯一来源），这里只把**看得见的因果**接上：
       上一版气囊是竖着直接顶在臂上的长杆，画面上是"一根肠子从车顶穿出来"。 */
    const stroke = 0.16 * p
    const carZ = BAG_Z0 + 0.22 + stroke + 0.05
    bag.set(bagBase0, cA.set(0, BAG_Y, carZ))
    carriage.position.set(0, BAG_Y, carZ)
    for (let i = 0; i < 2; i += 1) {
      // 钢索：导盘滑轮 → **弧形调整板的弧面**（不是臂身上的一个点）
      const sx = i === 0 ? -1 : 1
      cA.set(sx * PDIM.armX, BAG_Y + 0.02, carZ)
      cU.subVectors(p1[i], pivots[i]).normalize()
      // 弧板 90° 正对臂身，锚点取 200°（后下方）——钢索从导盘过来正好切在这里
      const th = Math.atan2(cU.y, cU.z) + deg(110)
      cB.set(pivots[i].x, pivots[i].y + Math.sin(th) * ARC_R, pivots[i].z + Math.cos(th) * ARC_R)
      const clen = Math.max(cA.distanceTo(cB), 0.05)
      placeAxis(cables[i], cA, cB)
      cables[i].scale.y = clen
    }
    for (let i = 0; i < 2; i += 1) {
      dampers[i].set(dmpBase[i], onLower(attach, i, 0.5, a1))
    }

    /* 弓头：自由间隙减去压缩量。臂尖到托架的距离就是间隙本身。 */
    const gap = PGAP.free - compression(p)
    susp.position.set(0, p2[0].y, p2[0].z)
    head.position.set(0, p2[0].y + gap, p2[0].z)
    const springLen = Math.max(gap, 0.006)
    for (const s of springs) {
      s.scale.y = springLen
      s.position.y = 0.012
    }
    for (const r of guideRods) {
      r.scale.y = Math.max(gap + 0.1, 0.02)
      r.position.y = gap / 2 + 0.02
    }

    /* ---------------- 两根导杆（每侧一组） ---------------- */
    for (let i = 0; i < 2; i += 1) {
      /* 导杆必须装在**上臂外侧**（`armX + armOut + 0.07`），不能只贴在下臂平面。
         上一版上导杆从下臂斜插到机身中轴，正对镜头时整根横穿臂面——实物里两根杆
         始终在臂的外侧、与臂大致平行，所以从任何角度看都不会"划"过臂的表面。 */
      const sx = i === 0 ? -1 : 1
      const rodX = pivots[i].x + sx * (PDIM.armOut + 0.07)

      // 上导杆：下臂 f 处 → 弓头支架幅板下方
      onLower(upA, i, UPPER_ROD.f, a1)
      upA.x = rodX
      upB.set(rodX, head.position.y + UPPER_ROD.offY, head.position.z + UPPER_ROD.offZ)
      const ur = upperRods[i]
      const ulen = Math.max(upA.distanceTo(upB), 0.15)
      placeAxis(ur.grp, upA, upB)
      // 管身两端各留 25mm 给耳板，避免管子戳出耳板外
      ur.tube.scale.y = Math.max(ulen - 0.05, 0.08)
      ur.tube.position.y = 0.025 + Math.max(ulen - 0.05, 0.08) / 2
      ur.b.position.y = ulen

      /* 下导杆：底架 → 上臂 s 处。外套定长，滑杆从中抽出。
         套口必须带压盖——没有压盖，外套端面在斜视角下就是一个圆孔，
         读成"被锯断的管子"（上一版截图里的第二个毛病）。 */
      const lr = lowerRods[i]
      rodEndA.set(rodX, LOWER_ROD.base.y, LOWER_ROD.base.z)
      rodEndB.set(
        rodX,
        p1[i].y + PDIM.upper * LOWER_ROD.s * Math.sin(a2),
        p1[i].z + PDIM.upper * LOWER_ROD.s * Math.cos(a2),
      )
      const llen = Math.max(rodEndA.distanceTo(rodEndB), 0.3)
      placeAxis(lr.grp, rodEndA, rodEndB)
      const sleeveLen = Math.max(Math.min(0.62, llen - 0.12), 0.14)
      lr.sleeve!.scale.y = sleeveLen
      lr.sleeve!.position.y = sleeveLen / 2
      lr.collar!.scale.y = 0.022
      lr.collar!.position.y = sleeveLen - 0.011
      // 滑杆从套口里伸出去，端头再收 5mm 到耳板内
      const slideLen = Math.max(llen - sleeveLen + 0.02, 0.06)
      lr.tube.scale.y = slideLen
      lr.tube.position.y = sleeveLen - 0.02 + slideLen / 2
      lr.b.position.y = llen
    }

    /* ---------------- 气路 / ADD ---------------- */
    const air = airState(t, mode)
    needlePivot.rotation.x = Math.PI * 0.75 - (air.bag / 0.8) * Math.PI * 1.5
    valve.set(air.diff, air.venting)
    switchBox.set(air.switchClosed)

    /* 滑板破裂：整根换成两截，缝宽随破裂量长开。
       只用显隐切换，不重建几何——每帧 new 一个 BoxGeometry 会持续泄漏显存。 */
    const burst = mode === 'add' ? Math.min(1, Math.max(0, (t - PANO_T.addRupture) / 0.02)) : 0
    stripWhole.visible = burst <= 0
    for (const h of halves) {
      h.visible = burst > 0
      const sign = h.userData.sign as number
      h.position.x = sign * (STRIP_HALF / 2 + 0.012 + 0.03 * burst)
    }
  }

  const framingAt = (t: number): { target: [number, number, number]; distance: number } => {
    const p = travel(t, mode)
    return { target: [0.08, 0.54 + 1.0 * p, 0.06], distance: 4.6 + 3.9 * p }
  }

  setT(0)

  /* ---------------------------------------------------------------- 标注 */
  /* 术语按公开资料，不用自造词。只标"看不出是什么/看不见内部变化"的件。 */
  /* 只留 6 条：全屏演示页上 9 条会互相挤，而且"弓角""绝缘子"这种一眼就认识的件
     标了只是噪音。留下的每一条都对应一个"看不出是什么/看不见内部变化"的件。 */
  const annots = [
    { id: 'strip', text: '碳滑板', note: '×2，中心距 597mm' },
    { id: 'urod', text: '上导杆', note: '保持滑板水平' },
    { id: 'bag', text: '气囊', note: '升弓动力源' },
    { id: 'damper', text: '阻尼器', note: '限下降速度' },
    { id: 'valve', text: '快排阀', note: 'ADD 时直排大气' },
    { id: 'panel', text: '气阀板', note: '过滤/调压/节流/压力表' },
  ] as const

  return {
    root,
    setT,
    setMode: (next: string) => {
      mode = next === 'add' ? 'add' : 'normal'
      setT(lastT)
    },
    parts,
    phase: (t: number) => airPhase(t, mode),
    framing: { target: [0.08, 1.55, 0.06], distance: 8.7 },
    /* 长焦（26°）而不是默认 34°：受电弓是一台 3m 高的设备，广角会把底架拉大、
       把弓头压小，看起来像"从脚边仰拍"。产品图用的是 24–28°，透视一弱，比例就对了。 */
    fov: 26,
    envIntensity: 1.15,
    viewDir: [0.66, 0.42, 0.62],
    framingAt,
    /* 标注锚点是**世界坐标**，随动作实时算。DeviceScene 把点投影到屏幕，做成 HTML 标签
       （3D 里的 Sprite 没有可用的字号：要么 1m 宽遮住设备，要么 4px 看不清）。 */
    annotations: () =>
      annots.map((a) => {
        if (a.id === 'strip') return { ...a, at: new Vector3(0.5, head.position.y + 0.12, PDIM.stripZ) }
        if (a.id === 'urod') {
          return { ...a, at: new Vector3(PDIM.armX + 0.2, (upA.y + upB.y) / 2, (upA.z + upB.z) / 2) }
        }
        if (a.id === 'bag') return { ...a, at: new Vector3(0, BAG_Y + 0.02, BAG_Z0 + 0.2) }
        if (a.id === 'damper') return { ...a, at: new Vector3(PDIM.armX + 0.06, DECK_Y + 0.14, 0.08) }
        if (a.id === 'valve') return { ...a, at: new Vector3(0.86, DECK_Y + 0.14, -0.38) }
        return { ...a, at: new Vector3(panelX + 0.02, panelY + 0.16, panelZ) }
      }),
    dispose: () => {
      disposeTree(root)
      for (const tex of textures) tex.dispose()
    },
  }
}
