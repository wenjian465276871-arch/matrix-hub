/** 司机操纵台（CRH380A 统型）：升弓试验里"人这一侧"的设备。
 *
 *  ## 形体依据（2026-11-13 第二轮，按实拍照片重做）
 *  参考图（只用于核对布局、比例、配色与件形，不落进仓库）：
 *  1. 维基共享资源 `CRH380A 60031 driver left / driver middle` 司机室实拍；
 *  2. CRH380A 统型驾驶设施讲义：仪表盘从左至右 ATP1 / TCMS1 / ATP2 /
 *     TCMS2 / 仪表显示盘 / CIR，台面左制动、右牵引，三个开关盘；
 *  3. Steam《CRH380A》手册里的 MON / ATP 界面截图：深色底、顶部状态条、
 *     表格行、屏下一排软键。
 *
 *  ## 这一轮改了什么（上一版在 1090×614 下看不清、也有穿模）
 *  - **屏幕整体放大**：MON 由 0.40×0.26 增到 0.46×0.345（面积 +53%），
 *    并加铝色外框、深色内凹、屏下软键排与顶部小字牌。
 *  - **仪表盘改成后倾 10.3° 的整体**：真车面板是斜的，屏幕法线朝司机眼睛；
 *    上一版垂直面板从俯视机位看只剩一条窄边。
 *  - **修穿模**：电话原来压在 CIR 小屏上（x 都是 0.88），现在挂到面板右端并加
 *    安装板；钥匙原来悬在制动底座前方 11cm 的空气里，现在锁在底座前脸；
 *    牵引手柄顶端原来是一个悬空的方疙瘩，现在接在杆上。
 *  - **台面重排**：左开关盘做成有壳体的斜面板（原来是一块 16mm 薄板浮在台面上），
 *    中开关盘承载 PanUS 与 VCB，按钮组挪到左前，与实拍一致。
 *
 *  ## 为什么仍要程序化几何
 *  可再分发的实拍/CAD 授权不存在（见 `rig.ts` 头部）；程序化几何 + PBR + 环境反射
 *  是本项目既定的逼真度路线。这里只把**布局、比例、件形**对齐照片。
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
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  SRGBColorSpace,
  SphereGeometry,
  TorusGeometry,
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

/** 台体：宽 1.90（单司机台的半幅）、深 0.66、台面高 0.72。 */
const W = 1.9
const D = 0.66
const TOP_Y = 0.72

/** 仪表盘：以后沿为铰点向后倾 10.3°，屏幕法线因此朝上、朝司机。 */
const PANEL_H = 0.48
const PANEL_TILT = -0.18
const PANEL_PIVOT_Z = -0.24

/** MON 屏：4:3，实拍两块大屏里靠左那块（TCMS）。 */
const SCR_W = 0.46
const SCR_H = 0.345
/** ATP 屏略小；CIR 是窄条。尺寸差来自实拍，不是随手取的。 */
const ATP_W = 0.38
const ATP_H = 0.285
const CIR_W = 0.19
const CIR_H = 0.14

const SW = 640
const SH = 480

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

