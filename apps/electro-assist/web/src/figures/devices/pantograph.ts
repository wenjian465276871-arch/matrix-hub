/** 单臂受电弓（TSG19A 型式）：参数化几何 + 四连杆式动作 + 气路/ADD 工况。
 *
 *  ## 形体依据与边界
 *  公开资料（公众号「轨道知道」CRH380A 受电弓详解、CR 系列检修工艺的公开片段）
 *  能确认的只有三件事：**单臂（单根下臂 + 单根上臂 + 弓头）**、**四个复合绝缘子**、
 *  **气囊驱动 + 阻尼器限速 + 快排阀实现 ADD**。尺寸只有弓头 1950mm、滑板 1576mm、
 *  工作高度约 1.5–2.9m 三条是公开的，其余杆长与铰点位置是**按实拍比例反推的示意值**。
 *  底座颜色（红丹防锈漆）、绝缘子的棕红釉面、碳滑板的深灰都是实拍配色，不是设计配色。
 *
 *  ## 三条"看起来假"的根因（2026-11-10 全部重做）
 *  1. **臂像两块平板**。原来用 `metalness = 1` 的不锈钢做臂：金属没有漫反射，
 *     正面照抄暗墙、顶面照抄灯带，屏幕上就是"黑板上贴了一条白条"。
 *     实机的臂是**喷铝漆的焊接箱体**——漆膜是电介质，`metalness = 0`，靠漫反射出体积。
 *  2. **收弓像升降台**。上臂落弓角原来是 +10°，两根臂都接近水平又同一高度，
 *     弓头吊在 0.84m，整台设备缩成一摞平板。实机收起时**肘部最高、弓头落到肘点下方**，
 *     所以上臂必须是负角（−2°），弓头落在 0.6m 高、贴着底架上的止档。
 *  3. **动作没有"证据"**。气路建压、压力开关闭合、快排阀排气，这三件在真机上都看不见，
 *     但不画出来，"为什么突然掉下来"就无从解释。这里用**剖切**（把壳体切掉一角，
 *     露出内腔、膜片、触点、阀芯）表达，而不是加一盏实物不存在的灯。
 *
 *  ## 为什么切掉一角而不是做半透明
 *  半透明在 WebGL 里要处理排序，叠在金属上会发灰、还吃掉一层性能；
 *  而"切开"本身就是检修培训件的常见做法（剖面模型）。做法是
 *  `CylinderGeometry / LatheGeometry` 的 `thetaLength` 少一段 + `DoubleSide`，
 *  一次成型、零额外开销，而且从任何角度看都成立。
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
import { PDIM, PGAP, WIRE_Y, armAngles, compression } from '../../lib/panto-kin'
import { PANO_T, airState, phase as airPhase, travel, type PantoMode } from '../../lib/panto-air'

/** 接触线所在的前后位置：正对**前侧那根滑板**。
 *  写 0.33 会让线落在两根滑板中间——从侧面看是"线悬在框里"，一眼假。 */
const HEAD_Z = 0.45

const deg = (v: number): number => (v * Math.PI) / 180

/* ---------------------------------------------------------------- 几何工具 */

/**
 * 把对象摆到两点之间，**滚转是确定的**。
 *
 * `Object3D.lookAt` / `setFromUnitVectors` 只保证轴向，绕轴的滚转是任意的——
 * 对圆柱无所谓，对矩形截面的梁就是"宽面朝天还是朝侧面"的差别，
 * 也就是"看着像梁"和"看着像板"的差别。这里用 `xRef = (1,0,0)` 构造正交基，
 * 保证局部 X 永远贴着世界 X：横撑、法兰、软管支架才能按设计的方向挂在梁上。
 */
const _x = new Vector3()
const _y = new Vector3()
const _z = new Vector3()
const _m = new Matrix4()
const _q = new Quaternion()
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

/**
 * 变截面焊接箱体：局部 +Y 从 0 到 `len`，根部 (w0×d0) 收到头部 (w1×d1)。
 *
 * `BoxGeometry` 只有上下两圈顶点，按 y 的正负分别缩放 x/z 即可，
 * 仍是 12 个三角面——与一个方块同价。棱线单独画：没有棱线，
 * 锥度在均匀受光的斜面上读不出来（实测：截面从 170 改到 125，画面几乎没差别）。
 */
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

/** 焊缝：**不需要**。锥形梁上贴一根等宽的焊道，头端必然悬在面外几厘米，
    近看是一条浮空的亮线——比不加更假。棱线已经足够读出锥度。 */

/** 软管：走 Catmull-Rom，管子本来就是软的，折线反而不像。 */
function hose(points: Vector3[], radius: number, material: MeshStandardMaterial): Mesh {
  const curve = new CatmullRomCurve3(points, false, 'catmullrom', 0.4)
  const mesh = new Mesh(new TubeGeometry(curve, 48, radius, 7, false), material)
  mesh.castShadow = true
  return mesh
}

