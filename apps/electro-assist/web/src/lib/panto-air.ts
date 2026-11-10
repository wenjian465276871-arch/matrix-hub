/**
 * 受电弓气路与三种试验工况的逻辑层（纯函数，不依赖 three）。
 *
 * ## 依据
 * 蓝本确定为 **TSG19A**（CRH380A 用，弓头 1950mm / 滑板 1576mm / 117kg）。
 * 三种工况来自公开资料《从结构到原理，CRH380A 受电弓详解》（公众号「轨道知道」2025-08-23）：
 *
 * 1. **正常升弓**：电磁阀得电 → 压缩空气经节流阀，**同时**向气囊与滑板气腔充气 →
 *    气囊压力达到一定值 → 下臂上转、上臂推动弓头 → 接触接触网取流。
 * 2. **正常降弓**：电磁阀失电 → 气囊压缩空气经电磁阀口排向大气 → 靠自重、由阻尼器
 *    控制下降速度，平稳落在止档上。
 * 3. **ADD 自动降弓**：滑板破裂 → 滑板气路泄漏 → 快排阀**出气口**压力下降而进气口不变
 *    → 形成压差 → 出气口压力降到压力开关断开设定值 → 常开触点由闭合跳为断开 →
 *    快排阀排气口打开 → 滑板与气囊的压缩空气直排大气 → 受电弓迅速落下。
 *
 * ## 为什么单独成模块
 * 时序原来在 `figures/devices/pantograph.ts`（`T`）与 `lib/demoreads.ts`（`PT`）各存一份。
 * 加 ADD 时只要有一边漏改，画面与读数就会各说各话——这类"两份同源数据"是本项目
 * 反复踩过的坑（跨端枚举也栽过一次）。这里做成唯一来源，两侧都从它取。
 *
 * ## 单位与口径
 * 压力 MPa、时间以归一化 `t ∈ [0,1]` 表示（0 = 落弓锁定，1 = 试验结束）。
 * 归一化不是图省事：演示页只有一根时间轴，实际秒数由 `durationMs` 换算。
 */

/** 三种试验工况。`normal` = 正常升降弓；`add` = ADD 自动降弓试验。 */
export type PantoMode = 'normal' | 'add'

/**
 * 归一化时序。**与画面一一对应**，改这里必须同时跑 `panto-air.spec.ts`。
 *
 * 0.00–0.04 落弓锁定（无压）→ 0.04–0.14 建压 → 0.14–0.54 升弓 →
 * 0.54–0.68 接触压力建立 → 0.68–0.80 保压（压力开关闭合）→ 0.80 起降弓。
 * 降弓段按模式分叉：正常走到 0.94 落弓；ADD 在 0.82 破裂、0.90 落弓。
 */
export const PANO_T = {
  airOn: 0.04,
  airFull: 0.12,
  raise0: 0.12,
  raise1: 0.54,
  press1: 0.68,
  hold1: 0.78,
  /** 电磁阀失电、开始降弓 */
  lower0: 0.8,
  /** 正常降弓落弓到位 */
  lower1: 0.94,
  /** ADD：碳滑板破裂 */
  addRupture: 0.82,
  /** ADD：压力开关触点断开 */
  addSwitch: 0.84,
  /** ADD：快排阀排空、落弓到位（明显早于正常降弓） */
  addLanded: 0.9,
} as const

/** 额定气囊压力（MPa）。TSG19A 的工作气压量级，演示取 0.62。 */
export const BAG_PRESSURE = 0.62
/**
 * 压力开关动作阈值（MPa 压差）。
 * 公开资料只说"出气口压力下降到压力开关的断开设定值"，没给具体数；
 * 这里取 0.03 作为演示值——**不是实测值**，标在读数里防止被当成真值。
 */
export const SWITCH_DIFF = 0.03

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const smooth = (a: number, b: number, t: number): number => {
  const x = clamp01((t - a) / (b - a))
  return x * x * (3 - 2 * x)
}

export interface AirState {
  /** 气囊压力 MPa */
  bag: number
  /** 滑板气腔压力 MPa（正常时与气囊同压，破裂后泄空） */
  slide: number
  /** 快排阀进/出气口压差 MPa */
  diff: number
  /** 压力开关常开触点是否闭合（有压且无压差 = 闭合） */
  switchClosed: boolean
  /** 弓头行程 0–1 */
  travel: number
  /** 本时刻所处工况的阶段名 */
  phase: string
  /** 当前是否处于 ADD 排气（快排阀打开） */
  venting: boolean
}