/** 屏下软键的编号：真车是 8 个，与屏内菜单一一对应。 */
const SOFTKEYS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8']

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

    // 底色：深墨绿而不是纯黑。实拍屏在暗处仍能看出玻璃的绿灰调。
    const bg = ctx.createLinearGradient(0, 0, 0, SH)
    bg.addColorStop(0, page.on ? '#123029' : '#070b09')
    bg.addColorStop(1, page.on ? '#0a1d17' : '#050706')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, SW, SH)

    /* 顶部状态条：车次 / 端号 / 模式。真车这一条是固定的，不随页面变。 */
    ctx.fillStyle = page.on ? '#175445' : '#101a16'
    ctx.fillRect(0, 0, SW, 62)
    ctx.fillStyle = page.on ? '#eafaf3' : '#33443d'
    ctx.font = 'bold 30px "Microsoft YaHei", sans-serif'
    ctx.fillText('MON', 22, 43)
    ctx.font = '20px "Microsoft YaHei", sans-serif'
    ctx.fillStyle = page.on ? '#b6d8ca' : '#2f3f39'
    ctx.fillText('CRH380A · 04 车', 118, 41)
    ctx.textAlign = 'right'
    ctx.fillStyle = page.on ? '#cfece0' : '#2f3f39'
    ctx.fillText(page.on ? '司机模式  14:26' : '未上电', SW - 22, 41)
    ctx.textAlign = 'left'

    /* 页面页签条 */
    ctx.fillStyle = page.on ? '#0e2c24' : '#0b1310'
    ctx.fillRect(0, 62, SW, 40)
    const tabs = ['电源电压', '车辆信息', '远程控制切除']
    let tx = 22
    for (const name of tabs) {
      const active = page.on && name === page.tab
      ctx.font = active ? 'bold 19px "Microsoft YaHei", sans-serif' : '19px "Microsoft YaHei", sans-serif'
      const w = ctx.measureText(name).width + 26
      if (active) {
        ctx.fillStyle = '#2f8f5b'
        ctx.fillRect(tx, 68, w, 28)
        ctx.fillStyle = '#04140e'
      } else {
        ctx.fillStyle = page.on ? '#6f9184' : '#2a3833'
      }
      ctx.fillText(name, tx + 13, 89)
      tx += w + 8
    }

    /* 表头与分隔线：让它看起来是一张表，不是两列字 */
    ctx.fillStyle = page.on ? '#1b4337' : '#101a16'
    ctx.fillRect(0, 102, SW, 2)
    ctx.fillStyle = page.on ? '#6f9184' : '#2a3833'
    ctx.font = '17px "Microsoft YaHei", sans-serif'
    ctx.fillText('项目', 30, 138)
    ctx.textAlign = 'right'
    ctx.fillText('显示值', SW - 30, 138)
    ctx.textAlign = 'left'

    let y = 196
    for (const [label, value] of page.rows) {
      ctx.fillStyle = page.on ? '#1d4a3c' : '#0f1a16'
      ctx.fillRect(30, y + 26, SW - 60, 1)
      ctx.fillStyle = page.on ? '#a9c9bd' : '#2c3a35'
      ctx.font = '27px "Microsoft YaHei", sans-serif'
      ctx.fillText(label, 30, y)
      ctx.fillStyle = page.on ? '#f0fdf7' : '#37463f'
      ctx.font = 'bold 38px "Consolas", "Microsoft YaHei", monospace'
      ctx.textAlign = 'right'
      ctx.fillText(value, SW - 30, y + 2)
      ctx.textAlign = 'left'
      y += 74
    }

    /* 状态提示条 */
    ctx.fillStyle = page.on ? '#0a1f19' : '#080f0c'
    ctx.fillRect(0, 402, SW, 34)
    ctx.fillStyle = page.on ? '#7fd6b4' : '#3c4a44'
    ctx.font = '21px "Microsoft YaHei", sans-serif'
    ctx.fillText(page.note, 30, 425)

    /* 底部软键排：8 个方块 + 编号 */
    for (let i = 0; i < SOFTKEYS.length; i += 1) {
      const w = 54
      const x = 22 + i * (w + 16)
      ctx.fillStyle = page.on ? '#1f5a7a' : '#121a17'
      ctx.fillRect(x, 444, w, 26)
      ctx.fillStyle = page.on ? '#cfe9ff' : '#2c3a35'
      ctx.font = 'bold 13px "Consolas", monospace'
      ctx.textAlign = 'center'
      ctx.fillText(SOFTKEYS[i], x + w / 2, 462)
      ctx.textAlign = 'left'
    }

    /* 玻璃反光：左上角一道很淡的斜向高光。没有它，屏像贴纸。 */
    if (page.on) {
      const gloss = ctx.createLinearGradient(0, 0, SW * 0.7, SH * 0.6)
      gloss.addColorStop(0, 'rgba(255,255,255,0.075)')
      gloss.addColorStop(0.55, 'rgba(255,255,255,0.015)')
      gloss.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = gloss
      ctx.fillRect(0, 0, SW, SH)
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
    const bg = ctx.createLinearGradient(0, 0, 0, SH)
    bg.addColorStop(0, '#081119')
    bg.addColorStop(1, '#040910')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, SW, SH)

    ctx.fillStyle = '#123a4d'
    ctx.fillRect(0, 0, SW, 62)
    ctx.fillStyle = '#d8eefc'
    ctx.font = 'bold 28px "Microsoft YaHei", sans-serif'
    ctx.fillText('ATP', 22, 43)
    ctx.font = '20px "Microsoft YaHei", sans-serif'
    ctx.fillStyle = '#9cc7e6'
    ctx.fillText('CTCS-3 · 允许 250', 110, 41)

    // 速度弧：0–400 km/h，允许速度圈
    const cx = 208
    const cy = 268
    const r = 148
    ctx.strokeStyle = '#20485c'
    ctx.lineWidth = 14
    ctx.beginPath()
    ctx.arc(cx, cy, r, Math.PI * 0.72, Math.PI * 2.28)
    ctx.stroke()
    ctx.strokeStyle = '#4fc3f7'
    ctx.lineWidth = 6
    ctx.beginPath()
    ctx.arc(cx, cy, r, Math.PI * 0.72, Math.PI * 1.42)
    ctx.stroke()

    ctx.fillStyle = '#e8f6ff'
    ctx.font = 'bold 92px "Consolas", monospace'
    ctx.fillText('248', 132, 290)
    ctx.fillStyle = '#7fb6d4'
    ctx.font = '24px "Microsoft YaHei", sans-serif'
    ctx.fillText('km/h', 168, 336)

    ctx.fillStyle = '#0b1f2c'
    ctx.fillRect(400, 130, 208, 230)
    ctx.fillStyle = '#7fb6d4'
    ctx.font = '20px "Microsoft YaHei", sans-serif'
    ctx.fillText('模式   目视', 418, 176)
    ctx.fillText('允许   250', 418, 220)
    ctx.fillText('目标   250', 418, 264)
    ctx.fillText('距离  2.1 km', 418, 308)

    for (let i = 0; i < 8; i += 1) {
      ctx.fillStyle = '#1c5a78'
      ctx.fillRect(22 + i * 74, 444, 58, 26)
    }
  }
  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

