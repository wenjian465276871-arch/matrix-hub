/** 塞尺测门缝：选片、翻片、插入、沿缝滑动、抽出五个动作。
 *
 *  ## 这一页要讲的动作
 *  「测量关闭间隙」的判据是 1.5–2.5mm 这类数字，但现场真正决定量得准不准的
 *  是**手法**：塞尺要垂直门面插入、沿缝滑动找最紧处、抽出来看是哪一片。
 *  2D 的 meter 只能画量程条，画不出"片插进去了没有"。
 *
 *  ## 为什么是「缝隙特写」而不是"整扇门 + 尺"
 *  第一版按整扇门建模（1.2m 高的门扇、8mm 的缝），视觉验收时整屏读不出三件事：
 *  哪两块是门、缝在哪、片插进去没有——门板与背景同色，8mm 的缝在整屏里
 *  只是一条黑线，90mm 的塞尺片只有几十个像素。这与配电柜那一页的教训相同：
 *  **讲机构就推到机构上**，讲柜体才退到柜体。所以这里只留两段门边（各 14cm）
 *  与它们之间的缝，镜头推到 30cm。
 *
 *  ## 尺度上的一处刻意夸大
 *  真实门缝 1–2mm、片厚 0.5mm；按真实比例，片在屏幕上是一条看不见的线。
 *  这里把缝放到 8mm、片厚放到 2.2mm（约 4 倍），**片数与分组仍按实物**
 *  （0.02–1.00mm 一组，十几片铆在同一根轴上）。夸大的是可视尺度，不是读数；
 *  片上也不印具体厚度——样例的判据是 2.0mm，印 0.50 会变成"图上的实测值"。
 *
 *  ## 形体参考
 *  塞尺的通用形式：十几片薄钢片铆在同一根轴上、扇形展开，发黑钢片 + 镀铬尺壳。
 *  比例按公开产品图核对，不贴照片——理由见 `print.ts` 头部。
 */
