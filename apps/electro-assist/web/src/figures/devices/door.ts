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
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  ShadowMaterial,
  SphereGeometry,
  TorusGeometry,
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
  boltRun,
} from './rig'
import { facePlate, isolationLabelTexture } from './print'
import { phaseFor } from '../../lib/devphase'
import { parseAux } from '../../lib/auxspec'
import contract from '../../contract/devices.json'

/** 示意尺寸（米）。
 *
 * ## 2026-11-15 改单扇（R25-3，本人裁决「选 1010 宽门」）
 * 原来做成**双扇对开**，与实车不符：CRH380A 客室侧门是**单扇内藏式侧拉门**，
 * 净通过尺寸 720（窄门）/ **1010（宽门）** × 1850，拉门行程 771 / **1061** mm。
 * 依据：CRH380A 侧拉门课件（净通过 720(1010)×1850、行程 771(1061)、门板与车体
 * 错差 35 mm）+ 专利 CN201198313Y（单扇门板、携门架、上下导轨、四点压紧）。
 *
 * 单扇之后，门扇要**盖住门洞并留出压紧余量**（每边约 30 mm），所以
 * `leafW = 1.07 > openW = 1.01`；门向 +X 滑开，停到右侧门机罩下（行程 1.061）。
 */
export const DIM = {
  openW: 1.01,
  openH: 1.85,
  /** 侧墙只留门洞两侧各 1.3m：真实车厢侧面是 25m 级，但画面里塞满墙就看不见门了。
   *  演示要的是「这扇门」，不是「这节车厢」。 */
  wallW: 3.7,
  wallH: 2.25,
  wallT: 0.09,
  /* 2026-11-15：0.66 → 1.07。单扇门要盖住 1.01 的门洞并留压紧量，单边约 30mm。 */
  leafW: 1.07,
  leafH: 1.9,
  leafT: 0.042,
  leafZ: 0.05,
  pop: 0.055,
  /** 拉门行程：公开值 1061 mm（宽门）。 */
  slide: 1.061,
  sill: 0.03,
}
/**
 * 防夹试块：尺寸与**工位**（门洞地板、门页滑移面上）。
 * 2026-11-16 单扇化后重定位：x 右移到 −openW/2+0.20，z 收到 leafZ+0.02。
 * 导出是为了让单测能断言"它真的跨在门页路径上"——这个靠截图很难稳定验（要点击才到工位）。
 */
export const BLOCK_SIZE = { w: 0.20, h: 0.14, d: 0.12 }
export const BLOCK_AT_DOOR: [number, number, number] = [
  -(DIM.openW / 2) + 0.24,
  DIM.sill,
  DIM.leafZ + 0.02,
]

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

/**
 * 球面热区：**投影永远是圆的**，怎么转机位都刚好围住试块本体。
 *
 * `visible = false` 的 mesh 不渲染、不参与几何自检，但 three 的 `Raycaster`
 * **不看 visible**，照样能命中（与 `driver_desk.ts` 的方盒热区同一套做法）。
 *
 * 2026-11-14 本人实测：试块移到门洞后"鼠标指着它却点不动"。当时用的是
 * 0.44×0.36×0.80 的方盒，往镜头方向伸了 0.65m 去抢射线——结果是
 * **可点区域和看得见的试块错位**：顺着视线看，盒子前脸在试块上方偏右，
 * 指着试块本体反而落在盒子外。球体没有朝向，加一个"半径 > 半宽"的余量，
 * 指着试块附近一圈都算命中，这才是"捕获范围"该有的形状。
 */