/** 网压表盘面：0–35 kV，绿色正常区 19–31。 */
function gaugeFace(): CanvasTexture {
  const size = 320
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const c = size / 2
    ctx.fillStyle = '#171b1d'
    ctx.beginPath()
    ctx.arc(c, c, c - 2, 0, Math.PI * 2)
    ctx.fill()

    const ang = (kv: number): number => ((210 - (kv / 35) * 240) * Math.PI) / 180
    ctx.strokeStyle = '#2f8f5b'
    ctx.lineWidth = 16
    ctx.beginPath()
    ctx.arc(c, c, c - 36, ang(19), ang(31))
    ctx.stroke()

    ctx.strokeStyle = '#e8ecee'
    ctx.fillStyle = '#e8ecee'
    ctx.font = 'bold 20px "Consolas", monospace'
    ctx.textAlign = 'center'
    for (let kv = 0; kv <= 35; kv += 5) {
      const a = ang(kv)
      ctx.lineWidth = kv % 10 === 0 ? 3.6 : 1.8
      ctx.beginPath()
      ctx.moveTo(c + Math.cos(a) * (c - 46), c - Math.sin(a) * (c - 46))
      ctx.lineTo(c + Math.cos(a) * (c - 22), c - Math.sin(a) * (c - 22))
      ctx.stroke()
      if (kv % 10 === 0) {
        ctx.fillText(String(kv), c + Math.cos(a) * (c - 68), c - Math.sin(a) * (c - 68) + 7)
      }
    }
    ctx.font = 'bold 18px "Microsoft YaHei", sans-serif'
    ctx.fillText('kV', c, c + 48)
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
  return new Mesh(new PlaneGeometry(w, h), new MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0 }))
}

/**
 * 不可见的点击热区。
 *
 * 为什么需要：台面宽 1.9m，五个操作件加起来不到 3% 的面积。用户点在"看起来是
 * 按钮的位置"却有 90% 概率命中台体，反馈是"本步不需要操作"——功能在，手感像没做。
 * 热区把每个件的可点范围放大到 ~12cm，仍远小于相邻件间距，不会串味。
 *
 * 三个约束都靠 `visible = false` 满足：渲染跳过、几何自检跳过（`collectBoxes`
 * 查祖先 visible）、而 three 的 `Raycaster` **不看 visible**，照样能命中。
 */
function hotzone(
  parent: Object3D,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
): void {
  const mesh = roundedBox(w, h, d, new MeshBasicMaterial({ visible: false }), x, y, z)
  mesh.visible = false
  mesh.castShadow = false
  mesh.receiveShadow = false
  parent.add(mesh)
}

/* ------------------------------------------------------------------ 建模 */

/** 屏组件：铝色外框 + 深色内凹 + 显示面 + 屏下软键 + 顶标。
 *
 *  外框比屏高 8.5cm，多出来的那一半留在下方做软键排——实拍每块屏下面都有一排
 *  蓝色图标键，没有它，屏像贴在一块平板上。 */
function screenUnit(
  w: number,
  h: number,
  tex: CanvasTexture,
  name: string,
  bezelMat: MeshStandardMaterial,
  recessMat: MeshStandardMaterial,
  bright = 0.82,
): Group {
  const g = new Group()
  const frameH = h + 0.085
  // 材质必须克隆：悬停高亮是按材质实例改 emissive 的，
  // 共用一份 bezelMat 会让 MON 与 ATP 的框同时变蓝。
  const bezel = bezelMat.clone()
  const recess = recessMat.clone()
  g.add(roundedBox(w + 0.05, frameH, 0.024, bezel, 0, 0.018, 0.01, 0.008, 3))
  g.add(roundedBox(w + 0.016, h + 0.02, 0.008, recess, 0, 0.02, 0.019, 0.003))

  const screen = new Mesh(
    new PlaneGeometry(w, h),
    new MeshStandardMaterial({
      map: tex,
      emissiveMap: tex,
      emissive: 0xffffff,
      emissiveIntensity: bright,
      roughness: 0.14,
      metalness: 0,
    }),
  )
  screen.name = 'display'
  screen.position.set(0, 0.02, 0.025)
  g.add(screen)

  // 软键：8 个，间距按屏宽均分。它们必须压在框面上（z=0.022），不能悬空
  const kw = (w - 0.024) / 8 - 0.006
  for (let i = 0; i < 8; i += 1) {
    const x = -w / 2 + 0.012 + kw / 2 + i * ((w - 0.024) / 8)
    g.add(roundedBox(kw, 0.016, 0.006, recess, x, -h / 2 + 0.006, 0.0245, 0.002))
  }

  const plate = labelPlate(name, 0.1, 0.013)
  plate.position.set(0, frameH / 2 + 0.012, 0.023)
  g.add(plate)
  return g
}

