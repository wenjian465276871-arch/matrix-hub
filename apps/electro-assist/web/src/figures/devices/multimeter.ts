/** 数字万用表测电压：档位、表笔、端子、读数四件事一起动。
 *
 *  ## 这一页要讲的动作
 *  工步「测量门控器输入电压」在 2D 里只能画一根量程条，看不出**表笔往哪搭**。
 *  现场真正会错的三处，恰好都在动作里：
 *  1. **档位**：直流电压档（V⎓），不是电阻档也不是电流档；
 *  2. **表笔落点**：红笔正极、黑笔负极/公共端，顺序错了读数带负号；
 *  3. **读数何时成立**：两根笔都搭稳才有读数，之前是 OL（开路）。
 *
 *  ## 形体参考
 *  手持式数字万用表的通用形式（以 Fluke 87V 这类工业表为参照，公开资料：
 *  约 183 × 90 × 49 mm、可拆黄色护套、四位半液晶、中央档位旋钮、四个插孔）。
 *  比例按实拍取，**表面印刷按实物画**（面板档位、液晶单位、端子编号），
 *  不贴任何照片——理由见 `print.ts` 头部。
 *
 *  ## 尺度
 *  按真实尺寸建模（1 单位 = 1m），相机推近到 0.55m。端子排是放大的：
 *  真实端子 6mm 宽，在 860px 的图里只有几个像素，做成 24mm 才看得清表笔落在哪一格。
 */