function hotBall(parent: Object3D, r: number, x: number, y: number, z: number): void {
  const mesh = new Mesh(new SphereGeometry(r, 14, 10), new MeshBasicMaterial({ visible: false }))
  mesh.position.set(x, y, z)
  mesh.visible = false
  mesh.castShadow = false
  mesh.receiveShadow = false
  parent.add(mesh)
}

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

  /* 门机罩：塞拉门是**外挂式**——门扇退出密封面后贴着车体外侧滑，
     滑到位时停在侧墙前面，不会进墙里（进门袋的是内藏门，另一种门）。
     既然如此，导轨和携门架就必须有地方待：真车是在门洞两侧各伸出一段
     外凸的门机罩，导轨藏在罩子里，门扇从罩子下面滑过去。
     这一段同时解决了三件事：导轨有长度、携门架不悬空、门扇滑出去不再是
     「贴在墙上一块板」。 */
  const houseZ = 0.14 // 罩子前脸：门扇最大外移 0.126，要留 15mm 让它从下面过
  const houseD = houseZ + DIM.wallT / 2
  const houseCz = (houseZ - DIM.wallT / 2) / 2
  const houseW = wallSideW - 0.15
  for (const dir of [-1, 1]) {
    const hx = dir * (DIM.openW / 2 + 0.075 + houseW / 2)
    wallTop.add(
      roundedBox(houseW, headerH, houseD, wallMat, hx, DIM.openH + headerH / 2, houseCz, 0.01),
    )
    // 罩子下沿一道收边：门扇从下面滑过，没有这道边会像一块悬空的梁
    wallTop.add(
      roundedBox(houseW, 0.022, houseD + 0.012, steelMaterial(0xa8acb0), hx, DIM.openH + 0.011, houseCz, 0.006),
    )

    /* 罩子表面：一整块光板是「未完工」的观感。真罩子由几段拼成，
       中间还有一个检修口，四角带螺钉、下沿两个四分之一转锁扣。 */
    const hatchX = hx - dir * 0.1
    const hatchY = DIM.openH + headerH * 0.5
    for (const off of [-0.36, 0.3]) {
      wallTop.add(roundedBox(0.005, headerH - 0.02, 0.004, paintedMaterial(0x76736c), hx + off, DIM.openH + headerH / 2, houseZ, 0.001))
    }
    // 检修口：面板比罩子低 2mm，四周留一道缝
    wallTop.add(roundedBox(0.34, headerH * 0.56, 0.004, paintedMaterial(0x9d9a92), hatchX, hatchY, houseZ - 0.002, 0.004))
    const hatchScrew = new CylinderGeometry(0.005, 0.005, 0.004, 8)
    for (const sx of [-0.14, 0.14]) {
      for (const sy of [-0.058, 0.058]) {
        const screw = new Mesh(hatchScrew, chromeMaterial())
        screw.rotation.x = Math.PI / 2
        screw.position.set(hatchX + sx, hatchY + sy, houseZ + 0.002)
        wallTop.add(screw)
      }
    }
    // 四分之一转锁扣：检修口下沿两个
    for (const sx of [-0.12, 0.12]) {
      const latch = new Mesh(new CylinderGeometry(0.011, 0.011, 0.007, 14), chromeMaterial())
      latch.rotation.x = Math.PI / 2
      latch.position.set(hatchX + sx, hatchY - 0.052, houseZ + 0.003)
      wallTop.add(latch)
      // 锁扣的转动标识：一道横槽
      const slot = roundedBox(0.016, 0.003, 0.002, paintedMaterial(0x2b2e33), hatchX + sx, hatchY - 0.052, houseZ + 0.007, 0.001)
      wallTop.add(slot)
    }

    /* 门扇顶与罩子之间的密封条：门滑开时这里会露出一条缝，
       真机是一道贴在前沿的橡胶挡边，门扇贴着它走。 */
    wallTop.add(
      roundedBox(houseW - 0.02, 0.02, 0.015, rubberMaterial(0x1b1d20), hx, DIM.openH - 0.002, houseZ - 0.016, 0.004),
    )
  }
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
      // 螺钉必须落在竖向包边（宽 28mm）上：内缩 14mm = 包边中线。原先内缩 50mm
      // 是按 1.4m 门洞写的，单扇化到 1.01m 后螺钉跑到包边外面 13mm，几何门禁当场抓住。
      boltSpots.push([sx * (DIM.openW / 2 - 0.014), DIM.sill + 0.06 + i * (DIM.openH - 0.12) / 4])
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

  /* ------------------------------------------------------------ 隔离锁挡 */
  /* 锁挡固定在**门框钢结构**上（不是门扇上）。C 形开口朝中缝，
     门扇上的长插销横向插进来——非隔离位时两者留 2~3mm。 */
  const isoStopMat = steelMaterial(0x9a9d9f)
  const switchMat = paintedMaterial(0x2a2e33)
  for (const s of [-1, 1]) {
    const sx = s * (DIM.openW / 2 - 0.011)
    // 底板：贴门框正面
    frame.add(roundedBox(0.034, 0.12, 0.008, isoStopMat, sx, 0.732, 0.062, 0.003))
    // 上下两翼：夹住插销，形成楔口（口高 32mm，插销 13mm）
    frame.add(
      roundedBox(0.034, 0.044, 0.026, isoStopMat, sx, 0.77, 0.076, 0.003),
      roundedBox(0.034, 0.044, 0.026, isoStopMat, sx, 0.694, 0.076, 0.003),
    )
    // 到位微动开关：隔离锁舌压下它才发隔离信号
    frame.add(roundedBox(0.026, 0.02, 0.018, switchMat, sx, 0.648, 0.074, 0.003))
    for (const off of [-0.006, 0.006]) {
      const leadWire = new Mesh(new CylinderGeometry(0.0012, 0.0012, 0.11, 6), switchMat)
      leadWire.position.set(sx + off, 0.585, 0.074)
      frame.add(leadWire)
    }
  }

  /* ------------------------------------------------- 门锁锁扣板 / 密封面（单扇） */
  /* 单扇之后锁舌只有一套：门扇上的锁舌（x=0.465）向 +X 伸出，咬进**门框侧**的
     锁扣板。原来那套「跨中缝咬对侧门扇」的结构随双扇一起去掉了。 */
  const lockPlateZ = DIM.leafZ + DIM.leafT / 2 + 0.03
  const lockPlate = roundedBox(0.03, 0.095, 0.022, steelMaterial(0xb0b5ba), DIM.openW / 2 - 0.012, 0.93, lockPlateZ, 0.004)
  lockPlate.userData.qaGroup = 'lockplate'
  frame.add(lockPlate)
  /* 锁孔（深色凹槽）**贴在钢板前面，不再嵌进去**。
     原来：钢板 z 0.090~0.112、孔盒 z 0.100~0.114 —— 两个实体重叠 12mm，
     前表面又在同一高度附近互相穿插，于是从某些角度孔会"闪一下有、闪一下没有"
     （本人报的"锁孔会出现和消失"）。现在孔盒 z 0.1135~0.1165，与板面留 1.5mm。 */
  /* 锁孔：一块**贴在板面外 1mm** 的薄暗片。
     试过两种更"像凹槽"的写法都不成立：
       ① 14mm 厚黑块嵌进板里 → 从侧面看是一块凸出来的黑板；
       ② 4mm 厚完全嵌进板内 → 整块被板包住，正面就看不见了（等于没有孔）。
     薄片外贴是唯一既能"正面读成孔"、又不会在侧面凸出的做法。
     注：本人报的"锁孔会出现和消失"仍未复现，原因未定（见 30.19）。 */
  /* **凹进板面 0.3mm**，不再贴在板外。
     隔离后绕到侧面才看清：贴面那块黑片会从板的轮廓里**伸出一小截**，
     正面读成"孔"、侧面读成"多出来一块黑板"——这就是"锁孔会出现和消失"。
     板面在 0.112；这里把暗片前沿放到 0.1117（内缩 0.3mm），厚 2mm，
     于是正面仍是暗孔，侧面被板的厚度挡死，任何角度都不露头。 */
  const lockHole = roundedBox(0.012, 0.034, 0.002, paintedMaterial(0x1b1e22), DIM.openW / 2 - 0.004, 0.93, lockPlateZ + 0.0097, 0.001)
  lockHole.userData.qaGroup = 'lockhole'
  frame.add(lockHole)
  // 前缘密封面：门扇合拢时密封条压在这条不锈钢压条上（−X 侧）
  frame.add(roundedBox(0.016, DIM.openH - 0.04, 0.03, steelMaterial(0xb4b9bf), -(DIM.openW / 2) + 0.008, DIM.openH / 2, DIM.leafZ + DIM.leafT / 2, 0.003))

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
  /* 导轨长度按**门扇总行程**给：门扇中心从 0 走到 +1.061，两端各留 0.12 余量 →
     全长 = 行程 + 门扇宽 + 0.24，中心随行程右移半个行程。 */
  const railLen = DIM.slide + DIM.leafW + 0.24
  const rail = new Mesh(new CylinderGeometry(0.011, 0.011, railLen, 14), railMat)
  rail.rotation.z = Math.PI / 2
  rail.position.set(DIM.slide / 2, DIM.openH + 0.062, bayZ + 0.02)
  op.add(rail)
  for (const rx of [-0.42, 0.18, 0.78, 1.38]) {
    op.add(roundedBox(0.028, 0.05, 0.026, railMat, rx, DIM.openH + 0.088, bayZ + 0.02, 0.006))
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

  /**
   * 同步带：两条直线段 + 两端带轮。
   * 单扇之后带段要跨过行程（1.061m），长度按「行程 + 0.30」给，带轮落在行程两端。
   *
   * 带子要能在门开合时跑起来：给带面贴一张齿形纹理，靠 offset.x 滚动。
   * 带轮同步自转（带子走多少 = 轮子转过多少弧长），两者速率对不上就会看出打滑。
   * 上下两段必须**反向**滚动——它们是同一条带子的两边，同向滚就等于两条独立的带子。 */
  const BELT_LEN = 1.36
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
    roundedBox(BELT_LEN, 0.008, 0.022, beltMatUpper, DIM.slide / 2, beltY + 0.028, bayZ, 0.003),
    roundedBox(BELT_LEN, 0.008, 0.022, beltMatLower, DIM.slide / 2, beltY - 0.028, bayZ, 0.003),
  )
  for (const px of [-0.22, DIM.slide + 0.22]) {
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

  /* 携门架：把门扇吊在导轨上的那个件。
   * 单扇门用**两只**携门架（相隔 0.60m）共同吊同一扇门——真机也是这个布置，
   * 单点吊挂会让门板下垂。两只都跟着门扇走，滑块始终骑在导轨上（导轨已够长）。 */
  const hangers: Group[] = []
  const railY = DIM.openH + 0.062
  for (let i = 0; i < 2; i += 1) {
    const hanger = new Group()
    // 滑块：骑在导轨上
    hanger.add(roundedBox(0.075, 0.05, 0.055, steelMaterial(0x9aa0a6), 0, railY, bayZ + 0.02, 0.006))
    /* 吊臂：从导轨降到门扇顶以下，进深做得够宽（0.11），
       门扇外移 55mm 之后仍然咬得住——真机的吊臂本来就是一块带长孔的板。 */
    hanger.add(roundedBox(0.03, 0.1, 0.11, steelMaterial(0xa8adb2), 0, railY - 0.045, 0.092, 0.005))
    hanger.position.x = i === 0 ? -0.3 : 0.3
    hangers.push(hanger)
    op.add(hanger)
  }

  parts.motor = op
  root.add(op)

  /* ---------------------------------------------------------------- 门扇 */
  /* 门扇用**喷漆铝板**，不是裸不锈钢。
     两条理由：① 高铁/城轨车门外表面本来就多是喷涂铝板，裸拉丝不锈钢是少数；
     ② metalness=1 的大面在 RoomEnvironment（几个自发光矩形）里只会反射出几块
     亮斑，出来的是一张暗灰带条纹的板，比喷漆件难看得多。
     teardown 的金属参数是给发动机、起落架那种裸金属机构的，不是给钣金外壳的。 */
  /** 门锁锁舌：解锁时缩回，锁闭时伸出、跨过中缝咬进对侧锁扣。 */
  const lockBolts: Mesh[] = []
  /** 隔离锁的长插销：t=0 处于隔离位（插进门框锁挡），解除隔离时缩回。
   *  不缩回就开门 = 「锁着还能拉开」，物理上不成立。 */
  const isoBolts: Array<{ mesh: Mesh; dir: number }> = []
  const buildLeaf = (dir: -1 | 1) => {
    const leaf = new Group()
    /* 单扇：门扇居中于门洞（cx=0）。`dir` 只用来决定「哪条边是前缘」——
       取 +1 时前缘在 -X（门向 +X 滑开，闭合时是左边先碰门框）。 */
    const cx = 0
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

    /* -------------------------------------------------- 门板分缝与紧固件（S3）
       上下两段的分缝本来就有，但**下段 1.07×0.71 m 是一整块光板**，4× 近景里
       它是画面中最大的空白面（51%）。真实门板背面有加强筋，正面能看到两道
       压筋线和一溜铆钉——这正是「一块塑料」与「一块钣金」的差别。
       压条凸出 2mm、宽 5mm，比板面暗一档；铆钉 φ8，间距约 0.1 m。 */
    const skinSeam = paintedMaterial(0xb7bcc2)
    const jointY = cy + DIM.leafH / 2 - upperH          // 上下段接缝
    const zFace = DIM.leafT / 2 + 0.0012
    for (const sx of [-0.33, 0.33]) {
      leaf.add(roundedBox(0.005, lowerH - 0.05, 0.004, skinSeam, sx, cy - DIM.leafH / 2 + lowerH / 2, zFace, 0.0012))
      boltRun(leaf, [sx, cy - DIM.leafH / 2 + 0.05, zFace], [sx, jointY - 0.04, zFace], 5, 'z', 0.008)
    }
    boltRun(leaf, [-DIM.leafW / 2 + 0.06, jointY, zFace], [DIM.leafW / 2 - 0.06, jointY, zFace], 9, 'z', 0.008)

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

    // 前缘密封条：朝门框那一侧外凸 12mm，是塞拉门最显著的特征件
    const seal = roundedBox(0.02, DIM.leafH - 0.03, DIM.leafT + 0.024, rubberMaterial(), -dir * (DIM.leafW / 2 - 0.01), cy, 0, 0.006)
    leaf.add(seal)

    // 门扇上下沿密封
    leaf.add(
      roundedBox(DIM.leafW - 0.04, 0.014, DIM.leafT + 0.018, rubberMaterial(), 0, cy + DIM.leafH / 2 - 0.01, 0, 0.004),
      roundedBox(DIM.leafW - 0.04, 0.014, DIM.leafT + 0.018, rubberMaterial(), 0, cy - DIM.leafH / 2 + 0.01, 0, 0.004),
    )

    /* 前缘挡边：单扇门没有「中缝」，前缘必须有一道压条把密封条压住，
       否则那一条橡胶看起来是「贴上去的」而不是装上去的。 */
    leaf.add(
      roundedBox(0.026, DIM.leafH - 0.05, DIM.leafT + 0.01, steelMaterial(0xa8adb2), -dir * (DIM.leafW / 2 - 0.004), cy, 0.004, 0.004),
    )

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

    /* 门锁：塞拉门到站锁闭靠它，不是靠指示灯。
       单扇门只有一个前缘，所以锁只有**一套**：锁体在门扇后缘附近，
       锁舌向 +X 伸出、咬进门框侧的锁扣板（不再有「跨中缝咬对侧」那种结构）。 */
    const lockY = cy - 0.05
    leaf.add(roundedBox(0.07, 0.1, 0.052, paintedMaterial(0x2f343a), 0.40, lockY, DIM.leafT / 2 + 0.012, 0.006))
    // 电磁铁线圈外壳：压在锁体上，解锁时嗡一下的就是它
    leaf.add(roundedBox(0.05, 0.05, 0.03, paintedMaterial(0x1f2429), 0.40, lockY + 0.055, DIM.leafT / 2 + 0.01, 0.005))
    const bolt = roundedBox(0.095, 0.028, 0.024, chromeMaterial(), 0.465, lockY, DIM.leafT / 2 + 0.03, 0.004)
    lockBolts.push(bolt)
    leaf.add(bolt)

    /* ---------------------------------------------------------- 隔离锁 */
    /* **本体在门扇、锁挡在门框**——三份独立资料写死的结构：
       《高速列车侧门锁闭安全性设计》："门上还设置有隔离锁……手动操作隔离锁可带动
       隔离插销伸出，并与固定于车体侧墙上的隔离锁挡搭接，同时触发隔离开关"；
       成都地铁架修技术条款："检查锁组成**在门扇上**安装牢固、无松动"、
       "隔离位时，隔离锁舌与**门框钢结构**搭接量不小于 2mm"、"三角锁芯无破损、
       无缺角、无变形"、"非隔离位置时，锁舌与行程开关弹片的间隙 2~3mm"；
       专利 CN208073187U：门扇上两个隔离锁，位于主锁扣与辅助锁扣之间。

       上一版的错不在"少了个零件"，而是：门扇上只有一个**主锁**（中缝那个黑盒），
       既没有三角锁芯、也没有门框侧的锁挡——于是它既不像主锁也不像隔离锁，
       被当成了"不符合实际的隔离锁"。
       现在按实物补齐：门扇上 = 锁盒 + 三角锁芯 + "隔离锁"铭牌 + 长插销；
       门框上 = C 形锁挡 + 到位微动开关（锁舌压下它才发隔离信号）。 */
    const ISO_Y = 0.735
    const isoBody = new Group()
    /* 2026-11-15 单扇化：隔离锁挪到门扇**后缘**（+0.44），插销伸出后要真的够到
       门框（门框内表面在 ±0.505）——放在 0.28 时插销端头离门框还有 15cm，
       等于"锁在空气里"。 */
    isoBody.position.set(dir * 0.44, ISO_Y, DIM.leafT / 2)
    leaf.add(isoBody)

    // 锁盒：凸出门面 27mm，里面是曲柄与弹簧（真实锁盒就是这个厚度）
    isoBody.add(roundedBox(0.085, 0.11, 0.026, paintedMaterial(0x24262a), 0, 0, 0.014, 0.006))
    // 盖板：略小一圈，压出一道分缝
    isoBody.add(roundedBox(0.072, 0.096, 0.004, paintedMaterial(0x33363b), 0, 0, 0.028, 0.004))
    /* 三角锁芯：**识别隔离锁的关键特征**。圆盘里一个等边三角孔，配三角钥匙
       （车站/检修用三角钥匙，不是普通方孔钥匙）。 */
    const keyDisc = new Mesh(new CylinderGeometry(0.016, 0.016, 0.007, 22), chromeMaterial())
    keyDisc.rotation.x = Math.PI / 2
    keyDisc.position.set(0, 0.019, 0.0315)
    isoBody.add(keyDisc)
    // 锁芯外圈一道凹槽：真实锁芯是"盘 + 环槽 + 三角孔"，只有盘和孔会看成一颗铆钉
    const keyGroove = new Mesh(new TorusGeometry(0.0125, 0.0011, 6, 22), paintedMaterial(0x2b2e33))
    keyGroove.position.set(0, 0.019, 0.0352)
    isoBody.add(keyGroove)
    /* 三角孔：等边三角形，**一个角朝上**（三角钥匙的三个方位就是这个朝向）。
       半径 8mm 是真实的三角钥匙芯规格，再大就不像标准件了。 */
    const keyHole = new Mesh(
      new CylinderGeometry(0.008, 0.008, 0.008, 3),
      new MeshStandardMaterial({ color: 0x0b0d0f, metalness: 0.1, roughness: 0.9 }),
    )
    keyHole.rotation.x = Math.PI / 2
    keyHole.rotation.z = 0
    keyHole.position.set(0, 0.019, 0.0335)
    isoBody.add(keyHole)
    // 标识铭牌："隔离锁"——现场辨认它最直接的东西
    const isoPlate = facePlate(0.044, 0.016, isolationLabelTexture(), { roughness: 0.55 })
    isoPlate.position.set(0, -0.033, 0.0308)
    isoBody.add(isoPlate)
    // 长插销：朝门框方向伸出，非隔离位时端头与锁挡口留 2~3mm（条款原文）
    const isoBolt = new Mesh(new CylinderGeometry(0.0065, 0.0065, 0.038, 12), chromeMaterial())
    isoBolt.rotation.z = Math.PI / 2
    isoBolt.position.set(dir * 0.0515, 0, 0.014)
    isoBody.add(isoBolt)
    isoBolts.push({ mesh: isoBolt, dir })
    // 插销出口的导向套
    isoBody.add(roundedBox(0.012, 0.022, 0.022, paintedMaterial(0x2b2f34), dir * 0.0435, 0, 0.014, 0.004))

    leaf.position.set(cx, 0, DIM.leafZ)
    return leaf

  }

  const leaf = buildLeaf(1)
  parts.leaf = leaf
  root.add(leaf)

  /* ---------------------------------------------------------------- 指示灯 */
  const lampGroup = new Group()
  const lampBase = roundedBox(0.09, 0.09, 0.03, chromeMaterial(), 0, 0, 0, 0.008)
  const lampBulb = new Mesh(new SphereGeometry(0.032, 24, 16), lampMaterial(LAMP_ALARM))
  lampBulb.position.z = 0.026
  lampBulb.castShadow = false
  lampGroup.add(lampBase, lampBulb)
  // 指示灯挪到门机罩前脸：原来的位置在门楣里，现在被罩子盖住了
  lampGroup.position.set(DIM.openW / 2 + 0.25, DIM.openH + 0.13, houseZ + 0.012)
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

  /* ---------------------------------------------------------------- 防夹试块 */
  /* 2026-11-14 本人指出：点「放试块」之后三维里什么都看不见，等于没放。
     试块必须是**看得见的一件东西**，而且要放在门洞地板上、门扇合拢时会被
     顶住的位置——否则"门碰到它停止并反开"在画面上不成立。
     2026-11-15 单扇化：门扇向 +X 滑开、前缘在 −X，所以试块要放在**左门框侧**
     的关闭边上（人/物被夹的位置就是前缘与门框之间），不再放"两扇中间"。

     形体：卷起的毛巾（约 40mm 厚、0.20m 宽、0.14m 高），浅色布面 + 两道束带。
     位置：x=−0.405（贴着左门框内表面 −0.505，向右占 0.20m），落在门槛上，
     z 取门页外移后的滑移面附近——门页是在这个深度上作水平滑移的。
     默认 `visible=false`：只有「放试块」时才出现，平时不占画面。 */
  const blockGroup = new Group()
  const blockBody = roundedBox(0.20, 0.14, 0.12, paintedMaterial(0xd9d3c4), 0, 0.07, 0, 0.03, 3)
  blockGroup.add(blockBody)
  // 两道束带：有它才像"卷起来的毛巾"，而不是一块砖
  for (const dx of [-0.045, 0.045]) {
    blockGroup.add(roundedBox(0.018, 0.144, 0.124, paintedMaterial(0x8f8a7e), dx, 0.07, 0, 0.006))
  }
  /* 两个摆放位（2026-11-14 本人指定，2026-11-15 单扇化后重定位）：
     - 原位：门外侧地面、门框左前方——平时就摆在那里，一眼看得见；
     - 工位：门洞地板上、**门扇前缘与左门框之间的关闭边**。
     点一次从原位移到工位，再点一次移回。所以它是**可拾取部件**（`parts.block`），
     不是页面上的按钮。 */
  const BLOCK_REST: [number, number, number] = [-0.98, DIM.sill, 0.88]
  /* 工位 = **左门框侧的关闭边**（单扇门夹人的位置）。2026-11-15 前它在门洞中线，
     那是双扇结构才成立的摆法；单扇化后中线不会被顶到，反而"看起来没挡住"。 */
  /* 2026-11-16 本人实测修正：单扇后原位置"看着不像挡着门"。
     ① **往右**：x 由 −openW/2+0.10 提到 +0.20（原来贴着左门框，落在门扇前缘够不到的地方）；
     ② **往门里**：z 由 leafZ+0.12 收到 leafZ+0.02——原来在门页平面之外 12cm，
        门扇合拢时从它内侧滑过去，画面里根本没挡住；现在它**跨在门页的滑移面上**。 */
  blockGroup.position.set(...BLOCK_REST)
  /* 热区：**球面**，半径 0.32m（试块宽 0.20m，留出一圈余量）。
     指着试块附近都算命中——本人 2026-11-14：「感觉是"捕获"范围不够」。
     一个球不管从哪个角度看都刚好包住它，不会出现"看得见却点不中"的错位。 */
  hotBall(blockGroup, 0.32, 0, 0.1, 0.02)
  parts.block = blockGroup
  root.add(blockGroup)

  /* ---------------------------------------------------------------- 动作 */
  const setT = (t: number): void => {
    /* 段零：解锁。**这是开门的前置条件**——锁舌没缩回，门扇一点都不能动。
       以前从 t=0 就开始外移，等于「锁着也能开门」，现场不可能。 */
    /* 段负一：**解除隔离**。t=0 是隔离位——长插销插在门框锁挡里（搭接 8mm），
       此时门是被机械约束住的，一点都不能动。现场顺序是「反转三角钥匙使锁复位
       （插销缩回）→ 再操作内外解锁装置」，所以这一段排在最前。 */
    const unisolate = seg(t, 0.002, 0.045)
    for (const iso of isoBolts) iso.mesh.position.x = iso.dir * (0.0515 - 0.008 * unisolate)

    const unlock = seg(t, 0.02, 0.08)
    for (const bolt of lockBolts) bolt.position.x = 0.465 - 0.065 * unlock

    // 段一：解锁后才外移（塞拉）。真实塞拉门必须先退出密封面才能滑，不能直接平移。
    const pop = seg(t, 0.08, 0.2)
    // 段二：沿车体滑移。留 0.02 重叠量，与真门一致。
    const slide = seg(t, 0.2, 0.88)

    const z = DIM.leafZ + pop * DIM.pop
    const travel = slide * DIM.slide
    /* 单扇：门向 +X 滑开（停到右侧门机罩下）。闭合时前缘在 -X，
       所以"关到位"是 x=0，"全开"是 x=+slide。 */
    leaf.position.set(travel, 0, z)

    /* 同步带跟着门扇跑。带面纹理按齿距滚动、带轮按半径自转，
       两者速率必须一致（带子走多远 = 轮子转过多少弧长），否则一眼看出打滑。
       上下两段的滚动方向相反：它们是同一条带子的两边。 */
    if (beltMatUpper.map) beltMatUpper.map.offset.x = travel / 0.042
    if (beltMatLower.map) beltMatLower.map.offset.x = -travel / 0.042
    for (const pulley of pulleys) pulley.rotation.y = travel / 0.032
    // 两只携门架与门扇同速：滑块始终在导轨上（导轨按行程 + 扇宽给足）
    hangers[0].position.x = -0.3 + travel
    hangers[1].position.x = 0.3 + travel

    /* 指示灯就是**锁闭信号**：锁闭到位绿灯，一旦解锁立刻转红。
       注意末尾是全开状态，此时门没锁，灯本来就该是红的——
       现场判据正是「锁闭信号丢失才允许动门」，不是「开门成功变绿」。
       颜色 + emissive 一起改，缺一个就会在暗部发灰。 */
    const locked = t < 0.02
    const bulb = lampBulb.material as MeshStandardMaterial
    const hex = locked ? LAMP_OK : LAMP_ALARM
    bulb.color.setHex(hex)
    bulb.emissive.setHex(hex)
  }

  /* 阶段文案的唯一来源在 `lib/devphase.ts`：同一句话不该在这里再写一遍。
     2026-11-12 评审 R11-6：三维侧与读数侧各写一份，`door` 已经漂成
     "三维说完全开启、界面说到位检测"。阈值改动请改 devphase 的常量。 */
  const phase = (t: number): string => phaseFor('door', t)

  /**
   * 场景附加态（离散，与 `t` 正交）。目前只有一件事：试块在不在。
   *
   * 为什么不用 `t` 表达：试块是**人放进去的**，与门走到第几拍无关；
   * 硬塞进时间轴会让"门开到一半"和"块有没有放"互相干扰。
   * 格式沿用 `lib/auxspec`：`door|block=1`。
   */
  const setAux = (spec: string): void => {
    const { kv } = parseAux(spec)
    // 试块只有两个位，没有中间态：点一下是"搬过去"，再点一下是"搬回来"
    blockGroup.position.set(...(kv.block === '1' ? BLOCK_AT_DOOR : BLOCK_REST))
  }

  setT(0)

  return {
    root,
    setT,
    parts,
    phase,
    // 「The machine fills 60-70% of its viewport」
    framing: { target: [0, 1.05, 0], distance: 5.25 },
    /* 悬停名称取自后端契约（`models/visual.py` 的 `DEVICE_PART_LABELS`）。
       2026-11-14 本人：试块摆在门外地上时没有任何标识，用户不知道那是试块——
       而它恰恰是本步唯一要点的那件东西。名称随设备 chunk 走，零首屏成本；
       `builders.spec.ts` 有一条用例逐字比对这个映射与契约。 */
    partLabels: (contract.devices.door?.part_labels ?? {}) as Record<string, string>,
    /* 剖切沿 X（竖直切一刀，从右往左扫）。
       **不能沿 Z 切**：门扇是一块薄板，切面平行于板面时，截面正好等于整张门脸
       ——画面上只会看到两块纯色大板，比不切还难懂。剖切只有切在「薄的那一维」上
       才有信息量：截面是一道 42mm 的薄边，旁边是 90mm 的墙体断面。
       切面用暖灰、比漆面深一档：截面是材料本体，不该和表面同色。 */
    cut: { axis: 'x', from: -0.9, to: 1.5, cap: 0xa79d8c },
    setAux,
    dispose: () => disposeTree(root),
  }
}
