/** 地铁/城轨塞拉门：参数化几何 + 动作驱动。
 *
 *  ## 形体依据
 *  公开资料里的城轨塞拉门通用形式：双扇对开、先向车外退出（塞拉）再沿车体滑移、
 *  中缝橡胶密封、上部观察窗、门框上方指示灯。尺寸取公开的通用值——
 *  门洞净宽 1.4m、净高约 1.98m、单扇约 0.7m、墙厚 90mm。
 *  这些是**演示用的示意尺寸**，不是任何车型的图纸值。
 *
 *  ## 逼真度靠什么
 *  不靠面数，靠四件事：① 钣金件全部圆角（真实件没有锐边）；② 材质分区
 *  （拉丝不锈钢外板 / 喷漆内框 / 橡胶密封 / 镀铬五金 / 深色玻璃）；
 *  ③ 分缝与层次（面板分块、窗框凸起、密封条外凸）；④ 环境反射（在 rig 里给）。
 */
import { Group, Mesh, MeshStandardMaterial, Object3D, ShadowMaterial, CylinderGeometry, SphereGeometry, PlaneGeometry } from 'three'

import type { DeviceRig } from './rig'
import {
  chromeMaterial,
  disposeTree,
  glassMaterial,
  lampMaterial,
  paintedMaterial,
  roundedBox,
  rubberMaterial,
  seg,
  steelMaterial,
  withEdges,
} from './rig'

/** 示意尺寸（米）。改这里就能整体缩放，不散落在各处。 */
const DIM = {
  openW: 1.4,
  openH: 1.98,
  /** 侧墙只留门洞两侧各 0.8m：真实车厢侧面是 4m 级，但画面里塞满墙就看不见门了。
   *  演示要的是「这扇门」，不是「这节车厢」。 */
  wallW: 3.7,
  wallH: 2.25,
  wallT: 0.09,
  leafW: 0.7,
  leafH: 1.95,
  leafT: 0.042,
  leafZ: 0.05,
  pop: 0.055,
  slide: 0.66,
  sill: 0.03,
}

const LAMP_ALARM = 0xd1483f
const LAMP_OK = 0x2f9e6a

