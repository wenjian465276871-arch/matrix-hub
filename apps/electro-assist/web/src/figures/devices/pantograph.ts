/** 单臂受电弓：参数化几何 + 连杆机构驱动。
 *
 *  ## 形体依据
 *  公开资料里单臂受电弓的通用结构：底架 + 四个复合绝缘子支撑、
 *  两根主臂（下臂）由底部铰点向后上方伸出、两根平衡臂（上臂）由主臂顶端折向前上方、
 *  顶端弓头带两根滑板与两端弓角。工作高度约 1.5–2.8m（相对车顶）。
 *  这些是**演示用的示意尺寸**，不代表任何车型图纸。
 *
 *  ## 为什么是双杆
 *  受电弓是左右对称的双臂机构，画成单杆会立刻失去辨识度。
 *  代价是动作要把两个铰点的坐标都算一遍——但杆长恒定，只有角度在变，算起来是廉价的。
 *
 *  ## 与车门的关键区别
 *  车门是「先退后滑」的平移，受电弓是**纯转动**：两根杆各绕一个铰点转，杆长不变。
 *  所以这里用 `placeStrut` 摆两端点，绝不对杆做缩放——缩放出来的杆会变细，一眼假。
 */
import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
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
  seg,
  steelMaterial,
  strut,
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

const LAMP_LOW = 0x8a8f96
const LAMP_OK = 0x2f9e6a

const deg = (value: number): number => (value * Math.PI) / 180

export function buildPantograph(): DeviceRig {
  const root = new Group()
  const parts: Record<string, Object3D> = {}

  /* ---------------------------------------------------------------- 底架 */
  const frameMat = paintedMaterial(0x8f9296)
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

  /* ---------------------------------------------------------------- 杆件 */
  const armMat = steelMaterial(0xc4c8cc)
  const tieMat = chromeMaterial()

  const lowerL = strut(DIM.lower, 0.052, armMat)
  const lowerR = strut(DIM.lower, 0.052, armMat)
  const upperL = strut(DIM.upper, 0.046, armMat)
  const upperR = strut(DIM.upper, 0.046, armMat)

  // 下臂中部的横撑，两根臂之间的连接件
  const braceLow = roundedBox(0.9, 0.045, 0.05, chromeMaterial(), 0, 0, 0, 0.008)
  const braceUp = roundedBox(0.9, 0.04, 0.045, chromeMaterial(), 0, 0, 0, 0.008)

  const arms = new Group()
  arms.add(lowerL, lowerR, upperL, upperR, braceLow, braceUp)
  parts.arms = arms
  root.add(arms)

  /* ---------------------------------------------------------------- 弓头 */
  const head = new Group()
  const shoeBody = roundedBox(DIM.headHalf * 2, 0.055, 0.1, steelMaterial(0xb6babe), 0, 0, 0, 0.01)
  head.add(shoeBody)

  // 两根滑板：真正与接触线摩擦的部分，材质偏深、粗糙
  const carbon = new MeshStandardMaterial({ color: 0x2b2d31, metalness: 0.1, roughness: 0.68 })
  for (const z of [-0.1, 0.1]) {
    head.add(roundedBox(DIM.headHalf * 1.86, 0.032, 0.05, carbon, 0, 0.042, z, 0.008))
  }
  // 弓头两端支撑
  for (const x of [-0.72, 0.72]) {
    head.add(roundedBox(0.06, 0.09, 0.26, chromeMaterial(), x, -0.05, 0, 0.01))
  }

  /* 弓角：两端向上外翘的羊角，作用是接触线偏移时把它导向滑板。
     没有它，弓头就是一根光秃秃的横杆。 */
  for (const sign of [-1, 1]) {
    const horn = strut(0.26, 0.016, tieMat)
    head.add(horn)
    horn.userData.sign = sign
  }
  parts.head = head
  root.add(head)

  const horns: Mesh[] = head.children.filter((c) => c.userData.sign !== undefined) as Mesh[]

  /* ---------------------------------------------------------------- 指示灯 */
  const lampBulb = new Mesh(
    new SphereGeometry(0.045, 20, 14),
    lampMaterial(LAMP_LOW),
  )
  lampBulb.position.set(0.62, DIM.deck + 0.16, 0.9)
  const lampBase = roundedBox(0.11, 0.06, 0.11, chromeMaterial(), 0.62, DIM.deck + 0.09, 0.9, 0.01)
  parts.lamp = new Group()
  ;(parts.lamp as Group).add(lampBase, lampBulb)
  root.add(parts.lamp)

  /* ---------------------------------------------------------------- 机构 */
  const p0L = new Vector3(-DIM.armX, DIM.deck + 0.02, DIM.pivotZ)
  const p0R = new Vector3(DIM.armX, DIM.deck + 0.02, DIM.pivotZ)

  const p1L = new Vector3()
  const p1R = new Vector3()
  const p2 = new Vector3()

  const setT = (t: number): void => {
    // 升弓是一个连续动作，留 0.05 的起止缓冲让「起」和「到」都不突兀。
    const p = seg(t, 0.08, 0.9)

    const a1 = deg(8 + (56 - 8) * p)
    const a2 = deg(16 + (62 - 16) * p)

    p1L.set(-DIM.armX, p0L.y + DIM.lower * Math.sin(a1), p0L.z - DIM.lower * Math.cos(a1))
    p1R.set(DIM.armX, p1L.y, p1L.z)

    // 弓头取左右两臂的中间高度，保证它始终水平——受电弓的弓头不跟着杆转。
    p2.set(
      0,
      p1L.y + DIM.upper * Math.sin(a2),
      p1L.z + DIM.upper * Math.cos(a2),
    )

    placeStrut(lowerL, p0L, p1L)
    placeStrut(lowerR, p0R, p1R)
    placeStrut(upperL, p1L, p2)
    placeStrut(upperR, p1R, p2)

    // 横撑位置随臂中段走
    braceLow.position.set(0, (p0L.y + p1L.y) / 2, (p0L.z + p1L.z) / 2)
    braceUp.position.set(0, (p1L.y + p2.y) / 2, (p1L.z + p2.z) / 2)

    head.position.copy(p2)
    // 弓角：从滑板端头向外上方翘起
    for (const horn of horns) {
      const sign = horn.userData.sign as number
      const from = new Vector3(sign * DIM.headHalf, 0.02, 0)
      const to = new Vector3(sign * (DIM.headHalf + 0.15), 0.17, 0)
      placeStrut(horn, from, to)
    }

    // 指示灯：升弓到位才转绿。未到位保持中性灰，不要用红色——红光表示故障，语义不对。
    const ok = t >= 0.92
    const bulb = lampBulb.material as MeshStandardMaterial
    const hex = ok ? LAMP_OK : LAMP_LOW
    bulb.color.setHex(hex)
    bulb.emissive.setHex(hex)
    bulb.emissiveIntensity = ok ? 1.4 : 0.05
  }

  const phase = (t: number): string => {
    if (t < 0.08) return '落弓锁定'
    if (t < 0.9) return '升弓中'
    if (t < 0.92) return '到位检测'
    return '升弓到位'
  }

  setT(0)

  return {
    root,
    setT,
    parts,
    phase,
    framing: { target: [0, 1.2, 0], distance: 5.4 },
    // 镜头跟着弓头走：收弓时贴近、升弓时拉开，两个姿态都不会缩成一点或顶出画面
    framingAt: (t: number) => {
      const p = seg(t, 0.08, 0.9)
      return {
        target: [0, 0.5 + 0.95 * p, 0],
        distance: 3.6 + 3.2 * p,
      }
    },
    dispose: () => disposeTree(root),
  }
}
