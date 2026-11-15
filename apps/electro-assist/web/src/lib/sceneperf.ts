/** 三维首帧计时（2026-11-15，R24-8）。
 *
 * ## 为什么先只做测量
 *
 * 「点下一步 → 三维出画」到底等多久，现在**没有任何数据**：只有主观印象。
 * 在这种情况下做预取（提前 `import('three')` + 下一步的设备 chunk）属于猜优化——
 * 万一等待主要在几何构建或首帧编译，预取一点用没有，还白占带宽。
 *
 * 所以这一步只加测量点，不改调度。拿到「改前 5 次中位数」之后再决定要不要预取。
 *
 * ## 口径（写清楚，免得以后拿它当"整段等待"）
 *
 * - 起点：`DeviceScene` 的 `setup()` 执行时刻——**chunk 已经下载并解析完**；
 * - 终点：第一次真正画到画布上（`render()` 里 `renderer.render()` 之后）；
 * - 因此这个数**不含网络**，含的是「WebGL 初始化 + 几何构建 + 首帧编译」。
 *   想知道含网络的整段，得在父组件翻页时打点，那是下一轮的事。
 *
 * ## 怎么读
 *
 * 控制台 / E2E 里：`__sceneFrames()` 返回最近 30 条 `{ subject, ms }`。
 * 只在有记录时才挂这个函数，正常浏览不产生全局副作用。
 */
export interface SceneFrame {
  /** 设备键（`door` / `hvac` / `pantograph` …），用来分辨是哪台设备慢。 */
  subject: string
  /** 从组件初始化到首帧的毫秒数（已取整）。 */
  ms: number
}

/** 只留最近 30 条：够算中位数，又不会把内存当日志用。 */
const MAX = 30
const frames: SceneFrame[] = []

export function recordSceneFrame(subject: string, ms: number): void {
  frames.push({ subject, ms: Math.round(ms) })
  if (frames.length > MAX) frames.splice(0, frames.length - MAX)
  installProbe()
}

export function readSceneFrames(): SceneFrame[] {
  return frames.slice()
}

/** 只为测试：清空。 */
export function resetSceneFrames(): void {
  frames.length = 0
}

let installed = false

function installProbe(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  ;(window as unknown as { __sceneFrames?: () => SceneFrame[] }).__sceneFrames = readSceneFrames
}