/** 螺旋弹簧：轴向单位高度为 1，用时按实际长度缩放 Y。 */
function helix(radius: number, wire: number, turns: number, material: Material): Mesh {
  const pts: Vector3[] = []
  const n = Math.round(turns * 18)
  for (let k = 0; k <= n; k += 1) {
    const a = (k / n) * Math.PI * 2 * turns
    pts.push(new Vector3(Math.cos(a) * radius, k / n, Math.sin(a) * radius))
  }
  return new Mesh(new TubeGeometry(new CatmullRomCurve3(pts), n, wire, 6, false), material)
}

/* ------------------------------------------------------------------ 标注 */

/* 标注不用 Sprite，交给 DeviceScene 做成投影到屏幕的 HTML 标签。
   原因很实际：世界坐标里一张"字高 16px"的牌子，在 6m 机位下要么做成 1m 宽的
   大板（遮住半台设备），要么缩到 4px 看不清——3D 里的字号没有中间档。
   投影到 DOM 之后字号与屏幕像素挂钩，缩略图与全屏都读得出来。
   这里只提供**锚点**（世界坐标，随动作实时算）。 */

/* ------------------------------------------------------------- 气动元件 */

interface Linear {
  group: Group
  /** 把缸体摆在 from、杆端顶到 to。缸体定长，只有活塞杆伸缩。 */
  set: (from: Vector3, to: Vector3) => void
}

/**
 * 气缸 / 阻尼器。缸体长度是**常量**，只有活塞杆在伸缩——这是液压气动件的本质。
 * 反过来（整根一起缩放）会看到缸径跟着变粗变细，是最容易被识破的一类假。
 */
