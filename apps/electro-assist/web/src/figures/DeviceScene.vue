<script setup lang="ts">
/** 设备 3D 场景容器：Three.js 渲染、环境光照、按需渲染、交互与高亮。
 *
 *  ## 三条硬约束
 *  1. **Three.js 走动态 import**。首屏 46KB，three 本体约 140KB gzip，
 *     静态引入等于让每个访客为一张场景图付 3 倍首屏。这里只在组件挂载后
 *     才 `await import('three')` 与几何模块，主包不涨。
 *  2. **不写任何内联 style**（CSP `style-src 'self'`）。canvas 尺寸靠
 *     `setSize(w, h, false)` 的第三参关掉 style 写入，布局全交给 CSS 类；
 *     连 `el.style.width = ...` 都要避免，免得将来收紧 CSP 时集体返工。
 *  3. **按需渲染**：没有常驻 rAF 循环。只在参数变化、相机操作、resize 时
 *     渲染一帧。静止时 CPU 占用为 0——现场平板要能挂着放一整天。
 *
 *  ## 逼真度来源
 *  环境反射（RoomEnvironment → PMREM，零外部文件）+ PBR 材质分区 +
 *  软阴影 + ACES 色调映射。这四件是 Web 端「像不像产品渲染图」的胜负手，
 *  比把面数翻十倍有效得多。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, WebGLRenderer } from 'three'
import type { DeviceRig } from './devices/rig'
import type { SectionCutter } from './devices/section'

/** 只声明用得到的那几个成员，避免把整个 OrbitControls 的类型拖进主包。 */
interface ControlsLike {
  enabled: boolean
  target: { set(x: number, y: number, z: number): void }
  minPolarAngle: number
  maxPolarAngle: number
  minAzimuthAngle: number
  maxAzimuthAngle: number
  minDistance: number
  maxDistance: number
  addEventListener(type: string, listener: () => void): void
  update(): void
  dispose(): void
}

const props = withDefaults(
  defineProps<{
    /** 设备标识。构建期白名单，不是自由字符串——见后端 `models/visual.py` 同款纪律。 */
    subject?: string
    /** 动作进度 0..1。外部时间轴直接喂。 */
    t?: number
    /** 要高亮的部件键（`leaf_l` / `leaf_r` / `frame` / `lamp`），空串为不高亮。 */
    focus?: string
    /** 关掉鼠标/触摸旋转（打印预览、静态截图场景用）。 */
    interactive?: boolean
    /** 读屏替代文本。canvas 对读屏不可用，这句必须有。 */
    label?: string
    /** 剖切开关。设备没声明 `cut` 时无效（由 `cutable` 事件告知）。 */
    cut?: boolean
    /** 剖切位置 0..1。0 = 切得最深（露出内部），1 = 完全不切。 */
    cutAt?: number
    /**
     * 显示部件标注。默认关：指导书里的图只有 340px 高，五个标注会盖住整台设备。
     * 全屏三维页打开——那是"看清一台设备"的场景。
     */
    labels?: boolean
    /**
     * 试验工况。目前只有受电弓用：`normal` 正常升降弓 / `add` ADD 自动降弓。
     * 设备没实现 `setMode` 时无效。
     */
    mode?: string
  }>(),
  {
    subject: 'door',
    t: 0,
    focus: '',
    interactive: true,
    label: '',
    cut: false,
    cutAt: 0.5,
    labels: false,
    mode: 'normal',
  },
)

/**
 * `snapshot` 在每次停下后给出当前帧的 PNG dataURL。
 * 打印时必须用它——canvas 在纸上什么都不打，指导书不能出现空白框。
 */
const emit = defineEmits<{
  snapshot: [dataUrl: string]
  /** 该设备是否支持剖切。UI 据此决定要不要显示开关，避免按场景名硬编码。 */
  cutable: [value: boolean]
}>()

const host = ref<HTMLDivElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
/* 标注画在**第二块 2D canvas** 上，不是 DOM 浮层。
   原因是 CSP：本站 `style-src 'self'`，Vue 的 `:style` 会生成 style 属性，被直接拦掉。
   画在 canvas 里既不受 CSP 限制，又能在 devicePixelRatio 下保持文字锐利。 */
const annot = ref<HTMLCanvasElement | null>(null)
let annotCtx: CanvasRenderingContext2D | null = null
let annotW = 0
let annotH = 0
const error = ref('')
const loading = ref(true)

const ariaLabel = computed(
  () => props.label || `设备三维示意（${props.subject}），可拖动旋转查看`,
)