import {
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
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

/** 门缝宽度（m）。真实 1–2mm，这里放大以便看清片插进去。 */
const GAP = 0.008
/** 塞尺片：长 90mm、宽 12mm、厚 2.2mm（真实 0.5mm，见文件头）。 */
const BLADE = { len: 0.09, w: 0.016, t: 0.003 }
/** 门边块的尺寸：只取一段（14cm 宽、10cm 高、6cm 厚）。 */
const BLOCK = { w: 0.14, h: 0.1, d: 0.06 }
/** 尺组（铆轴）的初始位置：门面前方 12.8cm。 */
const PIVOT = new Vector3(-0.03, 0.062, 0.128)
/** 叠片数量与选中片序号。 */
const BLADE_COUNT = 12
const SELECTED = 7

export function buildFeelerGauge(): DeviceRig {
  const root = new Group()
  const parts: Record<string, Object3D> = {}

  /* ------------------------------------------------------ 门边与门缝 */
  const gapGroup = new Group()
  root.add(gapGroup)
  parts.gap = gapGroup

  // 门扇侧与门框侧用两个色：同色时整屏读不出"这是两块"，缝隙也失去参照
  const leafMat = paintedMaterial(0xd6d4ce)
  const frameMat = paintedMaterial(0xb8b6b0)
  gapGroup.add(
    roundedBox(BLOCK.w, BLOCK.h, BLOCK.d, leafMat, -GAP / 2 - BLOCK.w / 2, BLOCK.h / 2, 0, 0.004, 3),
  )
  gapGroup.add(
    roundedBox(BLOCK.w, BLOCK.h, BLOCK.d, frameMat, GAP / 2 + BLOCK.w / 2, BLOCK.h / 2, 0, 0.004, 3),
  )

  // 缝的两侧各贴一条铝型材边：缝口有倒角，看起来才是"做出来的缝"
  const edgeMat = steelMaterial(0xc2c6ca)
  gapGroup.add(roundedBox(0.006, BLOCK.h, BLOCK.d, edgeMat, -GAP / 2 - 0.003, BLOCK.h / 2, 0, 0.0015))
  gapGroup.add(roundedBox(0.006, BLOCK.h, BLOCK.d, edgeMat, GAP / 2 + 0.003, BLOCK.h / 2, 0, 0.0015))

  // 缝底：一小段深色底，让"缝有多深"看得出来（真实缝深就是门边块厚度）
  /* 缝底用中灰而不是黑：黑底会把缝变成一条黑洞，片插进去后与背景分不开。 */
  gapGroup.add(
    roundedBox(GAP, BLOCK.h, 0.004, new MeshStandardMaterial({ color: 0x8d9196, metalness: 0.2, roughness: 0.8 }), 0, BLOCK.h / 2, -BLOCK.d / 2, 0.001),
  )

  /* 密封条：塞拉门靠这条橡胶压紧，它也是间隙测量的基准面之一，单独成部件。 */
  const seal = new Group()
  root.add(seal)
  parts.seal = seal
  seal.add(
    roundedBox(0.005, BLOCK.h - 0.01, 0.03, rubberMaterial(0x232528), GAP / 2 + 0.0065, BLOCK.h / 2, 0.012, 0.0015),
  )
  /* 密封唇只留在缝口外侧：上一版把一条黑色橡胶探进缝里，正好挡在片进来的路上，
     片一插进去就与它糊成一块黑。 */
  seal.add(
    roundedBox(0.0028, BLOCK.h - 0.01, 0.01, rubberMaterial(0x1d1f22), GAP / 2 + 0.0035, BLOCK.h / 2, 0.024, 0.001),
  )

  /* ---------------------------------------------------------- 塞尺 */
  const gauge = new Group()
  gauge.position.copy(PIVOT)
  root.add(gauge)

  const caseParts = new Group()
  gauge.add(caseParts)
  parts.case = caseParts

  const caseMat = chromeMaterial()
  for (const dx of [-0.0032, 0.0032]) {
    caseParts.add(roundedBox(0.0032, 0.032, 0.019, caseMat, dx, -0.004, 0.0085, 0.0014))
  }
  const pivot = new Mesh(new CylinderGeometry(0.0038, 0.0038, 0.011, 16), chromeMaterial())
  pivot.rotation.z = Math.PI / 2
  pivot.position.set(0, 0, 0.011)
  caseParts.add(pivot)

  /* ---- 叠片 ---- */
  const bladeGroup = new Group()
  gauge.add(bladeGroup)
  parts.blades = bladeGroup

  /* 两种钢色：叠片发黑、选中那片不锈钢。全用暗色时，片插进缝里会与缝底阴影糊成一片。 */
  const bladeMat = new MeshStandardMaterial({
    color: 0x555b63,
    metalness: 0.92,
    roughness: 0.38,
    side: DoubleSide,
  })
  const activeMat = new MeshStandardMaterial({
    // 金属度仍是 1（纪律：只在 0 与 1 之间选），靠"更亮 + 更粗"让它反出周围的白门板。
    // 0.18 那种镜面级粗糙度在这里只会把环境里的暗区照回来，片看起来是黑的。
    color: 0xdfe4e9,
    metalness: 1,
    roughness: 0.3,
    // 环境反射拉高：白门板就在旁边，片应当把它的亮度反回来
    envMapIntensity: 1.6,
    side: DoubleSide,
  })

  interface Blade {
    group: Group
    home: number
  }
  const blades: Blade[] = []

  for (let i = 0; i < BLADE_COUNT; i += 1) {
    const g = new Group()
    // 叠片在 y 上错开一点，扇开时不会互相穿插
    g.position.set(0, (i - (BLADE_COUNT - 1) / 2) * 0.0014, 0)
    const plate = new Mesh(
      new BoxGeometry(BLADE.w, BLADE.t, BLADE.len),
      i === SELECTED ? activeMat : bladeMat,
    )
    plate.position.set(0, 0, -BLADE.len / 2)
    // 不投影：这么薄的片，1024² 的阴影贴图只会留下一团黑，反而把片糊掉
    plate.castShadow = false
    g.add(plate)

    // 扇开的静止角度：选中那片在 0，其余往两侧铺开
    const home = (i - SELECTED) * 0.1
    g.rotation.y = home
    bladeGroup.add(g)
    blades.push({ group: g, home })
  }

  /* ------------------------------------------------------------ 动作 */
  /* 五段与后端 DEVICE_MOMENTS 同源：0.35 对准缝口 / 0.62 插入 / 0.82 滑动 / 1 抽出。 */
  const tmp = new Vector3()

  const setT = (t: number): void => {
    // ① 选片：扇形收起（其余片叠到选中片下面），选中片翻转成竖直
    const fold = seg(t, 0.0, 0.32)
    for (let i = 0; i < blades.length; i += 1) {
      const b = blades[i]
      if (i === SELECTED) {
        b.group.rotation.y = 0
        // 翻片：绕 z 转 90°，薄板由"平躺"变成"竖直"，厚度方向对上缝宽
        b.group.rotation.z = (Math.PI / 2) * fold
        continue
      }
      b.group.rotation.y = b.home * (1 - fold * 0.94)
      b.group.position.y = (i - (BLADE_COUNT - 1) / 2) * 0.0014 * (1 - fold * 0.7)
    }

    // ② 对准与插入：整把尺沿 -z 推进，片端进入缝内
    const approach = seg(t, 0.28, 0.35)
    const insert = seg(t, 0.35, 0.62)
    const slide = seg(t, 0.62, 0.82)
    const out = seg(t, 0.9, 1)

    tmp.copy(PIVOT)
    // 先摆到缝口正前方（x 对准缝中心、y 抬到观察高度）
    tmp.x += (0 - PIVOT.x) * approach
    // 片端要真的进到缝里（门边块厚 60mm，缝深就是块厚）：行程 70mm
    tmp.z += -0.07 * insert + 0.03 * out
    tmp.y += -slide * 0.035 + out * 0.02
    gauge.position.copy(tmp)

    // 插入时整把尺不能歪：一旦有侧倾，片就会刮到密封条（现场的大忌）
    gauge.rotation.x = 0.05 * (1 - approach) - 0.015 * insert
    gauge.rotation.y = -0.2 * (1 - approach)
  }

  const phase = (t: number): string => {
    if (t < 0.32) return '展开选片、翻成竖直'
    if (t < 0.35) return '片端对准门缝'
    if (t < 0.62) return '塞尺插入门缝'
    if (t < 0.82) return '沿缝滑动找最紧处'
    if (t < 0.92) return '抽出塞尺'
    return '读出片厚、判定间隙'
  }

  setT(0)
  root.updateMatrixWorld(true)

  return {
    root,
    setT,
    parts,
    phase,
    // 长焦 26°：缝是窄长条，广角会把两侧门板拉成斜面，缝宽就看不出是"缝"
    fov: 26,
    envIntensity: 1.0,
    // 34cm：整屏就是"缝 + 插进去的片"，与配电柜那页同一套取景逻辑
    framing: { target: [0.004, 0.064, 0.018], distance: 0.32 },
    /* 侧上方看（方位角约 62°、俯角 17°）：
       片是竖着插进竖缝的，只有从侧面才能看到它**露在缝外的那一段大面**；
       正面看只有 3mm 的边，俯视只有 16mm 的顶边——两头都是"一条线"。 */
    viewDir: [0.86, 0.3, 0.42],
    /* 这台**不声明 focus**，刻意。
       试过 ['blades','gap','case']：`gap` 是整条缝（含两块门板），包围盒
       一大，镜头反而退远，塞尺被门板淹没（2026-11-10 放大态验收）。
       它原有的 framing + viewDir 是前几轮按「缝隙剖面特写」逐次调出来的，
       放大态画布更高（322 vs 140），固定距离下物体自然会更大。 */
    dispose: () => disposeTree(root),
  }
}
