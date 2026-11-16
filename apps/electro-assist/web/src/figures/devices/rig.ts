/** 设备 3D 场景的共用基座：PBR 材质、程序化纹理、环境光照、缓动、销毁。
 *
 *  ## 为什么是程序化几何 + 程序化纹理
 *  1. **授权**：真实车门/受电弓的 CAD 不存在可再分发的自由授权版本，商业模型
 *     明确禁止再分发源文件，与公开仓冲突。程序化生成没有这个问题。
 *  2. **CSP**：本项目 `script-src 'self'` 无 `unsafe-eval`、`img-src 'self' data:`。
 *     程序化几何 + CanvasTexture 不产生任何网络请求、不需要 WASM 解码器，
 *     CSP 一行都不用改；换 GLB + DRACO 就必须放松 CSP 去换一个解码器。
 *  3. **体积**：首屏 46KB，Three.js 本体约 140KB gzip 已是上限，再把模型塞进来
 *     会把演示页拖到几 MB，弱网现场直接放弃。
 *
 *  ## 逼真度从哪来
 *  不靠贴图和模型精度，靠三件事：**环境反射（IBL）+ 材质分区 + 软阴影**。
 *  金属要有东西可反射才像金属，这是 Web 端逼真度最大的单点收益，
 *  比把面数翻十倍有效得多。所以这里用 RoomEnvironment 生成 PMREM 环境图，
 *  零外部文件却能得到接近产品渲染图的高光。
 */
import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Material,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  Vector3,
} from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'

import type { CutSpec } from './section'

