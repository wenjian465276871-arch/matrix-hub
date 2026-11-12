/** 司机操纵台（CRH380A 统型）：升弓试验里"人这一侧"的设备。
 *
 *  ## 形体依据（2026-11-13 按实拍照片重做，上一版凭文字描述做错了四处）
 *  参考：维基共享资源 `CRH380A 60031 driver left / driver middle` 两张司机室实拍，
 *  以及 CRH380A 统型驾驶设施讲义。照片只用于核对布局、比例与配色，不落进仓库。
 *
 *  改回来的四件事：
 *  1. **制动控制器在左手侧**，右手侧是牵引控制器 + 方向手柄。上一版把制动手柄放右边，错了。
 *  2. **主控钥匙插在制动控制器上**（讲义原文："制动控制器（含主控钥匙）"）。
 *     上一版在台面上另开一个钥匙孔，现场没有这个件。
 *  3. **MON 是仪表盘上并列两块大屏之一**，两块屏都嵌在深色仪表盘里、上有遮光帽檐、
 *     下有一排软键。上一版做成一块居中孤屏，不像司机室。
 *  4. **台体是浅灰、仪表盘是深灰**，圆形网压表在左下、紧挨着左开关盘。
 *
 *  ## 为什么仍要程序化几何
 *  可再分发的实拍/CAD 授权不存在（见 `rig.ts` 头部）；程序化几何 + PBR + 环境反射
 *  是本项目既定的逼真度路线。这里只把**布局与比例**对齐照片，不追求逐颗螺钉复刻。
 *
 *  ## 屏幕为什么现画
 *  MON 屏是这台设备的"结果指示器"：钥匙转到哪一位、弓起没起、网压多少全在屏上。
 *  贴一张固定图，八拍动作就只有机械件在动、屏永远一个样——而现场判断"成了没有"
 *  靠的恰恰是屏。所以按状态重画，只在状态切换时重画一次。
 */
import {
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  SRGBColorSpace,
  SphereGeometry,
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
} from './rig'
import { DESK_T, phaseFor } from '../../lib/devphase'

/* ------------------------------------------------------------------ 尺寸 */

/** 台体：宽 1.90（双人台的一半，单司机模式仍是整块台面）、深 0.64、台面高 0.64。 */
const W = 1.9
const D = 0.64
const TOP_Y = 0.64
/** 仪表盘（深色部分）前表面 z。屏幕、开关盘、表都装在它上面。 */
const FACE_Z = -0.08
/** 屏宽高：实拍两块屏接近 4:3，带帽檐。 */
const SCR_W = 0.4
const SCR_H = 0.26

const SW = 512
const SH = 320

type Row = [string, string]

/** 八个状态的 MON 画面。索引与 `stateAt()` 对齐。 */
const SCREEN: Array<{ tab: string; rows: Row[]; note: string; on: boolean }> = [
  { tab: '待机', rows: [['主控', '未激活'], ['MON', '熄灭']], note: '插入主控钥匙并右旋', on: false },
  { tab: '待机', rows: [['主控钥匙', '已插入'], ['MON', '自检中']], note: '右旋钥匙，建立司机室占用', on: false },
  {
    tab: '电源电压',
    rows: [['控制电压', '110.2 V'], ['蓄电池', '110.0 V'], ['总风缸 MR', '720 kPa']],
    note: '司机室占用 · 电压 ≥87 V 正常',
    on: true,
  },
  {
    tab: '电源电压',
    rows: [['控制电压', '110.2 V'], ['制动手柄', '快速位'], ['总风缸 MR', '720 kPa']],
    note: 'MCR 已励磁 · 可进行升弓操作',
    on: true,
  },
  {
    tab: '车辆信息',
    rows: [['EGS 接地保护', '断开'], ['VCB 真空断路器', '断开'], ['2U 受电弓', '未切除']],
    note: '联锁条件满足 · 允许升弓',
    on: true,
  },
  {
    tab: '远程控制切除',
    rows: [['2U 受电弓', '升弓中'], ['3U 受电弓', '未切除'], ['VCB', '断开']],
    note: '升弓指令已发出 · 保持旋钮',
    on: true,
  },
  {
    tab: '远程控制切除',
    rows: [['2U 受电弓', '升起'], ['网压', '25.1 kV'], ['VCB', '断开']],
    note: '升弓到位 · 网压 19–31 kV 正常',
    on: true,
  },
  {
    tab: '主画面',
    rows: [['2U 受电弓', '升起'], ['网压', '25.1 kV'], ['VCB', '闭合']],
    note: '送电完成 · 可开始后续试验',
    on: true,
  },
]