/* 模块引用不落成静态 import：`import type` 编译期擦除，运行期才拉真代码。 */
type RigModule = typeof import('./devices/rig')

let three: typeof import('three') | null = null
let rigModule: RigModule | null = null
let rig: DeviceRig | null = null
let renderer: WebGLRenderer | null = null
let scene: Scene | null = null
let camera: PerspectiveCamera | null = null
let controls: ControlsLike | null = null
let envTarget: { dispose(): void } | null = null
let observer: ResizeObserver | null = null
/** 剖切器。`section.ts` 同样只在用到时才加载，不拖首屏。 */
let cutter: SectionCutter | null = null

/**
 * 程序化影棚环境：给金属"反射内容"。
 *
 * ## 为什么不用 RoomEnvironment
 * 它是一座**空的浅灰房间**（几块发光板 + 灰墙）。PMREM 模糊之后，
 * 金属反射到的几乎是一片均匀浅灰——于是所有金属件看起来都像塑料：
 * 有亮度、没有明暗条纹。而真实照片里，金属最显眼的特征恰恰是
 * **反射出灯具的形状**（顶灯拉成一条白线、柔光箱是一块亮矩形）。
 *
 * ## 这里搭的是什么
 * 暗房（0.1 亮度墙）+ 三条顶部灯带 + 一块左侧柔光箱 + 一块右侧轮廓板。
 * 灯带做成细长条：金属杆件转个角度就会扫过一条高光，这是"工业感"的来源。
 *
 * ## 代价
 * 零外部文件（CSP 只允许 self/data），纯几何 + 自发光色块，
 * PMREM 烘焙一次约 20–40ms，之后只是环境贴图。
 */
function buildStudioEnv(T: typeof import('three')): import('three').Scene {
  const env = new T.Scene()

  /* 墙的颜色决定金属的**基础亮度**：`metalness=1` 的材质不吃漫反射，
     它只反射环境。墙压到 0.1 亮度时，抛光件会直接塌成剪影（实测过两轮）。
     所以墙用中灰（约 0.5 线性亮度），明暗层次靠**灯带的高动态范围**拉，
     不靠把墙压黑。 */
  const wall = new T.MeshBasicMaterial({ color: 0x7a8088, side: T.BackSide })
  env.add(new T.Mesh(new T.BoxGeometry(12, 9, 12), wall))

  /** 自发光板：HDR 值可以超过 1，PMREM 会把它烘成高光。 */
  const panel = (hex: number, gain: number) =>
    new T.MeshBasicMaterial({ color: new T.Color(hex).multiplyScalar(gain) })

  // 三条顶部灯带：细长，金属转动时会扫出线状高光
  for (const [x, z, len] of [
    [-1.7, 0, 3.4],
    [1.7, 0, 3.4],
    [0, 2.6, 2.6],
  ] as [number, number, number][]) {
    const bar = new T.Mesh(new T.BoxGeometry(0.42, 0.05, len), panel(0xffffff, 14))
    bar.position.set(x, 3.6, z)
    env.add(bar)
  }

  // 左侧柔光箱：一块大亮面，给金属左侧补一块缓的高光
  const softbox = new T.Mesh(new T.BoxGeometry(0.06, 3.4, 4.6), panel(0xfff2e0, 4.2))
  softbox.position.set(-4.8, 1.9, 0)
  env.add(softbox)

  // 右侧轮廓板：偏冷、弱一些，避免右侧完全黑掉
  const edge = new T.Mesh(new T.BoxGeometry(0.06, 2.2, 3.4), panel(0xdce8ff, 1.5))
  edge.position.set(4.8, 2.2, -1.2)
  env.add(edge)

  return env
}

/** 固定机位方向（单位向量，仰角 9°）。随动取景只改距离与目标点，不改方向。 */
const VIEW_DIR: [number, number, number] = [0.55, 0.16, 0.82]
/** 用户一旦拖动过视角，就停止自动跟随——镜头不能跟人抢。 */
let userMoved = false

/**
 * 距离自适应：按 `focus` 部件的包围盒 + 画布宽高比算距离。
 *
 * ## 为什么不能只改 CSS
 * `PerspectiveCamera.fov` 是垂直视场角。距离固定时，画布越扁，物体占据的
 * 像素高度越小——1097×509 的窗口里画布只有 658×166，万用表表体只剩 ~50px，
 * 读数看不清。放大画布只是把"50px"变成"100px"，仍然不够；
 * 必须同时把镜头推近到"刚好框住这一步要看的部件"。
 *
 * ## 算法
 * 垂直方向装下 h、水平方向装下 w，取更远的那个：
 *   dV = (h/2) / tan(fov/2)
 *   dH = (w/2) / (tan(fov/2) * aspect)
 * 斜视时深度会同时占据横纵，所以 w/h 各按深度的比例加一点。
 */
