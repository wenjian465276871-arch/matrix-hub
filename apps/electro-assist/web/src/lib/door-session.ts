/** 客室车门开关门试验（司机室操纵台操作）的会话状态。
 *
 *  ## 联锁来自公开资料，不是编的
 *  - 车速 < 5 km/h 才允许集控开门（零速保护）；
 *  - 顺序是**集控投入 → 开门 → 关门**：转换开关盘「集控」扳到投入，全列该侧门
 *    才接受集控（2026-11-15 改：原「释放按钮」在实车操纵台上不存在，见 R25-5）；
 *  - 关门过程中碰到障碍物，门**立即停止并反向开门到位**，**不会自己再关**；
 *    每一次重新按关门都会重新检测，连续 3 次受阻 → 停在全开位并报「关门障碍物超次数」
 *    （2026-11-17 本人：按钮不能锁死——人按错了会再按一次；要治的是"门自己再关"）；
 *  - 任意一个门没关到位，司机室操纵台的关门灯就灭。
 *  （见 `data/samples/door_switch_desk.json` 的 `source_note`，只引公开资料。）
 *
 *  ## 数字口径
 *  开门 2.5–4.0 s、关门 3.0–5.0 s 是公开资料给的通行区间；演示按 3.2 s / 3.6 s
 *  跑（`OPEN_SECONDS` / `CLOSE_SECONDS`），两个值都落在区间内——**不能**为了
 *  动画好看跑出区间，那会让同一页上的"读数"和"动画时长"互相打脸。
 */
import { reactive } from 'vue'

import { powered } from './desk-power'

export type Side = 'L' | 'R'
export type DoorKey = 'closed' | 'isolated' | 'nofault'

export interface ActionResult {
  ok: boolean
  hint: string
}

const OK = (hint = ''): ActionResult => ({ ok: true, hint })

/** 开门到位耗时（秒）。公开区间 2.5–4.0。 */
export const OPEN_SECONDS = 3.2
/** 关门到位耗时（秒）。公开区间 3.0–5.0。 */
export const CLOSE_SECONDS = 3.6
/**
 * 防夹反开的深度：门扇从 1.0 收到这里就判定"碰到东西"。
 *
 * ## 2026-11-15 单扇化后重算（R25-3）
 * 单扇门向 +X 滑开、前缘在 −X，试块摆在**左门框侧的关闭边**（中心 −0.405，
 * 宽 0.20 ⇒ 右缘 −0.305）。门扇前缘随行程右移：`前缘 = travel − leafW/2`，
 * 碰到的条件是 `travel − 0.535 = −0.305` ⇒ `travel = 0.23` ⇒
 * `openT = 0.23 / 1.061 ≈ 0.217`。取 **0.22**（比理论值晚 3mm，当作软物压缩量）。
 *
 * 旧值 0.30 是双扇结构按「两扇中间夹一块 0.16m」算出来的，单扇化后不成立：
 * 那时门已经滑到 0.318，前缘还在 −0.217，根本够不到左门框边的试块。
 */
const PINCH_AT = 0.22
/** 允许集控开门的最高车速（km/h）。 */
export const ZERO_SPEED_LIMIT = 5

interface State {
  side: Side
  /** 车门已释放（全列该侧接受集控）。 */
  released: boolean
  /** 门开度 0（关闭锁闭）–1（完全开启）。 */
  openT: number
  /** 目标位：1 开、0 关。 */
  target: 0 | 1
  /** 中缝里放了试块（防夹试验用）。 */
  blocked: boolean
  /** 已反开次数。 */
  bumps: number
  /** 故障文案，空串为无。 */
  fault: string
  /** 关门灯（司机室操纵台）。 */
  closedLed: boolean
  /** 正在反开：pinching 收门、reopening 回开。 */
  pinching: boolean
  reopening: boolean
  confirmed: Record<DoorKey, boolean>
  notice: string
}

function initial(): State {
  return {
    side: 'L',
    released: false,
    openT: 0,
    target: 0,
    blocked: false,
    bumps: 0,
    fault: '',
    closedLed: true,
    pinching: false,
    reopening: false,
    confirmed: { closed: false, isolated: false, nofault: false },
    notice: '',
  }
}

export const door = reactive<State>(initial())

export function reset(): void {
  Object.assign(door, initial())
}

/* ------------------------------------------------------------------ 读数 */

export function openTime(): number {
  return OPEN_SECONDS
}

export function closeTime(): number {
  return CLOSE_SECONDS
}

