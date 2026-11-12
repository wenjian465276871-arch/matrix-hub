/** 力矩扳手复紧门机螺栓：套筒落位、施力、到值咔嗒、复检。
 *
 *  ## 这一页要讲的动作
 *  「门机安装螺栓复紧」的判据是 25 ± 2 N·m，而现场最容易错的两件事都在手上：
 *  **套筒没坐到底就施力**（打滑、六角头受伤）与**没听到咔嗒就继续加力**
 *  （预置式扳手已脱扣，再拧下去读数不再增加，反而把螺栓拧过）。
 *  这两件在 2D 的 torque_gauge 里完全看不见。
 *
 *  ## 「咔嗒」怎么表现
 *  声音不能画，就用三个可见信号：手柄**回弹约 4°**、刻度窗的指针停在设定值、
 *  刻度窗短促亮一下。三者同时发生才是"到值脱扣"，只亮一下会像装饰。
 *
 *  ## 形体参考
 *  预置式（click-type）力矩扳手的通用形式：镀铬方杆 + 黑色滚花握把 +
 *  握把上的刻度窗 + 棘轮头 + 六角套筒。比例按公开产品图核对，
 *  刻度窗的文字按实物排（每 4 N·m 一格），不贴照片——理由见 `print.ts` 头部。
 */
import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from 'three'

import type { DeviceRig } from './rig'
import {
  chromeMaterial,
  disposeTree,
  paintedMaterial,
  roundedBox,
  rubberMaterial,
  seg,
  steelMaterial,
} from './rig'
import { facePlate, setGlow, torqueScaleTexture } from './print'
import { phaseFor } from '../../lib/devphase'

/** 螺栓轴心（世界坐标）与设定扭矩。 */
const BOLT = new Vector3(0, 0.092, 0)
const TARGET = 25
/** 手柄初始角度与终了角度（绕 z）：约 50° 的施力行程。 */
const A0 = 0.55
const A1 = -0.32