/* ------------------------------------------------------------------ 贴图 */

/** 一张可重画的屏幕贴图。`paint` 只重画内容，不重建纹理。 */
function screenSurface(): { tex: CanvasTexture; paint: (index: number) => void } {
  const canvas = document.createElement('canvas')
  canvas.width = SW
  canvas.height = SH
  const ctx = canvas.getContext('2d')
  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 4

  const paint = (index: number): void => {
    if (!ctx) return
    const page = SCREEN[index] ?? SCREEN[0]
    ctx.clearRect(0, 0, SW, SH)

    ctx.fillStyle = page.on ? '#0d2420' : '#080b0a'
    ctx.fillRect(0, 0, SW, SH)

    // 顶栏 + 底部软键排：实拍里每块屏底下都有一排蓝色图标键
    ctx.fillStyle = page.on ? '#1d5b4c' : '#121a17'
    ctx.fillRect(0, 0, SW, 50)
    ctx.fillStyle = page.on ? '#d8f2e8' : '#3a4a44'
    ctx.font = 'bold 25px "Microsoft YaHei", sans-serif'
    ctx.fillText('MON', 18, 35)
    ctx.font = '21px "Microsoft YaHei", sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(page.on ? page.tab : '未上电', SW - 18, 35)
    ctx.textAlign = 'left'

    let y = 100
    for (const [label, value] of page.rows) {
      ctx.fillStyle = page.on ? '#9fc4b8' : '#2c3a35'
      ctx.font = '21px "Microsoft YaHei", sans-serif'
      ctx.fillText(label, 24, y)
      ctx.fillStyle = page.on ? '#eafaf3' : '#37463f'
      ctx.font = 'bold 28px "Consolas", "Microsoft YaHei", monospace'
      ctx.fillText(value, 240, y + 2)
      y += 54
    }

    // 状态条
    ctx.fillStyle = page.on ? '#0a1a16' : '#0a0d0c'
    ctx.fillRect(0, SH - 84, SW, 44)
    ctx.fillStyle = page.on ? '#7fd6b4' : '#3c4a44'
    ctx.font = '19px "Microsoft YaHei", sans-serif'
    ctx.fillText(page.note, 22, SH - 54)

    ctx.fillStyle = page.on ? '#123a31' : '#101715'
    ctx.fillRect(0, SH - 40, SW, 40)
    ctx.fillStyle = page.on ? '#5f9dd8' : '#2c3a35'
    for (let i = 0; i < 9; i += 1) {
      ctx.fillRect(16 + i * 54, SH - 31, 38, 20)
    }

    tex.needsUpdate = true
  }

  paint(0)
  return { tex, paint }
}

/** ATP 速度表屏：与 MON 并列的另一块大屏，只作背景（本试验不看它）。 */
function atpSurface(): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = SW
  canvas.height = SH
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#070d12'
    ctx.fillRect(0, 0, SW, SH)
    ctx.fillStyle = '#0f2b3a'
    ctx.fillRect(0, 0, SW, 50)
    ctx.fillStyle = '#9cc7e6'
    ctx.font = 'bold 24px "Microsoft YaHei", sans-serif'
    ctx.fillText('ATP', 18, 35)

    // 速度弧
    const cx = 170
    const cy = 190
    const r = 108
    ctx.strokeStyle = '#1f4a63'
    ctx.lineWidth = 10
    ctx.beginPath()
    ctx.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 2.25)
    ctx.stroke()
    ctx.strokeStyle = '#4fc3f7'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 1.35)
    ctx.stroke()
    ctx.fillStyle = '#e6f4ff'
    ctx.font = 'bold 72px "Consolas", monospace'
    ctx.fillText('250', 108, 205)
    ctx.font = '20px "Microsoft YaHei", sans-serif'
    ctx.fillText('km/h', 132, 240)

    ctx.fillStyle = '#0c1c26'
    ctx.fillRect(320, 90, 170, 170)
    ctx.fillStyle = '#7fb6d4'
    ctx.font = '19px "Microsoft YaHei", sans-serif'
    ctx.fillText('模式  目视', 336, 130)
    ctx.fillText('允许  250', 336, 166)
    ctx.fillText('目标  250', 336, 202)
    ctx.fillStyle = '#4fc3f7'
    for (let i = 0; i < 9; i += 1) ctx.fillRect(16 + i * 54, SH - 31, 38, 20)
  }
  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