function fitDistance(aspect: number): number | null {
  if (!rig?.focus?.length || !three) return null
  const T = three
  const box = new T.Box3()
  let has = false
  rig.root.updateMatrixWorld(true)
  for (const key of rig.focus) {
    const obj = rig.parts[key]
    if (!obj) continue
    const b = new T.Box3().setFromObject(obj)
    if (b.isEmpty()) continue
    if (has) box.union(b)
    else {
      box.copy(b)
      has = true
    }
  }
  if (!has) return null

  const size = box.getSize(new T.Vector3())
  // 斜视补偿：深度方向的内容会同时占横向与纵向
  const w = size.x + size.z * 0.55
  const h = size.y + size.z * 0.45
  const tan = Math.tan((((rig.fov ?? 34) * Math.PI) / 180) / 2)
  const dV = h / 2 / tan
  const dH = w / 2 / (tan * Math.max(aspect, 0.1))
  return Math.max(dV, dH) * (rig.fitMargin ?? 1.16)
}

/** 统一落机位：初始化、随动、resize 三条路都走这里，避免三份算法漂移。 */
function placeCamera(t: number): void {
  if (!rig || !camera || !controls) return
  const view = rig.viewDir ?? VIEW_DIR
  const frame = rig.framingAt?.(t) ?? rig.framing
  const fitted = fitDistance(camera.aspect || 1)
  const distance = fitted ?? frame.distance
  controls.target.set(frame.target[0], frame.target[1], frame.target[2])
  camera.position.set(
    frame.target[0] + view[0] * distance,
    frame.target[1] + view[1] * distance,
    frame.target[2] + view[2] * distance,
  )
  controls.update()
  // 缩放上下限也跟着走：定死会让自适应之后的推近被 clamp 住
  const ctrl = controls as unknown as { minDistance: number; maxDistance: number }
  ctrl.minDistance = distance * 0.55
  ctrl.maxDistance = distance * 1.6
}

/**
 * 随动取景：设备高度变化大时必须跟着走。
 * 受电弓收弓 0.9m、到位 2.8m，固定机位只能二选一——要么升起时顶出画面，
 * 要么落下时缩成一个点。
 */
function followCamera(t: number): void {
  if (!rig?.framingAt || !camera || !controls || userMoved) return
  placeCamera(t)
}

let captureTimer = 0

/** 把当前帧导出成 PNG。失败只是打印版少一张图，不该影响交互，所以静默吞掉。 */
function capture(): void {
  const canvasEl = canvas.value
  if (!canvasEl || !rig) return
  try {
    const url = canvasEl.toDataURL('image/png')
    // 空画布的 dataURL 很短；这里顺带挡掉「只截到一个透明框」
    if (url.length < 512) return
    emit('snapshot', url)
  } catch {
    /* 跨源污染或 GPU 回收时会抛，忽略 */
  }
}

/** 拖动时每帧截图会卡（一次 toDataURL 约 10–30ms），停下再截。 */
function scheduleCapture(): void {
  window.clearTimeout(captureTimer)
  captureTimer = window.setTimeout(capture, 320)
}

function render(): void {
  if (renderer && scene && camera) renderer.render(scene, camera)
  drawAnnotations()
}

/**
 * 把 `rig.annotations()` 给的**世界坐标**投影成屏幕上的引线标签。
 *
 * 每帧重画（一次 clear + 五个矩形，开销可以忽略）。位置算错的地方只有一个：
 * 忘了 `camera.updateMatrixWorld()`——`render()` 里已经做过，所以这里直接用 `project`。
 * 在 `z > 1` 时跳过：那是相机背后的点，投影会翻到画面另一侧。
 */
