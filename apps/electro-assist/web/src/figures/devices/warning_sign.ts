/** 安全警示牌挂牌：牌面、挂绳、操作把手、门体四件一起动。
 *
 *  ## 这一页要讲的动作
 *  第 1 步「作业前安全确认」在 2D 里只能画一张勾选清单，而现场最容易漏的
 *  恰恰是**牌挂在哪、挂正了没有**：牌挂在门边的操作把手上，才叫"隔离点已挂牌"；
 *  挂在别处、或者牌面朝里，等于没挂。
 *
 *  ## 为什么不演"从地上把牌拿起来"
 *  演示里没有操作者，凭空飘起来的牌子比"已经挂上、正在摆正"更假。
 *  所以这条时间轴从**牌已挂在把手上但歪着**开始，演到摆正、静止——
 *  这是挂牌动作里唯一能自证的一段，也是判据里"牌面朝向作业面"要看的那一段。
 *
 *  ## 形体与牌面参考
 *  电力安全标示牌「禁止合闸，有人工作！」的公开式样：白底红字、200 × 160mm，
 *  悬挂在"一经合闸即可送电到工作地点的断路器（开关）和隔离开关（刀闸）操作把手上"
 *  （见《电业安全工作规程》标示牌表；同款另有 200×100 的规格）。
 *  牌面按 5:4 画、红框红字；挂绳是红色尼龙绳，从牌顶穿线孔绕过把手。
 *  照片只用于核对比例与配色，不落进仓库——理由见 `print.ts` 头部。
 */
import {
  CatmullRomCurve3,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  TubeGeometry,
  Vector3,
} from 'three'

import type { DeviceRig } from './rig'
import {
  chromeMaterial,
  disposeTree,
  floorMaterial,
  glassMaterial,
  paintedMaterial,
  roundedBox,
  rubberMaterial,
  seg,
} from './rig'
import { facePlate, signFaceTexture } from './print'
import { phaseFor } from '../../lib/devphase'

/** 牌面：200 × 160mm，厚度取 3mm（PVC 板常见 2.5–3mm）。 */
const PLATE = { w: 0.2, h: 0.16, t: 0.003 }
/** 把手中心（门面上）。牌子挂在它下面。 */
const BAR = new Vector3(0.152, 0.78, 0.058)