/** 一支设备场景的可驱动骨架。`setT` 接收 0..1 的归一化进度，内部自行分段。 */
export interface DeviceRig {
  root: Group
  /**
   * 可选：剖面标注。返回**世界坐标**的锚点，由 `DeviceScene` 投影成屏幕上的 HTML 标签。
   *
   * ## 为什么不是三维里的 Sprite
   * 世界坐标的字号没有中间档：在 6m 机位下要看清，牌子就得做到 1m 宽，
   * 直接遮住半台设备；缩小到"不挡"的尺寸又只剩 4px。
   * 投影到 DOM 之后字号跟着屏幕像素走，缩略图与全屏都读得出来，代价只是一次投影。
   *
   * 只有「实物上看不见内部变化」或「认不出是什么」的件才标——装在人一眼就认识的
   * 件（门框、底架）上是噪音。
   */
  annotations?: () => Array<{ id: string; text: string; note?: string; at: Vector3 }>
  /**
   * 可选：切换试验工况（目前只有受电弓用：`normal` 正常升降弓 / `add` 自动降弓）。
   * 实现方自己保存状态并就地重算，不需要外部再调一次 `setT`。
   */
  setMode?: (mode: string) => void
  /**
   * 可选：切换显示单元（受电弓 2U / 3U）。
   * 只影响"屏上显示哪一个单元"，不改机械件——升的是同一台受电弓，
   * 不同的是它属于 04 车还是 06 车。
   */
  setUnit?: (unit: '2U' | '3U') => void
  /**
   * 可选：场景附加态（目前只有司机操纵台用）。
   *
   * 三项试验共用同一块 MON 与同一排门控按钮，而 `t` 只够表达"手走到第几拍"：
   * 屏上该显示空调页还是车门页、哪个按钮正被按下，都不是时间轴能推出来的。
   * 所以另开一条**离散**通道，由场景自己拼串（格式见 `driver_desk.ts` 的 `setAux`）。
   * 为什么是字符串而不是对象：`DeviceScene` 是 props 驱动的纯展示组件，
   * 传对象会因每次 render 新建引用而触发无意义的重绘。
   */
  setAux?: (spec: string) => void
  /**
   * 可选：**持续运转的件**（目前只有空调的两台轴流风机）。
   *
   * ## 为什么不能塞进 `setT`
   * `t` 表达的是"手走到第几拍"：通风模式下 `t` 一直是 0.55，但叶轮该一直转。
   * 把"转了几圈"塞进 `t`，时间轴一停风机就冻住、倒放还会反转——2026-11-14
   * 本人看到的就是这个：第 4 步写着"通风运行"，两台风机却纹丝不动。
   *
   * ## 约定
   * 返回 `true` = "这一刻还有东西在动"，`DeviceScene` 据此续下一帧；
   * 返回 `false` 就停掉 rAF。场景整体仍是**按需渲染**，只有真在转时才多烧帧。
   * `dt` 单位是秒，调用方已钳到 ≤50ms（切回标签页不会一下跳半圈）。
   */
  tick?: (dt: number) => boolean
  /** 0 = 初始状态，1 = 动作结束。外部时间轴 scrub 直接喂这个。 */
  setT: (t: number) => void
  /** 可点选/高亮的部件，键名与 DSL 的 `part` 枚举一一对应。 */
  parts: Record<string, Object3D>
  /**
   * 可选：部件的中文名称，供悬停气泡显示。
   *
   * ## 为什么由设备自己给，而不是 `DeviceScene` 统一查表
   * 契约 JSON（`web/src/contract/devices.json`，含 `part_labels`）有 12.5KB。
   * `DeviceScene` 在主包里（three 才是懒加载的那一层），静态引入它会直接顶破
   * 首屏预算（余量只有 1.9KB）。而设备模块本来就是 `await import()` 进来的，
   * 名称随设备分块走，看哪台设备就下载哪台的名称，零首屏成本。
   *
   * ## 口径
   * 内容必须与后端 `models/visual.py` 的 `PART_LABELS` 一致——那是权威源，
   * `devices.json` 由它生成。`builders.spec.ts` 有一条断言逐字比对，
   * 漂移会当场变红，不需要人记。
   */
  partLabels?: Record<string, string>
  /** 当前所处阶段（用于外部状态条显示）。 */
  phase: (t: number) => string
  /** 相机取景建议：不同设备的包围盒不一样，交给载荷自己报。 */
  framing: { target: [number, number, number]; distance: number }
  /**
   * 可选：机位方向（单位向量，从目标点指向相机）。默认 `(0.55, 0.16, 0.82)`，
   * 即"正前方偏右下 9°"。
   *
   * 为什么要按设备开放：默认机位是为整机（门、受电弓）调的——略微俯视即可。
   * 而**缝隙类细节**（塞尺插进门缝）必须从更高处往下看，否则片是插在一条
   * 侧对着镜头的槽里，看到的永远是一条线。这不是换个距离能解决的。
   */
  viewDir?: [number, number, number]
  /**
   * 可选：这一步要让人看清的部件键。给了它就**自动按画布宽高比算距离**，
   * `framing.distance` 退化为兜底。
   *
   * ## 为什么必须有这个
   * `PerspectiveCamera.fov` 是**垂直**视场角。坐标固定、画布一变扁（1097×509 的窗口里
   * 三维画布只有 658×166），同样的 distance 只能把物体挤进更少的高度——万用表表体
   * 在屏幕上只剩 50px，110.3 这个读数根本看不清。而三维演绎是本项目的核心，
   * 不是配图。
   *
   * ## 口径
   * 填**这一步真正要看的部件**，不是整个场景：桌面、背景墙、本步没参与的端子
   * 都排除在外。装得越紧凑，放大倍数越高。
   * 整机类（车门、受电弓）不要声明——它们要的是"看全"，不是"看清某个读数"。
   */
  focus?: string[]
  /** 自动取景的留白系数，默认 1.16。调大 = 退远。 */
  fitMargin?: number
  /**
   * 可选：滚轮**拉远**的上限倍数（相对于本刻度的基准距离），默认 1.6。
   *
   * ## 为什么需要按设备放开
   * 默认 1.6 是给"总高 2.25m 的门"定的。受电弓升到位后目标点是 1.54m、相机还
   * 带 0.42 的仰角，窗口一窄（`PantoOps` 右栏只有 ~330px 高）画面顶部就贴到弓头；
   * 用户滚轮拉到最远仍差一截，看起来像"缩放坏了"（2026-11-14 本人实测）。
   * 调大它 = 允许退到能看全"受电弓 + 接触网"的距离，代价只是拉远后模型变小。
   */
  zoomOut?: number
  /**
   * 可选：视场角（度）。默认 34（中焦）。
   * 元件特写要用小 FOV 长焦——同样的构图下透视更弱，
   * 一块竖直背板不会被拉成斜的，元件也更"正"。
   */
  fov?: number
  /**
   * 可选：环境光强度。默认 1.25。
   * 为什么要按场景分：浅色背板 + 浅色元件的场景（配电柜）在 1.25 下会整片过曝，
   * 而深色杆件为主、需要金属感的场景（受电弓）在同样的亮度下才正常。
   */
  envIntensity?: number
  /**
   * 可选：随动作进度给出取景。受电弓从 0.9m 升到 2.8m，
   * 用一套固定机位必然「升起时顶满、落下时缩成一点」，镜头必须跟着走。
   * 用户一旦手动拖过视角，跟随立即停止——不能跟人抢镜头。
   */
  framingAt?: (t: number) => { target: [number, number, number]; distance: number }
  /**
   * 可选：剖切能力。声明了就能被切开，没声明就没有这个功能。
   * 结构（门、柜）切开有意义；纯杆件机构（受电弓）切开只是把杆锯断，所以不声明。
   */
  cut?: CutSpec
  dispose: () => void
}