function drawAnnotations(): void {
  const ctx = annotCtx
  if (!ctx || !annotW || !annotH) return
  ctx.clearRect(0, 0, annotW, annotH)
  if (!props.labels || !rig?.annotations || !camera || !three) return

  const items = rig.annotations()
  const v = new three.Vector3()
  interface Placed {
    text: string
    note?: string
    ax: number
    ay: number
    x: number
    y: number
    w: number
    h: number
  }
  const placed: Placed[] = []

  for (const item of items) {
    v.copy(item.at).project(camera)
    // z > 1 是相机背后的点：投影会翻到画面另一侧，画出来就是"飘在空中的假标签"
    if (v.z > 1 || v.z < -1) continue
    const ax = (v.x * 0.5 + 0.5) * annotW
    const ay = (-v.y * 0.5 + 0.5) * annotH
    if (ax < -40 || ax > annotW + 40 || ay < -40 || ay > annotH + 40) continue

    ctx.font = '600 12px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif'
    const tw = ctx.measureText(item.text).width
    ctx.font = '11px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif'
    const nw = item.note ? ctx.measureText(item.note).width : 0
    const w = Math.max(tw, nw) + 18
    const h = item.note ? 34 : 21

    /* 靠右侧的锚点把标签放到左边，避免顶出画布。
       然后是**避让**：与已放好的标签重叠时整体下移。
       五个标签里有三个（气囊/快排阀/压力开关）挤在底架一角，
       不避让就会叠成一坨——这不是理论问题，是第一版截图里的实际样子。 */
    let x = ax + 18
    if (ax > annotW * 0.58) x = ax - 18 - w
    x = Math.min(Math.max(x, 6), annotW - w - 6)
    /* 锚点掉在画面下三分之一时，标签往**上**放。
       只做"重叠就下移"会把底架附近那几个标签一路推到画面外——
       气囊/阻尼器/快排阀/气阀板的锚点全在底架，实测第一版就是这么丢的。 */
    let y = ay > annotH * 0.62 ? ay - h - 12 : ay - h / 2
    for (let guard = 0; guard < 6; guard += 1) {
      const hit = placed.find(
        (p2) => x < p2.x + p2.w + 6 && x + w + 6 > p2.x && y < p2.y + p2.h + 6 && y + h + 6 > p2.y,
      )
      if (!hit) break
      y = ay > annotH * 0.62 ? hit.y - h - 6 : hit.y + hit.h + 6
    }
    y = Math.min(Math.max(y, 6), annotH - h - 6)
    placed.push({ text: item.text, note: item.note, ax, ay, x, y, w, h })
  }

  for (const b of placed) {
    // 引线：从锚点到标签框最近的那个角，不要连到框中心（会穿过文字）
    const nearX = Math.min(Math.max(b.ax, b.x), b.x + b.w)
    const nearY = Math.min(Math.max(b.ay, b.y), b.y + b.h)
    ctx.strokeStyle = 'rgba(240, 245, 250, 0.66)'
    ctx.lineWidth = 1.1
    ctx.beginPath()
    ctx.moveTo(b.ax, b.ay)
    ctx.lineTo(nearX, nearY)
    ctx.stroke()
    ctx.fillStyle = 'rgba(240, 245, 250, 0.95)'
    ctx.beginPath()
    ctx.arc(b.ax, b.ay, 2.4, 0, Math.PI * 2)
    ctx.fill()

    const r = 5
    ctx.fillStyle = 'rgba(16, 20, 24, 0.8)'
    ctx.strokeStyle = 'rgba(232, 238, 244, 0.28)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(b.x + r, b.y)
    ctx.arcTo(b.x + b.w, b.y, b.x + b.w, b.y + b.h, r)
    ctx.arcTo(b.x + b.w, b.y + b.h, b.x, b.y + b.h, r)
    ctx.arcTo(b.x, b.y + b.h, b.x, b.y, r)
    ctx.arcTo(b.x, b.y, b.x + b.w, b.y, r)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()

    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#f2f5f8'
    ctx.font = '600 12px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif'
    ctx.fillText(b.text, b.x + 9, b.y + (b.note ? 11 : b.h / 2))
    if (b.note) {
      ctx.fillStyle = 'rgba(186, 200, 214, 0.95)'
      ctx.font = '11px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif'
      ctx.fillText(b.note, b.x + 9, b.y + 24)
    }
  }
}