export function buildDoor(): DeviceRig {
  const root = new Group()
  const parts: Record<string, Object3D> = {}

  /* ---------------------------------------------------------------- 侧墙 */
  // 墙面压到中深灰、门扇保持亮不锈钢：真实城轨车门就是这个关系（不锈钢门 + 涂装侧墙），
  // 顺带解决「白门贴白墙」看不出形的问题。
  const wallMat = paintedMaterial(0x8f8c84)
  const wallSideW = (DIM.wallW - DIM.openW) / 2
  const wallY = DIM.wallH / 2

  const wallL = roundedBox(wallSideW, DIM.wallH, DIM.wallT, wallMat, -(DIM.openW / 2 + wallSideW / 2), wallY, 0, 0.008)
  const wallR = roundedBox(wallSideW, DIM.wallH, DIM.wallT, wallMat, DIM.openW / 2 + wallSideW / 2, wallY, 0, 0.008)
  const headerH = DIM.wallH - DIM.openH
  const wallTop = roundedBox(DIM.openW, headerH, DIM.wallT, wallMat, 0, DIM.openH + headerH / 2, 0, 0.008)
  const sill = roundedBox(DIM.openW, DIM.sill, DIM.wallT + 0.02, paintedMaterial(0xc2bfb8), 0, DIM.sill / 2, 0, 0.006)
  root.add(wallL, wallR, wallTop, sill)

  /* ---------------------------------------------------------------- 门框 */
  // 门洞四周的包边，比墙面外凸 8mm。真实件都有这道收口，缺了会像「挖了个洞」。
  const frameMat = steelMaterial(0xa8acb0)
  const frameT = 0.028
  const frameZ = DIM.wallT / 2 + 0.004
  const frame = new Group()
  frame.add(
    roundedBox(frameT, DIM.openH, 0.02, frameMat, -(DIM.openW / 2) + frameT / 2, DIM.openH / 2, frameZ, 0.005),
    roundedBox(frameT, DIM.openH, 0.02, frameMat, DIM.openW / 2 - frameT / 2, DIM.openH / 2, frameZ, 0.005),
    roundedBox(DIM.openW, frameT, 0.02, frameMat, 0, DIM.openH - frameT / 2, frameZ, 0.005),
    roundedBox(DIM.openW, frameT, 0.02, frameMat, 0, frameT / 2 + DIM.sill, frameZ, 0.005),
  )
  // 门框四角螺栓
  const boltGeo = new CylinderGeometry(0.009, 0.009, 0.014, 12)
  const boltMat = chromeMaterial()
  for (const [bx, by] of [
    [-DIM.openW / 2 + 0.05, DIM.sill + 0.05],
    [DIM.openW / 2 - 0.05, DIM.sill + 0.05],
    [-DIM.openW / 2 + 0.05, DIM.openH - 0.05],
    [DIM.openW / 2 - 0.05, DIM.openH - 0.05],
  ]) {
    const bolt = new Mesh(boltGeo, boltMat)
    bolt.rotation.x = Math.PI / 2
    bolt.position.set(bx, by, frameZ + 0.012)
    bolt.castShadow = true
    frame.add(bolt)
  }
  parts.frame = frame
  root.add(frame)

  /* ---------------------------------------------------------------- 门扇 */
  /* 门扇用**喷漆铝板**，不是裸不锈钢。
     两条理由：① 高铁/城轨车门外表面本来就多是喷涂铝板，裸拉丝不锈钢是少数；
     ② metalness=1 的大面在 RoomEnvironment（几个自发光矩形）里只会反射出几块
     亮斑，出来的是一张暗灰带条纹的板，比喷漆件难看得多。
     teardown 的金属参数是给发动机、起落架那种裸金属机构的，不是给钣金外壳的。 */
  const buildLeaf = (dir: -1 | 1) => {
    const leaf = new Group()
    const cx = (dir * DIM.leafW) / 2
    const cy = DIM.sill + DIM.leafH / 2

    // 外板：拉丝不锈钢，两段分缝（真门板是拼接的，整块反而假）
    const skin = paintedMaterial(0xd5d8db)
    const upperH = DIM.leafH * 0.62
    const lowerH = DIM.leafH - upperH - 0.012
    /* 近白板材 + 浅色背景 = 轮廓消失。
       teardown 的规则：「Watch near-white parts on a pale backdrop:
       give them an ink outline or a darker ground」——背景已经压暗，这里再补墨线。 */
    leaf.add(
      withEdges(roundedBox(DIM.leafW, upperH, DIM.leafT, skin, 0, cy + DIM.leafH / 2 - upperH / 2, 0, 0.008, 2), 0.17),
      withEdges(roundedBox(DIM.leafW, lowerH, DIM.leafT, skin, 0, cy - DIM.leafH / 2 + lowerH / 2, 0, 0.008, 2), 0.17),
    )

    // 观察窗：深色玻璃 + 凸起窗框
    const winW = 0.5
    const winH = 0.6
    const winY = cy + 0.42
    const glass = new Mesh(new PlaneGeometry(winW, winH), glassMaterial())
    glass.position.set(0, winY, DIM.leafT / 2 + 0.002)
    leaf.add(glass)

    const bezelMat = rubberMaterial(0x1b1d20)
    const bezelT = 0.022
    const bz = DIM.leafT / 2 + 0.006
    leaf.add(
      roundedBox(winW + bezelT * 2, bezelT, 0.012, bezelMat, 0, winY + winH / 2 + bezelT / 2, bz, 0.004),
      roundedBox(winW + bezelT * 2, bezelT, 0.012, bezelMat, 0, winY - winH / 2 - bezelT / 2, bz, 0.004),
      roundedBox(bezelT, winH, 0.012, bezelMat, -(winW / 2 + bezelT / 2), winY, bz, 0.004),
      roundedBox(bezelT, winH, 0.012, bezelMat, winW / 2 + bezelT / 2, winY, bz, 0.004),
    )

    // 中缝密封条：朝中缝那一侧外凸 12mm，是塞拉门最显著的特征件
    const seal = roundedBox(0.02, DIM.leafH - 0.03, DIM.leafT + 0.024, rubberMaterial(), -dir * (DIM.leafW / 2 - 0.01), cy, 0, 0.006)
    leaf.add(seal)

    // 门扇上下沿密封
    leaf.add(
      roundedBox(DIM.leafW - 0.04, 0.014, DIM.leafT + 0.018, rubberMaterial(), 0, cy + DIM.leafH / 2 - 0.01, 0, 0.004),
      roundedBox(DIM.leafW - 0.04, 0.014, DIM.leafT + 0.018, rubberMaterial(), 0, cy - DIM.leafH / 2 + 0.01, 0, 0.004),
    )

    // 锁钩：中缝上下各一，镀铬。关闭时看得见「咬合」，开门时随门扇走。
    const lockMat = chromeMaterial()
    for (const ly of [cy + DIM.leafH / 2 - 0.18, cy - DIM.leafH / 2 + 0.18]) {
      const hook = roundedBox(0.052, 0.1, 0.026, lockMat, -dir * (DIM.leafW / 2 - 0.032), ly, DIM.leafT / 2 + 0.008, 0.006)
      leaf.add(hook)
    }

    // 内侧把手：贯穿一条，低调但能撑起「这是能拉的门」
    const handle = roundedBox(0.022, 0.34, 0.03, chromeMaterial(), -dir * (DIM.leafW / 2 - 0.07), cy - 0.12, -DIM.leafT / 2 - 0.012, 0.008)
    leaf.add(handle)

    leaf.position.set(cx, 0, DIM.leafZ)
    return leaf
  }

  const leafL = buildLeaf(-1)
  const leafR = buildLeaf(1)
  parts.leaf_l = leafL
  parts.leaf_r = leafR
  root.add(leafL, leafR)

  /* ---------------------------------------------------------------- 指示灯 */
  const lampGroup = new Group()
  const lampBase = roundedBox(0.09, 0.09, 0.03, chromeMaterial(), 0, 0, 0, 0.008)
  const lampBulb = new Mesh(new SphereGeometry(0.032, 24, 16), lampMaterial(LAMP_ALARM))
  lampBulb.position.z = 0.026
  lampBulb.castShadow = false
  lampGroup.add(lampBase, lampBulb)
  lampGroup.position.set(DIM.openW / 2 + 0.12, DIM.openH + 0.14, DIM.wallT / 2 + 0.01)
  parts.lamp = lampGroup
  root.add(lampGroup)

  /* ---------------------------------------------------------------- 车内 */
  /* 门洞后面必须有东西。没有它，门一开就是一片背景灰，看着像对着一堵墙；
     一块深色背板就能给出门的「纵深」，成本是一个平面。 */
  const interior = new Mesh(
    new PlaneGeometry(DIM.openW + 0.16, DIM.openH + 0.06),
    new MeshStandardMaterial({ color: 0x33363b, roughness: 0.92, metalness: 0 }),
  )
  interior.position.set(0, DIM.openH / 2, -0.62)
  root.add(interior)

  /* ---------------------------------------------------------------- 地面 */
  // 接影面只铺到墙下沿：24m 的大平面会整片落进阴影相机的范围外，
  // 被判定为「全在阴影里」,得到一整块莫名其妙的灰。
  /* 「A ShadowMaterial a fraction of a millimetre above the floor loses the depth
     test — give it polygonOffset」：接影面和地面本来就共面，不加偏移会闪。 */
  const floor = new Mesh(
    new PlaneGeometry(3.4, 2.6),
    new ShadowMaterial({
      opacity: 0.18,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.position.y = 0
  floor.receiveShadow = true
  root.add(floor)

  /* ---------------------------------------------------------------- 动作 */
  const setT = (t: number): void => {
    // 段一：解锁外移（塞拉）。真实塞拉门必须先退出密封面才能滑，不能直接平移。
    const pop = seg(t, 0, 0.16)
    // 段二：沿车体滑移。留 0.02 重叠量，与真门一致。
    const slide = seg(t, 0.16, 0.86)

    const z = DIM.leafZ + pop * DIM.pop
    leafL.position.set(-(DIM.leafW / 2) - slide * DIM.slide, 0, z)
    leafR.position.set(DIM.leafW / 2 + slide * DIM.slide, 0, z)

    // 指示灯：锁定到位才转绿。颜色 + emissive 一起改，缺一个就会在暗部发灰。
    const ok = t >= 0.88
    const bulb = lampBulb.material as MeshStandardMaterial
    const hex = ok ? LAMP_OK : LAMP_ALARM
    bulb.color.setHex(hex)
    bulb.emissive.setHex(hex)
  }

  const phase = (t: number): string => {
    if (t < 0.03) return '关闭锁定'
    if (t < 0.16) return '解锁外移'
    if (t < 0.86) return '门扇开启'
    if (t < 0.88) return '到位检测'
    return '完全开启'
  }

  setT(0)

  return {
    root,
    setT,
    parts,
    phase,
    // 「The machine fills 60-70% of its viewport」
    framing: { target: [0, 1.05, 0], distance: 5.25 },
    dispose: () => disposeTree(root),
  }
}
