/** 客室空调制冷试验（司机台操作）的会话状态。
 *
 *  ## 这份状态机守的是什么
 *  1. **MON 未上电不能设参数**——屏都没亮就"设定 24℃"是假动作；
 *  2. **设定温度不低于回风温度时压缩机不启动**——真实机组就是这么保护的
 *     （公开资料：制冷试验需把设定值压到车内温度以下，否则压缩机不动作）；
 *  3. **制冷先看通风**——先确认风机与风道，再起压缩机；反过来做，
 *     风量不够会让蒸发器结霜，这条是现场最常被跳过的一步。
 *  4. **"模式即起动"**（2026-11-14 本人追问"起动通风/起动制冷到底是什么逻辑"）：
 *     公开资料里的口径是"功能选择通风模式 → 确认送风回风 → 将模式调整为制冷，
 *     此时压缩机和冷凝风机开始工作"——**没有独立的"起动"按钮**。所以这里把
 *     `applySettings()` 作为唯一起机入口：下发通风 = 风机运行，下发制冷 = 压缩机运行。
 *
 *  ## 读数为什么是推的，不是写死的
 *  第 5 步要判「送回风温差 6–12 ℃、电流 10–14 A、高压 1.4–1.8 MPa」。
 *  如果三个数各写一个常量，图上永远合格，演示就退化成贴纸。
 *  这里用一条 0–1 的制冷进程 `coolT` 推所有读数：点「制冷」它才涨，
 *  涨到位读数才落进范围——判据是"跑出来"的，不是"印上去"的。
 *
 *  ## 时间压缩
 *  现场制冷稳定要 15 分钟。演示按 25 秒走完（`COOL_SECONDS`），
 *  另给一个「模拟运行 15 分钟」直接推到稳态——E2E 与讲解都不必真等。
 */
import { reactive } from 'vue'

import { powered } from './desk-power'

export type HvacMode = 'off' | 'vent' | 'cool' | 'heat'
/** 需要逐项确认的五条（第 3、4、5 步各认几条）。 */
export type HvacKey = 'comm' | 'fan' | 'drain' | 'comp' | 'pressure'

export interface ActionResult {
  ok: boolean
  hint: string
}

const OK = (hint = ''): ActionResult => ({ ok: true, hint })

/** 制冷进程走满所需秒数。现场 15 min，演示 25 s。 */
const COOL_SECONDS = 25

/** 环境与初始客室温度（演示虚构值）。 */
export const AMBIENT_TEMP = 32
const CABIN_START = 28.5

interface State {
  /** 屏上选中、尚未下发的模式。 */
  pending: HvacMode
  /** 已下发的模式。 */
  mode: HvacMode
  /** 屏上选中、尚未下发的设定温度。 */
  pendingTemp: number
  /** 已下发的设定温度。 */
  setTemp: number
  /** 新风门：制冷试验要求关闭（公开资料：关闭新风门后测温差）。 */
  freshAir: 'closed' | 'open'
  applied: boolean
  ventRunning: boolean
  cooling: boolean
  /** 制冷进程 0–1。所有读数由它推。 */
  coolT: number
  confirmed: Record<HvacKey, boolean>
  notice: string
}

function initial(): State {
  return {
    pending: 'off',
    mode: 'off',
    pendingTemp: 24,
    setTemp: 24,
    freshAir: 'closed',
    applied: false,
    ventRunning: false,
    cooling: false,
    coolT: 0,
    confirmed: { comm: false, fan: false, drain: false, comp: false, pressure: false },
    notice: '',
  }
}

export const hvac = reactive<State>(initial())

export function reset(): void {
  Object.assign(hvac, initial())
}

/* ------------------------------------------------------------------ 读数 */

/** 回风温度：从 28.5 緩慢降到 25.9（客室热惯性）。 */
export function returnTemp(): number {
  return round1(CABIN_START - 2.6 * hvac.coolT)
}

/** 送风温度：比回风低 10 ℃（稳定后 15.9 ℃）。启动瞬间两者相等。 */
export function supplyTemp(): number {
  return round1(returnTemp() - 10 * hvac.coolT)
}

/** 送回风温差。判据 6–12 ℃，稳定后 9.8。 */
export function tempDiff(): number {
  return round1(returnTemp() - supplyTemp())
}

/** 压缩机运行电流：起动 3 秒内爬到 12.4 A。 */
export function compressorCurrent(): number {
  return round1(12.4 * Math.min(1, hvac.coolT * 3))
}

/** 高压侧压力：随负荷升到 1.70 MPa（正常 1.4–1.8）。 */
export function highPressure(): number {
  return round1(1.35 + 0.35 * Math.min(1, hvac.coolT * 2))
}

/** 低压侧压力：稳定后 0.34 MPa（正常 0.2–0.5）。
 *
 *  这里必须按**两位**取整：0.42−0.08 的浮点结果是 0.34000000000000003，
 *  按一位取整会显示成 0.3，而指导书写的是 0.34——同一页两个数字对不上。 */
export function lowPressure(): number {
  return Math.round((0.42 - 0.08 * hvac.coolT) * 100) / 100
}