/** 高亮用的强调色。与前端主色同族，避免出现第六套配色。 */
export const FOCUS = 0x2f6fd0

/* ---------------------------------------------------------------- 程序化纹理 */

/** 确定性伪随机：同一份代码每次构建纹理一致，截图可复现。 */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/**
 * 拉丝金属的粗糙度纹理：一个方向上的细密条纹。
 * 真实不锈钢的拉丝是轧制留下的，方向高度一致，所以只沿 U 抖。
 * 只作 roughnessMap 用——当颜色贴图会立刻显假。
 */
function brushedRoughness(): Texture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const rand = lcg(20261109)
    ctx.fillStyle = '#8a8a8a'
    ctx.fillRect(0, 0, size, size)
    for (let y = 0; y < size; y += 1) {
      const v = 128 + Math.round((rand() - 0.5) * 46)
      ctx.fillStyle = `rgb(${v},${v},${v})`
      ctx.fillRect(0, y, size, 1)
    }
    // 几道深浅不匀的长纹，模拟轧制纹路的不均匀
    for (let i = 0; i < 7; i += 1) {
      const y = Math.floor(rand() * size)
      const alpha = 0.06 + rand() * 0.1
      ctx.fillStyle = `rgba(60,60,60,${alpha.toFixed(3)})`
      ctx.fillRect(0, y, size, 1 + Math.floor(rand() * 2))
    }
  }
  const tex = new CanvasTexture(canvas)
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.repeat.set(3, 6)
  tex.anisotropy = 4
  return tex
}

/** 磨砂表面的细微颗粒。橡胶、喷塑件用它，比纯 flat 有质感。 */
function grainRoughness(): Texture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const rand = lcg(77031)
    const img = ctx.createImageData(size, size)
    for (let i = 0; i < size * size; i += 1) {
      const v = 150 + Math.round((rand() - 0.5) * 70)
      img.data[i * 4] = v
      img.data[i * 4 + 1] = v
      img.data[i * 4 + 2] = v
      img.data[i * 4 + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
  }
  const tex = new CanvasTexture(canvas)
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.repeat.set(8, 8)
  return tex
}

/* -------------------------------------------------------------------- 材质库 */

let sharedBrushed: Texture | null = null
let sharedGrain: Texture | null = null

function brushed(): Texture {
  if (!sharedBrushed) sharedBrushed = brushedRoughness()
  return sharedBrushed
}

function grain(): Texture {
  if (!sharedGrain) sharedGrain = grainRoughness()
  return sharedGrain
}

/**
 * 拉丝不锈钢。车门外板最常见的表面，也是全场景最贵的材质——
 * metalness 拉满后完全靠环境图成像，所以必须有 environment 才有金属味。
 */
export function steelMaterial(color = 0xb9bdc1): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    metalness: 1,
    /* 参数来自 teardown 技能的「Taste, with numbers」：
       「Glossy metal under a low light streaks: roughness ≥ 0.45 and
       envMapIntensity ≈ 0.5 on big surfaces」。
       我们原来 0.42 / 1.15 正好落在起条纹的区间，门扇上会浮出油污状高光。 */
    roughness: 0.46,
    roughnessMap: brushed(),
    envMapIntensity: 0.85,
  })
}

