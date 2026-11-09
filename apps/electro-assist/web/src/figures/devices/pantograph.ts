/** 单臂受电弓：参数化几何 + 连杆机构驱动 + 气路/气缸/阻尼器。
 *
 *  ## 形体依据
 *  公开资料里单臂受电弓的通用结构：底架 + 四个复合绝缘子支撑、
 *  两根下臂由底部铰点向前上方伸出、两根平衡臂由下臂顶端折向后上方、
 *  顶端弓头带两根滑板与两端弓角。工作高度约 1.5–2.9m（相对车顶）。
 *  这些是**演示用的示意尺寸**，不代表任何车型图纸。
 *
 *  ## 为什么是双杆
 *  受电弓是左右对称的双臂机构，画成单杆会立刻失去辨识度。
 *  代价是动作要把两个铰点的坐标都算一遍——但杆长恒定，只有角度在变，算起来是廉价的。
 *
 *  ## 与车门的关键区别
 *  车门是「先退后滑」的平移，受电弓是**纯转动**：两根杆各绕一个铰点转，杆长不变。
 *  所以这里用 `placeStrut` 摆两端点，绝不对杆做缩放——缩放出来的杆会变细，一眼假。
 *
 *  ## 三个「为什么能动」的答案
 *  上一版只有杆在转，看不出是谁在推它。这一版把力与限速都摆出来：
 *  - **气缸**（每根下臂一支）：供气 → 活塞杆伸出 → 顶起下臂。这是升弓的动力源
 *  - **阻尼器**（每根下臂一支）：降弓时不主动出力，只把下降速度限成近匀速。
 *    所以降弓比升弓快，但绝不是自由落体——这是现场判断阻尼器失效的直接依据
 *  - **接触压力**：不是画出来的数字。弓头坐在两根悬挂弹簧上，弓臂继续上行时
 *    弓头被接触线挡住、弹簧被压下去，压缩量换算成压力
 */