/** 送风口风速：通风运行即 2.4 m/s（判据 1.5–3.0）。 */
export function supplySpeed(): number {
  return hvac.ventRunning ? 2.4 : 0
}

/** 送风温度是否已稳定（供 UI 提示"再等等"）。 */
export function coolingStable(): boolean {
  return hvac.coolT >= 0.999
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/* ------------------------------------------------------------------ 动作 */

export function poweredNow(): boolean {
  return powered()
}

const OFF_HINT = 'MON 未上电：先插钥匙右旋，并把制动手柄推到「快速」位'

/** 在 MON 上选模式（只是选中，未下发）。 */
export function selectMode(mode: HvacMode): ActionResult {
  if (!powered()) return { ok: false, hint: OFF_HINT }
  if (hvac.cooling) return { ok: false, hint: '压缩机正在运行：先停制冷再改模式' }
  hvac.pending = mode
  return OK(`已选中「${MODE_LABEL[mode]}」，点「下发设定」生效`)
}

/** 设定温度 ±0.5 ℃。范围 16–30 ℃（公开资料里客室设定的一般范围）。 */
export function bumpTemp(delta: number): ActionResult {
  if (!powered()) return { ok: false, hint: OFF_HINT }
  if (hvac.cooling) return { ok: false, hint: '压缩机正在运行：先停制冷再改设定温度' }
  const next = Math.min(30, Math.max(16, hvac.pendingTemp + delta))
  if (next === hvac.pendingTemp) {
    return { ok: false, hint: `设定温度已到${delta > 0 ? '上' : '下'}限 ${next} ℃` }
  }
  hvac.pendingTemp = next
  return OK(`设定温度 ${next} ℃（未下发）`)
}

/** 新风门开关。制冷试验要求关闭。 */
export function toggleFreshAir(): ActionResult {
  if (!powered()) return { ok: false, hint: OFF_HINT }
  hvac.freshAir = hvac.freshAir === 'closed' ? 'open' : 'closed'
  return OK(`新风门已${hvac.freshAir === 'closed' ? '关闭' : '打开'}`)
}

/** 下发设定。这是"屏上改的那一堆"真正写进机组的一刻。 */
/**
 * 下发设定 = **起机**。
 *
 * 公开资料里空调没有"起动通风""起动制冷"这类独立按钮：模式选到通风，风机就转；
 * 模式调到制冷，压缩机与冷凝风机就开始工作。所以这里把"下发"当成唯一入口，
 * 界面上的按钮只该出现在 MON 屏上（司机台没有这颗实体按钮）。
 *
 * 三条前置仍在：新风门关闭、设定温度低于回风 2 ℃ 以上（否则压缩机不启动）。
 */
export function applySettings(): ActionResult {
  if (!powered()) return { ok: false, hint: OFF_HINT }
  if (hvac.pending === 'off') return { ok: false, hint: '先在 MON 上选一个模式（通风 / 制冷 / 制热）' }
  /* 重复下发同一份设定 = 幂等（评审 R23-3，2026-11-15）。
     原来运行中再点一次会掉进下面的"设定温度不低于回风"分支，回一句"压缩机不会启动"
     ——而屏上正写着「压缩机 12.4 A」。同一块屏上一句话否定自己的读数，是最难辩解的那种错。
     真值表：设定没变 → 什么都不做；设定变了 → 才回到"压缩机运行中不许改"的拒绝。 */
  if (hvac.cooling && hvac.pending === hvac.mode && hvac.pendingTemp === hvac.setTemp) {
    return OK(`设定未变：机组保持「${MODE_LABEL[hvac.mode]} ${hvac.setTemp} ℃」运行`)
  }
  if (hvac.pending === 'cool') {
    if (hvac.freshAir === 'open') {
      return { ok: false, hint: '新风门未关闭：制冷试验要求关闭新风门，否则温差测不准' }
    }
    if (hvac.pendingTemp >= returnTemp() - 2) {
      return {
        ok: false,
        hint: `设定 ${hvac.pendingTemp} ℃ 不低于回风 ${returnTemp()} ℃：压缩机不会启动，把设定温度调低 2 ℃ 以上`,
      }
    }
  }
  hvac.mode = hvac.pending
  hvac.setTemp = hvac.pendingTemp
  hvac.applied = true
  // 模式即起动：通风只转风机；制冷同时起压缩机
  hvac.ventRunning = hvac.pending === 'vent' || hvac.pending === 'cool'
  hvac.cooling = hvac.pending === 'cool'
  if (hvac.cooling) hvac.coolT = 0
  return OK(`已下发：${MODE_LABEL[hvac.mode]} · 设定 ${hvac.setTemp} ℃`)
}

/** 在 MON 上确认一条。`comp` / `pressure` 必须压缩机真的在转才有东西可确认。 */
export function confirmHvac(key: HvacKey): ActionResult {
  if (!powered()) return { ok: false, hint: OFF_HINT }
  if (!applicable(key)) {
    return {
      ok: false,
      hint: '通风模式下压缩机不运行：这两项本步不判，切到制冷后再确认',
    }
  }
  if (key === 'fan' && !hvac.ventRunning) {
    return { ok: false, hint: '风机还没转：先起动通风再确认风机状态' }
  }
  hvac.confirmed[key] = true
  return OK('MON 已确认一项')
}

export function confirmDone(): number {
  return HVAC_ITEMS.filter((item) => hvac.confirmed[item.key]).length
}

/** 通风阶段（只判三项）已确认几条。 */
export function ventConfirmDone(): number {
  return VENT_KEYS.filter((key) => hvac.confirmed[key]).length
}

export function ventConfirmMissing(): HvacKey[] {
  return VENT_KEYS.filter((key) => !hvac.confirmed[key])
}

export function confirmMissing(): HvacKey[] {
  return HVAC_ITEMS.filter((item) => !hvac.confirmed[item.key]).map((item) => item.key)
}

/** 通风阶段要确认的三项。**压缩机与高压侧压力在这一阶段不适用**：
 *  压缩机不转，就没有电流、也没有高压侧读数——写成"未确认"会让人以为漏做了一步。
 *  2026-11-14 本人实测指出这一点。 */
export const VENT_KEYS: HvacKey[] = ['comm', 'fan', 'drain']

/**
 * 这一项在当前工况下**有没有东西可确认**。
 *
 * 通风：只有通信、风机、排水滤网三项；制冷：五项全部。
 * 判据来源是物理事实（压缩机不转 ⇒ 无电流、无高压），不是界面取舍。
 */
export function applicable(key: HvacKey): boolean {
  if (key === 'comp' || key === 'pressure') return hvac.cooling
  return true
}

export const HVAC_ITEMS: Array<{ key: HvacKey; label: string; required: string; value: () => string }> = [
  { key: 'comm', label: '全列机组通信', required: '正常', value: () => '8/8 正常' },
  { key: 'fan', label: '冷凝/送风机', required: '运转平稳', value: () => (hvac.ventRunning ? '2+2 运行' : '停止') },
  // 未确认时显示「—」而不是「未确认」：这一列是**显示值**，不是确认状态。
  // 确认状态在第四列（○ / ✓），两列各说一件事（2026-11-14 本人要求）。
  {
    key: 'drain',
    label: '排水与滤网',
    required: '畅通、清洁',
    value: () => (hvac.confirmed.drain ? '畅通、清洁' : '—'),
  },
  {
    key: 'comp',
    label: '压缩机',
    required: '运行',
    value: () => (hvac.cooling ? `${compressorCurrent().toFixed(1)} A` : hvac.ventRunning ? '—' : '停止'),
  },
  {
    key: 'pressure',
    label: '高压侧压力',
    required: '1.4–1.8 MPa',
    value: () => (hvac.cooling ? `${highPressure().toFixed(2)} MPa` : '—'),
  },
]

/* ------------------------------------------------------------------ 推进 */

/** 推进制冷进程。返回是否还在动（组件据此决定要不要继续 rAF）。 */
export function stepCooling(dt: number): boolean {
  if (!hvac.cooling) return false
  if (hvac.coolT >= 1) return false
  hvac.coolT = Math.min(1, hvac.coolT + Math.max(0, dt) / COOL_SECONDS)
  return hvac.coolT < 1
}

/* ------------------------------------------------------------------ 派生 */

export const MODE_LABEL: Record<HvacMode, string> = {
  off: '停止',
  vent: '通风',
  cool: '制冷',
  heat: '制热',
}

/** 机组三维进度：与后端 `DEVICE_MOMENTS['hvac']` 的时刻一致。 */
export function unitT(): number {
  if (hvac.coolT >= 0.999) return 1
  if (hvac.cooling) return 0.78
  if (hvac.ventRunning) return 0.55
  if (hvac.applied) return 0.4
  return 0.36
}

export function stageText(): string {
  if (coolingStable()) return '制冷稳定、读数在范围内'
  if (hvac.cooling) return '制冷运行中'
  if (hvac.ventRunning) return '通风运行'
  if (hvac.applied) return `已下发 ${MODE_LABEL[hvac.mode]} ${hvac.setTemp} ℃`
  return '机组未起动'
}

export function nextAction(): string {
  if (!powered()) return '先完成上电：点三维里的主控钥匙与制动手柄（钥匙右旋 + 手柄快速位）'
  if (!hvac.applied) {
    return hvac.pending === 'cool'
      ? '点 MON 屏：模式选「制冷」、设定 24 ℃，点「下发设定」起动压缩机'
      : '点 MON 屏：选「通风」并「下发设定」，机组风机随即运行'
  }
  if (hvac.mode === 'vent' && !hvac.cooling) {
    const left = ventConfirmMissing()
    if (left.length) return '在 MON「机组状态」页确认：全列机组通信、冷凝/送风机、排水与滤网（通风模式下压缩机与高压侧压力不判）'
    return '通风三项已确认：测送风口风速与送风温度，完成后进入下一工步'
  }
  if (hvac.cooling && hvac.coolT < 1) return '制冷运行中：等读数稳定（现场 15 分钟）'
  if (confirmMissing().length) return '点 MON 屏：在「机组状态」页把五项逐项确认'
  return '五项已确认，可进入结论'
}