/** 门扇状态一句话。 */
export function doorState(): string {
  if (door.openT >= 0.999) return '完全开启'
  if (door.openT <= 0.001) return '关闭锁闭'
  if (door.pinching) return '门页碰到试块、反向开门中'
  return door.target === 1 ? '开门中' : '关门中'
}

/* ------------------------------------------------------------------ 动作 */

const OFF_HINT = 'MON 未上电：先插钥匙右旋，并把制动手柄推到「快速」位'

/** 屏是否点亮（透给面板组件，避免它们各自 import 两处状态）。 */
export function poweredNow(): boolean {
  return powered()
}

export function selectSide(side: Side): ActionResult {
  if (door.openT > 0.001) return { ok: false, hint: '门扇未关闭：先关门再换侧' }
  if (door.released) return { ok: false, hint: '集控已释放：先按「释放」复位再换侧' }
  door.side = side
  return OK(`试验侧：${side === 'L' ? '左侧（站台侧）' : '右侧'}`)
}

/**
 * 集控释放 / 复位。按下后按钮灯亮，全列该侧门接受集控。
 *
 * 2026-11-14：门已关闭时**再按一次 = 复位**（灯灭）。现场这颗按钮是自复位式的，
 * 但"释放状态"必须能解除——试验结束不复位，下次动车就可能误开门。
 * 门开着的时候按它没有任何意义，直接拒绝。
 */
export function release(): ActionResult {
  if (!powered()) return { ok: false, hint: OFF_HINT }
  if (door.openT > 0.001) return { ok: false, hint: '门扇未关闭：先关门，再按「释放」复位' }
  if (door.released) {
    door.released = false
    return OK('释放已复位：按钮灯灭，全列该侧恢复未释放')
  }
  door.released = true
  return OK(`${door.side === 'L' ? '左' : '右'}侧车门已释放：按钮灯亮，全列该侧接受集控`)
}

/** 集控开门。 */
export function open(): ActionResult {
  if (!powered()) return { ok: false, hint: OFF_HINT }
  if (!door.released) return { ok: false, hint: '未投入集控：先把转换开关盘的「集控」扳到投入，再发开门指令' }
  if (door.openT > 0.9) return OK('门已开到位')
  door.target = 1
  door.closedLed = false
  door.reopening = false
  return OK('开门指令已发出：门扇退出密封面并沿导轨滑开')
}

/**
 * 集控关门。
 *
 * 两条分支：
 * - 中缝有试块 → 走到 0.86 就反开，`bumps+1`；满 3 次停在全开位并报故障；
 * - 没有试块 → 正常关门，到位后关门灯亮。
 */
export function close(): ActionResult {
  if (!powered()) return { ok: false, hint: OFF_HINT }
  if (!door.released) return { ok: false, hint: '未投入集控：先把「集控」扳到投入' }
  if (door.openT < 0.9) return { ok: false, hint: '门没开到位：先开门，再测关门时间' }
  /* 已报故障：按钮**照样能按**，但动作前先要求复位——这是"故障要处理"，
     不是"按钮被锁"。复位 = 撤除试块（`toggleBlock` 清零 bumps 与 fault）。 */
  if (door.fault) {
    return { ok: false, hint: '已报「关门障碍物超次数」：先撤除试块复位，再关门' }
  }
  if (door.blocked) {
    /* **每一次关门都允许按**（2026-11-17 本人更正：不能因为失败一次就把按钮锁死，
       人按错了会再按一次）。但门**不会自己再关**——碰到就停、反开到全开位，
       等你下一次指令；连续 3 次受阻才报故障并停在全开位。 */
    door.bumps += 1
    if (door.bumps >= 3) {
      door.fault = '关门障碍物超次数：门停在全开位'
      door.pinching = false
      door.reopening = true
      door.target = 1
      return {
        ok: false,
        hint: '第 3 次仍检测到障碍物：停在全开位并报「关门障碍物超次数」，撤除试块后复位',
      }
    }
    door.pinching = true
    door.target = 0
    return {
      ok: false,
      hint: `门扇前缘碰到试块：立即停止关门、反向开门到位（第 ${door.bumps} 次；满 3 次报故障）`,
    }
  }
  door.pinching = false
  door.reopening = false
  door.target = 0
  return OK('关门指令已发出：门扇滑移、压紧密封面')
}