import {
  CanvasTexture,
  CatmullRomCurve3,
  CylinderGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  SRGBColorSpace,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three'

import type { DeviceRig } from './rig'
import {
  chromeMaterial,
  disposeTree,
  lampMaterial,
  paintedMaterial,
  placeStrut,
  roundedBox,
  rubberMaterial,
  seg,
  steelMaterial,
  strut,
  withEdges,
} from './rig'

/** 示意尺寸（米）。改这里就能整体缩放。 */
const DIM = {
  /** 下臂长度 */
  lower: 1.55,
  /** 上臂长度 */
  upper: 1.35,
  /** 底架顶面高度（绝缘子顶） */
  deck: 0.32,
  /** 主铰点相对中心的前后位置 */
  pivotZ: 0.72,
  /** 左右两臂的间距半径 */
  armX: 0.45,
  /** 弓头滑板半长 */
  headHalf: 0.98,
}

const LAMP_OFF = 0x8a8f96
const LAMP_OK = 0x2f9e6a

/* ---- 弓头悬挂与接触线 -------------------------------------------------------
   这几个数彼此锁定，改一个就要改全部（DeviceDemoView 里有一份同样的算式）：
   - 弓臂尖端（p2）到弓头底面的自由间隙 0.09
   - 弓头本体中心到底面 0.0275、到滑板顶面 0.0855
   - 接触线高度 = 满行程时的自由顶面 − 设计压缩量
   ------------------------------------------------------------------------- */
const GAP_FREE = 0.07
const MAX_COMP = 0.055
const HEAD_BASE = 0.0275
const HEAD_TOP = 0.0855
/** 满行程时 p2.y = 2.817，自由顶面 2.817+0.07+0.0855 = 2.9725，减 0.055 → 2.9175 */
const WIRE_Y = 2.9175

const deg = (value: number): number => (value * Math.PI) / 180

/** 时间轴（与 DeviceDemoView 的读数同源，改一处要改两处）。 */
const T = {
  airOn: 0.04,
  airFull: 0.12,
  raise0: 0.12,
  raise1: 0.54,
  press1: 0.68,
  hold1: 0.78,
  lower0: 0.8,
  lower1: 0.94,
}

interface Piston {
  group: Group
  /** 把缸体摆在 from、活塞杆顶到 to。杆长随两点距离自动伸缩。 */
  set: (from: Vector3, to: Vector3) => void
}

/**
 * 气缸 / 阻尼器共用的执行元件。
 *
 * 缸体长度是**常量**，只有活塞杆在伸缩——这是液压气动件的本质。
 * 反过来（整根一起缩放）会看到缸径跟着变粗变细，是最容易被识破的一类假。
 */
function piston(opts: {
  barrelLen: number
  barrelR: number
  rodR: number
  barrelMat: MeshStandardMaterial
  rodMat: MeshStandardMaterial
}): Piston {
  const group = new Group()
  const barrel = new Mesh(
    new CylinderGeometry(opts.barrelR, opts.barrelR, opts.barrelLen, 18),
    opts.barrelMat,
  )
  const rod = new Mesh(new CylinderGeometry(opts.rodR, opts.rodR, 1, 12), opts.rodMat)
  // 底座法兰 + 杆端耳环：没有这两个件，缸体就是一根悬空的管子
  const foot = roundedBox(opts.barrelR * 2.6, 0.024, opts.barrelR * 2.4, opts.barrelMat, 0, 0.008, 0, 0.005)
  const clevis = roundedBox(opts.rodR * 4.4, 0.028, opts.rodR * 3.2, opts.rodMat, 0, 0, 0, 0.005)
  group.add(barrel, rod, foot, clevis)

  const UP = new Vector3(0, 1, 0)
  const dir = new Vector3()
  return {
    group,
    set(from, to) {
      dir.subVectors(to, from)
      const len = dir.length()
      if (len < 1e-4) return
      group.position.copy(from)
      group.quaternion.setFromUnitVectors(UP, dir.clone().divideScalar(len))
      barrel.position.y = opts.barrelLen / 2
      const rodLen = Math.max(len - opts.barrelLen, 0.004)
      rod.scale.y = rodLen
      rod.position.y = opts.barrelLen + rodLen / 2
      clevis.position.y = len
    },
  }
}

interface Airbag {
  group: Group
  set: (from: Vector3, to: Vector3) => void
}

/**
 * 气囊（空气弹簧）。升弓的动力源。
 *
 * 为什么不用气缸：气囊的长度变化是**压缩/鼓胀**，直接缩放 Y 就是对的；
 * 气缸的缸体必须定长、只有活塞杆伸缩，缩放整根会看到缸径一起变粗——那是假的。
 * 而且气囊短而粗，在底架这种狭窄空间里看得见；同行程的细气缸藏在梁下面，
 * 屏幕上什么也看不到。
 */
function airbag(mat: MeshStandardMaterial, plateMat: MeshStandardMaterial): Airbag {
  const group = new Group()
  /* 侧形：中段鼓出、两端收口，再叠三道浅肋。气囊受压时就是这个形状。
     单位高度做成 1，用的时候按实测长度缩放 Y。 */
  const profile: Vector2[] = []
  for (let i = 0; i <= 26; i += 1) {
    const y = i / 26
    const bulge = Math.sin(Math.PI * y)
    const rib = 0.005 * Math.sin(y * Math.PI * 2 * 3)
    profile.push(new Vector2(0.068 + 0.032 * bulge + rib, y))
  }
  const body = new Mesh(new LatheGeometry(profile, 24), mat)
  body.castShadow = true
  const foot = roundedBox(0.2, 0.02, 0.2, plateMat, 0, 0.01, 0, 0.006)
  const cap = roundedBox(0.18, 0.018, 0.18, plateMat, 0, 0, 0, 0.006)
  group.add(body, foot, cap)

  const UP = new Vector3(0, 1, 0)
  const dir = new Vector3()
  return {
    group,
    set(from, to) {
      dir.subVectors(to, from)
      const len = dir.length()
      if (len < 1e-4) return
      group.position.copy(from)
      group.quaternion.setFromUnitVectors(UP, dir.clone().divideScalar(len))
      body.scale.y = len
      cap.position.y = len
    },
  }
}

/** 软管：走 Catmull-Rom，管子本来就是软的，折线反而不像。 */
function hose(points: Vector3[], radius: number, material: MeshStandardMaterial): Mesh {
  const curve = new CatmullRomCurve3(points, false, 'catmullrom', 0.4)
  const mesh = new Mesh(new TubeGeometry(curve, 52, radius, 7, false), material)
  mesh.castShadow = true
  return mesh
}

export function buildPantograph(): DeviceRig {
  const root = new Group()
  const parts: Record<string, Object3D> = {}

  /* ---------------------------------------------------------------- 底架 */
  /* 车顶板：绝缘子总得有东西可坐。少了它，整台设备悬在半空，
     阴影也无处落脚——这是渲染里最容易被察觉、也最容易被忽略的一处。 */
  const roof = new Group()
  const roofSlab = roundedBox(3.4, 0.1, 2.3, paintedMaterial(0x33373b), 0, -0.06, 0, 0.012)
  roofSlab.receiveShadow = true
  roof.add(roofSlab)
  // 顶面两道纵向筋，免得是一整块光板
  for (const z of [-0.55, 0.55]) {
    roof.add(roundedBox(3.2, 0.014, 0.05, paintedMaterial(0x2a2e32), 0, 0.0, z, 0.004))
  }
  root.add(roof)

  const frameMat = paintedMaterial(0x53575c)
  const deck = new Group()

  // 两根纵梁
  deck.add(
    roundedBox(0.09, 0.1, 1.72, frameMat, -0.62, DIM.deck, 0, 0.008),
    roundedBox(0.09, 0.1, 1.72, frameMat, 0.62, DIM.deck, 0, 0.008),
  )
  // 三根横梁
  for (const z of [-0.72, 0, 0.72]) {
    deck.add(roundedBox(1.28, 0.08, 0.09, frameMat, 0, DIM.deck, z, 0.008))
  }

  /* 复合绝缘子：真实件是棕红釉面陶瓷，一串伞裙。
     它是受电弓最好认的特征之一，颜色不能省成灰。 */
  const ceramic = new MeshStandardMaterial({
    color: 0x7d4634,
    metalness: 0,
    roughness: 0.28,
  })
  for (const x of [-0.62, 0.62]) {
    for (const z of [-0.78, 0.78]) {
      const post = new Group()
      const core = new Mesh(new CylinderGeometry(0.058, 0.058, 0.3, 16), ceramic)
      core.position.y = 0.15
      core.castShadow = true
      post.add(core)
      // 三道伞裙
      for (const y of [0.06, 0.15, 0.24]) {
        const skirt = new Mesh(new CylinderGeometry(0.105, 0.105, 0.032, 20), ceramic)
        skirt.position.y = y
        skirt.castShadow = true
        post.add(skirt)
      }
      post.position.set(x, 0, z)
      deck.add(post)
    }
  }

  parts.frame = deck
  root.add(deck)

  /* ------------------------------------------------------------ 气路与阀 */
  /* 控制箱摆在底架左后：里面是过滤减压阀与电磁阀，前脸一块压力表。
     气路是「电气调试」在这台设备上唯一能看见的电气部分——升弓指令进来、
     电磁阀动作、压力建立，这条链断了弓就起不来。 */
  const boxX = -0.55
  const boxY = DIM.deck + 0.1
  const boxZ = -0.45
  const boxW = 0.32
  const boxH = 0.2
  const boxD = 0.16
  const boxMat = paintedMaterial(0x494e54)
  const box = new Group()
  box.add(roundedBox(boxW, boxH, boxD, boxMat, boxX, boxY, boxZ, 0.01))
  // 上盖略小一圈，形成一道翻边
  box.add(roundedBox(boxW - 0.02, 0.016, boxD - 0.02, paintedMaterial(0x474d54), boxX, boxY + boxH / 2 + 0.008, boxZ, 0.005))

  /* 压力表：表盘用画布画，刻度才看得清；指针单独一片，绕轴转。 */
  const gaugeR = 0.062
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
    // 刻度：0 → 0.8 MPa，-135° 到 +135°
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
  const dialMaterial = new MeshStandardMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.55,
    map: dialTex,
  })
  /* 材质组顺序是 [侧面, 顶盖, 底盖]。表盘必须挂在**顶盖**（索引 1）上，
     挂到索引 0 会把表盘卷在圆柱侧面上，正面只剩一圈不锈钢——第一版就是这样。 */
  const dial = new Mesh(new CylinderGeometry(gaugeR, gaugeR, 0.014, 32), [
    chromeMaterial(),
    dialMaterial,
    chromeMaterial(),
  ])
  // 圆柱的顶面朝 +Y，转成朝 +Z 才能被相机看见
  dial.rotation.x = Math.PI / 2
  dial.position.set(boxX, boxY + 0.02, gaugeZ)
  box.add(dial)

  const gaugeBezel = new Mesh(new CylinderGeometry(gaugeR + 0.012, gaugeR + 0.012, 0.022, 28), chromeMaterial())
  gaugeBezel.rotation.x = Math.PI / 2
  gaugeBezel.position.set(boxX, boxY + 0.02, gaugeZ)
  box.add(gaugeBezel)

  const needlePivot = new Group()
  needlePivot.position.set(boxX, boxY + 0.02, gaugeZ + 0.014)
  const needle = roundedBox(0.006, gaugeR * 0.78, 0.004, paintedMaterial(0xb23b32), 0, gaugeR * 0.32, 0, 0.001)
  needlePivot.add(needle)
  box.add(needlePivot)
  // 指针轴帽
  const hub = new Mesh(new CylinderGeometry(0.008, 0.008, 0.01, 12), chromeMaterial())
  hub.rotation.x = Math.PI / 2
  hub.position.set(boxX, boxY + 0.02, gaugeZ + 0.016)
  box.add(hub)

  /* 两个指示：升弓到位（绿）与落弓到位（绿）。
     真机是两个独立的接近开关，不是一盏灯两头用——降弓过程中两盏都不亮，
     正好可以拿来讲「信号丢失」的判定。 */
  const lampGroup = new Group()
  const lampRise = new Mesh(new SphereGeometry(0.03, 16, 12), lampMaterial(LAMP_OFF))
  lampRise.position.set(boxX + 0.09, boxY - 0.05, gaugeZ + 0.012)
  const lampLow = new Mesh(new SphereGeometry(0.03, 16, 12), lampMaterial(LAMP_OFF))
  lampLow.position.set(boxX - 0.09, boxY - 0.05, gaugeZ + 0.012)
  for (const [lamp, label] of [
    [lampRise, 'rise'],
    [lampLow, 'low'],
  ] as const) {
    const bezel = new Mesh(new CylinderGeometry(0.036, 0.036, 0.016, 18), paintedMaterial(0x24282d))
    bezel.rotation.x = Math.PI / 2
    bezel.position.set(lamp.position.x, lamp.position.y, lamp.position.z - 0.014)
    lampGroup.add(bezel)
    lamp.userData.kind = label
    lampGroup.add(lamp)
  }

  const drive = new Group()
  drive.add(box)
  drive.add(lampGroup)

  /* 软管：控制箱 → 两支气缸。走线照现场，贴着底架走，不横穿机构。 */
  const hoseMat = rubberMaterial(0x23262a)
  for (const sx of [-1, 1]) {
    drive.add(
      hose(
        [
          new Vector3(boxX + sx * 0.1, boxY - boxH / 2 + 0.01, boxZ + boxD / 2 - 0.02),
          new Vector3(boxX + sx * 0.16, boxY - 0.16, boxZ + 0.14),
          new Vector3(sx * 0.28, 0.22, 0.02),
          new Vector3(sx * 0.42, 0.2, 0.16),
          new Vector3(sx * 0.45, 0.185, 0.215),
        ],
        0.0085,
        hoseMat,
      ),
    )
  }
  // 总风管：从车体上来，接到控制箱后侧
  drive.add(
    hose(
      [
        new Vector3(boxX - 0.06, boxY - boxH / 2, boxZ - boxD / 2 + 0.01),
        new Vector3(boxX - 0.08, 0.28, -0.68),
        new Vector3(boxX - 0.02, 0.16, -0.84),
        new Vector3(boxX + 0.04, 0.05, -0.94),
      ],
      0.011,
      hoseMat,
    ),
  )

  parts.drive = drive
  root.add(drive)

  /* ---------------------------------------------------------------- 杆件 */
  const armMat = steelMaterial(0x8f9499)
  const tieMat = chromeMaterial()

  /* 臂是**双管桁架**，不是一根圆管。
     真实受电弓的下臂由两根平行钢管 + 腹杆焊成，截面是扁的——单管看着像水管。
     两根管沿臂的垂直方向错开 ARM_GAP，中间三段腹杆。 */
  const ARM_GAP = 0.075
  const braceMat = paintedMaterial(0x8d9297)

  interface ArmPair {
    a: Mesh
    b: Mesh
    webs: Mesh[]
  }
  const makeArm = (len: number, r: number): ArmPair => ({
    a: strut(len, r, armMat),
    b: strut(len, r, armMat),
    webs: [0, 1, 2].map(() => strut(ARM_GAP, r * 0.62, braceMat)),
  })

  const lowerL = makeArm(DIM.lower, 0.046)
  const lowerR = makeArm(DIM.lower, 0.046)
  const upperL = makeArm(DIM.upper, 0.04)
  const upperR = makeArm(DIM.upper, 0.04)

  // 下臂中部的横撑，两根臂之间的连接件
  const braceLow = roundedBox(1.02, 0.036, 0.04, braceMat, 0, 0, 0, 0.007)
  const braceUp = roundedBox(1.02, 0.032, 0.036, braceMat, 0, 0, 0, 0.007)

  const arms = new Group()
  for (const pair of [lowerL, lowerR, upperL, upperR]) {
    arms.add(pair.a, pair.b, ...pair.webs)
  }
  arms.add(braceLow, braceUp)
  parts.arms = arms
  root.add(arms)

  /* 摆一对平行管 + 三段腹杆。offset 是臂的垂直方向（在 YZ 平面内）。 */
  const _f2 = new Vector3()
  const _t2 = new Vector3()
  const _pA = new Vector3()
  const _pB = new Vector3()
  const placeArm = (
    pair: ArmPair,
    from: Vector3,
    to: Vector3,
    perpX: number,
    perpY: number,
    perpZ: number,
  ): void => {
    placeStrut(pair.a, from, to)
    _f2.set(from.x + perpX, from.y + perpY, from.z + perpZ)
    _t2.set(to.x + perpX, to.y + perpY, to.z + perpZ)
    placeStrut(pair.b, _f2, _t2)
    for (let i = 0; i < pair.webs.length; i += 1) {
      const f = 0.2 + i * 0.3
      _pA.lerpVectors(from, to, f)
      _pB.set(_pA.x + perpX, _pA.y + perpY, _pA.z + perpZ)
      placeStrut(pair.webs[i], _pA, _pB)
    }
  }

  /* -------------------------------------------------------- 气囊 / 阻尼器 */
  /* 每根下臂一套：气囊在前（出力，把臂顶起来），阻尼器在后（限速，只管下降）。
     两个安装点都在底架上，杆端挂在**同一根下臂**的不同位置——
     装在不同臂上，两臂就会打架。 */
  const bagMat = rubberMaterial(0x1d2024)
  const plateMat = paintedMaterial(0x4a5058)
  const bagL = airbag(bagMat, plateMat)
  const bagR = airbag(bagMat, plateMat)
  const damperL = piston({ barrelLen: 0.32, barrelR: 0.032, rodR: 0.014, barrelMat: paintedMaterial(0x3b4148), rodMat: chromeMaterial() })
  const damperR = piston({ barrelLen: 0.32, barrelR: 0.032, rodR: 0.014, barrelMat: paintedMaterial(0x3b4148), rodMat: chromeMaterial() })
  const driveMech = new Group()
  driveMech.add(bagL.group, bagR.group, damperL.group, damperR.group)
  // 阻尼器调节旋钮：一个小滚花头，特写时能认出这是可调的
  for (const d of [damperL, damperR]) {
    const knob = new Mesh(new CylinderGeometry(0.018, 0.018, 0.02, 14), chromeMaterial())
    knob.position.y = 0.018
    d.group.add(knob)
  }
  parts.drive2 = driveMech
  root.add(driveMech)

  /* ---------------------------------------------------------------- 弓头 */
  const head = new Group()
  const shoeBody = withEdges(
    roundedBox(DIM.headHalf * 2, 0.055, 0.1, steelMaterial(0x9aa0a6), 0, 0, 0, 0.01),
    0.16,
  )
  head.add(shoeBody)

  // 两根滑板：真正与接触线摩擦的部分，材质偏深、粗糙
  const carbon = new MeshStandardMaterial({ color: 0x2b2d31, metalness: 0.1, roughness: 0.68 })
  for (const z of [-0.1, 0.1]) {
    head.add(roundedBox(DIM.headHalf * 1.86, 0.032, 0.05, carbon, 0, 0.042, z, 0.008))
  }
  /* 磨耗到限线：滑板侧面一道浅色槽。碳滑板磨到这条线就必须换，
     没有它，「磨耗检查」在图上无从判断。 */
  for (const z of [-0.1, 0.1]) {
    head.add(
      roundedBox(DIM.headHalf * 1.8, 0.004, 0.004, paintedMaterial(0xd8d2c4), 0, 0.03, z + 0.026, 0.001),
    )
  }
  // 弓头两端支撑
  for (const x of [-0.72, 0.72]) {
    head.add(roundedBox(0.07, 0.1, 0.24, paintedMaterial(0x5c6166), x, -0.045, 0, 0.008))
    head.add(roundedBox(0.05, 0.03, 0.2, chromeMaterial(), x, 0.005, 0, 0.006))
  }
  // 滑板支座：把两根碳滑板撑在本体上，否则滑板像贴纸
  for (const x of [-0.55, 0, 0.55]) {
    head.add(roundedBox(0.06, 0.05, 0.26, paintedMaterial(0x707579), x, 0.012, 0, 0.006))
  }

  /* 弓角：两端向上外翘的羊角，作用是接触线偏移时把它导向滑板。
     没有它，弓头就是一根光秃秃的横杆。 */
  for (const sign of [-1, 1]) {
    const horn = strut(0.24, 0.024, tieMat)
    head.add(horn)
    horn.userData.sign = sign
  }
  parts.head = head
  root.add(head)

  const horns: Mesh[] = head.children.filter((c) => c.userData.sign !== undefined) as Mesh[]

  /* ------------------------------------------------------- 弓头悬挂弹簧 */
  /* 弓头不是焊在臂上的，它坐在两根弹簧上。这一条是「接触压力」能存在的
     前提：臂继续上行，弓头被接触线挡住，弹簧被压下去，压力才建立起来。 */
  const susp = new Group()
  susp.add(roundedBox(0.66, 0.024, 0.13, paintedMaterial(0x4c525a), 0, 0, 0, 0.006))
  const springs: Mesh[] = []
  const helixPts: Vector3[] = []
  for (let k = 0; k <= 44; k += 1) {
    const a = (k / 44) * Math.PI * 2 * 4.5
    helixPts.push(new Vector3(Math.cos(a) * 0.032, (k / 44) - 0.5, Math.sin(a) * 0.032))
  }
  const helixGeo = new TubeGeometry(new CatmullRomCurve3(helixPts), 96, 0.0075, 6, false)
  for (const x of [-0.32, 0.32]) {
    const spring = new Mesh(helixGeo, chromeMaterial())
    spring.position.set(x, 0, 0)
    springs.push(spring)
    susp.add(spring)
  }
  /* 中央导向柱：弓头不是浮在臂上的，它套在这根柱子上滑动。
     少了它，弹簧再明显也解释不了「为什么弓头停在那个高度」。 */
  const guideRod = new Mesh(new CylinderGeometry(0.028, 0.028, 1, 16), chromeMaterial())
  guideRod.scale.y = 0.12
  susp.add(guideRod)
  root.add(susp)

  /* ---------------------------------------------------------------- 接触线 */
  /* 把接触线画出来，是因为「接触压力」这个判据在图上本来无处落脚：
     没有线，弓头升到头只是一个位置；有了线，才看得出「顶住了、还往上顶」。 */
  const wireGroup = new Group()
  /* 接触线要压成深色、低金属度。高金属度的细杆会照抄背景亮度，
     在浅色底上等于隐形——试过才知道，不是想当然。 */
  const wireMat = new MeshStandardMaterial({ color: 0x33352f, metalness: 0.12, roughness: 0.74 })
  /* 接触线沿 **Z**（车行方向），滑板横在它下面——两者是正交的。
     第一版我把线画成沿 X，正好和滑板平行，行内人一眼就能看出错。 */
  const HEAD_Z = 0.49
  /* 抬 9mm 坐**在**滑板上，而不是嵌进去。
     再把近端往前伸到弓头前 2m：相机在接触线下方，同一高度的近处一点投影更高，
     于是前面那段会露在弓头上方——线沿车行方向时，这是它唯一能被看见的机会。 */
  const wire = new Mesh(new CylinderGeometry(0.013, 0.013, 9.5, 10), wireMat)
  wire.rotation.x = Math.PI / 2
  wire.position.set(0, WIRE_Y + 0.009, HEAD_Z - 2.4)
  wireGroup.add(wire)
  for (const z of [-2.4, 1.7]) {
    const dropper = new Mesh(new CylinderGeometry(0.004, 0.004, 1.0, 6), wireMat)
    dropper.position.set(0, WIRE_Y + 0.51, z)
    wireGroup.add(dropper)
  }
  root.add(wireGroup)

  /* ---------------------------------------------------------------- 机构 */
  const p0L = new Vector3(-DIM.armX, DIM.deck + 0.02, DIM.pivotZ)
  const p0R = new Vector3(DIM.armX, DIM.deck + 0.02, DIM.pivotZ)
  /* 气囊底座落在底架下方的车顶面上（y≈0.03），从梁间空档里穿上来。
     为什么不放在底架上表面：落弓时下臂几乎贴在底架上，只有 3cm 净空，
     气囊会被压成一个扁饼，屏幕上看不出是什么。 */
  const bagBaseL = new Vector3(-DIM.armX, 0.03, 0.46)
  const bagBaseR = new Vector3(DIM.armX, 0.03, 0.46)
  const dmpBaseL = new Vector3(-DIM.armX, 0.07, -0.34)
  const dmpBaseR = new Vector3(DIM.armX, 0.07, -0.34)

  const p1L = new Vector3()
  const p1R = new Vector3()
  const p2 = new Vector3()

  /** 下臂上距铰点 f 比例处的点。气缸与阻尼器的杆端都挂在这条线上。 */
  const onLower = (out: Vector3, side: 1 | -1, f: number, a1: number): Vector3 =>
    out.set(
      side * DIM.armX,
      p0L.y + DIM.lower * f * Math.sin(a1),
      p0L.z - DIM.lower * f * Math.cos(a1),
    )

  const tmp = new Vector3()

  const setT = (t: number): void => {
    /* 行程 p（0=落弓、1=升到位）。分四段，因为「升」「压」「保压」「降」
       在真机上就是四个不同的物理过程，用一条曲线糊过去会把判据线索抹掉。 */
    let p = 0
    if (t >= T.raise0 && t < T.raise1) {
      p = 0.94 * seg(t, T.raise0, T.raise1)
    } else if (t >= T.raise1 && t < T.press1) {
      // 最后 6% 是「顶着接触线继续上行」——这一段才是接触压力的来源
      p = 0.94 + 0.06 * seg(t, T.raise1, T.press1)
    } else if (t >= T.press1 && t < T.lower0) {
      p = 1
    } else if (t >= T.lower0) {
      /* 降弓取**线性**而不是缓动：阻尼器给的就是近匀速下降。
         这里用 smoothstep 会看出「先慢后快再慢」，那是自由落体，不是阻尼。 */
      p = 1 - Math.min(1, Math.max(0, (t - T.lower0) / (T.lower1 - T.lower0)))
    }

    const a1 = deg(4 + (56 - 4) * p)
    const a2 = deg(10 + (62 - 10) * p)

    p1L.set(-DIM.armX, p0L.y + DIM.lower * Math.sin(a1), p0L.z - DIM.lower * Math.cos(a1))
    p1R.set(DIM.armX, p1L.y, p1L.z)

    // 弓头取左右两臂的中间高度，保证它始终水平——受电弓的弓头不跟着杆转。
    p2.set(0, p1L.y + DIM.upper * Math.sin(a2), p1L.z + DIM.upper * Math.cos(a2))

    /* 垂直方向：下臂取 (0, cos a1, sin a1)，上臂取 (0, cos a2, −sin a2)，
       都与杆轴正交。两根管沿这个方向错开，才是扁截面的桁架。 */
    const n1y = Math.cos(a1) * ARM_GAP
    const n1z = Math.sin(a1) * ARM_GAP
    const n2y = Math.cos(a2) * ARM_GAP
    const n2z = -Math.sin(a2) * ARM_GAP
    placeArm(lowerL, p0L, p1L, 0, n1y, n1z)
    placeArm(lowerR, p0R, p1R, 0, n1y, n1z)
    placeArm(upperL, p1L, p2, 0, n2y, n2z)
    placeArm(upperR, p1R, p2, 0, n2y, n2z)

    // 横撑位置随臂中段走
    braceLow.position.set(0, (p0L.y + p1L.y) / 2, (p0L.z + p1L.z) / 2)
    braceUp.position.set(0, (p1L.y + p2.y) / 2, (p1L.z + p2.z) / 2)

    /* 气囊顶在下臂 20% 处，阻尼器挂在 45% 处。
       挂点都在下臂上，随下臂一起转；底座固定，长度随两点距离变。 */
    bagL.set(bagBaseL, onLower(tmp, -1, 0.34, a1))
    bagR.set(bagBaseR, onLower(tmp, 1, 0.34, a1))
    damperL.set(dmpBaseL, onLower(tmp, -1, 0.3, a1))
    damperR.set(dmpBaseR, onLower(tmp, 1, 0.3, a1))

    /* 弓头悬挂：自由间隙 GAP_FREE，被接触线挡住后按超出量压缩。 */
    const freeTop = p2.y + GAP_FREE + HEAD_TOP
    const comp = Math.min(Math.max(freeTop - WIRE_Y, 0), MAX_COMP)
    const gap = GAP_FREE - comp
    head.position.set(p2.x, p2.y + gap + HEAD_BASE, p2.z)
    susp.position.set(p2.x, p2.y + 0.012 + (gap - 0.024) / 2, p2.z)
    // 弹簧按当前间隙缩放：长度 = gap − 0.024（两端各让出一点安装高度）
    const springLen = Math.max(gap - 0.024, 0.004)
    for (const spring of springs) spring.scale.y = springLen
    guideRod.scale.y = Math.max(gap + 0.16, 0.012)

    // 弓角：从滑板端头向外上方翘起（跟着弓头走，用局部坐标）
    for (const horn of horns) {
      const sign = horn.userData.sign as number
      const from = new Vector3(sign * DIM.headHalf, 0.02, 0)
      const to = new Vector3(sign * (DIM.headHalf + 0.11), 0.2, 0)
      placeStrut(horn, from, to)
    }

    /* ---------------- 气路与指示 ---------------- */
    let air = 0
    if (t >= T.airOn) air = 0.62 * seg(t, T.airOn, T.airFull)
    if (t >= T.lower0) air *= 1 - seg(t, T.lower0, T.lower0 + 0.05)
    // 指针：0 → 0.8 MPa 映射到 +135° → -135°
    needlePivot.rotation.z = Math.PI * 0.75 - (air / 0.8) * Math.PI * 1.5

    /* 到位信号是**两个独立的开关**：升弓到位与落弓到位，互不覆盖。
       降弓中途两盏都不亮——这正是现场判断「弓在动」的依据。 */
    const riseOk = t >= T.press1 && t < T.lower0
    const lowOk = t < T.raise0 || t >= T.lower1
    setLamp(lampRise, riseOk)
    setLamp(lampLow, lowOk)
  }

  const setLamp = (lamp: Mesh, on: boolean): void => {
    const bulb = lamp.material as MeshStandardMaterial
    const hex = on ? LAMP_OK : LAMP_OFF
    bulb.color.setHex(hex)
    bulb.emissive.setHex(hex)
    bulb.emissiveIntensity = on ? 0.95 : 0.05
  }

  const phase = (t: number): string => {
    if (t < T.airOn) return '落弓锁定'
    if (t < T.raise0) return '气路建压'
    if (t < T.raise1) return '升弓中'
    if (t < T.press1) return '接触压力建立'
    if (t < T.hold1) return '升弓到位'
    if (t < T.lower0) return '保压'
    if (t < T.lower1) return '降弓中（阻尼）'
    return '落弓到位'
  }

  setT(0)

  return {
    root,
    setT,
    parts,
    phase,
    framing: { target: [0, 1.2, 0], distance: 5.4 },
    // 浅色钣金多，环境光按场景收到 1.0，否则整机糊成一片灰
    envIntensity: 1.0,
    // 镜头跟着弓头走：收弓时贴近、升弓时拉开，两个姿态都不会缩成一点或顶出画面
    framingAt: (t: number) => {
      let p = 0
      if (t >= T.raise0 && t < T.raise1) p = 0.94 * seg(t, T.raise0, T.raise1)
      else if (t >= T.raise1 && t < T.lower0) p = 1
      else if (t >= T.lower0) p = 1 - Math.min(1, Math.max(0, (t - T.lower0) / (T.lower1 - T.lower0)))
      return {
        target: [0, 0.5 + 0.95 * p, 0],
        distance: 3.6 + 3.2 * p,
      }
    },
    dispose: () => disposeTree(root),
  }
}