export function buildTorqueWrench(): DeviceRig {
  const root = new Group()
  const parts: Record<string, Object3D> = {}

  /* ---------------------------------------------------------- 安装座 */
  const bracket = new Group()
  root.add(bracket)
  parts.bracket = bracket

  // 门机安装座：一块立板 + 一条加强筋，螺栓从这里穿过去
  bracket.add(roundedBox(0.26, 0.15, 0.024, paintedMaterial(0xc9c7c1), 0, 0.088, -0.045, 0.006, 3))
  bracket.add(roundedBox(0.24, 0.016, 0.06, steelMaterial(0xb0b4b8), 0, 0.012, -0.02, 0.004))

  /* ---- 螺栓：六角头 + 垫圈 + 螺杆 ---- */
  const bolt = new Group()
  bolt.position.copy(BOLT)
  root.add(bolt)
  parts.bolt = bolt

  const head = new Mesh(new CylinderGeometry(0.0115, 0.0115, 0.008, 6), steelMaterial(0xa9adb2))
  head.rotation.x = Math.PI / 2
  head.position.z = -0.012
  head.castShadow = true
  bolt.add(head)

  const washer = new Mesh(new CylinderGeometry(0.014, 0.014, 0.0022, 20), chromeMaterial())
  washer.rotation.x = Math.PI / 2
  washer.position.z = -0.0175
  bolt.add(washer)

  const shank = new Mesh(new CylinderGeometry(0.0075, 0.0075, 0.03, 14), steelMaterial(0x8f9499))
  shank.rotation.x = Math.PI / 2
  shank.position.z = -0.032
  bolt.add(shank)

  // 旁边一颗已复紧的螺栓：给"这里是一组螺栓"的上下文
  const other = new Group()
  /* z 从 0 挪到 -0.017：安装座正面在 z=-0.033，螺栓头半厚 0.004，
     原来整颗头浮在座子前面 17mm（自检抓到的）。 */
  other.position.set(-0.085, 0.092, -0.017)
  other.add(new Mesh(new CylinderGeometry(0.0115, 0.0115, 0.008, 6), steelMaterial(0xa9adb2)))
  const otherHead = other.children[0] as Mesh
  otherHead.rotation.x = Math.PI / 2
  otherHead.position.z = -0.012
  bracket.add(other)

  /* ------------------------------------------------------------ 套筒 */
  const socket = new Group()
  root.add(socket)
  parts.socket = socket

  const socketBody = new Mesh(new CylinderGeometry(0.019, 0.019, 0.03, 12), new MeshStandardMaterial({
    color: 0x3a3d42,
    metalness: 0.85,
    roughness: 0.38,
  }))
  socketBody.rotation.x = Math.PI / 2
  socket.add(socketBody)

  // 六角口：用一圈小平面暗示，不必真做挖空
  const mouth = new Mesh(new CylinderGeometry(0.0135, 0.0135, 0.004, 6), new MeshStandardMaterial({
    color: 0x14161a,
    metalness: 0.5,
    roughness: 0.7,
  }))
  mouth.rotation.x = Math.PI / 2
  mouth.position.z = -0.014
  socket.add(mouth)

  /* ------------------------------------------------------------ 扳手 */
  const wrench = new Group()
  wrench.position.copy(BOLT)
  wrench.position.z = 0.032
  root.add(wrench)
  parts.wrench = wrench

  // 棘轮头
  const ratchet = new Mesh(new CylinderGeometry(0.023, 0.023, 0.018, 20), chromeMaterial())
  ratchet.rotation.x = Math.PI / 2
  ratchet.castShadow = true
  wrench.add(ratchet)

  // 方杆：从棘轮头沿 +x 伸出
  const shaft = new Mesh(new CylinderGeometry(0.008, 0.008, 0.2, 14), chromeMaterial())
  shaft.rotation.z = Math.PI / 2
  shaft.position.x = 0.115
  shaft.castShadow = true
  wrench.add(shaft)

  // 握把：黑色滚花橡胶
  const grip = roundedBox(0.13, 0.026, 0.019, rubberMaterial(0x2a2c30), 0.225, 0, 0, 0.006)
  wrench.add(grip)

  // 尾端挡圈：真扳手都有，防止手滑出去
  const endCap = new Mesh(new CylinderGeometry(0.016, 0.016, 0.008, 16), rubberMaterial(0x1c1e21))
  endCap.rotation.z = Math.PI / 2
  endCap.position.x = 0.292
  wrench.add(endCap)

  /* ---- 刻度窗 ---- */
  const windowGroup = new Group()
  windowGroup.position.set(0.2, 0.011, 0.008)
  wrench.add(windowGroup)
  parts.window = windowGroup

  windowGroup.add(roundedBox(0.062, 0.018, 0.003, new MeshStandardMaterial({
    color: 0x14161a,
    metalness: 0.2,
    roughness: 0.5,
  }), 0, 0, 0, 0.002))

  const scale = facePlate(0.058, 0.0145, torqueScaleTexture(), { glow: 0.05, roughness: 0.3 })
  scale.position.z = 0.0018
  windowGroup.add(scale)

  // 指针：随扭矩沿刻度窗平移
  const needle = roundedBox(0.0022, 0.012, 0.001, new MeshStandardMaterial({
    color: 0xd1483f,
    emissive: 0xd1483f,
    emissiveIntensity: 0.25,
    roughness: 0.5,
  }), -0.026, 0, 0.0026, 0.0006)
  windowGroup.add(needle)

  /* ------------------------------------------------------------ 动作 */
  const setT = (t: number): void => {
    const seated = seg(t, 0, 0.42)
    const loaded = seg(t, 0.42, 0.7)
    const click = seg(t, 0.78, 0.86)
    const away = seg(t, 0.92, 1)

    // 套筒：从螺栓上方落下、坐到底
    socket.position.copy(BOLT)
    socket.position.z = 0.006 + 0.055 * (1 - seated) + 0.05 * away
    socket.rotation.z = 0.12 * (1 - seated)

    // 扳手：先落位，再绕螺栓轴转；到值后回弹 4°（预置式脱扣的可见证据）
    const angle = A0 + (A1 - A0) * loaded + 0.07 * click + 0.5 * away
    const lift = 0.055 * (1 - seated) + 0.05 * away
    wrench.position.set(BOLT.x, BOLT.y + lift, 0.032 + 0.03 * (1 - seated) + 0.02 * away)
    wrench.rotation.z = angle
    // 施力时扳手平面必须与螺栓轴垂直：侧倾一点，套筒就会咬偏
    wrench.rotation.x = -0.06 * loaded * (1 - click)

    // 螺栓跟着扳手转（60° 行程），到值后停住——它已经贴紧了
    bolt.rotation.z = (A0 - angle) * 0.9 * (1 - click) * 0.6

    // 指针：0 → 25 N·m，与角度同步；咔嗒后停在满格
    const torque = TARGET * Math.min(1, loaded * 0.94 + click * 0.06)
    const p = torque / 40 // 刻度窗是 10–50 N·m
    needle.position.x = -0.026 + 0.052 * p

    // 刻度窗亮一下：0.12 秒的短促提示，与回弹同一个时间点
    const flash = t >= 0.8 && t <= 0.9 ? Math.sin(((t - 0.8) / 0.1) * Math.PI) : 0
    setGlow(scale, 0.05 + 0.55 * flash)
  }

  /* 阶段文案的唯一来源在 `lib/devphase.ts`：同一句话不该在这里再写一遍。
     2026-11-12 评审 R11-6：三维侧与读数侧各写一份，`door` 已经漂成
     "三维说完全开启、界面说到位检测"。阈值改动请改 devphase 的常量。 */
  const phase = (t: number): string => phaseFor('torque_wrench', t)

  setT(0)
  root.updateMatrixWorld(true)

  return {
    root,
    setT,
    parts,
    phase,
    fov: 30,
    envIntensity: 1.05,
    framing: { target: [0.085, 0.095, 0.05], distance: 0.66 },
    /* 要看的是「套筒咬住螺母」与「刻度窗读数」，支架只是背景。 */
    focus: ['socket', 'window', 'wrench'],
    fitMargin: 1.2,
    dispose: () => disposeTree(root),
  }
}