/** 喷漆铝板：车内壁、门框。半哑光，反射柔和。
 *  `metalness` 取 0 不是偷懒：漆膜是电介质，PBR 里中间值只会得到「脏金属」的观感。
 *  纪律——金属度只在 0 和 1 之间选，同一条约束见 steel / chrome / rubber。 */
export function paintedMaterial(color = 0xd9d7d1): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    metalness: 0,
    roughness: 0.58,
    roughnessMap: grain(),
    envMapIntensity: 0.85,
  })
}

/** 橡胶密封条：几乎全漫反射，深色，不能有任何金属度。 */
export function rubberMaterial(color = 0x24262a): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    metalness: 0.0,
    roughness: 0.96,
    roughnessMap: grain(),
    envMapIntensity: 0.3,
  })
}

/** 镀铬五金（锁钩、把手、导轨）。低粗糙度，高对比高光。 */
export function chromeMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: 0xd6d9dc,
    metalness: 1,
    // 小件（螺钉、锁钩）允许更亮，但压到 0.9 以内，再高就在浅底上炸成白点
    roughness: 0.24,
    envMapIntensity: 0.9,
  })
}

/**
 * 观察窗玻璃。刻意**不用** transmission：真透射材质每帧要多渲染一遍场景，
 * 中低端机上直接把帧率砍半。这里用「低不透明度 + 高环境反射 + 深色底」骗过去，
 * 在静态观察角度下和真玻璃几乎分不出来。
 */
export function glassMaterial(): MeshPhysicalMaterial {
  return new MeshPhysicalMaterial({
    color: 0x3a4a55,
    metalness: 0,
    roughness: 0.08,
    transparent: true,
    /* 0.55：再深就变成两块黑板。真车门玻璃的主要观感是「反射环境」而不是「深色」 */
    opacity: 0.55,
    // 2.0 会让玻璃在浅色背板上反射成一块白斑，1.0 已经够「像玻璃」
    envMapIntensity: 1.0,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
  })
}

/** 指示灯。emissive 让它在任何光照下都自发光，不需要额外的 bloom 后处理。 */
export function lampMaterial(color: number): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    emissive: color,
    // 「Bloom eats detail: keep emissive layers under 1.0」——即使现在没接 bloom，
    // 1.4 的自发光在浅色场景里也会把灯糊成一团，看不清是哪个灯亮
    emissiveIntensity: 0.95,
    metalness: 0,
    roughness: 0.35,
  })
}

/** 地面：只用来接阴影，本身不可见（页面色透上来），避免出现「悬浮模型」。 */
export function floorMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: 0x9a9a96, roughness: 0.95, metalness: 0 })
}

/* ------------------------------------------------------------------ 几何工具 */

/** 单位上向量。杆件对齐要用它做参考轴，每次 new 一个太浪费。 */
const UP = new Vector3(0, 1, 0)
const _seg = new Vector3()

/**
 * 造一根定长杆件。受电弓这类连杆机构的全部动作都能归结为
 * 「两端点 + 一根杆」，所以这个函数是机构建模的主力。
 */