/** 网压表盘面：0–35 kV，绿色正常区 19–31。 */
function gaugeFace(): CanvasTexture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const c = size / 2
    ctx.fillStyle = '#e9e7df'
    ctx.beginPath()
    ctx.arc(c, c, c - 2, 0, Math.PI * 2)
    ctx.fill()

    const ang = (kv: number): number => ((210 - (kv / 35) * 240) * Math.PI) / 180
    ctx.strokeStyle = '#2f8f5b'
    ctx.lineWidth = 12
    ctx.beginPath()
    ctx.arc(c, c, c - 28, ang(19), ang(31))
    ctx.stroke()

    ctx.strokeStyle = '#1a1c1e'
    ctx.fillStyle = '#1a1c1e'
    ctx.font = 'bold 17px "Consolas", monospace'
    ctx.textAlign = 'center'
    for (let kv = 0; kv <= 35; kv += 5) {
      const a = ang(kv)
      ctx.lineWidth = kv % 10 === 0 ? 3 : 1.6
      ctx.beginPath()
      ctx.moveTo(c + Math.cos(a) * (c - 38), c - Math.sin(a) * (c - 38))
      ctx.lineTo(c + Math.cos(a) * (c - 18), c - Math.sin(a) * (c - 18))
      ctx.stroke()
      if (kv % 10 === 0) {
        ctx.fillText(String(kv), c + Math.cos(a) * (c - 56), c - Math.sin(a) * (c - 56) + 6)
      }
    }
    ctx.font = 'bold 15px "Microsoft YaHei", sans-serif'
    ctx.fillText('kV', c, c + 40)
  }
  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  return tex
}

/** 面板上的小字牌。真实台面上每一块都有标签，没有标签就只剩一堆塑料疙瘩。 */
function labelPlate(text: string, w = 0.07, h = 0.016): Mesh {
  const tex = (() => {
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 64
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#20242a'
      ctx.fillRect(0, 0, 256, 64)
      ctx.fillStyle = '#e8ecef'
      ctx.font = 'bold 34px "Microsoft YaHei", sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(text, 128, 44)
    }
    const t = new CanvasTexture(canvas)
    t.colorSpace = SRGBColorSpace
    return t
  })()
  const mesh = new Mesh(
    new PlaneGeometry(w, h),
    new MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0 }),
  )
  return mesh
}

/* ------------------------------------------------------------------ 建模 */