/**
 * 弓头行程 0–1。
 *
 * 正常降弓是**阻尼控制**的匀速下落（3.5s 量级）；ADD 是**快排**，落得更快——
 * 这正是现场区分"正常降弓"和"ADD 动作"最直观的一条，不能画成一样快。
 */
export function travel(t: number, mode: PantoMode = 'normal'): number {
  const T = PANO_T
  if (t < T.raise0) return 0
  if (t < T.raise1) return 0.94 * smooth(T.raise0, T.raise1, t)
  if (t < T.press1) return 0.94 + 0.06 * smooth(T.raise1, T.press1, t)
  if (t < T.lower0) return 1
  if (mode === 'add') {
    // 0.80 起先按阻尼下落一小段（破裂瞬间还没压降完），0.84 后排空、加速落下
    if (t < T.addSwitch) return 1 - 0.15 * smooth(T.lower0, T.addSwitch, t)
    return 0.85 * (1 - smooth(T.addSwitch, T.addLanded, t))
  }
  return 1 - smooth(T.lower0, T.lower1, t)
}

/** 气路状态。三种工况的全部差异都收敛在这里，画面与读数都只读它。 */
export function airState(t: number, mode: PantoMode = 'normal'): AirState {
  const T = PANO_T

  // 建压：气囊与滑板气腔**同时**充气（同一路气，经节流阀）
  let bag = 0
  if (t >= T.airOn) bag = BAG_PRESSURE * smooth(T.airOn, T.airFull, t)

  let slide = bag
  let venting = false

  if (t >= T.lower0) {
    if (mode === 'add') {
      // 破裂：滑板气路泄漏 → 出气口压力掉，进气口（气囊）暂时还撑着
      slide = bag * (1 - smooth(T.lower0, T.addRupture + 0.02, t))
      // 0.84 开关断开 → 快排阀排气口打开 → 气囊也排空
      if (t >= T.addSwitch) {
        venting = true
        bag = BAG_PRESSURE * 0.85 * (1 - smooth(T.addSwitch, T.addLanded - 0.01, t))
      }
    } else {
      // 正常降弓：电磁阀失电，气囊经阀口排气；滑板气腔同路，跟着掉
      bag = BAG_PRESSURE * (1 - smooth(T.lower0, T.lower0 + 0.06, t))
      slide = bag
    }
  }

  const diff = Math.max(0, bag - slide)
  const switchClosed = bag > 0.08 && diff < SWITCH_DIFF

  return { bag, slide, diff, switchClosed, travel: travel(t, mode), phase: phase(t, mode), venting }
}

/** 阶段名。现场看的就是这一行字，所以用"动作 + 判据"的说法，不用抽象状态词。 */
export function phase(t: number, mode: PantoMode = 'normal'): string {
  const T = PANO_T
  if (t < T.airOn) return '落弓锁定（无压）'
  if (t < T.raise0) return '气路建压（气囊+滑板气腔）'
  if (t < T.raise1) return '升弓中'
  if (t < T.press1) return '接触压力建立'
  if (t < T.hold1) return '升弓到位（开关闭合）'
  if (t < T.lower0) return '保压'
  if (mode === 'add') {
    if (t < T.addRupture) return '滑板破裂（出气口掉压）'
    if (t < T.addSwitch) return '压差建立中'
    if (t < T.addLanded) return '快排阀排气 · 自动降弓'
    return 'ADD 动作完成（落弓）'
  }
  if (t < T.lower1) return '降弓中（阻尼控制）'
  return '落弓到位'
}

/**
 * 两种工况的可见证据。做三维时按这张表逐条对，别凭印象加特效。
 *
 * | 工况 | 必须看得见 |
 * |---|---|
 * | 正常升弓 | 气囊鼓起 → 下臂上转 → 弓头接触接触线 → 压力开关闭合、升弓到位灯亮 |
 * | 正常降弓 | 电磁阀失电 → 气囊排气 → 阻尼器控制匀速下落 → 落在止档/弓装配上 |
 * | ADD | 滑板破裂 → 出气口掉压、压差出现 → 开关**断开** → 快排阀排气（有声有气）→ 弓头**明显更快**落下 |
 */
export const VISIBLE_EVIDENCE = {
  normalRaise: ['气囊鼓起', '下臂上转', '弓头接触线', '压力开关闭合', '升弓到位灯亮'],
  normalLower: ['电磁阀失电', '气囊排气', '阻尼匀速下落', '落在止档'],
  add: ['滑板破裂', '出气口掉压', '压差出现', '开关断开', '快排阀排气', '弓头更快落下'],
} as const