export function buildWarningSign(): DeviceRig {
  const root = new Group()
  const parts: Record<string, Object3D> = {}

  const table = new Mesh(new PlaneGeometry(2.4, 2.4), floorMaterial())
  table.rotation.x = -Math.PI / 2
  table.receiveShadow = true
  root.add(table)

  /* ------------------------------------------------------------ 门体 */
  const door = new Group()
  root.add(door)
  parts.door = door

  // 门扇：1.2m 高、0.5m 宽的单扇门（只看下半截，画面才给得到牌子）
  const leaf = roundedBox(0.5, 1.2, 0.04, paintedMaterial(0xd9d7d1), 0, 0.6, 0, 0.008, 3)
  door.add(leaf)

  // 观察窗：位置抬高到画面外沿，露一条边就够，读者认得出这是门
  const glass = roundedBox(0.26, 0.02, 0.044, glassMaterial(), 0, 1.19, 0, 0.004)
  door.add(glass)

  // 门框：左侧固定框，比门扇深一档色，用来交代"门与墙的关系"
  door.add(roundedBox(0.06, 1.3, 0.08, paintedMaterial(0xb9b7b1), -0.29, 0.65, -0.01, 0.008))

  // 门槛压条
  door.add(roundedBox(0.52, 0.02, 0.06, rubberMaterial(0x24262a), 0, 0.01, 0.004, 0.004))

  // 前缘密封条：塞拉门的密封面就在这条边上，牌子挂在它旁边才有意义
  door.add(roundedBox(0.014, 1.16, 0.05, rubberMaterial(0x2a2c30), 0.245, 0.6, 0, 0.004))

  // 把手底座两块 + 一根横杆（不锈钢，现场绝大多数是这种）
  const handle = new Group()
  door.add(handle)
  parts.handle = handle

  const standoffMat = chromeMaterial()
  for (const dx of [-0.05, 0.05]) {
    const post = new Mesh(new CylinderGeometry(0.008, 0.008, 0.045, 14), standoffMat)
    post.rotation.x = Math.PI / 2
    post.position.set(BAR.x + dx, BAR.y, BAR.z - 0.026)
    handle.add(post)
  }
  const bar = new Mesh(new CylinderGeometry(0.0095, 0.0095, 0.13, 18), standoffMat)
  bar.rotation.z = Math.PI / 2
  bar.position.copy(BAR)
  bar.castShadow = true
  handle.add(bar)

  /* ------------------------------------------------------------ 牌面 */
  const plateGroup = new Group()
  root.add(plateGroup)
  parts.plate = plateGroup

  const plateMat = new MeshStandardMaterial({ color: 0xf2f0ea, metalness: 0, roughness: 0.55 })
  // 原点放在穿绳孔上：牌是"吊"着的，绕孔摆动的
  const board = roundedBox(PLATE.w, PLATE.h, PLATE.t, plateMat, 0, -PLATE.h / 2 - 0.008, 0, 0.002)
  plateGroup.add(board)

  const face = facePlate(PLATE.w - 0.004, PLATE.h - 0.004, signFaceTexture(), {
    roughness: 0.5,
    doubleSide: true,
  })
  face.position.set(0, -PLATE.h / 2 - 0.008, PLATE.t / 2 + 0.0008)
  plateGroup.add(face)

  // 穿绳孔：一个金属护圈，绳子从这里穿过去
  const eyelet = new Mesh(new CylinderGeometry(0.0055, 0.0055, 0.005, 16), chromeMaterial())
  eyelet.rotation.x = Math.PI / 2
  eyelet.position.set(0, -0.004, 0)
  plateGroup.add(eyelet)

  /* ------------------------------------------------------------ 挂绳 */
  const cordMat = new MeshStandardMaterial({ color: 0xb42a2e, metalness: 0.02, roughness: 0.85 })
  const cord = new Mesh(new TubeGeometry(new CatmullRomCurve3([BAR, BAR, BAR]), 24, 0.0018, 6, false), cordMat)
  cord.castShadow = true
  root.add(cord)
  parts.cord = cord

  const lastHole = new Vector3(1, 1, 1)
  /** 绳从孔 → 绕过横杆 → 回孔。孔一动就重建，绳才真是"挂着"的。 */
  const updateCord = (hole: Vector3, slack: number): void => {
    if (lastHole.distanceToSquared(hole) < 1e-8 && slack < 1e-6) return
    lastHole.copy(hole)
    const bend = 0.006 + slack * 0.02
    const curve = new CatmullRomCurve3(
      [
        hole,
        new Vector3(hole.x - 0.008, hole.y + bend, hole.z + 0.004),
        new Vector3(BAR.x - 0.012, BAR.y - 0.004, BAR.z + 0.012),
        new Vector3(BAR.x, BAR.y + 0.0105, BAR.z + 0.004),
        new Vector3(BAR.x + 0.012, BAR.y - 0.004, BAR.z + 0.012),
        new Vector3(hole.x + 0.008, hole.y + bend, hole.z + 0.004),
        hole,
      ],
      false,
      'catmullrom',
      0.35,
    )
    cord.geometry.dispose()
    cord.geometry = new TubeGeometry(curve, 40, 0.0018, 6, false)
  }

  /* ------------------------------------------------------------ 动作 */
  const hole = new Vector3()
  const SLACK = { x: 0.038, y: 0.1, z: 0.05 }
  const HANG = { x: 0, y: 0.128, z: 0.012 }

  const setT = (t: number): void => {
    // 挂正：把手内侧滑入 → 牌离手下落 → 摆正
    const seated = seg(t, 0.0, 0.4)
    const dropped = seg(t, 0.4, 0.62)

    hole.set(
      BAR.x + SLACK.x * (1 - seated),
      BAR.y - SLACK.y - (HANG.y - SLACK.y) * dropped,
      BAR.z + SLACK.z - (SLACK.z - HANG.z) * seated,
    )
    plateGroup.position.copy(hole)

    /* 摆正 + 摆动衰减：悬挂件离手后必然摆几下。
       用解析式而不是物理积分，是为了让同一 t 永远得到同一帧——截图与打印要可复现。 */
    const tilt = 0.42 * (1 - seated)
    const since = Math.max(0, t - 0.62)
    const swing = t < 0.62 ? 0 : 0.16 * Math.sin(since * 34) * Math.exp(-11 * since)
    plateGroup.rotation.z = tilt + swing
    // 牌面略微转向镜头：正对作业面的意思，不是"摆拍"
    plateGroup.rotation.y = -0.18 * (1 - seg(t, 0.6, 0.9))

    updateCord(hole, 1 - seated)
  }

  /* 阶段文案的唯一来源在 `lib/devphase.ts`：同一句话不该在这里再写一遍。
     2026-11-12 评审 R11-6：三维侧与读数侧各写一份，`door` 已经漂成
     "三维说完全开启、界面说到位检测"。阈值改动请改 devphase 的常量。 */
  const phase = (t: number): string => phaseFor('warning_sign', t)

  setT(0)
  root.updateMatrixWorld(true)

  return {
    root,
    setT,
    parts,
    phase,
    fov: 32,
    envIntensity: 1.15,
    // 0.98：整页布局里画布是 3:2 以下的扁比例，0.84 会把牌面下沿切掉
    framing: { target: [0.14, 0.645, 0.03], distance: 0.98 },
    /* 机位几乎正对门面（方位角 5°）：牌面是平面，默认 34° 的斜视会把文字
       透视成歪的（上一次改成 20° 仍然看得出斜），而这一步要读的就是牌上的字。 */
    viewDir: [0.09, 0.22, 0.97],
    /* 这一步要看的是「牌面写什么」和「绳怎么绕过把手」。门板只是背景。 */
    focus: ['plate', 'cord', 'handle'],
    fitMargin: 1.22,
    dispose: () => disposeTree(root),
  }
}