export function buildDriverDesk(): DeviceRig {
  const root = new Group()
  const parts: Record<string, Object3D> = {}

  /* ------------------------------------------------------------ 台体 */
  const desk = new Group()
  root.add(desk)
  parts.desk = desk

  const bodyMat = paintedMaterial(0xb9bdbd)
  const topMat = paintedMaterial(0xc4c8c7)
  const darkMat = paintedMaterial(0x30343a)
  const recessMat = paintedMaterial(0x1b1e22)

  desk.add(roundedBox(W + 0.05, 0.04, D + 0.05, paintedMaterial(0x9fa3a3), 0, 0.02, 0, 0.006))
  desk.add(roundedBox(W, 0.54, D, bodyMat, 0, 0.31, 0, 0.014, 3))
  // 台面：司机侧前缘做出圆弧，实拍里台面是向前拱出的
  desk.add(roundedBox(W + 0.02, 0.06, D - 0.04, topMat, 0, 0.61, 0.02, 0.02, 3))
  desk.add(roundedBox(W + 0.02, 0.05, 0.1, topMat, 0, 0.6, D / 2 - 0.03, 0.024, 3))
  // 仪表盘：深色立面，屏幕与表都嵌在里面
  desk.add(roundedBox(W - 0.06, 0.36, 0.2, darkMat, 0, 0.8, -0.18, 0.01, 3))
  // 遮光帽檐：从仪表盘顶向前伸，压住屏幕上方
  desk.add(roundedBox(W - 0.04, 0.018, 0.12, darkMat, 0, 0.975, -0.115, 0.006))
  desk.add(roundedBox(W - 0.04, 0.05, 0.018, darkMat, 0, 0.952, -0.058, 0.006))

  // 屏幕凹槽底板（比仪表盘再深一档，屏幕嵌进去才有"洞"的感觉）
  desk.add(roundedBox(0.9, 0.3, 0.012, recessMat, -0.07, 0.8, FACE_Z + 0.006, 0.004))

  // 右屏（ATP）与更右的 CIR 小屏：背景件，不参与本试验
  const atpTex = atpSurface()
  const atp = new Mesh(
    new PlaneGeometry(SCR_W, SCR_H),
    new MeshStandardMaterial({
      map: atpTex,
      emissiveMap: atpTex,
      emissive: 0xffffff,
      emissiveIntensity: 0.5,
      roughness: 0.18,
    }),
  )
  atp.position.set(0.24, 0.8, FACE_Z + 0.013)
  desk.add(atp)

  const cir = roundedBox(0.24, 0.17, 0.02, recessMat, 0.76, 0.79, FACE_Z + 0.012, 0.004)
  desk.add(cir)
  desk.add(roundedBox(0.2, 0.13, 0.004, paintedMaterial(0x2b4a5c), 0.76, 0.79, FACE_Z + 0.024, 0.002))

  // 话筒（实拍里在右侧立面上，黑手柄 + 螺旋线）
  desk.add(roundedBox(0.06, 0.24, 0.05, rubberMaterial(0x1b1d21), 0.88, 0.79, FACE_Z + 0.03, 0.012))
  desk.add(roundedBox(0.05, 0.09, 0.03, rubberMaterial(0x24262a), 0.88, 0.66, FACE_Z + 0.03, 0.008))

  // 台面上的按钮排（绿 2 / 红 2 / 黑旋钮 2）：实拍里就在正中偏前
  const strip: Array<[number, number, number, 'green' | 'red' | 'black']> = [
    [-0.3, 0.05, 0.026, 'black'],
    [-0.18, 0.05, 0.026, 'green'],
    [-0.1, 0.05, 0.026, 'green'],
    [-0.02, 0.05, 0.026, 'red'],
    [0.06, 0.05, 0.026, 'red'],
    [0.16, 0.05, 0.026, 'black'],
  ]
  for (const [x, z, r, kind] of strip) {
    const base = new Mesh(new CylinderGeometry(r + 0.004, r + 0.004, 0.012, 20), darkMat)
    base.position.set(x, TOP_Y - 0.004, z)
    desk.add(base)
    const cap =
      kind === 'black'
        ? new Mesh(new CylinderGeometry(r, r * 0.82, 0.016, 20), rubberMaterial(0x1e2024))
        : new Mesh(new CylinderGeometry(r, r, 0.014, 20), lampMaterial(kind === 'green' ? 0x2f8f5b : 0xb03a34))
    cap.position.set(x, TOP_Y + 0.008, z)
    desk.add(cap)
  }

  // 牵引控制器（右手侧）：圆底座 + 短杆，背景件
  const tracBase = new Mesh(new SphereGeometry(0.085, 24, 16), bodyMat)
  tracBase.scale.set(1, 0.62, 1.05)
  tracBase.position.set(0.3, 0.66, 0.18)
  desk.add(tracBase)
  const tracArm = new Mesh(new CylinderGeometry(0.011, 0.013, 0.16, 14), chromeMaterial())
  tracArm.position.set(0.3, 0.73, 0.18)
  tracArm.rotation.x = 0.18
  desk.add(tracArm)
  desk.add(roundedBox(0.05, 0.05, 0.05, rubberMaterial(0x1e2024), 0.3, 0.805, 0.165, 0.02))

  /* ------------------------------------------------------------ MON 屏 */
  const mon = new Group()
  root.add(mon)
  parts.mon = mon

  mon.add(roundedBox(SCR_W + 0.03, SCR_H + 0.03, 0.018, recessMat, -0.24, 0.8, FACE_Z + 0.004, 0.004))
  const { tex: screenTex, paint } = screenSurface()
  const screen = new Mesh(
    new PlaneGeometry(SCR_W, SCR_H),
    new MeshStandardMaterial({
      map: screenTex,
      emissiveMap: screenTex,
      emissive: 0xffffff,
      emissiveIntensity: 0.55,
      roughness: 0.16,
      metalness: 0,
    }),
  )
  screen.position.set(-0.24, 0.8, FACE_Z + 0.014)
  mon.add(screen)
  const monLabel = labelPlate('MON', 0.06, 0.014)
  monLabel.position.set(-0.24, 0.955, FACE_Z + 0.015)
  mon.add(monLabel)

  /* ------------------------------------------------------------ 主控钥匙（在制动控制器上） */
  const key = new Group()
  root.add(key)
  parts.key = key

  // 锁芯：装在制动控制器朝司机的前下方（实拍里钥匙就插在这个圆顶上）
  const keyBody = new Mesh(new CylinderGeometry(0.017, 0.017, 0.014, 20), chromeMaterial())
  keyBody.rotation.x = Math.PI / 2
  keyBody.position.set(-0.48, 0.7, 0.32)
  key.add(keyBody)
  const keyTurn = new Group()
  keyTurn.position.set(-0.48, 0.7, 0.328)
  key.add(keyTurn)
  const shaft = new Mesh(new CylinderGeometry(0.005, 0.005, 0.05, 10), chromeMaterial())
  shaft.rotation.x = Math.PI / 2
  shaft.position.z = 0.022
  keyTurn.add(shaft)
  const head = roundedBox(0.03, 0.016, 0.006, chromeMaterial(), 0, 0, 0.048, 0.002)
  keyTurn.add(head)
  // 黄色标牌：实拍里钥匙上挂着一块黄色牌子，是最容易一眼认出的特征
  keyTurn.add(roundedBox(0.026, 0.04, 0.004, paintedMaterial(0xd8b53a), 0, -0.026, 0.048, 0.002))

  /* ------------------------------------------------------------ 制动控制器（制动手柄） */
  const brake = new Group()
  root.add(brake)
  parts.brake = brake

  const brakeBase = new Mesh(new SphereGeometry(0.095, 24, 16), bodyMat)
  brakeBase.scale.set(1, 0.6, 1.08)
  brakeBase.position.set(-0.42, 0.66, 0.22)
  brake.add(brakeBase)
  brake.add(roundedBox(0.16, 0.02, 0.24, paintedMaterial(0x8f9393), -0.42, 0.645, 0.22, 0.008))
  // 扇形齿板：拔取/快速/B1–B7/运行 的档位刻线（实拍里是块黑牌）
  const quadrant = roundedBox(0.13, 0.07, 0.012, darkMat, -0.42, 0.71, 0.16, 0.004)
  brake.add(quadrant)
  for (let i = 0; i < 5; i += 1) {
    brake.add(roundedBox(0.004, 0.024, 0.004, chromeMaterial(), -0.48 + i * 0.03, 0.706, 0.153, 0.001))
  }

  const lever = new Group()
  lever.position.set(-0.42, 0.7, 0.22)
  brake.add(lever)
  const arm = new Mesh(new CylinderGeometry(0.011, 0.014, 0.18, 14), chromeMaterial())
  arm.position.y = 0.09
  lever.add(arm)
  const grip = new Mesh(new SphereGeometry(0.032, 20, 14), rubberMaterial(0x1e2024))
  grip.position.y = 0.195
  lever.add(grip)

  /* ------------------------------------------------------------ 受电弓切换开关（转换开关盘2） */
  const sw = new Group()
  root.add(sw)
  parts.switch = sw

  // 左开关盘：一块深色斜面板，上面是拨动开关与两只旋钮（实拍左侧）
  const swPanel = roundedBox(0.26, 0.016, 0.2, darkMat, -0.78, TOP_Y + 0.008, 0.06, 0.004)
  swPanel.rotation.x = -0.12
  sw.add(swPanel)
  for (let i = 0; i < 4; i += 1) {
    sw.add(roundedBox(0.024, 0.03, 0.012, rubberMaterial(0x15171a), -0.86 + i * 0.05, TOP_Y + 0.03, 0.09, 0.002))
  }
  const swLabel = labelPlate('受电弓 2U/3U', 0.1, 0.014)
  swLabel.position.set(-0.78, TOP_Y + 0.034, 0.13)
  swLabel.rotation.x = -Math.PI / 2
  sw.add(swLabel)
  const swBody = new Mesh(new CylinderGeometry(0.024, 0.024, 0.02, 20), chromeMaterial())
  swBody.position.set(-0.74, TOP_Y + 0.028, 0.02)
  sw.add(swBody)
  const swTurn = new Group()
  swTurn.position.set(-0.74, TOP_Y + 0.04, 0.02)
  sw.add(swTurn)
  swTurn.add(roundedBox(0.046, 0.008, 0.012, chromeMaterial(), 0, 0, 0.014, 0.002))

  /* ------------------------------------------------------------ 升弓旋钮 PanUS */
  const knob = new Group()
  root.add(knob)
  parts.knob = knob

  // 中央开关盘上一只带箭头的旋钮（PanUS）：右旋保持、松手回位
  const knobBase = new Mesh(new CylinderGeometry(0.032, 0.032, 0.014, 22), darkMat)
  knobBase.position.set(0.02, TOP_Y + 0.006, 0.16)
  knob.add(knobBase)
  const knobBody = new Mesh(new CylinderGeometry(0.026, 0.026, 0.024, 22), rubberMaterial(0x1e2024))
  knobBody.position.set(0.02, TOP_Y + 0.024, 0.16)
  knob.add(knobBody)
  const knobTurn = new Group()
  knobTurn.position.set(0.02, TOP_Y + 0.036, 0.16)
  knob.add(knobTurn)
  knobTurn.add(roundedBox(0.05, 0.008, 0.012, chromeMaterial(), 0, 0, 0.016, 0.002))
  const knobLabel = labelPlate('升弓 PanUS', 0.1, 0.014)
  knobLabel.position.set(0.02, TOP_Y + 0.006, 0.196)
  knobLabel.rotation.x = -Math.PI / 2
  knob.add(knobLabel)

  /* ------------------------------------------------------------ VCB 按钮 */
  const vcb = new Group()
  root.add(vcb)
  parts.vcb = vcb

  const vcbBase = new Mesh(new CylinderGeometry(0.03, 0.03, 0.012, 22), darkMat)
  vcbBase.position.set(0.12, TOP_Y + 0.005, 0.16)
  vcb.add(vcbBase)
  const vcbButton = new Mesh(new CylinderGeometry(0.021, 0.021, 0.018, 22), lampMaterial(0x2f8f5b))
  vcbButton.position.set(0.12, TOP_Y + 0.018, 0.16)
  vcb.add(vcbButton)
  const vcbLabel = labelPlate('VCB 合', 0.07, 0.014)
  vcbLabel.position.set(0.12, TOP_Y + 0.006, 0.196)
  vcbLabel.rotation.x = -Math.PI / 2
  vcb.add(vcbLabel)

  /* ------------------------------------------------------------ 网压表 */
  const gauge = new Group()
  root.add(gauge)
  parts.gauge = gauge

  // 实拍：圆形表嵌在仪表盘左下、紧挨左开关盘
  gauge.add(roundedBox(0.13, 0.14, 0.02, darkMat, -0.6, 0.76, FACE_Z + 0.006, 0.004))
  const can = new Mesh(new CylinderGeometry(0.055, 0.055, 0.036, 32), paintedMaterial(0x2b2f34))
  can.rotation.x = Math.PI / 2
  can.position.set(-0.6, 0.76, FACE_Z + 0.024)
  gauge.add(can)
  const face = new Mesh(
    new PlaneGeometry(0.102, 0.102),
    new MeshStandardMaterial({ map: gaugeFace(), roughness: 0.4, metalness: 0 }),
  )
  face.position.set(-0.6, 0.76, FACE_Z + 0.0425)
  gauge.add(face)
  const needle = roundedBox(0.004, 0.042, 0.003, lampMaterial(0xc0392b), -0.6, 0.76, FACE_Z + 0.046)
  needle.geometry.translate(0, 0.021, 0)
  needle.position.set(-0.6, 0.758, FACE_Z + 0.046)
  gauge.add(needle)
  gauge.add(roundedBox(0.012, 0.012, 0.004, chromeMaterial(), -0.6, 0.758, FACE_Z + 0.047, 0.002))

  /* ------------------------------------------------------------ 动作 */
  let lastState = -1

  const stateAt = (t: number): number => {
    if (t < DESK_T.keyIn) return 0
    if (t < DESK_T.keyOn) return 1
    if (t < DESK_T.brake) return 2
    if (t < DESK_T.unit) return 3
    if (t < DESK_T.raise) return 4
    if (t < DESK_T.raised) return 5
    if (t < 1) return 6
    return 7
  }

  const setT = (t: number): void => {
    const clamped = t < 0 ? 0 : t > 1 ? 1 : t
    const state = stateAt(clamped)
    if (state !== lastState) {
      paint(state)
      lastState = state
    }

    // 钥匙：0.04–0.12 推入 25mm；0.12–0.22 右旋 90°（拔取位 → 运行位）
    const inserted = seg(clamped, 0.04, DESK_T.keyIn)
    const turned = seg(clamped, DESK_T.keyIn, DESK_T.keyOn)
    keyTurn.position.z = 0.328 + 0.025 * (1 - inserted)
    keyTurn.rotation.z = (Math.PI / 2) * turned

    // 制动手柄：0.30–0.36 从制动位推到快速位（向后拉 → 向前推）
    const brakeMoved = seg(clamped, 0.3, DESK_T.brake)
    lever.rotation.x = 0.42 - 0.7 * brakeMoved

    // 受电弓切换开关：0.36–0.50 从 3U 侧旋到 2U 侧
    const unitSel = seg(clamped, DESK_T.brake, DESK_T.unit)
    swTurn.rotation.y = 0.55 - 0.55 * unitSel

    // 升弓旋钮：右旋 75°，到 0.74 之后松手回位
    const held = seg(clamped, DESK_T.unit, DESK_T.raise)
    const released = seg(clamped, DESK_T.raised - 0.06, DESK_T.raised)
    knobTurn.rotation.y = (Math.PI / 2.4) * held * (1 - released)

    // VCB：0.96 之后按下 5mm 并点亮
    const pressed = seg(clamped, 0.96, 1)
    vcbButton.position.y = TOP_Y + 0.018 - 0.005 * pressed
    const vcbMat = vcbButton.material as MeshStandardMaterial
    vcbMat.emissiveIntensity = 0.25 + 0.75 * pressed

    // 网压表：升弓到位后指针升到 25.1 kV
    const kv = 25.1 * seg(clamped, DESK_T.raise, DESK_T.raised)
    const angle = ((210 - (kv / 35) * 240) * Math.PI) / 180 - Math.PI / 2
    needle.rotation.z = angle
  }

  const phase = (t: number): string => phaseFor('driver_desk', t)

  setT(0)
  root.updateMatrixWorld(true)

  return {
    root,
    setT,
    parts,
    phase,
    framing: { target: [0, 0.78, 0.04], distance: 1.95 },
    // 略俯视：台面是水平面，平视只能看到一排侧影；实拍也是从司机肩后上方看
    viewDir: [0.18, 0.5, 0.85],
    // 动的是钥匙、手柄、旋钮、按钮与屏，仪表盘与电话是背景
    focus: ['mon', 'key', 'brake', 'switch', 'knob', 'vcb', 'gauge'],
    fitMargin: 1.08,
    fov: 32,
    envIntensity: 1.1,
    dispose: () => disposeTree(root),
  }
}

/** 屏幕状态数：相位契约要覆盖每一个状态。 */
export const DESK_STATES = SCREEN.length
