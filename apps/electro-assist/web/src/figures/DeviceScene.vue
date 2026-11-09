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
  }>(),
  { subject: 'door', t: 0, focus: '', interactive: true, label: '' },
)

const host = ref<HTMLDivElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
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

function render(): void {
  if (renderer && scene && camera) renderer.render(scene, camera)
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
  render()
}

/**
 * 部件高亮：只加 emissive，不改颜色。
 * 改颜色会丢失原本的材质语义（不锈钢/橡胶/玻璃各有一套），
 * 叠加自发光则能在任何底色上被看见，也方便一键还原。
 */
function setFocus(key: string): void {
  if (!rig || !rigModule) return
  const focusHex = rigModule.FOCUS
  for (const [name, node] of Object.entries(rig.parts)) {
    const active = key !== '' && name === key
    node.traverse((child) => {
      const material = (child as Mesh).material
      if (!material) return
      const list = Array.isArray(material) ? material : [material]
      for (const item of list) {
        const std = item as MeshStandardMaterial
        if (!std.emissive) continue
        if (active) {
          if (std.userData.baseEmissive === undefined) {
            std.userData.baseEmissive = std.emissive.getHex()
            std.userData.baseIntensity = std.emissiveIntensity
          }
          std.emissive.setHex(focusHex)
          std.emissiveIntensity = 0.55
        } else if (std.userData.baseEmissive !== undefined) {
          std.emissive.setHex(std.userData.baseEmissive as number)
          std.emissiveIntensity = std.userData.baseIntensity as number
          delete std.userData.baseEmissive
          delete std.userData.baseIntensity
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
    const { buildDoor } = await import('./devices/door')
    rig = buildDoor()
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
  })
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
  const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js')
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04)
  scene.environment = env.texture
  scene.environmentIntensity = 1.15
  envTarget = env
  pmrem.dispose()

  const key = new T.DirectionalLight(0xfff6ea, 1.15)
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
  const fill = new T.DirectionalLight(0xd9e7ff, 0.7)
  fill.position.set(-4.4, 2.6, 2.6)
  scene.add(fill)

  const rim = new T.DirectionalLight(0xffefd6, 0.6)
  rim.position.set(-1.8, 1.4, -4.6)
  scene.add(rim)

  const { target, distance } = rig.framing
  camera = new T.PerspectiveCamera(34, 1, 0.1, 60)
  // 俯角压到 9°：再大就会让地面占满下半屏，产品图的机位基本与主体同高
  const dir = new T.Vector3(0.55, 0.16, 0.82).normalize()

  scene.add(rig.root)
  rig.setT(props.t)

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
  controls = ctrl as unknown as ControlsLike

  observer = new ResizeObserver(resize)
  observer.observe(hostEl)
  resize()

  if (props.focus) setFocus(props.focus)
  loading.value = false
}

watch(
  () => props.t,
  (value) => {
    rig?.setT(value)
    render()
  },
)

watch(
  () => props.focus,
  (value) => setFocus(value),
)

onMounted(() => {
  void init()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  controls?.dispose()
  controls = null
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