function cylinderActuator(opts: {
  barrelLen: number
  barrelR: number
  rodR: number
  barrelMat: Material
  rodMat: Material
}): Linear {
  const group = new Group()
  // 局部 +Y 从 0 到 barrelLen：缸体、底部耳环、活塞杆依次向上
  const barrel = new Mesh(
    new CylinderGeometry(opts.barrelR, opts.barrelR, opts.barrelLen, 18),
    opts.barrelMat,
  )
  barrel.position.y = opts.barrelLen / 2
  barrel.castShadow = true
  const rod = new Mesh(new CylinderGeometry(opts.rodR, opts.rodR, 1, 12), opts.rodMat)
  const foot = new Mesh(new CylinderGeometry(opts.barrelR * 1.5, opts.barrelR * 1.5, 0.02, 14), opts.barrelMat)
  foot.position.y = -0.008
  const clevis = roundedBox(opts.rodR * 4.6, 0.03, opts.rodR * 3.4, opts.rodMat, 0, 0, 0, 0.006)
  // 调节旋钮：特写时能认出这是可调阻尼
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
 * 空气弹簧（气囊）。升弓的动力源。
 *
 * 用**波纹管**而不是一根光滑的圆柱：真件是 3 道波纹的橡胶气囊，
 * 波纹是它在行程中被辨认出来的唯一特征。剖掉 1/4（`thetaLength`）露出内腔与活塞，
 * 这样"充气鼓起 → 顶起下臂"才有依据——外壳会挡住一切，否则只是根黑管子。
 */
function airSpring(len: number, color: number, plateMat: Material, inner: Material): Linear {
  const group = new Group()
  const profile: Vector2[] = []
  const steps = 30
  for (let i = 0; i <= steps; i += 1) {
    const y = i / steps
    // 3 道波纹：半径在 0.082 与 0.100 之间起伏，端部收口
    const wave = 0.5 + 0.5 * Math.cos(y * Math.PI * 2 * 3)
    const mouth = Math.min(1, Math.min(y, 1 - y) * 10)
    profile.push(new Vector2(0.078 + 0.022 * wave * mouth + 0.004, y))
  }
  // 切掉 1/4（90°），切口朝相机默认机位方向
  const shell = new Mesh(
    new LatheGeometry(profile, 26, deg(18), deg(270)),
    new MeshStandardMaterial({ color, metalness: 0, roughness: 0.94, side: DoubleSide }),
  )
  shell.castShadow = true
  shell.scale.y = len
  // 内腔：稍小的暗色胆，透过切口看到的是它，不是"空壳"
  const bladder = new Mesh(new CylinderGeometry(0.062, 0.07, 1, 20, 1, true), inner)
  bladder.scale.y = len * 0.94
  bladder.position.y = len * 0.47
  const foot = new Mesh(new CylinderGeometry(0.104, 0.104, 0.022, 22), plateMat)
  foot.position.y = 0.011
  const cap = new Mesh(new CylinderGeometry(0.092, 0.092, 0.02, 22), plateMat)
  // 顶盖随行程移动，所以在 set 里改位置
  group.add(shell, bladder, foot, cap)

  const dir = new Vector3()
  return {
    group,
    set(from, to) {
      dir.subVectors(to, from)
      const l = dir.length()
      if (l < 1e-4) return
      placeAxis(group, from, to)
      shell.scale.y = l
      bladder.scale.y = l * 0.9
      bladder.position.y = l * 0.46
      cap.position.y = l
    },
  }
}

/**
 * ADD 快排阀（剖切）。三个接口：
 * 进气口 P1（接气囊）、出气口 P2（接滑板气腔）、排气口（通大气，带喷嘴）。
 *
 * 内部按实物：阀芯 + 复位弹簧 + 阀座。压差建立后阀芯被推离阀座，
 * P1 与排气口连通，气囊直排大气——这就是"受电弓迅速落下"的全部原因。
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
  // 阀体：切掉 100° 露出内腔
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
  // 排气口：朝外下方的喷嘴
  const nozzle = new Mesh(new CylinderGeometry(0.014, 0.018, 0.05, 14), bodyMat)
  nozzle.rotation.z = deg(-52)
  nozzle.position.set(0.05, 0.028, 0)
  // 三个接口的接管嘴
  const p1 = new Mesh(new CylinderGeometry(0.012, 0.012, 0.05, 12), chromeMaterial())
  p1.position.y = 0.012
  const p2 = new Mesh(new CylinderGeometry(0.011, 0.011, 0.045, 12), chromeMaterial())
  p2.rotation.z = deg(90)
  p2.position.set(-0.042, 0.115, 0)
  group.add(body, seat, spool, spring, nozzle, p1, p2)

  // 排气射流：只在 venting 时可见（半透明锥，避免粒子系统）
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
      // 阀芯开度随压差推进；排气时阀芯被顶到最上，弹簧压缩
      const open = venting ? 1 : Math.min(1, diff / 0.05)
      spool.position.y = 0.078 + 0.02 * open
      spring.scale.y = 0.034 - 0.016 * open
      ;(jet.material as MeshBasicMaterial).opacity = venting ? 0.62 : 0
    },
  }
}

/**
 * ADD 压力开关（剖切）。常开触点：有压且无压差才闭合。
 *
 * 内部三件实物：膜片、动触点（簧片）、静触点。用户要的"看不见的内部变化"
 * 就是这个闭合/断开的一瞬间——它决定了快排阀是否动作。
 */
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
  // 膜片：横在壳体中部，压力从下方顶它
  const dia = new Mesh(
    new CylinderGeometry(0.033, 0.033, 0.004, 18),
    rubberMaterial(0x3a3f44),
  )
  dia.position.y = 0.03
  // 动触点：一根悬臂簧片，被膜片顶起时与静触点分开
  const blade = new Mesh(new BoxGeometry(0.03, 0.003, 0.01), steelMaterial(0xc8ccd0))
  blade.position.set(0.012, 0.05, 0)
  const fixed = new Mesh(new BoxGeometry(0.016, 0.004, 0.01), steelMaterial(0xcf9b45))
  fixed.position.set(-0.008, 0.056, 0)
  // 两个接线端子
  for (const z of [-0.028, 0.028]) {
    const t = new Mesh(new CylinderGeometry(0.005, 0.005, 0.014, 10), chromeMaterial())
    t.position.set(-0.024, 0.072, z)
    group.add(t)
  }
  group.add(cap, dia, blade, fixed)

  return {
    group,
    set(closed) {
      // 闭合 = 簧片抬起贴住静触点；断开时落到 45° 下方
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
  /* 纪律：`metalness` 只在 0 与 1 之间选（见 rig.ts）。臂与底架是喷漆件 → 0。
     这一条是"看起来像不像"的分水岭，见文件头 §"三条看起来假的根因"。 */
  /* 臂用**喷铝漆**：metalness 0、roughness 0.46。
     原来的不锈钢（metalness 1）没有漫反射，正面照抄暗墙、顶面照抄灯带，
     屏幕上就是「黑板上贴一条白条」——这才是「两块平板」的真正来源。 */
  const armPaint = new MeshStandardMaterial({ color: 0x7f858b, metalness: 0, roughness: 0.46 })
  const armDark = paintedMaterial(0x5c6268)
  const frameMat = paintedMaterial(0x8a3a2c)
  const fitting = steelMaterial(0x9aa0a6)
  const chrome = chromeMaterial()
  const hoseMat = rubberMaterial(0x23262a)
  const carbon = new MeshStandardMaterial({ color: 0x3a3d42, metalness: 0.08, roughness: 0.66 })

  /* ---------------------------------------------------------------- 车顶 */
  const roof = new Group()
  const roofSlab = roundedBox(2.9, 0.08, 2.2, paintedMaterial(0x74797e), 0, -0.05, 0, 0.01)
  roofSlab.receiveShadow = true
  roof.add(roofSlab)
  /* 车顶不能是一块光板，也不能画成瓷砖：真车顶是几块带螺栓的盖板 + 一条线槽。
     第一版拉了 2×2 道长接缝，渲染出来像展示台的大理石纹。 */
  for (const z of [-0.82, 0.82]) {
    roof.add(roundedBox(2.2, 0.014, 0.5, paintedMaterial(0x7d8287), -0.1, -0.004, z, 0.006))
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
  // 线槽：车顶电缆从这里走，避开受电弓的转动范围
  roof.add(roundedBox(0.16, 0.03, 2.1, paintedMaterial(0x63686d), -1.2, 0.006, 0, 0.008))
  root.add(roof)

  /* ---------------------------------------------------------------- 底架 */
  /* 四只复合绝缘子撑起底架。真件是棕红釉面瓷 + 上下金属法兰，
     伞裙**薄而密**（间距小于裙厚），否则渲染出来像一圈弹簧（实测过）。 */
  const ceramic = new MeshStandardMaterial({ color: 0x6f4238, metalness: 0, roughness: 0.34 })
  const deck = new Group()
  const INS_H = 0.34
  for (const x of [-PDIM.armX, PDIM.armX]) {
    for (const z of [-0.8, 0.8]) {
      const post = new Group()
      const core = new Mesh(new CylinderGeometry(0.036, 0.036, INS_H, 16), ceramic)
      core.position.y = INS_H / 2
      core.castShadow = true
      post.add(core)
      for (let i = 0; i < 10; i += 1) {
        const skirt = new Mesh(new CylinderGeometry(0.068, 0.086, 0.013, 20), ceramic)
        skirt.position.y = 0.026 + i * 0.031
        skirt.castShadow = true
        post.add(skirt)
      }
      for (const [y, r] of [[0.009, 0.048], [INS_H - 0.009, 0.048]] as const) {
        const flange = new Mesh(new CylinderGeometry(r, r, 0.018, 16), fitting)
        flange.position.y = y
        post.add(flange)
      }
      post.position.set(x, 0, z)
      deck.add(post)
    }
  }

  /* 底架：两根纵梁 + 三根横梁 + 四角垫板 + 铰座。
     梁要有**厚度**——原来 90×100mm 的方管做 1.7m 跨距，看着像个相框。 */
  const DECK_Y = INS_H + 0.07
  parts.frame = deck
  root.add(deck)

  /* 底架在绝缘子之上的部分单独成组，跟着 DECK_Y 走 */
  const chassis = new Group()
  for (const x of [-PDIM.armX, PDIM.armX]) {
    chassis.add(roundedBox(0.1, 0.13, 1.92, frameMat, x, DECK_Y, 0, 0.008))
  }
  for (const z of [-0.8, 0, 0.8]) {
    chassis.add(roundedBox(0.98, 0.096, 0.09, frameMat, 0, DECK_Y, z, 0.008))
  }
  // 垫板：底架不是直接坐在瓷瓶顶上，中间有一块机加工垫板
  for (const x of [-PDIM.armX, PDIM.armX]) {
    for (const z of [-0.8, 0.8]) {
      chassis.add(roundedBox(0.15, 0.024, 0.15, frameMat, x, DECK_Y - 0.076, z, 0.006))
    }
  }
  /* 铰座：每根下臂一对耳板 + 一根销轴。
     耳板必须**夹在臂的两侧**（z 向），销轴横穿过去——这是"这根杆会转"的唯一视觉依据。
     第一版只放了 0.022m 厚的薄片，正对镜头时几乎是一条线，等于没画。 */
  for (const x of [-PDIM.armX, PDIM.armX]) {
    for (const dz of [-0.078, 0.078]) {
      chassis.add(roundedBox(0.034, 0.15, 0.03, armDark, x, DECK_Y + 0.055, PDIM.pivotZ + dz, 0.005))
    }
    const pin = new Mesh(new CylinderGeometry(0.028, 0.028, 0.2, 14), fitting)
    pin.rotation.z = Math.PI / 2
    pin.position.set(x, PDIM.pivotY, PDIM.pivotZ)
    chassis.add(pin)
  }
  deck.add(chassis)

  /* -------------------------------------------------------------- 控制箱 */
  /* 电气调试在这台设备上唯一能看见的"电气"就在这里：升弓指令进来、电磁阀动作、
     压力建立。气路断了弓就起不来，所以它必须出现在画面里。 */
  const boxX = -0.44
  const boxY = DECK_Y + 0.04
  const boxZ = -0.42
  const boxW = 0.3
  const boxH = 0.22
  const boxD = 0.17
  const boxMat = paintedMaterial(0x494e54)
  const drive = new Group()
  drive.add(roundedBox(boxW, boxH, boxD, boxMat, boxX, boxY, boxZ, 0.01))
  drive.add(
    roundedBox(boxW - 0.016, 0.014, boxD - 0.016, paintedMaterial(0x3f444a), boxX, boxY + boxH / 2 + 0.007, boxZ, 0.004),
  )
  // 箱脚
  for (const dx of [-0.11, 0.11]) {
    for (const dz of [-0.06, 0.06]) {
      drive.add(roundedBox(0.03, 0.05, 0.03, boxMat, boxX + dx, boxY - boxH / 2 - 0.02, boxZ + dz, 0.004))
    }
  }

  /* 压力表：表盘用画布画，刻度才看得清；指针单独一片，绕轴转。 */
  const gaugeR = 0.058
  const gaugeZ = boxZ + boxD / 2 + 0.004
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
     挂到索引 0 会把表盘卷在圆柱侧面上，正面只剩一圈不锈钢——第一版就是这样。 */
  const dial = new Mesh(new CylinderGeometry(gaugeR, gaugeR, 0.012, 32), [
    chromeMaterial(),
    new MeshStandardMaterial({ color: 0xffffff, metalness: 0, roughness: 0.55, map: dialTex }),
    chromeMaterial(),
  ])
  dial.rotation.x = Math.PI / 2
  dial.position.set(boxX, boxY + 0.018, gaugeZ)
  drive.add(dial)
  const bezel = new Mesh(new CylinderGeometry(gaugeR + 0.01, gaugeR + 0.01, 0.018, 28), chromeMaterial())
  bezel.rotation.x = Math.PI / 2
  bezel.position.copy(dial.position)
  drive.add(bezel)
  const needlePivot = new Group()
  needlePivot.position.set(boxX, boxY + 0.018, gaugeZ + 0.012)
  needlePivot.add(roundedBox(0.005, gaugeR * 0.76, 0.003, paintedMaterial(0xb23b32), 0, gaugeR * 0.3, 0, 0.001))
  drive.add(needlePivot)
  const hub = new Mesh(new CylinderGeometry(0.007, 0.007, 0.008, 12), chromeMaterial())
  hub.rotation.x = Math.PI / 2
  hub.position.set(boxX, boxY + 0.018, gaugeZ + 0.014)
  drive.add(hub)

  /* 两个**接近开关**：升弓到位 / 落弓到位，冲着下臂。真机没有"到位指示灯"，
     状态由读数面板与标注表达（见文件头与 `ACTION-LOGIC-pantograph.md` §0）。 */
  const lampGroup = new Group()
  for (const [x, kind] of [
    [boxX + 0.085, 'rise'],
    [boxX - 0.085, 'low'],
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
    probe.position.set(x, boxY - 0.055, gaugeZ + 0.01)
    probe.userData.kind = kind
    lampGroup.add(probe)
  }
  drive.add(lampGroup)
  parts.lamp = lampGroup

  // 总风管：从车体上来接到箱后
  drive.add(
    hose(
      [
        new Vector3(boxX - 0.05, boxY - boxH / 2, boxZ - boxD / 2 + 0.01),
        new Vector3(boxX - 0.07, 0.24, -0.7),
        new Vector3(boxX - 0.01, 0.1, -0.86),
        new Vector3(boxX + 0.06, 0.04, -0.95),
      ],
      0.011,
      hoseMat,
    ),
  )
  parts.drive = drive
  root.add(drive)

  /* ---------------------------------------------------------------- 臂 */
  /* 两根下臂 + 两根上臂，各自成组：组内局部 +Y 沿杆轴、局部 X 贴世界 X。
     这样横撑、软管支架、耳板都能按设计方向挂上去，不会因为滚转翻面。 */
  const lowerArms = [new Group(), new Group()]
  const upperArms = [new Group(), new Group()]
  /* 上臂装在**下臂外侧**，偏出 ARM_OUT。
     为什么必须偏：收弓时两根臂都接近水平、几乎共面，同平面会直接穿插
     （2026-11-10 落弓位截图里，四根臂在中间拧成一团）。
     实机也是这个构造——上臂的铰点在下臂外侧的伸出耳板上。 */
  const ARM_OUT = 0.12
  const arms = new Group()

  for (const g of [...lowerArms, ...upperArms]) arms.add(g)

  const buildLower = (g: Group, side: 1 | -1): void => {
    g.add(boxBeam(PDIM.lower, 0.15, 0.195, 0.095, 0.13, armPaint))
    /* 中段拼接板 + 螺栓。真机的下臂由两段箱体拼接（运输与更换滑板时要拆开），
       这一块是**最好认的比例线索**：没有它，一根 1.8m 长的等截面光板
       在屏幕上分不出是 1m 还是 3m；有了它，人眼立刻有尺子。 */
    g.add(roundedBox(0.168, 0.3, 0.212, armPaint, 0, PDIM.lower * 0.46, 0, 0.008))
    for (const bx of [-0.086, 0.086]) {
      for (const by of [-0.1, 0, 0.1]) {
        const bolt = new Mesh(new CylinderGeometry(0.009, 0.009, 0.012, 8), fitting)
        bolt.rotation.z = Math.PI / 2
        bolt.position.set(bx, PDIM.lower * 0.46 + by, 0)
        g.add(bolt)
      }
    }
    /* 肘部：不是一块黑方块，而是**两块耳板夹一根销轴**。
       关节是判断"这台设备会不会动"的唯一线索，做成实心块等于把关节藏起来。 */
    for (const bx of [-0.062, 0.062]) {
      g.add(roundedBox(0.02, 0.15, 0.135, armPaint, bx, PDIM.lower - 0.05, 0, 0.006))
    }
    const pin = new Mesh(new CylinderGeometry(0.026, 0.026, 0.16, 14), fitting)
    pin.rotation.z = Math.PI / 2
    pin.position.set(0, PDIM.lower - 0.05, 0)
    g.add(pin)
    /* 外侧伸出耳板 + 销：上臂挂在这里，所以上臂的 X 也偏出 ARM_OUT。
       少了这块板，上臂就是"悬在梁旁边"的，接头处会露一条缝。 */
    g.add(roundedBox(0.026, 0.17, 0.12, armPaint, side * 0.075, PDIM.lower - 0.05, 0, 0.006))
    const outPin = new Mesh(new CylinderGeometry(0.024, 0.024, 0.09, 12), fitting)
    outPin.rotation.z = Math.PI / 2
    outPin.position.set(side * (ARM_OUT - 0.02), PDIM.lower - 0.05, 0)
    g.add(outPin)
    // 气囊 / 阻尼器的挂点耳板
    g.add(roundedBox(0.06, 0.07, 0.05, armDark, 0, PDIM.lower * 0.32, -0.1, 0.008))
    g.add(roundedBox(0.05, 0.06, 0.045, armDark, 0, PDIM.lower * 0.6, -0.09, 0.007))
    // 铰点轴套
    const boss = new Mesh(new CylinderGeometry(0.045, 0.045, 0.14, 16), armDark)
    boss.rotation.z = Math.PI / 2
    boss.position.y = 0.02
    g.add(boss)
  }

  const buildUpper = (g: Group): void => {
    g.add(boxBeam(PDIM.upper, 0.11, 0.145, 0.068, 0.09, armPaint))
    // 两道抱箍：上臂上挂着气管与配重，抱箍是它们唯一的安装面
    for (const f of [0.34, 0.62]) {
      g.add(roundedBox(0.124, 0.022, 0.158, armDark, 0, PDIM.upper * f, 0, 0.006))
    }
    // 头部托架：与弓头横梁销接
    g.add(roundedBox(0.1, 0.11, 0.1, armDark, 0, PDIM.upper - 0.04, 0, 0.01))
    // 沿上臂走的气管：快排阀 → 弓头滑板气腔（ADD 的信号通道）
    g.add(
      hose(
        [
          new Vector3(0.03, 0.04, 0.085),
          new Vector3(0.05, PDIM.upper * 0.35, 0.09),
          new Vector3(0.045, PDIM.upper * 0.72, 0.085),
          new Vector3(0.02, PDIM.upper - 0.02, 0.06),
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

  // 下臂之间 / 上臂之间的横向联结：没有它，左右两片臂像两块独立的板
  const braceLow = roundedBox(0.92, 0.05, 0.06, armDark, 0, 0, 0, 0.008)
  const braceUp = roundedBox(1.14, 0.042, 0.05, armDark, 0, 0, 0, 0.007)
  arms.add(braceLow, braceUp)
  parts.arms = arms
  root.add(arms)

  /* ------------------------------------------------------- 气囊 / 阻尼器 */
  const plateMat = paintedMaterial(0x4a5058)
  const innerMat = rubberMaterial(0x2a2e33)
  const bags = [
    airSpring(0.2, 0x3a3f45, plateMat, innerMat),
    airSpring(0.2, 0x3a3f45, plateMat, innerMat),
  ]
  const dampers = [0, 1].map(() =>
    cylinderActuator({
      barrelLen: 0.34,
      barrelR: 0.03,
      rodR: 0.013,
      barrelMat: paintedMaterial(0x555b62),
      rodMat: chrome,
    }),
  )
  const valve = quickReleaseValve()
  const switchBox = pressureSwitch()

  const driveMech = new Group()
  driveMech.add(bags[0].group, bags[1].group, dampers[0].group, dampers[1].group)
  driveMech.add(valve.group, switchBox.group)
  /* 阀与开关装在底架后侧的支架上（真机在气路控制箱旁）。位置固定，直接给世界坐标。
     **放在 +X 侧**：默认机位在 +X+Z，放远侧等于把要讲解的件藏到设备背面。 */
  /* 阀与开关挂在底架**外侧**的悬臂上，不在臂的摆动平面内。
     第一版放在 x=0.36：默认机位在 +X，近侧那根臂把它们整个挡住，
     讲解用的两个件等于没画（截图里只看得到两个标签浮在臂上）。 */
  driveMech.add(roundedBox(0.42, 0.014, 0.2, paintedMaterial(0x3f444a), 0.68, DECK_Y + 0.06, -0.3, 0.005))
  driveMech.add(roundedBox(0.1, 0.05, 0.05, paintedMaterial(0x3f444a), 0.5, DECK_Y + 0.02, -0.3, 0.006))
  valve.group.position.set(0.78, DECK_Y + 0.07, -0.3)
  valve.group.rotation.z = deg(-6)
  switchBox.group.position.set(0.6, DECK_Y + 0.07, -0.3)
  parts.drive2 = driveMech
  root.add(driveMech)

  /* ---------------------------------------------------------------- 弓头 */
  /* 弓头是一个**矩形框**：两根碳滑板 + 两端端板 + 中间托架 + 四条羊角。
     弓角必须**向下向外**弯——朝上等于把导流面翻了个面（2026-11-10 已改过一次）。 */
  const head = new Group()
  const STRIP_HALF = PDIM.stripLen / 2
  /* 弓头做成**两套独立的滑板组件**，不是一个大方框：
     每根滑板有自己的托架，两者之间只由端板与两处支撑座连系。
     第一版把中间填满（三处 0.28m 深的支撑座），渲染出来是个"抽屉"。 */
  // 弓头横梁：上臂顶端的销接梁，也是悬挂弹簧的上座
  head.add(roundedBox(1.24, 0.05, 0.1, armDark, 0, 0.01, 0, 0.009))
  // 铝托架（两根，沿 X）：碳滑板坐在它上面
  for (const z of [-0.1, 0.1]) {
    head.add(roundedBox(STRIP_HALF + 0.02, 0.026, 0.05, paintedMaterial(0x9ba1a7), 0, 0.076, z, 0.006))
  }
  // 端板：把两根滑板连成闭合框，羊角从这里接出去
  for (const x of [-STRIP_HALF, STRIP_HALF]) {
    head.add(roundedBox(0.026, 0.062, 0.25, armDark, x, 0.075, 0, 0.007))
  }
  // 两处支撑座（不是三处：中间那块把两根滑板之间的空隙填死了）
  for (const x of [-0.52, 0.52]) {
    head.add(roundedBox(0.05, 0.03, 0.2, armDark, x, 0.046, 0, 0.005))
  }
  // 碳滑板：整根 / 破裂后的两截（ADD 工况切换显隐）
  const stripWhole = new Mesh(new BoxGeometry(PDIM.stripLen, 0.05, 0.062), carbon)
  stripWhole.position.set(0, 0.11, 0.1)
  stripWhole.castShadow = true
  head.add(stripWhole)
  const stripBack = new Mesh(new BoxGeometry(PDIM.stripLen, 0.05, 0.062), carbon)
  stripBack.position.set(0, 0.11, -0.1)
  stripBack.castShadow = true
  head.add(stripBack)
  const halves: Mesh[] = []
  for (const sign of [-1, 1]) {
    const half = new Mesh(new BoxGeometry(STRIP_HALF - 0.02, 0.05, 0.062), carbon)
    half.position.set(sign * (STRIP_HALF / 2 + 0.01), 0.11, 0.1)
    half.userData.sign = sign
    half.visible = false
    halves.push(half)
    head.add(half)
  }
  // 磨耗到限线：滑板侧面一道浅槽，磨到这条线就要换
  for (const z of [-0.1, 0.1]) {
    head.add(roundedBox(STRIP_HALF * 1.96, 0.005, 0.004, paintedMaterial(0xd8d2c4), 0, 0.098, z + 0.032, 0.001))
  }
  /* 弓角：四条，每根滑板两端各一条，**向下向外**弯。
     材质用喷铝而不是镀铬——镀铬在浅底上会炸成一根白线（这个尺寸下尤其明显）。 */
  const hornMat = paintedMaterial(0x9aa1a8)
  for (const sign of [-1, 1]) {
    for (const z of [-0.1, 0.1]) {
      const curve = new CatmullRomCurve3([
        new Vector3(sign * (STRIP_HALF - 0.01), 0.118, z),
        new Vector3(sign * (STRIP_HALF + 0.075), 0.105, z),
        new Vector3(sign * (PDIM.headHalf - 0.015), 0.028, z),
        new Vector3(sign * PDIM.headHalf, -0.062, z),
      ])
      const horn = new Mesh(new TubeGeometry(curve, 26, 0.0145, 9, false), hornMat)
      horn.castShadow = true
      head.add(horn)
    }
  }
  parts.head = head
  root.add(head)

  /* ------------------------------------------------------------ 弓头悬挂 */
  /* 弓头不是焊在臂上的，它坐在两根弹簧上。这一条是"接触压力"能存在的前提：
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
  /* 线沿 **Z**（车行方向），滑板横在它下面。画成沿 X 就正好与滑板平行——
     行内人一眼能看出错（第一版错在这里）。 */
  const wireMat = new MeshStandardMaterial({ color: 0x33352f, metalness: 0.12, roughness: 0.74 })
  const wireGroup = new Group()
  const wire = new Mesh(new CylinderGeometry(0.012, 0.012, 9, 10), wireMat)
  wire.rotation.x = Math.PI / 2
  wire.position.set(0, WIRE_Y + 0.008, HEAD_Z - 2.2)
  wireGroup.add(wire)
  /* 吊弦：只画两根、拉远到 -3.6 / +3.2，并且做成很细的浅色线。
     第一版放在弓头两侧 1m 长，投影里读成"第二根接触线"，把弓头压住了。 */
  for (const z of [-3.6, 3.2]) {
    const dropper = new Mesh(new CylinderGeometry(0.003, 0.003, 0.85, 6), wireMat)
    dropper.position.set(0, WIRE_Y + 0.42, z)
    wireGroup.add(dropper)
  }
  root.add(wireGroup)

  /* 标注锚点：只标"看不见内部变化"或"认不出是什么"的件。
     装在人一眼就认识的件上（底架、臂）反而是噪音。
     坐标在 `annotations()` 里实时算——弓头会升到 2.9m，写死的高度一出厂就错。 */
  const annots = [
    { id: 'strip', text: '碳滑板', note: '破裂 → ADD' },
    { id: 'horn', text: '弓角', note: undefined },
    { id: 'bag', text: '气囊', note: '充气顶起下臂' },
    { id: 'valve', text: '快排阀', note: 'ADD 时直排大气' },
    { id: 'switch', text: '压力开关', note: '常开触点' },
  ] as const

  /* ---------------------------------------------------------------- 机构 */
  const pivots: Vector3[] = []
  for (const side of [-1, 1]) {
    pivots.push(new Vector3(side * PDIM.armX, PDIM.pivotY, PDIM.pivotZ))
  }
  const bagBase = [
    new Vector3(-PDIM.armX, 0.05, 0.26),
    new Vector3(PDIM.armX, 0.05, 0.26),
  ]
  const dmpBase = [
    new Vector3(-PDIM.armX, 0.14, 0.14),
    new Vector3(PDIM.armX, 0.14, 0.14),
  ]

  const p1 = [new Vector3(), new Vector3()]
  const p2 = [new Vector3(), new Vector3()]
  const attach = new Vector3()
  const outA = new Vector3()
  const outB = new Vector3()
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
      p1[i].set(pivots[i].x, pivots[i].y + PDIM.lower * Math.sin(a1), pivots[i].z - PDIM.lower * Math.cos(a1))
      p2[i].set(
        pivots[i].x,
        p1[i].y + PDIM.upper * Math.sin(a2),
        p1[i].z + PDIM.upper * Math.cos(a2),
      )
      placeAxis(lowerArms[i], pivots[i], p1[i])
      outA.copy(p1[i]).setX(p1[i].x + (i === 0 ? -ARM_OUT : ARM_OUT))
      outB.copy(p2[i]).setX(p2[i].x + (i === 0 ? -ARM_OUT : ARM_OUT))
      placeAxis(upperArms[i], outA, outB)
    }

    /* 横撑跟着两根臂的中点走。它们是**横跨左右**的联结件，
       所以只给位置与绕 Z 的 90°（局部 +Y 转到世界 X），不参与臂的滚转。 */
    const midLowY = (pivots[0].y + p1[0].y) / 2
    const midLowZ = (pivots[0].z + p1[0].z) / 2
    const midUpY = (p1[0].y + p2[0].y) / 2
    const midUpZ = (p1[0].z + p2[0].z) / 2
    braceLow.position.set(0, midLowY, midLowZ)
    braceUp.position.set(0, midUpY, midUpZ)

    /* 气囊顶在下臂 32% 处、阻尼器挂在 60% 处。挂点都在下臂上随臂转，
       底座固定，长度随两点距离变——这就是"推起来"与"限速"两个动作的全部。 */
    for (let i = 0; i < 2; i += 1) {
      bags[i].set(bagBase[i], onLower(attach, i, 0.32, a1))
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

    /* ---------------- 气路 / ADD ---------------- */
    const air = airState(t, mode)
    needlePivot.rotation.z = Math.PI * 0.75 - (air.bag / 0.8) * Math.PI * 1.5
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

    /* 段位名直接用气路模块的说法：画面、读数、判据共用一句话 */
    void airPhase
  }

  const framingAt = (t: number): { target: [number, number, number]; distance: number } => {
    const p = travel(t, mode)
    return { target: [0, 0.5 + 1.05 * p, 0.02], distance: 3.3 + 2.9 * p }
  }

  setT(0)

  return {
    root,
    setT,
    setMode: (next: string) => {
      mode = next === 'add' ? 'add' : 'normal'
      setT(lastT)
    },
    parts,
    phase: (t: number) => airPhase(t, mode),
    framing: { target: [0, 1.55, 0.02], distance: 6.3 },
    /* 1.3：环境太暗时，箱形梁朝下的那个面会塌成一条深灰，
       而朝上的面接近高光——同一根梁在屏幕上读成"两条平行导轨"，
       这正是"像平板"最顽固的来源（2026-11-10 实测：0.95 → 1.3 才收住）。 */
    envIntensity: 1.3,
    /* 机位抬到 17°：原来的 6° 是"贴着车顶平视"，两根臂在屏幕上叠成一条线，
       锥度和间距全被吃掉——这也是"像平板"的一部分原因。 */
    viewDir: [0.66, 0.3, 0.69],
    framingAt,
    /* 标注锚点：世界坐标，随动作实时算。DeviceScene 把点投影到屏幕，做成 HTML 标签。
       点在"件的外侧一点点"，标签就不会压住要看的那个件本身。 */
    annotations: () =>
      annots.map((a) => {
        if (a.id === 'strip') {
          return { ...a, at: new Vector3(0.66, head.position.y + 0.19, -0.1) }
        }
        if (a.id === 'horn') {
          return { ...a, at: new Vector3(PDIM.headHalf + 0.1, head.position.y + 0.02, -0.1) }
        }
        if (a.id === 'bag') {
          return { ...a, at: new Vector3(0.52, 0.24, 0.32) }
        }
        if (a.id === 'valve') {
          return { ...a, at: new Vector3(0.86, DECK_Y + 0.18, -0.3) }
        }
        return { ...a, at: new Vector3(0.6, DECK_Y + 0.16, -0.34) }
      }),
    dispose: () => {
      disposeTree(root)
      for (const tex of textures) tex.dispose()
    },
  }
}