import {
  CatmullRomCurve3,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from 'three'

import type { DeviceRig } from './rig'
import {
  chromeMaterial,
  disposeTree,
  floorMaterial,
  roundedBox,
  rubberMaterial,
  seg,
} from './rig'
import { facePlate, lcdTexture, meterPanelTexture, setGlow, terminalLabelTexture } from './print'

/** 表体尺寸（m）：183 × 90 × 49mm 的通用工业表，取整到 180 × 88 × 46。 */
const BODY = { w: 0.088, h: 0.18, d: 0.046 }
/** 表体中心。整台设备偏左，右边留给端子排与表笔。 */
const C = new Vector3(-0.105, 0.1, 0)
/** 端子排：6 位，每位 24mm（放大 4 倍，见文件头）。y 取 0.031 让端子块底面正好落在台面上。 */
const STRIP = new Vector3(0.098, 0.031, 0.004)
const TERM_W = 0.024
const TERM_COUNT = 6

const UP = new Vector3(0, 1, 0)

/** Fluke 那种琥珀黄护套。0xffc20e 的原色在 ACES 下会发荧光，压到 0xd8a01c。 */
const YELLOW = 0xd8a01c
const DARK = 0x2c2f33

interface Lead {
  mesh: Mesh
  update: (grip: Vector3, jack: Vector3) => void
}

/**
 * 表笔线：从插孔出口到笔身末端的一条软线。
 *
 * 每帧重建 TubeGeometry 是这里唯一"不省"的地方——线的形状由两端位置决定，
 * 不重建就只能是一根直棍，一眼假。代价可控：24 段 × 6 边，一次几十微秒，
 * 而且只在拖动时间轴或翻页时才触发。
 */
function makeLead(color: number, jack: Vector3): Lead {
  const material = new MeshStandardMaterial({ color, metalness: 0.05, roughness: 0.72 })
  const mesh = new Mesh(new TubeGeometry(new CatmullRomCurve3([jack, jack, jack]), 24, 0.0022, 6, false), material)
  mesh.castShadow = true
  const lastGrip = new Vector3(1, 1, 1)
  const lastJack = new Vector3(1, 1, 1)

  const update = (grip: Vector3, from: Vector3): void => {
    if (lastGrip.distanceToSquared(grip) < 1e-8 && lastJack.distanceToSquared(from) < 1e-8) return
    lastGrip.copy(grip)
    lastJack.copy(from)
    // 线的中段必须往下垂：两点直连会穿过表体，是"一眼假"的典型
    const sag = new Vector3()
      .addVectors(from, grip)
      .multiplyScalar(0.5)
      .add(new Vector3(0, -0.03, 0.05))
    const near = new Vector3().lerpVectors(from, sag, 0.45)
    const curve = new CatmullRomCurve3(
      [from, from.clone().add(new Vector3(0.012, -0.008, 0.03)), near, sag, grip],
      false,
      'catmullrom',
      0.4,
    )
    mesh.geometry.dispose()
    mesh.geometry = new TubeGeometry(curve, 28, 0.0022, 6, false)
  }

  update(new Vector3(0, 0.2, 0), jack)
  return { mesh, update }
}

/** 一支表笔：探针在原点、笔身朝 +Y 长。摆放时把原点放到落点、+Y 指向握把方向。 */
function makeProbe(body: number, grip: number): Group {
  const group = new Group()

  const tip = new Mesh(new ConeGeometry(0.0016, 0.018, 10), chromeMaterial())
  // Cone 默认尖端朝 +Y，反过来让尖端落在原点
  tip.position.y = 0.009
  tip.rotation.z = Math.PI
  group.add(tip)

  const barrel = new Mesh(new CylinderGeometry(0.0048, 0.0048, 0.052, 14), rubberMaterial(body))
  barrel.position.y = 0.044
  barrel.castShadow = true
  group.add(barrel)

  // 护指环：真表笔都有，也是"捏住这里"的视觉提示
  const guard = new Mesh(new TorusGeometry(0.0085, 0.0022, 8, 16), rubberMaterial(grip))
  guard.position.y = 0.022
  guard.rotation.x = Math.PI / 2
  group.add(guard)

  // 笔身末端的接线帽
  const cap = new Mesh(new CylinderGeometry(0.0052, 0.0042, 0.012, 12), rubberMaterial(grip))
  cap.position.y = 0.075
  group.add(cap)

  return group
}

/** 把表笔摆到"尖端在 tip、笔身朝 dir 方向"。 */
function orient(probe: Object3D, tip: Vector3, dir: Vector3): void {
  probe.position.copy(tip)
  const d = dir.clone().normalize()
  probe.quaternion.setFromUnitVectors(UP, d)
}

export function buildMultimeter(): DeviceRig {
  const root = new Group()
  const parts: Record<string, Object3D> = {}

  /* 台面：没有它，表和表笔都浮在半空。只接阴影，颜色与页面底接近。 */
  const table = new Mesh(new PlaneGeometry(0.9, 0.6), floorMaterial())
  table.rotation.x = -Math.PI / 2
  table.position.y = 0.01
  table.receiveShadow = true
  root.add(table)

  /* ------------------------------------------------------------ 表体 */
  const bodyGroup = new Group()
  bodyGroup.position.copy(C)
  bodyGroup.rotation.set(-0.1, 0.22, 0.04)
  root.add(bodyGroup)
  parts.body = bodyGroup

  bodyGroup.add(roundedBox(BODY.w, BODY.h, BODY.d, new MeshStandardMaterial({
    color: DARK,
    metalness: 0.05,
    roughness: 0.55,
  }), 0, 0, 0, 0.008, 3))

  // 黄色护套：四条边框而不是整壳——整壳会把面板全盖住
  const boot = rubberMaterial(YELLOW)
  bodyGroup.add(roundedBox(BODY.w + 0.006, 0.012, BODY.d + 0.005, boot, 0, BODY.h / 2, 0, 0.005))
  bodyGroup.add(roundedBox(BODY.w + 0.006, 0.012, BODY.d + 0.005, boot, 0, -BODY.h / 2, 0, 0.005))
  bodyGroup.add(roundedBox(0.01, BODY.h, BODY.d + 0.005, boot, -BODY.w / 2, 0, 0, 0.004))
  bodyGroup.add(roundedBox(0.01, BODY.h, BODY.d + 0.005, boot, BODY.w / 2, 0, 0, 0.004))

  // 前脸印刷层（档位刻度 + 丝印）
  const panel = facePlate(0.084, 0.174, meterPanelTexture(), { roughness: 0.5 })
  panel.position.set(0, 0, BODY.d / 2 + 0.0012)
  bodyGroup.add(panel)

  /* ---- 液晶 ---- */
  const screenGroup = new Group()
  screenGroup.position.set(0, 0.052, BODY.d / 2 + 0.0018)
  bodyGroup.add(screenGroup)
  parts.screen = screenGroup

  screenGroup.add(roundedBox(0.066, 0.036, 0.004, new MeshStandardMaterial({
    color: 0x14171a,
    metalness: 0.1,
    roughness: 0.4,
  }), 0, 0, 0, 0.003))

  /* 读数取 110.3 V：与样例判据「输入电压 110V（77–137.5）」一致。
     上一版写 24.1 V，图与判据差了一个电压等级——这种"图好看、读数也对、
     只是不是这一步"的错，比画不出来更糟。 */
  const LCD = {
    blank: lcdTexture('', ''),
    open: lcdTexture('OL', 'V⎓'),
    settle: lcdTexture('109.8', 'V⎓', 'DC'),
    steady: lcdTexture('110.3', 'V⎓', 'DC'),
  }
  const lcd = facePlate(0.06, 0.03, LCD.blank, { glow: 0.12, roughness: 0.28 })
  lcd.position.set(0, 0, 0.0026)
  screenGroup.add(lcd)

  /* ---- 档位旋钮 ---- */
  const dial = new Group()
  dial.position.set(0, -0.004, BODY.d / 2 + 0.002)
  bodyGroup.add(dial)
  parts.dial = dial

  const knob = new Mesh(new CylinderGeometry(0.019, 0.021, 0.011, 24), new MeshStandardMaterial({
    color: 0x3a3d42,
    metalness: 0.25,
    roughness: 0.42,
  }))
  knob.rotation.x = Math.PI / 2
  knob.position.z = 0.005
  knob.castShadow = true
  dial.add(knob)

  // 旋钮上的指示线：白色的那一小条决定"档位在哪"，必须能看见转
  const pointer = roundedBox(0.004, 0.015, 0.0025, new MeshStandardMaterial({
    color: 0xe9e6dc,
    roughness: 0.5,
  }), 0, 0.009, 0.0122, 0.0012)
  dial.add(pointer)

  /* ---- 按键 ---- */
  const keyMat = rubberMaterial(YELLOW)
  for (let i = 0; i < 4; i += 1) {
    bodyGroup.add(roundedBox(0.013, 0.008, 0.004, keyMat, -0.028 + i * 0.019, -0.043, BODY.d / 2 + 0.001, 0.002))
  }

  /* ---- 插孔：两个红、两个黑 ---- */
  for (let i = 0; i < 4; i += 1) {
    const x = -0.03 + i * 0.02
    const ringColor = i === 0 || i === 2 ? 0xc0262a : 0x1a1c1f
    const ring = new Mesh(new TorusGeometry(0.0058, 0.0016, 8, 18), rubberMaterial(ringColor))
    ring.position.set(x, -0.078, BODY.d / 2 + 0.001)
    bodyGroup.add(ring)
    const hole = new Mesh(new CylinderGeometry(0.0042, 0.0042, 0.006, 14), new MeshStandardMaterial({
      color: 0x08090a,
      roughness: 0.9,
    }))
    hole.rotation.x = Math.PI / 2
    hole.position.set(x, -0.078, BODY.d / 2 - 0.002)
    bodyGroup.add(hole)
  }

  /* 插孔的世界坐标（表笔线的起点）：必须先把世界矩阵算出来，
     否则拿到的是 bodyGroup 的局部原点——四条线会全部连到表心。 */
  bodyGroup.updateMatrixWorld(true)
  const jackAt = (x: number): Vector3 =>
    new Vector3(x, -0.078, BODY.d / 2 + 0.002).applyMatrix4(bodyGroup.matrixWorld)
  const jackWorld = [jackAt(-0.03), jackAt(-0.01), jackAt(0.01), jackAt(0.03)]

  /* ---------------------------------------------------------- 端子排 */
  const strip = new Group()
  strip.position.copy(STRIP)
  root.add(strip)
  parts.terminals = strip

  strip.add(roundedBox(0.152, 0.05, 0.055, new MeshStandardMaterial({
    color: 0x8b8f94,
    metalness: 0.15,
    roughness: 0.62,
  }), 0, 0.006, 0, 0.004))

  const screwTops: Vector3[] = []
  for (let i = 0; i < TERM_COUNT; i += 1) {
    const x = (i - (TERM_COUNT - 1) / 2) * TERM_W
    strip.add(roundedBox(TERM_W - 0.002, 0.062, 0.058, new MeshStandardMaterial({
      color: i % 2 === 0 ? 0xd8d5cc : 0xc9c6bd,
      metalness: 0.05,
      roughness: 0.68,
    }), x, 0.008, 0, 0.003))

    const screw = new Mesh(new CylinderGeometry(0.0068, 0.0068, 0.005, 16), chromeMaterial())
    screw.position.set(x, 0.041, 0)
    strip.add(screw)

    // 十字槽：两道细条，比画个圆更像螺钉
    for (const rot of [0, Math.PI / 2]) {
      const slot = roundedBox(0.0092, 0.0012, 0.0008, new MeshStandardMaterial({
        color: 0x3a3d42,
        metalness: 0.6,
        roughness: 0.5,
      }), 0, 0, 0, 0.0004)
      slot.position.set(x, 0.0436, 0)
      slot.rotation.y = rot
      strip.add(slot)
    }
    screwTops.push(new Vector3(x, 0.0436, 0))
  }

  // 编号条：贴在端子排前脸，正对镜头
  const label = facePlate(0.148, 0.0246, terminalLabelTexture(TERM_COUNT), { roughness: 0.6 })
  label.position.set(0, -0.013, 0.0302)
  strip.add(label)

  /* 表笔落点用世界坐标：端子排的局部坐标要乘上它自己的矩阵，
     否则六个落点全挤在原点附近。 */
  strip.updateMatrixWorld(true)
  const termVec = (index: number): Vector3 =>
    strip.localToWorld(screwTops[index].clone().add(new Vector3(0, 0.0016, 0)))

  /* ------------------------------------------------------------ 表笔 */
  const probes = new Group()
  root.add(probes)
  parts.probes = probes

  const redProbe = makeProbe(0xc0262a, 0x8f1b1e)
  const blackProbe = makeProbe(0x1a1c1f, 0x0f1113)
  probes.add(redProbe, blackProbe)

  const redLead = makeLead(0xc0262a, jackWorld[1])
  const blackLead = makeLead(0x1a1c1f, jackWorld[3])
  probes.add(redLead.mesh, blackLead.mesh)

  /* 表笔的两个极限位置：针尖搁在台面上（未接），与搭在 1/2 号端子上。 */
  const redRest = new Vector3(-0.052, 0.013, 0.072)
  const blackRest = new Vector3(-0.018, 0.013, 0.084)
  const redRestDir = new Vector3(-0.32, 0.46, 0.83)
  const blackRestDir = new Vector3(0.22, 0.44, 0.87)
  const redTouch = termVec(0)
  const blackTouch = termVec(1)
  const redTouchDir = new Vector3(-0.45, 0.82, 0.36)
  const blackTouchDir = new Vector3(0.4, 0.84, 0.36)

  const tmpTip = new Vector3()
  const tmpDir = new Vector3()
  const tmpGrip = new Vector3()

  /** 一支笔在 t 时刻的姿态：`from` → `to` 之间插值；`back` 为撤笔段。 */
  function poseProbe(
    probe: Object3D,
    lead: Lead,
    jack: Vector3,
    restTip: Vector3,
    restDir: Vector3,
    touchTip: Vector3,
    touchDir: Vector3,
    engage: number,
    retract: number,
  ): void {
    // `engage` 与 `retract` 都是 0–1 的进度：进场 × (1 − 撤场) = 当前贴合量。
    // 不要在这里再调 seg(t, …)——本函数拿不到 t，上一版就是这么写崩的（NaN 曲线）。
    const k = engage * (1 - retract)
    tmpTip.lerpVectors(restTip, touchTip, k)
    // 提笔时先抬后撤：纯插值会让针尖贴着端子横向刮过去，那是划伤端子的动作
    tmpTip.y += Math.sin(Math.PI * k) * 0.018
    tmpDir.lerpVectors(restDir, touchDir, k).normalize()
    orient(probe, tmpTip, tmpDir)
    tmpGrip.copy(tmpTip).addScaledVector(tmpDir, 0.075)
    lead.update(tmpGrip, jack)
  }

  /* ------------------------------------------------------------ 动作 */
  const applyLcd = (which: 'blank' | 'open' | 'settle' | 'steady'): void => {
    const material = lcd.material as MeshStandardMaterial
    material.map = LCD[which]
    material.emissiveMap = LCD[which]
    material.needsUpdate = true
    setGlow(lcd, which === 'blank' ? 0.04 : 0.42)
  }

  const setT = (t: number): void => {
    // 档位：OFF → 直流电压。真机旋钮是 0–360° 的棘轮，这里只转 90°，
    // 因为图上要看清的是"指到 V⎓"，不是转了多少度。
    dial.rotation.z = -1.35 * (1 - seg(t, 0, 0.12))

    poseProbe(
      redProbe, redLead, jackWorld[1],
      redRest, redRestDir, redTouch, redTouchDir,
      seg(t, 0.18, 0.3), seg(t, 0.9, 1),
    )
    poseProbe(
      blackProbe, blackLead, jackWorld[3],
      blackRest, blackRestDir, blackTouch, blackTouchDir,
      seg(t, 0.43, 0.55), seg(t, 0.9, 1),
    )

    // 读数：两根笔都到位才成立。之前是 OL（开路），之后有一段跳动。
    if (t < 0.12) applyLcd('blank')
    else if (t < 0.58) applyLcd('open')
    else if (t < 0.7) applyLcd('settle')
    else applyLcd('steady')
  }

  const phase = (t: number): string => {
    if (t < 0.12) return '档位置于直流电压档'
    if (t < 0.3) return '红表笔接近正极端子'
    if (t < 0.55) return '黑表笔接近公共端'
    if (t < 0.7) return '读数建立中'
    if (t < 0.9) return '读数稳定 110.3 V'
    return '撤笔、读数保持'
  }

  setT(0)
  root.updateMatrixWorld(true)

  return {
    root,
    setT,
    parts,
    phase,
    // 中焦 30°：表体与端子排都要看清，再窄端子排就被切出画面
    fov: 30,
    envIntensity: 1.0,
    // 0.72：端子排贴着画面下沿时，整页布局会把它切掉一截
    framing: { target: [0.01, 0.075, 0.03], distance: 0.72 },
    /* 这一步要看的是「LCD 读数 + 表笔落在哪两个端子」。
       桌面、端子排后四位、表笔线的走向都是背景，不该参与取景——
       它们一进来，镜头就得退到 0.72m，表体在矮画布上只剩四五十像素。 */
    focus: ['body', 'terminals'],
    // 表笔悬空时会在包围盒外多出一截，留白给到 1.2
    fitMargin: 1.2,
    dispose: () => disposeTree(root),
  }
}