export function strut(length: number, radius: number, material: Material, segments = 12): Mesh {
  const mesh = new Mesh(new CylinderGeometry(radius, radius, length, segments), material)
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

/**
 * 把已有杆件摆到两点之间。只改位置与朝向，不改长度——
 * 机构的杆长是常量，动作靠铰点转动，给杆做缩放是错的。
 *
 * 例外是 `stretch`：像平衡杆这种按两点距离硬连的辅助杆，简化模型里两端点距离
 * 会随姿态变化，不缩放就会出现「一根 1m 的杆摆在 2.2m 的间距上」，悬在半空。
 * 细杆拉长看不出粗细变化，可以接受；主臂绝不能用这个开关。
 */
export function placeStrut(mesh: Mesh, from: Vector3, to: Vector3, stretch = false): void {
  _seg.subVectors(to, from)
  const length = _seg.length()
  if (length < 1e-6) return
  mesh.position.copy(from).addScaledVector(_seg, 0.5)
  mesh.quaternion.setFromUnitVectors(UP, _seg.divideScalar(length))
  if (stretch) {
    const base = (mesh.geometry as CylinderGeometry).parameters.height || 1
    mesh.scale.set(1, length / base, 1)
  }
}

/**
 * 圆角方件。直角边是「CG 感」最大的来源——真实钣金件没有一条绝对锐边。
 * radius 控制在 6–14mm，segments 2–3，够用又不爆面数。
 */
export function roundedBox(
  w: number,
  h: number,
  d: number,
  material: Material,
  x = 0,
  y = 0,
  z = 0,
  radius = 0.01,
  segments = 2,
): Mesh {
  const r = Math.min(radius, w / 2.05, h / 2.05, d / 2.05)
  const mesh = new Mesh(new RoundedBoxGeometry(w, h, d, segments, r), material)
  mesh.position.set(x, y, z)
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

/** 技术插图档的墨线包边（可选）。逼真模式下默认不用，只在「图解模式」打开。 */
export function withEdges(mesh: Mesh, opacity = 0.32): Mesh {
  const edges = new EdgesGeometry(mesh.geometry as BufferGeometry, 26)
  const lines = new LineSegments(
    edges,
    new LineBasicMaterial({ color: 0x14161a, transparent: true, opacity }),
  )
  lines.renderOrder = 1
  mesh.add(lines)
  return mesh
}

/* -------------------------------------------------------------------- 缓动 */

/** smoothstep：起止都平缓，比线性更像机械动作。入参自动夹到 0..1。 */
export function smooth(v: number): number {
  const t = v < 0 ? 0 : v > 1 ? 1 : v
  return t * t * (3 - 2 * t)
}

/** 取 [a, b] 区间内的归一化进度并平滑。a >= b 时退化成阶跃，避免除零。 */
export function seg(t: number, a: number, b: number): number {
  if (b <= a) return t >= b ? 1 : 0
  return smooth((t - a) / (b - a))
}

/* -------------------------------------------------------------------- 销毁 */

/** 释放整棵树的几何与材质。canvas 里的东西 GC 收不到，必须手动。 */
export function disposeTree(root: Object3D): void {
  root.traverse((obj) => {
    const holder = obj as Mesh | LineSegments
    if (holder.geometry) holder.geometry.dispose()
    const material = holder.material as Material | Material[] | undefined
    if (!material) return
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else material.dispose()
  })
}


/**
 * 程序化文字牌：铭牌 / 回路编号 / 警示标识。
 *
 * **零贴图文件**：字是用 Canvas 现画的，缩放靠 `ppm`，不引任何图片。
 * 为什么要它——S5 的 4× 近景实测里，`surfaceInfo` 九台有六台是 0 处，
 * 面板上没有任何"可读信息"，读起来就是一块塑料。
 *
 * 三条硬约束：
 * 1. **只写标识性文字**（名称、回路号、标准警示语），不写参数值。
 *    参数一律来自样例判据，印在模型上就变成"图上的实测值"（塞尺那页踩过这个坑）。
 * 2. 字号按牌高比例给，4× 近景要能读：牌高 0.05 m 时字号约 0.012 m，
 *    640 px 画幅下 ≈ 15 px 一个字。
 * 3. 贴面不透明（铭牌是金属牌+丝印），用 `MeshStandardMaterial` 保持与周围同光照。
 */
export interface TextPlateLine {
  text: string
  /** 字号比例（1 = 默认），同一块牌里混大小字用 */
  scale?: number
  color?: string
}

export interface TextPlateOptions {
  lines: TextPlateLine[]
  /** 牌面宽 / 高（米） */
  width: number
  height: number
  bg?: string
  border?: string
  /** 每米像素：默认 4096（0.1 m 的牌 → 410 px 宽） */
  ppm?: number
  /** 粗糙度：金属牌 0.4，贴纸 0.7 */
  roughness?: number
}

export function textPlate(o: TextPlateOptions): Mesh {
  const ppm = o.ppm ?? 4096
  const W = Math.min(1024, Math.max(48, Math.round(o.width * ppm)))
  const H = Math.min(1024, Math.max(24, Math.round((o.height / o.width) * W)))
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = o.bg ?? '#d8d5cd'
    ctx.fillRect(0, 0, W, H)
    if (o.border) {
      ctx.strokeStyle = o.border
      ctx.lineWidth = Math.max(2, Math.round(H * 0.06))
      ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, W - ctx.lineWidth, H - ctx.lineWidth)
    }
    const n = Math.max(1, o.lines.length)
    const base = (H * 0.78) / n
    o.lines.forEach((line, i) => {
      const size = base * (line.scale ?? 1)
      ctx.fillStyle = line.color ?? '#23262a'
      ctx.font = `600 ${Math.round(size)}px "Noto Sans SC","Microsoft YaHei",system-ui,sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(line.text, W / 2, (H * 0.11) + base * (i + 0.5) * 0.92, W * 0.9)
    })
  }
  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 8
  tex.needsUpdate = true
  const mesh = new Mesh(
    new PlaneGeometry(o.width, o.height),
    new MeshStandardMaterial({ map: tex, roughness: o.roughness ?? 0.45, metalness: 0.05 }),
  )
  // 文字牌是"信息层"，剖切时不该跟着被裁掉（否则剖切态下铭牌凭空消失）
  mesh.userData.cutKeep = true
  return mesh
}


/**
 * 六角螺栓（M6/M8）：头 + 垫圈，沿给定轴向贴在板面上。
 *
 * 为什么值得单独做一个组件：S5 的 4× 近景里，大平板空白面 50%~70%，
 * 而真实钣金的"密度感"一半来自**规则排列的紧固件**——它们是画面里唯一的
 * 高频结构。用 6 边柱（12 个三角面）就够，4× 下能看出六角，1× 下是一条压边。
 *
 * @param axis 螺栓轴：贴在顶面用 'y'，贴在 ±Z 侧板用 'z'，贴在 ±X 端板用 'x'
 */
export function hexBolt(
  parent: Object3D,
  x: number,
  y: number,
  z: number,
  axis: 'x' | 'y' | 'z' = 'y',
  diameter = 0.009,
  /** 沿轴的正负方向（贴在 -Z 侧板时要传 -1，否则螺栓会陷进板里） */
  sign = 1,
): void {
  const d = diameter
  const head = new Mesh(new CylinderGeometry(d / 2, d / 2, d * 0.44, 6), steelMaterial(0xb9bdc1))
  const washer = new Mesh(new CylinderGeometry(d * 0.82, d * 0.82, d * 0.10, 14), steelMaterial(0x9aa0a6))
  /* 圆柱默认沿 Y；转到目标轴。垫圈在里、六角头在外。
     **两者必须留缝**：第一版垫圈顶面与六角头底面只差 0.005d，qa 报
     `door.023<->door.024` 这类"每对 18 个共面三角"——全是我自己加的螺栓。
     现在垫圈占 [0, 0.10d]、六角头占 [0.16d, 0.60d]，中间 0.06d 的空隙。 */
  const lift = d * 0.38
  if (axis === 'x') {
    head.rotation.z = Math.PI / 2
    washer.rotation.z = Math.PI / 2
    head.position.set(x + lift * sign, y, z)
    washer.position.set(x + (d * 0.05) * sign, y, z)
  } else if (axis === 'z') {
    head.rotation.x = Math.PI / 2
    washer.rotation.x = Math.PI / 2
    head.position.set(x, y, z + lift * sign)
    washer.position.set(x, y, z + (d * 0.05) * sign)
  } else {
    head.position.set(x, y + lift * sign, z)
    washer.position.set(x, y + (d * 0.05) * sign, z)
  }
  parent.add(head, washer)
}

/** 沿直线等距排一串螺栓。首尾都落在端点上（与铆钉排同一约定）。 */
export function boltRun(
  parent: Object3D,
  from: [number, number, number],
  to: [number, number, number],
  count: number,
  axis: 'x' | 'y' | 'z' = 'y',
  diameter = 0.009,
  sign = 1,
): void {
  for (let i = 0; i < count; i += 1) {
    const k = count === 1 ? 0.5 : i / (count - 1)
    hexBolt(
      parent,
      from[0] + (to[0] - from[0]) * k,
      from[1] + (to[1] - from[1]) * k,
      from[2] + (to[2] - from[2]) * k,
      axis,
      diameter,
      sign,
    )
  }
}


/**
 * 角焊缝：梁与板交接处那条"鱼鳞"。低模做法——一条 4 mm 高的窄脊 + 微凹凸，
 * 不做真正的焊道几何（那要几万个面）。
 *
 * 为什么值得加：焊接件与螺栓连接件在近景里是两种东西。受电弓底架是**焊接**的，
 * 没有一个焊道就会读成"拼装玩具"。
 */
export function weldSeam(
  parent: Object3D,
  from: [number, number, number],
  to: [number, number, number],
  thickness = 0.005,
): void {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const dz = to[2] - from[2]
  const len = Math.hypot(dx, dy, dz)
  if (len < 1e-4) return
  const seam = new Mesh(new BoxGeometry(thickness, thickness, len), steelMaterial(0x8f959a))
  seam.position.set((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2)
  // 让 +Z 对准 from→to 方向
  seam.lookAt(new Vector3(to[0], to[1], to[2]))
  parent.add(seam)
}

/** 管卡：一圈抱箍（细环）+ 底座。管路每隔 0.4 m 一个（GB 50243 的常规间距）。 */
export function pipeClamp(
  parent: Object3D,
  at: [number, number, number],
  axis: 'x' | 'y' | 'z' = 'y',
  radius = 0.014,
  /** 管在该点的切向（给了就按切向摆正，比用坐标轴近似准得多）。
   *  软管是 CatmullRom 插值的：凭"看起来在这里"放管卡，门禁会当场报脱开 9mm——
   *  R25-15 第一次就是这么红的。正解是从**同一条曲线**取点与切向。 */
  dir?: [number, number, number],
): void {
  const strap = new Mesh(
    new CylinderGeometry(radius + 0.0022, radius + 0.0022, 0.008, 14, 1, true),
    steelMaterial(0xa9aeb3),
  )
  if (dir) {
    const from = new Vector3(0, 1, 0)
    const to = new Vector3(dir[0], dir[1], dir[2]).normalize()
    strap.quaternion.setFromUnitVectors(from, to)
  } else if (axis === 'x') strap.rotation.z = Math.PI / 2
  else if (axis === 'z') strap.rotation.x = Math.PI / 2
  strap.position.set(at[0], at[1], at[2])
  const foot = new Mesh(new BoxGeometry(0.018, 0.012, 0.014), steelMaterial(0x9aa0a6))
  foot.position.set(at[0], at[1] + radius + 0.008, at[2])
  parent.add(strap, foot)
}

/**
 * 钣金折边：板边那道 2 mm 小圆角翻边。真实钣金没有"刀切边"，
 * 折边既增加刚度又是最容易反光的一条细棱。
 *
 * 实现上只加一条 45° 的窄斜条（不是真折弯），4× 下足够读成折边。
 */
export function hemEdge(
  parent: Object3D,
  at: [number, number, number],
  length: number,
  axis: 'x' | 'y' | 'z' = 'x',
  size = 0.004,
): void {
  const dims: [number, number, number] = axis === 'x' ? [length, size, size]
    : axis === 'y' ? [size, length, size] : [size, size, length]
  const edge = new Mesh(new BoxGeometry(...dims), steelMaterial(0xbfc4c9))
  edge.position.set(at[0], at[1], at[2])
  edge.rotation.z = Math.PI / 4
  parent.add(edge)
}


/**
 * 线号管（线标套管）：导线外面套的一小段白色塑料管，现场用它在两端做回路编号。
 *
 * 为什么值得加：配电柜、控制箱的导线上**一定**有线号管；没有它，一束彩线就只是"彩线"，
 * 读不出"这是按图施工的线"。4× 近景里它是一圈白色套管，很显眼。
 *
 * **不印字**：真实线号管的字高约 2mm，4× 下也读不清；印上去只会变成糊点。
 * 要读编号的场景请用 `textPlate()` 单独做铭牌/端子牌。
 */
export function wireTag(
  parent: Object3D,
  at: [number, number, number],
  dir: [number, number, number] = [1, 0, 0],
  wireRadius = 0.007,
): void {
  const r = wireRadius * 1.45
  const sleeve = new Mesh(
    new CylinderGeometry(r, r, 0.014, 12, 1, true),
    new MeshStandardMaterial({ color: 0xf0efe9, roughness: 0.72, metalness: 0 }),
  )
  const from = new Vector3(0, 1, 0)
  const to = new Vector3(dir[0], dir[1], dir[2]).normalize()
  sleeve.quaternion.setFromUnitVectors(from, to)
  sleeve.position.set(at[0], at[1], at[2])
  parent.add(sleeve)
}