export function buildDriverDesk(): DeviceRig {
  const root = new Group()
  const parts: Record<string, Object3D> = {}

  /* 配色取自实拍：台体浅灰、面板近黑、屏框深灰铝。 */
  const bodyMat = paintedMaterial(0x858b8c)
  const topMat = paintedMaterial(0x8d9394)
  const darkMat = paintedMaterial(0x2b2f33)
  const bezelMat = paintedMaterial(0x585e61)
  const recessMat = paintedMaterial(0x0b0e10)
  const kickMat = paintedMaterial(0x6f7476)

  /* ------------------------------------------------------------ 台体 */
  const desk = new Group()
  root.add(desk)
  parts.desk = desk

  // 踢脚：往里收 4cm，灯光下自然压出一条阴影，模型才不是"一个方块"
  desk.add(roundedBox(W - 0.12, 0.14, D - 0.10, kickMat, 0, 0.07, -0.02, 0.01))
  desk.add(roundedBox(W, 0.58, D, bodyMat, 0, 0.41, 0, 0.018, 3))
  // 台面前缘：一根横放的圆柱，做出实拍里那条圆润的扶手边
  const roll = new Mesh(new CylinderGeometry(0.03, 0.03, W + 0.01, 24), topMat)
  roll.rotation.z = Math.PI / 2
  roll.position.set(0, TOP_Y - 0.03, D / 2 - 0.012)
  desk.add(roll)
  desk.add(roundedBox(W + 0.02, 0.05, D - 0.02, topMat, 0, TOP_Y - 0.025, 0.005, 0.02, 3))
  // 前沿软包扶手：实拍里有一条深灰的软边，也是手臂搁的位置
  desk.add(roundedBox(W - 0.04, 0.028, 0.06, paintedMaterial(0x6f7576), 0, TOP_Y + 0.012, 0.30, 0.012, 3))

  /* ------------------------------------------------------------ 仪表盘（后倾整体） */
  const panel = new Group()
  panel.position.set(0, TOP_Y, PANEL_PIVOT_Z)
  panel.rotation.x = PANEL_TILT
  desk.add(panel)

  panel.add(roundedBox(W - 0.04, PANEL_H, 0.07, darkMat, 0, PANEL_H / 2, -0.035, 0.012, 3))
  // 面板与台面的接缝：一条浅色台沿，把"立起来的板"和"平放的台"收在一起
  panel.add(roundedBox(W - 0.02, 0.03, 0.10, paintedMaterial(0x767c7d), 0, 0.006, 0.05, 0.008))
  // 下沿通风槽
  panel.add(roundedBox(1.0, 0.012, 0.008, recessMat, -0.02, 0.045, 0.002, 0.003))

  /* 遮光帽檐：屏幕顶上向前伸的一整条，实拍里最显眼的特征之一 */
  panel.add(roundedBox(W - 0.02, 0.05, 0.18, darkMat, 0, 0.49, 0.075, 0.014, 3))
  panel.add(roundedBox(W - 0.04, 0.045, 0.02, darkMat, 0, 0.462, 0.165, 0.008))
  // 更上面的浅色台沿（挡风玻璃下沿的软包）
  panel.add(roundedBox(W + 0.04, 0.10, 0.22, topMat, 0, 0.56, -0.02, 0.03, 3))

  /* ------------------------------------------------------------ MON 屏 */
  const mon = new Group()
  parts.mon = mon

  const { tex: screenTex, paint } = screenSurface()
  const monUnit = screenUnit(SCR_W, SCR_H, screenTex, 'MON', bezelMat, recessMat)
  monUnit.position.set(-0.30, 0.235, 0.004)
  // 屏幕挂在后倾的面板坐标系里：世界矩阵由 panel 带过去。
  // 但 screenUnit 必须放进 parts.mon（而不是直接挂 panel）——射线拾取、
  // 悬停高亮、自动取景都按 parts 的子树算，挂错了这三件事一起失效。
  mon.add(monUnit)
  panel.add(mon)

  const atpUnit = screenUnit(ATP_W, ATP_H, atpSurface(), 'ATP', bezelMat, recessMat, 0.42)
  atpUnit.position.set(0.24, 0.225, 0.004)
  panel.add(atpUnit)
  const atpMat = (atpUnit.getObjectByName('display') as Mesh).material as MeshStandardMaterial

  // CIR 小屏：窄条，右侧。它是背景件，但缺了右边会空一大块
  panel.add(roundedBox(CIR_W + 0.04, CIR_H + 0.04, 0.02, bezelMat, 0.72, 0.25, 0.008, 0.006))
  panel.add(roundedBox(CIR_W, CIR_H, 0.008, recessMat, 0.72, 0.25, 0.02, 0.003))
  panel.add(roundedBox(CIR_W - 0.02, CIR_H - 0.02, 0.004, paintedMaterial(0x223f4f), 0.72, 0.25, 0.025, 0.002))
  const cirLabel = labelPlate('CIR', 0.06, 0.012)
  cirLabel.position.set(0.72, 0.335, 0.024)
  panel.add(cirLabel)

  // 面板中部的扬声器孔：4×5 个小圆点
  for (let r = 0; r < 5; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      const dot = new Mesh(new CylinderGeometry(0.0028, 0.0028, 0.004, 8), recessMat)
      dot.rotation.x = Math.PI / 2
      dot.position.set(0.53 + c * 0.009, 0.1 + r * 0.009, 0.002)
      panel.add(dot)
    }
  }

  // 面板左下角的检修铭牌
  const nameplate = labelPlate('TCMS', 0.08, 0.013)
  nameplate.position.set(-0.86, 0.075, 0.004)
  panel.add(nameplate)

  /* 话筒：挂板 + 手柄 + 螺旋线。上一版它压在 CIR 屏上，是明确的穿模。 */
  panel.add(roundedBox(0.06, 0.25, 0.02, darkMat, 0.895, 0.30, 0.012, 0.006))
  panel.add(roundedBox(0.05, 0.20, 0.04, rubberMaterial(0x14171a), 0.895, 0.305, 0.045, 0.014))
  panel.add(roundedBox(0.038, 0.05, 0.032, rubberMaterial(0x0f1214), 0.895, 0.225, 0.048, 0.01))
  for (let i = 0; i < 5; i += 1) {
    const ring = new Mesh(new TorusGeometry(0.019, 0.0035, 6, 18), rubberMaterial(0x101315))
    ring.rotation.x = Math.PI / 2
    ring.position.set(0.895, 0.188 - i * 0.013, 0.05)
    panel.add(ring)
  }

  /* ------------------------------------------------------------ 主控钥匙（在制动控制器上） */
  const key = new Group()
  root.add(key)
  parts.key = key

  const KEY_X = -0.44
  const KEY_Y = 0.795
  const KEY_Z = 0.214

  // 锁芯：装在制动底座前脸。锁体、锁圈、钥匙三段必须互相咬住，
  // 上一版把钥匙放在 z=0.32（底座前脸外 11cm），整串东西是悬空的。
  const lockBody = new Mesh(new CylinderGeometry(0.019, 0.019, 0.016, 22), chromeMaterial())
  lockBody.rotation.x = Math.PI / 2
  lockBody.position.set(KEY_X, KEY_Y, KEY_Z - 0.008)
  key.add(lockBody)
  const lockRing = new Mesh(new CylinderGeometry(0.026, 0.026, 0.006, 24), darkMat)
  lockRing.rotation.x = Math.PI / 2
  lockRing.position.set(KEY_X, KEY_Y, KEY_Z - 0.019)
  key.add(lockRing)

  const keyTurn = new Group()
  keyTurn.position.set(KEY_X, KEY_Y, KEY_Z)
  key.add(keyTurn)
  const shaft = new Mesh(new CylinderGeometry(0.0055, 0.0055, 0.05, 12), chromeMaterial())
  shaft.rotation.x = Math.PI / 2
  shaft.position.z = 0.024
  keyTurn.add(shaft)
  const head = roundedBox(0.032, 0.017, 0.007, chromeMaterial(), 0, 0, 0.051, 0.002)
  keyTurn.add(head)
  // 黄色标牌：实拍里钥匙上挂着一块黄色牌子，是最容易一眼认出的特征
  keyTurn.add(roundedBox(0.032, 0.05, 0.004, paintedMaterial(0xe0bb3c), 0, -0.034, 0.051, 0.002))
  hotzone(key, 0.15, 0.15, 0.17, KEY_X, KEY_Y + 0.01, KEY_Z + 0.05)

  /* ------------------------------------------------------------ 制动控制器（制动手柄） */
  const brake = new Group()
  root.add(brake)
  parts.brake = brake
  const brakeDark = darkMat.clone()

  const BR_X = KEY_X
  const BR_Z = 0.10
  const well = new Mesh(new CylinderGeometry(0.14, 0.14, 0.014, 40), paintedMaterial(0x878d8e))
  well.position.set(BR_X, TOP_Y + 0.007, BR_Z)
  brake.add(well)
  const wellInner = new Mesh(new CylinderGeometry(0.118, 0.118, 0.006, 40), paintedMaterial(0x767c7d))
  wellInner.position.set(BR_X, TOP_Y + 0.016, BR_Z)
  brake.add(wellInner)

  // 底座：圆角方墩，比上一版的椭球更像实拍里的铸件
  const brakeBase = roundedBox(0.20, 0.10, 0.20, brakeDark, BR_X, TOP_Y + 0.065, BR_Z, 0.03, 3)
  brakeBase.userData.noHover = true
  brake.add(brakeBase)
  brake.add(roundedBox(0.17, 0.012, 0.17, paintedMaterial(0x3a3f43), BR_X, TOP_Y + 0.118, BR_Z, 0.008))

  // 扇形齿板与档位刻线（拔取 / 快速 / B1–B7 / 运行）
  brake.add(roundedBox(0.11, 0.065, 0.012, recessMat.clone(), BR_X, TOP_Y + 0.13, BR_Z - 0.085, 0.004))
  for (let i = 0; i < 5; i += 1) {
    brake.add(
      roundedBox(0.004, 0.022, 0.004, chromeMaterial(), BR_X - 0.042 + i * 0.021, TOP_Y + 0.128, BR_Z - 0.092, 0.001),
    )
  }
  const brakeLabel = labelPlate('制动 快速位', 0.11, 0.014)
  brakeLabel.position.set(BR_X, TOP_Y + 0.132, BR_Z - 0.076)
  brakeLabel.rotation.x = -Math.PI / 2
  brake.add(brakeLabel)

  const lever = new Group()
  lever.position.set(BR_X, TOP_Y + 0.12, BR_Z)
  brake.add(lever)
  const arm = new Mesh(new CylinderGeometry(0.012, 0.016, 0.20, 16), chromeMaterial())
  arm.position.y = 0.10
  lever.add(arm)
  const collar = new Mesh(new CylinderGeometry(0.022, 0.024, 0.03, 20), brakeDark)
  collar.position.y = 0.015
  lever.add(collar)
  const grip = new Mesh(new SphereGeometry(0.035, 22, 16), rubberMaterial(0x15181b))
  grip.scale.set(1, 0.86, 1)
  grip.position.y = 0.215
  lever.add(grip)
  hotzone(brake, 0.22, 0.34, 0.26, BR_X, TOP_Y + 0.19, BR_Z)

  /* ------------------------------------------------------------ 受电弓切换开关（左开关盘） */
  const sw = new Group()
  root.add(sw)
  parts.switch = sw
  const swDark = darkMat.clone()

  const SW_X = -0.80
  const SW_Z = 0.0
  // 有壳体的斜面板：上一版是 16mm 薄板直接躺在台面上，像一块裸 PCB
  const swHousing = roundedBox(0.26, 0.07, 0.22, paintedMaterial(0x3c4145), SW_X, TOP_Y + 0.035, SW_Z, 0.008, 3)
  swHousing.userData.noHover = true
  sw.add(swHousing)
  const swFace = roundedBox(0.24, 0.012, 0.19, swDark, SW_X, TOP_Y + 0.078, SW_Z + 0.005, 0.004)
  swFace.rotation.x = -0.22
  swFace.userData.noHover = true
  sw.add(swFace)

  // 4 只拨动开关
  for (let i = 0; i < 4; i += 1) {
    const x = SW_X - 0.078 + i * 0.052
    sw.add(roundedBox(0.018, 0.036, 0.014, rubberMaterial(0x121416), x, TOP_Y + 0.098, SW_Z + 0.04, 0.003))
    sw.add(roundedBox(0.014, 0.022, 0.018, chromeMaterial(), x, TOP_Y + 0.09, SW_Z + 0.042, 0.002))
  }
  // 2 只小旋钮
  for (let i = 0; i < 2; i += 1) {
    const x = SW_X - 0.045 + i * 0.09
    sw.add(roundedBox(0.03, 0.014, 0.03, swDark, x, TOP_Y + 0.09, SW_Z - 0.045, 0.006))
    sw.add(roundedBox(0.008, 0.022, 0.026, chromeMaterial(), x, TOP_Y + 0.102, SW_Z - 0.045, 0.002))
  }

  // 受电弓单元选择：带指针的旋钮
  const swBody = new Mesh(new CylinderGeometry(0.03, 0.03, 0.024, 24), chromeMaterial())
  swBody.position.set(SW_X + 0.06, TOP_Y + 0.092, SW_Z - 0.045)
  sw.add(swBody)
  const swTurn = new Group()
  swTurn.position.set(SW_X + 0.06, TOP_Y + 0.106, SW_Z - 0.045)
  sw.add(swTurn)
  swTurn.add(roundedBox(0.052, 0.008, 0.012, chromeMaterial(), 0, 0, 0.016, 0.002))
  const swLabel = labelPlate('受电弓 2U / 3U', 0.14, 0.015)
  swLabel.position.set(SW_X, TOP_Y + 0.038, SW_Z + 0.111)
  sw.add(swLabel)
  hotzone(sw, 0.16, 0.14, 0.16, SW_X + 0.04, TOP_Y + 0.09, SW_Z - 0.03)

  /* ------------------------------------------------------------ 升弓旋钮 PanUS（中开关盘） */
  const knob = new Group()
  parts.knob = knob
  const knobDark = darkMat.clone()

  const KN_X = -0.10
  const KN_Z = 0.15
  const knobPanel = roundedBox(0.36, 0.035, 0.20, knobDark, -0.02, 0.012, 0.145, 0.008, 3)
  knobPanel.userData.noHover = true
  knob.add(knobPanel)
  const knobPlate = roundedBox(0.34, 0.008, 0.18, paintedMaterial(0x3a3f43), -0.02, 0.032, 0.145, 0.003)
  knobPlate.userData.noHover = true
  knob.add(knobPlate)

  const knobBase = new Mesh(new CylinderGeometry(0.036, 0.036, 0.014, 26), paintedMaterial(0x22262a))
  knobBase.position.set(KN_X, 0.04, KN_Z)
  knob.add(knobBase)
  const knobBody = new Mesh(new CylinderGeometry(0.028, 0.03, 0.026, 26), rubberMaterial(0x14171a))
  knobBody.position.set(KN_X, 0.058, KN_Z)
  knob.add(knobBody)
  const knobTurn = new Group()
  knobTurn.position.set(KN_X, 0.072, KN_Z)
  knob.add(knobTurn)
  knobTurn.add(roundedBox(0.054, 0.008, 0.014, chromeMaterial(), 0, 0, 0.017, 0.002))
  const knobLabel = labelPlate('升弓 PanUS', 0.10, 0.014)
  knobLabel.position.set(KN_X, 0.014, 0.247)
  knob.add(knobLabel)
  panel.add(knob)
  hotzone(knob, 0.12, 0.12, 0.12, KN_X, 0.07, KN_Z)

  /* ------------------------------------------------------------ VCB 按钮 */
  const vcb = new Group()
  parts.vcb = vcb

  const VC_X = 0.04
  const vcbBase = new Mesh(new CylinderGeometry(0.032, 0.032, 0.014, 26), paintedMaterial(0x22262a))
  vcbBase.position.set(VC_X, 0.04, KN_Z)
  vcb.add(vcbBase)
  const vcbButton = new Mesh(new CylinderGeometry(0.022, 0.022, 0.02, 26), lampMaterial(0x2f8f5b))
  vcbButton.position.set(VC_X, 0.056, KN_Z)
  vcb.add(vcbButton)
  const vcbLabel = labelPlate('VCB 合', 0.075, 0.014)
  vcbLabel.position.set(VC_X, 0.014, 0.247)
  vcb.add(vcbLabel)
  panel.add(vcb)
  hotzone(vcb, 0.11, 0.11, 0.11, VC_X, 0.065, KN_Z)

  /* ------------------------------------------------------------ 牵引控制器（右手侧） */
  const TR_X = 0.44
  const TR_Z = 0.10
  const trWell = new Mesh(new CylinderGeometry(0.125, 0.125, 0.014, 40), paintedMaterial(0x878d8e))
  trWell.position.set(TR_X, TOP_Y + 0.007, TR_Z)
  desk.add(trWell)
  desk.add(roundedBox(0.18, 0.09, 0.18, darkMat, TR_X, TOP_Y + 0.06, TR_Z, 0.028, 3))

  const trArm = new Mesh(new CylinderGeometry(0.012, 0.015, 0.17, 16), chromeMaterial())
  trArm.position.set(TR_X, TOP_Y + 0.16, TR_Z + 0.01)
  trArm.rotation.x = 0.12
  desk.add(trArm)
  // 实拍里牵引手柄是一块竖向的黑色握把，不是方疙瘩
  const trGrip = roundedBox(0.055, 0.13, 0.06, rubberMaterial(0x15181b), TR_X, TOP_Y + 0.255, TR_Z + 0.02, 0.024, 3)
  trGrip.rotation.x = 0.12
  desk.add(trGrip)

  // 方向手柄：右手侧靠后，小一号（背景件）
  desk.add(roundedBox(0.10, 0.03, 0.10, darkMat, 0.66, TOP_Y + 0.015, 0.04, 0.012))
  const dirArm = new Mesh(new CylinderGeometry(0.009, 0.011, 0.10, 12), chromeMaterial())
  dirArm.position.set(0.66, TOP_Y + 0.08, 0.04)
  desk.add(dirArm)
  desk.add(roundedBox(0.04, 0.05, 0.04, rubberMaterial(0x15181b), 0.66, TOP_Y + 0.145, 0.04, 0.016))

  /* ------------------------------------------------------------ 台面按钮组（左前） */
  const buttons: Array<[number, number, 'green' | 'red']> = [
    [-0.86, 0.165, 'green'],
    [-0.79, 0.165, 'green'],
    [-0.72, 0.165, 'red'],
    [-0.65, 0.165, 'red'],
  ]
  for (const [x, z, kind] of buttons) {
    desk.add(roundedBox(0.052, 0.012, 0.052, darkMat, x, TOP_Y + 0.006, z, 0.008))
    const cap = new Mesh(new CylinderGeometry(0.017, 0.017, 0.016, 20), lampMaterial(kind === 'green' ? 0x2f8f5b : 0xb03a34))
    cap.position.set(x, TOP_Y + 0.018, z)
    desk.add(cap)
  }

  /* ------------------------------------------------------------ 网压表 */
  const gauge = new Group()
  parts.gauge = gauge

  const GA_X = -0.73
  const GA_Y = 0.235
  gauge.add(roundedBox(0.17, 0.185, 0.02, darkMat.clone(), GA_X, GA_Y, 0.006, 0.006))
  const can = new Mesh(new CylinderGeometry(0.078, 0.078, 0.046, 36), paintedMaterial(0x2b2f34))
  can.rotation.x = Math.PI / 2
  can.position.set(GA_X, GA_Y, 0.036)
  gauge.add(can)
  const bezel = new Mesh(new TorusGeometry(0.078, 0.006, 10, 36), chromeMaterial())
  bezel.position.set(GA_X, GA_Y, 0.058)
  gauge.add(bezel)
  const face = new Mesh(
    new PlaneGeometry(0.15, 0.15),
    new MeshStandardMaterial({ map: gaugeFace(), roughness: 0.38, metalness: 0 }),
  )
  face.position.set(GA_X, GA_Y, 0.06)
  gauge.add(face)
  const needle = roundedBox(0.004, 0.062, 0.003, lampMaterial(0xc0392b), GA_X, GA_Y, 0.063)
  needle.geometry.translate(0, 0.031, 0)
  needle.position.set(GA_X, GA_Y - 0.002, 0.063)
  gauge.add(needle)
  const hub = new Mesh(new CylinderGeometry(0.008, 0.008, 0.008, 16), chromeMaterial())
  hub.rotation.x = Math.PI / 2
  hub.position.set(GA_X, GA_Y, 0.064)
  gauge.add(hub)
  panel.add(gauge)

  /* ------------------------------------------------------------ 右开关盘（背景） */
  desk.add(roundedBox(0.18, 0.05, 0.16, paintedMaterial(0x3c4145), 0.86, TOP_Y + 0.025, 0.02, 0.008, 3))
  for (let i = 0; i < 2; i += 1) {
    desk.add(roundedBox(0.036, 0.026, 0.02, rubberMaterial(0x121416), 0.81 + i * 0.09, TOP_Y + 0.062, 0.03, 0.004))
  }
  const rightLabel = labelPlate('空调 / 照明', 0.1, 0.014)
  rightLabel.position.set(0.86, TOP_Y + 0.045, 0.101)
  desk.add(rightLabel)

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
      // ATP 与 MON 同步上电：没插钥匙时它是暗的，否则全屏最亮的是这块背景屏
      atpMat.emissiveIntensity = state >= 2 ? 0.3 : 0.0
      // 只压 emissive 不够：贴图本身是亮的，环境光仍把它照出来
      atpMat.color.setHex(state >= 2 ? 0xffffff : 0x151a1c)
      lastState = state
    }

    // 钥匙：0.04–0.12 推入 25mm；0.12–0.22 右旋 90°（拔取位 → 运行位）
    const inserted = seg(clamped, 0.04, DESK_T.keyIn)
    const turned = seg(clamped, DESK_T.keyIn, DESK_T.keyOn)
    keyTurn.position.z = KEY_Z + 0.025 * (1 - inserted)
    keyTurn.rotation.z = (Math.PI / 2) * turned

    // 制动手柄：0.30–0.36 从制动位推到快速位（向后拉 → 向前推）
    const brakeMoved = seg(clamped, 0.3, DESK_T.brake)
    lever.rotation.x = 0.34 - 0.62 * brakeMoved

    // 受电弓切换开关：0.36–0.50 从 3U 侧旋到 2U 侧
    const unitSel = seg(clamped, DESK_T.brake, DESK_T.unit)
    swTurn.rotation.y = 0.6 - 0.6 * unitSel

    // 升弓旋钮：右旋 75°，到 0.74 之后松手回位
    const held = seg(clamped, DESK_T.unit, DESK_T.raise)
    const released = seg(clamped, DESK_T.raised - 0.06, DESK_T.raised)
    knobTurn.rotation.y = (Math.PI / 2.4) * held * (1 - released)

    // VCB：0.96 之后按下 5mm 并点亮
    const pressed = seg(clamped, 0.96, 1)
    vcbButton.position.y = 0.056 - 0.005 * pressed
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
    framing: { target: [0, 0.95, 0.0], distance: 2.3 },
    // 略俯视：台面是水平面，平视只能看到一排侧影；实拍也是从司机肩后上方看
    viewDir: [0.1, 0.4, 0.92],
    // 动的是钥匙、手柄、旋钮、按钮与屏，仪表盘与电话是背景
    focus: ['mon', 'key', 'brake', 'switch', 'knob', 'vcb', 'gauge'],
    fitMargin: 1.16,
    fov: 32,
    envIntensity: 0.95,
    dispose: () => disposeTree(root),
  }
}

/** 屏幕状态数：相位契约要覆盖每一个状态。 */
export const DESK_STATES = SCREEN.length