/** 放置/撤除中缝试块（约 40 mm 厚软物）。 */
export function toggleBlock(): ActionResult {
  door.blocked = !door.blocked
  if (door.blocked) return OK('试块已放在门洞地板上（约 40 mm 厚卷状软物，门页合拢时会被顶住）')
  door.bumps = 0
  door.fault = ''
  return OK('试块已撤除，反开次数清零')
}

/** 在 MON 上确认一条。 */
export function confirmDoor(key: DoorKey): ActionResult {
  if (!powered()) return { ok: false, hint: OFF_HINT }
  if (key === 'closed' && door.openT > 0.001) {
    return { ok: false, hint: '当前有门未关闭：先把门关到位再确认「全列关闭锁闭」' }
  }
  if (key === 'nofault' && door.fault) {
    return { ok: false, hint: 'MON 上还有故障：先撤除障碍物、复位后重试关门' }
  }
  door.confirmed[key] = true
  return OK('MON 已确认一项')
}

export function confirmDone(): number {
  return DOOR_ITEMS.filter((item) => door.confirmed[item.key]).length
}

export function confirmMissing(): DoorKey[] {
  return DOOR_ITEMS.filter((item) => !door.confirmed[item.key]).map((item) => item.key)
}

export const DOOR_ITEMS: Array<{ key: DoorKey; label: string; required: string; value: () => string }> = [
  {
    key: 'closed',
    label: '全列车门',
    required: '关闭锁闭',
    value: () => (door.openT > 0.001 ? '有门未关闭' : '8/8 关闭锁闭'),
  },
  { key: 'isolated', label: '车门隔离', required: '无隔离', value: () => '无隔离' },
  { key: 'nofault', label: '车门故障', required: '无故障', value: () => door.fault || '无故障' },
]

/* ------------------------------------------------------------------ 推进 */

/** 推进门扇动画。返回是否还在动。 */
export function stepDoor(dt: number): boolean {
  const step = Math.max(0, dt)

  // 反开：先按关门方向收到 PINCH_AT，再往回开
  if (door.pinching) {
    const speed = 1 / CLOSE_SECONDS
    door.openT = Math.max(PINCH_AT, door.openT - speed * step)
    if (door.openT <= PINCH_AT + 1e-6) {
      door.pinching = false
      door.reopening = true
      door.target = 1
    }
    return true
  }

  const target = door.target
  if (Math.abs(door.openT - target) < 1e-6) {
    if (target === 0 && !door.closedLed) door.closedLed = true
    // 到位必须把 reopening 收掉，否则 `stepDoor` 永远返回 true——
    // 组件会拿它决定要不要继续 rAF，等于挂了一个永不停止的循环。
    door.reopening = false
    return false
  }

  const speed = target > door.openT ? 1 / OPEN_SECONDS : 1 / CLOSE_SECONDS
  door.openT = target > door.openT
    ? Math.min(target, door.openT + speed * step)
    : Math.max(target, door.openT - speed * step)

  if (door.openT >= 1 - 1e-6) door.reopening = false
  /* 只有**往关的方向**走到位才点关门灯。
     原来这里只判 `openT <= 1e-6`：开门的第一帧 openT 还是 0，灯被重新点亮，
     于是一整段开门/开门到位的过程里"关门灯"都亮着——与"8/8 关闭锁闭"直接矛盾
     （2026-11-14 本人截图指出）。 */
  if (door.openT <= 1e-6 && door.target === 0) {
    door.reopening = false
    door.closedLed = true
  }
  return Math.abs(door.openT - target) > 1e-6
}

/* ------------------------------------------------------------------ 派生 */

export function stageText(): string {
  if (door.fault) return door.fault
  if (door.openT >= 0.999) return '门完全开启'
  if (door.openT <= 0.001) return door.released ? '已释放、门关闭锁闭' : '门关闭锁闭'
  if (door.pinching) return '门页碰到试块、反向开门中'
  return door.target === 1 ? '开门中' : '关门中'
}

export function nextAction(): string {
  if (!powered()) return '先完成上电：钥匙右旋 + 制动手柄快速位'
  if (!door.released) return '把转换开关盘的「集控」扳到「投入」：该侧全列门才接受集控'
  if (door.openT <= 0.001) return '把「开关门」开关扳到「开」：门扇退出密封面并滑开，计时 3.2 s'
  if (door.openT < 0.999) return '门正在动作，等它到位'
  if (door.blocked) return '把「开关门」扳到「关」验证防夹：门应停止并自动反开'
  if (!door.confirmed.closed) return '把「开关门」扳到「关」：到位后确认全列关闭锁闭、关门灯亮'
  return '门已关闭锁闭，可进入下一步确认'
}
