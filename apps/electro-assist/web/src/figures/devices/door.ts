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
import {
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  ShadowMaterial,
  SphereGeometry,
} from 'three'

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

/**
 * 同步带齿形：一格一颗齿。滚 offset.x 就是带子在跑。
 * 齿距按 14mm 算，0.86m 的带段上大约 60 颗——和真机的 HTD 5M 皮带量级接近。
 */
let teethTexture: CanvasTexture | null = null
function beltTeeth(): CanvasTexture {
  if (teethTexture) return teethTexture.clone()
  const size = 32
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    /* 纹理本身画成深色：材质基色是白的，最终颜色 = 基色 × 纹理。
       若基色取近黑再把灰齿乘上去，齿纹会黑成一整条——第一版就是这么废的。 */
    ctx.fillStyle = '#22252a'
    ctx.fillRect(0, 0, size, size)
    ctx.fillStyle = '#4d535a'
    ctx.fillRect(0, 0, size * 0.42, size)
    ctx.fillStyle = '#6b727a'
    ctx.fillRect(0, size * 0.2, size * 0.42, size * 0.6)
  }
  const tex = new CanvasTexture(canvas)
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.colorSpace = SRGBColorSpace
  tex.repeat.set(0.86 / 0.042, 1)
  teethTexture = tex
  /* clone() 不会带上 upload 标记，不显式置 needsUpdate 的话纹理永远不上传，
     材质就退回纯色——第一版整条带子发白就是这么来的。 */
  const copy = tex.clone()
  copy.needsUpdate = true
  return copy
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
  /* 门楣不是一整块：真实塞拉门的门机、导轨、丝杠都装在门楣里，
     外表面只是一块可拆的检修盖板。这里把盖板「打开」——
     后半留实墙，前上留一道压条，中间就是设备舱。
     这么做有两个收益：① 门机默认可见，不必先剖切才能看到；② 剖切时有东西可切。 */
  const headerH = DIM.wallH - DIM.openH
  const wallTopBack = roundedBox(DIM.openW, headerH, 0.055, wallMat, 0, DIM.openH + headerH / 2, -0.0175, 0.008)
  const wallTopFront = roundedBox(DIM.openW, 0.06, 0.035, wallMat, 0, DIM.wallH - 0.03, 0.0275, 0.006)
  const wallTop = new Group()
  wallTop.add(wallTopBack, wallTopFront)
  const sill = roundedBox(DIM.openW, DIM.sill, DIM.wallT + 0.02, paintedMaterial(0xc2bfb8), 0, DIM.sill / 2, 0, 0.006)
  root.add(wallL, wallR, wallTop, sill)

  /* ------------------------------------------------------- 墙板分缝与紧固件 */
  /* 一大片纯色平板是「CG 感」最强的来源。真实侧墙由多块板拼成，
     板与板之间有分缝，缝里能看到固定螺钉。这里只加两样最便宜的：
     竖向分缝 + 缝内螺钉，视觉密度立刻不一样。 */
  const seamMat = paintedMaterial(0x6f6c65)
  for (const dir of [-1, 1]) {
    const cx = dir * (DIM.openW / 2 + wallSideW / 2)
    // 每侧两道竖向分缝
    for (const off of [-wallSideW / 6, wallSideW / 6]) {
      const seam = roundedBox(0.006, DIM.wallH - 0.02, 0.004, seamMat, cx + off, DIM.wallH / 2, DIM.wallT / 2, 0.001)
      root.add(seam)
      for (let i = 0; i < 5; i += 1) {
        const screw = new Mesh(new CylinderGeometry(0.0055, 0.0055, 0.004, 10), chromeMaterial())
        screw.rotation.x = Math.PI / 2
        screw.position.set(cx + off, 0.22 + i * 0.46, DIM.wallT / 2 + 0.004)
        root.add(screw)
      }
    }
    // 腰线：一条水平分缝，把墙分成上下两段
    root.add(roundedBox(wallSideW, 0.006, 0.004, seamMat, cx, 1.28, DIM.wallT / 2, 0.001))
  }

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
  const boltSpots: [number, number][] = []
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 5; i += 1) {
      boltSpots.push([sx * (DIM.openW / 2 - 0.05), DIM.sill + 0.06 + i * (DIM.openH - 0.12) / 4])
    }
  }
  for (const [bx, by] of boltSpots) {
    const bolt = new Mesh(boltGeo, boltMat)
    bolt.rotation.x = Math.PI / 2
    bolt.position.set(bx, by, frameZ + 0.012)
    bolt.castShadow = true
    frame.add(bolt)
  }
  parts.frame = frame
  root.add(frame)

  // 门槛压条：一条镀铬槽，门下沿的导柱就插在这条槽里
  root.add(
    roundedBox(DIM.openW - 0.02, 0.006, 0.055, chromeMaterial(), 0, DIM.sill + 0.006, 0.018, 0.003),
    roundedBox(DIM.openW - 0.02, 0.004, 0.012, rubberMaterial(0x1b1d20), 0, DIM.sill + 0.01, 0.018, 0.002),
  )

  /* 铭牌：一块小金属牌 + 两颗螺钉。细节密度就是这么一点一点堆出来的，
     少了它，整面墙就是一块刷了漆的铁皮。 */
  const plateX = DIM.openW / 2 + 0.3
  root.add(roundedBox(0.12, 0.06, 0.004, steelMaterial(0xc2c7cc), plateX, 1.46, DIM.wallT / 2 + 0.003, 0.002))
  for (const px of [plateX - 0.045, plateX + 0.045]) {
    const rivet = new Mesh(new CylinderGeometry(0.004, 0.004, 0.003, 8), chromeMaterial())
    rivet.rotation.x = Math.PI / 2
    rivet.position.set(px, 1.46, DIM.wallT / 2 + 0.006)
    root.add(rivet)
  }

  /* ---------------------------------------------------------------- 门机 */
  /* 一套单臂式门机：电机 + 减速箱 + 同步带 + 张紧轮 + 导轨 + 携门架。
     这是塞拉门真正的「内脏」，也是电气调试里最先要确认动作时序的部件。
     参数仍是示意值，但结构关系照真件摆：电机在左端、皮带横穿门楣、
     两个携门架挂在同一条导轨上。 */
  const op = new Group()
  const pulleys: Mesh[] = []
  const bayZ = 0.022
  const bayY = DIM.openH + headerH / 2

  // 舱底衬板：压深一档，否则门楣里是一片和墙同色的白，看不出深度
  op.add(roundedBox(DIM.openW - 0.012, headerH - 0.012, 0.004, paintedMaterial(0x2b2e33), 0, bayY, 0.012, 0.002))

  // 导轨：横贯门楣的圆钢，携门架挂在上面
  const railMat = steelMaterial(0x9aa0a6)
  const rail = new Mesh(new CylinderGeometry(0.011, 0.011, DIM.openW - 0.09, 14), railMat)
  rail.rotation.z = Math.PI / 2
  rail.position.set(0, DIM.openH + 0.062, bayZ + 0.006)
  op.add(rail)
  for (const rx of [-0.58, -0.2, 0.2, 0.58]) {
    op.add(roundedBox(0.028, 0.05, 0.026, railMat, rx, DIM.openH + 0.088, bayZ + 0.006, 0.006))
  }

  // 电机（带散热筋）+ 减速箱
  const motorMat = paintedMaterial(0x34383f)
  const motor = new Mesh(new CylinderGeometry(0.04, 0.04, 0.15, 22), motorMat)
  motor.rotation.z = Math.PI / 2
  motor.position.set(-0.46, DIM.openH + 0.15, bayZ + 0.002)
  op.add(motor)
  for (let i = -3; i <= 3; i += 1) {
    const fin = new Mesh(new CylinderGeometry(0.044, 0.044, 0.008, 22), steelMaterial(0x767b82))
    fin.rotation.z = Math.PI / 2
    fin.position.set(-0.46 + i * 0.019, DIM.openH + 0.15, bayZ + 0.002)
    op.add(fin)
  }
  op.add(roundedBox(0.15, 0.12, 0.06, paintedMaterial(0x3d424a), -0.33, DIM.openH + 0.14, bayZ, 0.008))

  // 同步带：两条直线段 + 两端带轮
  /* 同步带要能在门开合时跑起来：给带面贴一张齿形纹理，靠 offset.x 滚动。
     带轮同步自转（带子走多少 = 轮子转过多少弧长），两者速率对不上就会看出打滑。

     **没有做携门架**：门扇行程 0.66m，滑到位时已经越过门楣里的导轨端头；
     再加一个「骑在导轨上」的滚轮座，它会明摆着悬在导轨外面。
     真机是靠墙里的门袋把门扇和携门架一起收进去的——那要连墙体一起改，
     不是加个零件能解决的。宁可少一个零件，也不要一个看起来错的机构。
     上下两段必须**反向**滚动——它们是同一条带子的两边，同向滚就等于两条独立的带子。 */
  const beltMatUpper = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0,
    map: beltTeeth(),
  })
  const beltMatLower = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0,
    map: beltTeeth(),
  })
  const beltY = DIM.openH + 0.15
  op.add(
    roundedBox(0.86, 0.008, 0.022, beltMatUpper, 0.09, beltY + 0.028, bayZ, 0.003),
    roundedBox(0.86, 0.008, 0.022, beltMatLower, 0.09, beltY - 0.028, bayZ, 0.003),
  )
  for (const px of [-0.34, 0.52]) {
    /* 带轮包一层枢轴：外层负责把圆柱摆成横向（绕 Z 转 90°），
       内层绕自己的 Y 轴自转——直接在外层上转 Y 会连带把整根轴翻掉。
       轮面加一根标记条，否则光滑圆柱转不转看不出来。 */
    const pivot = new Group()
    pivot.position.set(px, beltY, bayZ)
    pivot.rotation.z = Math.PI / 2
    const pulley = new Mesh(new CylinderGeometry(0.032, 0.032, 0.026, 18), steelMaterial(0xb4b9bf))
    pulley.add(roundedBox(0.058, 0.002, 0.009, paintedMaterial(0x3a4048), 0, 0.014, 0, 0.001))
    pivot.add(pulley)
    pulleys.push(pulley)
    op.add(pivot)
  }

  parts.motor = op
  root.add(op)

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

    /* 踢脚板：下沿一条拉丝不锈钢。真实车门一定有——那是鞋跟和搬运车最先碰到的地方。
       顺带在下半扇留白最重的位置压一道深色，构图也不那么空。 */
    leaf.add(
      roundedBox(DIM.leafW - 0.03, 0.2, 0.005, paintedMaterial(0x9aa0a6), 0, cy - DIM.leafH / 2 + 0.125, DIM.leafT / 2 + 0.002, 0.003),
    )
    // 板面中段的一道浅分缝：整块板没有任何横向分割，看起来像塑料件
    leaf.add(
      roundedBox(DIM.leafW - 0.02, 0.003, 0.003, paintedMaterial(0x9ca0a3), 0, cy + 0.06, DIM.leafT / 2 + 0.001, 0.001),
    )
    // 下部导柱：插进门坎导轨槽，防止门扇前后摆动
    const guide = new Mesh(new CylinderGeometry(0.011, 0.011, 0.055, 12), chromeMaterial())
    guide.position.set(-dir * (DIM.leafW / 2 - 0.07), cy - DIM.leafH / 2 - 0.012, 0)
    leaf.add(guide)

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
  const cabinMat = new MeshStandardMaterial({ color: 0x33363b, roughness: 0.92, metalness: 0 })
  const interior = new Mesh(new PlaneGeometry(DIM.openW + 0.16, DIM.openH + 0.06), cabinMat)
  interior.position.set(0, DIM.openH / 2, -0.62)
  root.add(interior)

  /* 只有一块背板时，门一开就是一片黑——那是「洞」，不是「车厢」。
     补一块地板和一块顶板，纵深立刻成立：切开门能看到地面往里铺进去。 */
  const cabinFloor = new Mesh(new PlaneGeometry(DIM.openW + 0.16, 0.66), paintedMaterial(0x5e6166))
  cabinFloor.rotation.x = -Math.PI / 2
  cabinFloor.position.set(0, DIM.sill + 0.004, -0.29)
  cabinFloor.receiveShadow = true
  const cabinCeil = new Mesh(new PlaneGeometry(DIM.openW + 0.16, 0.66), paintedMaterial(0x4a4d52))
  cabinCeil.rotation.x = Math.PI / 2
  cabinCeil.position.set(0, DIM.openH - 0.02, -0.29)
  root.add(cabinFloor, cabinCeil)

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
    const travel = slide * DIM.slide
    leafL.position.set(-(DIM.leafW / 2) - travel, 0, z)
    leafR.position.set(DIM.leafW / 2 + travel, 0, z)

    /* 同步带跟着门扇跑。带面纹理按齿距滚动、带轮按半径自转，
       两者速率必须一致（带子走多远 = 轮子转过多少弧长），否则一眼看出打滑。
       上下两段的滚动方向相反：它们是同一条带子的两边。 */
    if (beltMatUpper.map) beltMatUpper.map.offset.x = travel / 0.042
    if (beltMatLower.map) beltMatLower.map.offset.x = -travel / 0.042
    for (const pulley of pulleys) pulley.rotation.y = travel / 0.032

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
    /* 剖切沿 X（竖直切一刀，从右往左扫）。
       **不能沿 Z 切**：门扇是一块薄板，切面平行于板面时，截面正好等于整张门脸
       ——画面上只会看到两块纯色大板，比不切还难懂。剖切只有切在「薄的那一维」上
       才有信息量：截面是一道 42mm 的薄边，旁边是 90mm 的墙体断面。
       切面用暖灰、比漆面深一档：截面是材料本体，不该和表面同色。 */
    cut: { axis: 'x', from: -0.9, to: 1.5, cap: 0xa79d8c },
    dispose: () => disposeTree(root),
  }
}