function syncAnnotSize(width: number, height: number): void {
  const el = annot.value
  if (!el) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  annotW = width
  annotH = height
  el.width = Math.max(1, Math.round(width * dpr))
  el.height = Math.max(1, Math.round(height * dpr))
  annotCtx = el.getContext('2d')
  annotCtx?.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function resize(): void {
  const hostEl = host.value
  if (!hostEl || !renderer || !camera) return
  const width = hostEl.clientWidth
  const height = hostEl.clientHeight
  if (width === 0 || height === 0) return
  // 第三参 false：只改 drawingBuffer，不写 canvas.style，CSP 安全。
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  // 画布比例一变，自适应距离就得重算——否则「放大画布」只放大空白，物体不放大。
  // 用户拖过视角就不动他的机位（镜头不能跟人抢）。
  if (!userMoved && rig?.focus?.length) placeCamera(props.t)
  syncAnnotSize(width, height)
  render()
}

/**
 * 部件高亮：只加 emissive，不改颜色。
 * 改颜色会丢失原本的材质语义（不锈钢/橡胶/玻璃各有一套），
 * 叠加自发光则能在任何底色上被看见，也方便一键还原。
 */
function setFocus(key: string): void {
  // `T` 只是 init() 里的局部别名；模块级持有的是 `three`，这里必须用它。
  if (!rig || !rigModule || !three) return
  const accent = new three.Color(rigModule.FOCUS)
  for (const [name, node] of Object.entries(rig.parts)) {
    const active = key !== '' && name === key
    node.traverse((child) => {
      const material = (child as Mesh).material
      if (!material) return
      const list = Array.isArray(material) ? material : [material]
      for (const item of list) {
        const std = item as MeshStandardMaterial
        if (!std.color) continue
        if (active) {
          if (std.userData.baseColor === undefined) {
            std.userData.baseColor = std.color.getHex()
          }
          /* 高亮走**基色混合**，不走自发光。
             自发光对深色件（碳滑板、黑色气囊、深色缸体）等于加了一层蓝光，
             整块件会变成塑料蓝；基色混合对深色浅色都只是"染了一点色"，
             材质本色与明暗关系都还在。 */
          std.color.setHex(std.userData.baseColor as number).lerp(accent, 0.18)
        } else if (std.userData.baseColor !== undefined) {
          std.color.setHex(std.userData.baseColor as number)
          delete std.userData.baseColor
        }
      }
    })
  }
  render()
}

async function init(): Promise<void> {
  const hostEl = host.value
  const canvasEl = canvas.value
  if (!hostEl || !canvasEl) return

  try {
    three = await import('three')
    rigModule = await import('./devices/rig')
    /* 构建期白名单：subject 不是自由字符串，查到哪个建哪个。
       与后端 `models/visual.py` 的枚举纪律一致——模型不能靠一句话让前端加载任意场景。 */
    const builders: Record<string, () => Promise<() => DeviceRig>> = {
      door: async () => (await import('./devices/door')).buildDoor,
      pantograph: async () => (await import('./devices/pantograph')).buildPantograph,
      cabinet: async () => (await import('./devices/cabinet')).buildCabinet,
      hvac: async () => (await import('./devices/hvac')).buildHvac,
      // 工具类四台：静态资源同样按需加载，翻到没有它们的那一页就不下载
      multimeter: async () => (await import('./devices/multimeter')).buildMultimeter,
      warning_sign: async () => (await import('./devices/warning_sign')).buildWarningSign,
      feeler_gauge: async () => (await import('./devices/feeler_gauge')).buildFeelerGauge,
      torque_wrench: async () => (await import('./devices/torque_wrench')).buildTorqueWrench,
    }
    const load = builders[props.subject]
    if (!load) throw new Error(`未注册的设备场景：${props.subject}`)
    const build = await load()
    rig = build()
    /* 调试出口：把 rig 挂到 window 上，便于用 Playwright 量每个 mesh 的包围盒。
       2026-11-10 加——「改了参数画面没变化」连续出现三次，靠眼睛猜不动了。
       生产环境也挂：它不含敏感数据，而且只在演示页生效；换来的是可测。 */
    ;(window as unknown as { __rig?: unknown }).__rig = rig
    /* 同一个出口再挂一次重绘：本场景是**按需渲染**（没有 rAF 循环），
       在控制台里改 `mesh.visible` 之类不会自己刷新——2026-11-10 排查
       「隐藏部件后截图完全没变」时发现的：15 张隔离截图 md5 全同。 */
    ;(window as unknown as { __rigRender?: () => void }).__rigRender = render

    /* 导出 glb：给离线烘焙（Blender）用，**只在开发服务器里存在**。
       为什么挂在 DEV 分支：`import.meta.env.DEV` 在构建时被替换成常量 false，
       整段连同那条动态 import 一起被摇掉——生产包里不会多出 40kB 的导出器，
       也不会有任何人能在线上把场景抠出去。 */
    if (import.meta.env.DEV) {
      // 量包围盒要用 three 的 Box3；不给出口就得在页面上手搓矩阵，容易算错
      ;(window as unknown as { __three?: unknown }).__three = three
      ;(window as unknown as { __exportGlb?: (t?: number) => Promise<string> }).__exportGlb =
        async (t?: number) => {
          const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js')
          // 先摆到目标姿态再导出：几何是参数化的，姿态由 setT 决定，不摆就是落弓位
          rig!.setT(typeof t === 'number' ? t : props.t)
          rig!.root.updateMatrixWorld(true)
          const data = await new GLTFExporter().parseAsync(rig!.root, {
            binary: true,
            // 隐藏件不导出：ADD 工况下断成两截的滑板此刻是 visible=false，
            // 带出去会在 Blender 里和整根滑板重叠
            onlyVisible: true,
            maxTextureSize: 2048,
          })
          const bytes = new Uint8Array(data as ArrayBuffer)
          // 分块转 base64：一次性展开 400 万个参数会爆调用栈
          let bin = ''
          const CHUNK = 0x8000
          for (let i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
          }
          return btoa(bin)
        }

      /* 按**设备名**直接导出，不依赖"当前挂载的是哪台"。
         为什么需要它：切步骤时 Vue 会复用同一个 DeviceScene 实例，
         `__exportGlb` 闭包里的 rig 可能还指向上一步那台设备——
         2026-11-12 烘焙其余五台设备时，五张图里四张都成了同一台，
         排查半小时才发现是导出钩子的生命周期问题，不是渲染问题。
         这里现场建、导出、销毁，与页面状态完全解耦。 */
      ;(window as unknown as { __exportSubject?: (s: string, t?: number) => Promise<string> })
        .__exportSubject = async (subject: string, t = 0) => {
        const load = builders[subject]
        if (!load) throw new Error(`未注册的设备场景：${subject}`)
        const build = await load()
        const r = build()
        r.setT(t)
        r.root.updateMatrixWorld(true)
        const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js')
        const data = await new GLTFExporter().parseAsync(r.root, {
          binary: true,
          onlyVisible: true,
          maxTextureSize: 2048,
        })
        const bytes = new Uint8Array(data as ArrayBuffer)
        let bin = ''
        const CHUNK = 0x8000
        for (let i = 0; i < bytes.length; i += CHUNK) {
          bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
        }
        r.dispose?.()
        return btoa(bin)
      }

      /* 量一台设备在某个姿态下**指定部件**的世界包围盒，给离线烘焙算机位用。
         为什么要在浏览器里量：GLB 导出不保留节点名（受电弓那次实测），
         Blender 侧按名字取景取不到；而几何的真实位置只有 rig 自己知道。
         返回 center/size，脚本据此换算成"目标点 + 距离"。 */
      ;(window as unknown as {
        __subjectBox?: (
          subject: string,
          t?: number,
          keys?: string[],
        ) => Promise<{ center: [number, number, number]; size: [number, number, number] } | null>
      }).__subjectBox = async (subject: string, t = 0, keys) => {
        const load = builders[subject]
        if (!load) throw new Error(`未注册的设备场景：${subject}`)
        const build = await load()
        const r = build()
        r.setT(t)
        r.root.updateMatrixWorld(true)
        const box = new three!.Box3()
        const names = keys && keys.length ? keys : Object.keys(r.parts)
        /* 只量**看得见**的网格：检修盖板被"取下"后只是 visible=false，
           仍挂在树上，`expandByObject` 会把它算进去——量出来的框比实际大一圈，
           机位就会退远（2026-11-12 空调控制盒那张就是这么拍空的）。 */
        const visible = (o: import('three').Object3D): boolean => {
          let cur: import('three').Object3D | null = o
          while (cur) {
            if (!cur.visible) return false
            cur = cur.parent
          }
          return true
        }
        for (const key of names) {
          const part = r.parts[key]
          if (!part) continue
          const meshes: import('three').Object3D[] = []
          part.traverse((o) => {
            if ((o as import('three').Mesh).isMesh && visible(o)) meshes.push(o)
          })
          for (const mesh of meshes) box.expandByObject(mesh)
        }
        const out = box.isEmpty()
          ? null
          : {
              center: box.getCenter(new three!.Vector3()).toArray() as [number, number, number],
              size: box.getSize(new three!.Vector3()).toArray() as [number, number, number],
            }
        r.dispose?.()
        return out
      }
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : '3D 场景加载失败'
    loading.value = false
    return
  }

  const T = three
  if (!T || !rig) return

  renderer = new T.WebGLRenderer({
    canvas: canvasEl,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
    // 截图要在渲染之后读像素，不保留绘制缓冲会拿到一张全空图
    preserveDrawingBuffer: true,
  })
  // 逐材质的 clippingPlanes 需要它打开，否则设了也不生效
  renderer.localClippingEnabled = true
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  // ACES：没有它，金属高光会糊成一块死白，PBR 看起来还不如 Phong。这不是可选项。
  renderer.toneMapping = T.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.95
  renderer.outputColorSpace = T.SRGBColorSpace
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = T.PCFSoftShadowMap

  scene = new T.Scene()

  // 程序化环境光箱：零外部文件却有真实的高光形状，金属材质全靠它。
  const pmrem = new T.PMREMGenerator(renderer)
  // 0.02 比 RoomEnvironment 那套的 0.04 更锐：反射里的灯带要留得住形状，
  // 糊成一团又回到"均匀灰"了。
  const env = pmrem.fromScene(buildStudioEnv(T), 0.02)
  scene.environment = env.texture
  /* 金属的大面亮度几乎全来自环境图。RoomEnvironment 是中性室内，不够亮，
     metalness=1 的门扇会直接变黑——teardown 的「metal 参数」是在它自己的
     明亮影棚下调的，搬过来必须连环境亮度一起抬。 */
  scene.environmentIntensity = rig.envIntensity ?? 1.25
  envTarget = env
  pmrem.dispose()

  /* 光比（2026-11-10）：原来 key 1.15 / fill 0.7 / rim 0.6，加上环境光 1.0~1.25，
     四路光加起来 3.45，其中两路是"填阴影"的——结果就是物体浮在背景上、没有体积感。
     真实产品摄影里补光只负责"把暗部提到能看见"，不是把暗部提成亮的。
     现在 key 1.9（主）+ fill 0.34（暗部保底）+ rim 0.45（轮廓），对比度回来了。 */
  const key = new T.DirectionalLight(0xfff6ea, 1.9)
  // 主光偏正面：侧向光会把整面侧墙投到门洞上，出一块没意义的斜影。
  key.position.set(0.9, 4.4, 5.2)
  key.castShadow = true
  key.shadow.mapSize.set(1024, 1024)
  key.shadow.camera.near = 0.5
  key.shadow.camera.far = 18
  // 阴影相机贴着模型收：范围开太大等于把 1024² 的贴图摊薄，边缘会生硬。
  key.shadow.camera.left = -2.2
  key.shadow.camera.right = 2.2
  key.shadow.camera.top = 2.8
  key.shadow.camera.bottom = -0.6
  key.shadow.bias = -0.0006
  key.shadow.normalBias = 0.028
  scene.add(key)

  // 补光压冷、轮廓光偏暖：三灯是产品摄影的底配，少了立体感立刻塌。
  const fill = new T.DirectionalLight(0xd9e7ff, 0.34)
  fill.position.set(-4.4, 2.6, 2.6)
  scene.add(fill)

  const rim = new T.DirectionalLight(0xffefd6, 0.45)
  rim.position.set(-1.8, 1.4, -4.6)
  scene.add(rim)

  const { target, distance } = rig.framing
  camera = new T.PerspectiveCamera(rig.fov ?? 34, 1, 0.1, 60)
  // 机位方向可以由设备覆盖（缝隙类细节需要俯视），默认仍是 VIEW_DIR
  const view = rig.viewDir ?? VIEW_DIR
  const dir = new T.Vector3(view[0], view[1], view[2]).normalize()

  scene.add(rig.root)
  rig.setT(props.t)
  // 工况要在 setT 之后设：setMode 内部会按上一次的 t 重算一遍，此时 t 已就位
  if (props.mode) rig.setMode?.(props.mode)

  if (rig.cut) {
    const { createSection } = await import('./devices/section')
    cutter = createSection(rig.root, rig.cut)
    cutter.setAt(props.cutAt)
    cutter.setEnabled(props.cut)
    emit('cutable', true)
  } else {
    emit('cutable', false)
  }

  const { OrbitControls } = await import(
    'three/examples/jsm/controls/OrbitControls.js'
  )
  const ctrl = new OrbitControls(camera, canvasEl)
  ctrl.target.set(target[0], target[1], target[2])
  /* 顺序有坑：OrbitControls 构造时会用**当时**的 target（默认原点）重算一次朝向，
     如果先摆机位再 new controls，模型会整体偏上——画面中心对着地面原点。
     所以机位必须在 target 设好之后落，再 update() 让它按新目标重算。 */
  camera.position.set(target[0], target[1], target[2]).addScaledVector(dir, distance)
  ctrl.update()
  ctrl.enableDamping = false
  ctrl.enablePan = false
  // 限制机位：让用户看得到背面空壳是设计事故，不是自由度。
  ctrl.minPolarAngle = Math.PI * 0.24
  ctrl.maxPolarAngle = Math.PI * 0.52
  ctrl.minAzimuthAngle = -Math.PI * 0.44
  ctrl.maxAzimuthAngle = Math.PI * 0.44
  ctrl.minDistance = distance * 0.62
  ctrl.maxDistance = distance * 1.5
  ctrl.enabled = props.interactive
  ctrl.addEventListener('change', render)
  ctrl.addEventListener('start', () => {
    userMoved = true
  })
  controls = ctrl as unknown as ControlsLike

  observer = new ResizeObserver(resize)
  observer.observe(hostEl)
  resize()
  // 初始那一帧也要跟随：watch 不是 immediate，不显式调一次的话
  // 打开页面看到的是 framing 的固定机位，只有拖过一次时间轴才会切换。
  followCamera(props.t)

  if (props.focus) setFocus(props.focus)
  loading.value = false
  // 第一帧渲染完再截：此时 loading 已经关掉，画布里有内容
  capture()
}

watch(
  () => props.t,
  (value) => {
    rig?.setT(value)
    followCamera(value)
    render()
    scheduleCapture()
  },
)

watch(
  () => props.focus,
  (value) => setFocus(value),
)

watch(
  () => props.cut,
  (value) => {
    cutter?.setEnabled(value)
    render()
    scheduleCapture()
  },
)

watch(
  () => props.cutAt,
  (value) => {
    cutter?.setAt(value)
    render()
    scheduleCapture()
  },
)

/* 标注与工况：两者都只改"画法"，不动几何，所以一次 render 就够 */
watch(
  () => props.labels,
  () => {
    render()
    scheduleCapture()
  },
)

watch(
  () => props.mode,
  (value) => {
    rig?.setMode?.(value)
    followCamera(props.t)
    render()
    scheduleCapture()
  },
)

onMounted(() => {
  // `new WebGLRenderer` 在 try 之外：WebGL 被禁用或显卡上下文创建失败时
  // 它会直接抛（"Error creating WebGL context"）。不接住的话整个组件树报错，
  // 而这里其实只需要降级成一句话。
  void init().catch((err: unknown) => {
    error.value = err instanceof Error ? err.message : '三维场景初始化失败'
    loading.value = false
  })
})

onBeforeUnmount(() => {
  window.clearTimeout(captureTimer)
  observer?.disconnect()
  observer = null
  controls?.dispose()
  controls = null
  cutter?.dispose()
  cutter = null
  rig?.dispose()
  rig = null
  scene?.clear()
  scene = null
  envTarget?.dispose()
  envTarget = null
  renderer?.dispose()
  renderer = null
  camera = null
  rigModule = null
  three = null
})
</script>

<template>
  <div ref="host" class="scene">
    <canvas ref="canvas" class="scene__canvas" role="img" :aria-label="ariaLabel" />
    <!-- 标注层：纯视觉，同样的信息在读数面板里也有文字，所以对读屏隐藏 -->
    <canvas ref="annot" class="scene__annot" aria-hidden="true" />
    <p v-if="loading && !error" class="scene__note">正在加载三维场景…</p>
    <p v-else-if="error" class="scene__note scene__note--error">
      {{ error }} · 已降级为文字说明
    </p>
  </div>
</template>

<style scoped>
.scene {
  position: relative;
  width: 100%;
  /* 16:9 而不是 16:10：车门是横长的，画面高一点只会多出上下空白 */
  aspect-ratio: 3 / 2;
  overflow: hidden;
  border: 1px solid var(--c-line);
  border-radius: 12px;
  /* 中性灰底：太亮会把浅色钣金吞掉，太暗金属反射又失去参照 */
  background: #cfcec9;
}

.scene__canvas {
  display: block;
  width: 100%;
  height: 100%;
  /* OrbitControls 需要接管手势，否则拖动会带着整页滚 */
  touch-action: none;
  cursor: grab;
}

.scene__canvas:active {
  cursor: grabbing;
}

/* 标注层压在上面，但不吃鼠标：旋转仍然由 OrbitControls 接管 */
.scene__annot {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.scene__note {
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  margin: 0;
  transform: translateY(-50%);
  text-align: center;
  color: var(--c-ink-2);
  font-size: 13px;
}

.scene__note--error {
  color: var(--c-ink-2);
}

@media (prefers-color-scheme: dark) {
  /* 暗色下浅灰底会刺眼；降成中性深灰，反射仍然成立 */
  .scene {
    background: #24262a;
  }
}
</style>
