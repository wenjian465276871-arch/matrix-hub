/** 受电弓升弓试验的会话状态：六屏共用一个状态机。
 *
 *  ## 为什么状态必须活在组件外面
 *  阅读器是"一步一屏"，只挂当前页与左右各一页。状态放进组件，翻页就清零：
 *  第 2 步插了钥匙，第 3 步又变成"未上电"；第 5 步升起的弓，第 6 步回到落弓。
 *  而这些恰好是这套演示唯一要证明的事——**操作有后果、后果会保持**。
 *  所以用模块级单例，按"一份指导书一次试验"来用；`reset()` 给"重新开始"。
 *
 *  ## 联锁为什么写在这里而不是组件里
 *  真实车辆的升弓回路是一串硬线联锁：钥匙不右旋 → 司机室不占用 → MCR 不励磁 →
 *  升弓指令不成立。把这套条件写进 UI 的 if 里，换个页面就会漏一条；
 *  写成状态机的一部分，任何入口（点三维、点按钮、键盘）都走同一套判断。
 *
 *  ## 动画为什么由外部驱动
 *  `stepRaise(dt)` 是纯函数式的推进：给时间增量，返回新进度。组件用 rAF 喂它，
 *  测试用固定步长喂它——不依赖真实时钟，也不会在单测里跑 4.6 秒。
 */

import { reactive } from 'vue'

/** MON 屏上必须逐项确认的五条。缺一条就不许发升弓指令。 */
export type MonKey = 'voltage' | 'mr' | 'egs' | 'vcb' | 'panto_cut'
export type Unit = '2U' | '3U'

/** 升弓到位对应的三维进度：受电弓 `setT(0.72)` 是"升弓到位、保压"。 */
export const RAISE_T = 0.72
/** 升起耗时（秒）。与演示页 4.6s 同一手感。 */
const RAISE_SECONDS = 4.6
/** 松手回落更快：气路快排本来就是"唰"一下。 */
const LOWER_SECONDS = 1.8

export interface ActionResult {
  ok: boolean
  /** 不成立时给现场口吻的原因，不是"操作失败"四个字。 */
  hint: string
}

const OK = (hint = ''): ActionResult => ({ ok: true, hint })

interface State {
  keyInserted: boolean
  keyTurned: boolean
  brakeFast: boolean
  unit: Unit | null
  raiseHeld: boolean
  raised: boolean
  vcbClosed: boolean
  mon: Record<MonKey, boolean>
  /** 三维进度 0–0.72。由 `stepRaise()` 推进。 */
  raiseT: number
  /** 上一条操作回执，给界面显示。 */
  notice: string
}

export const MON_ITEMS: Array<{ key: MonKey; label: string; required: string; value: string }> = [
  { key: 'voltage', label: '蓄电池/控制电压', required: '≥87 V', value: '110.2 V' },
  { key: 'mr', label: '总风缸 MR 压力', required: '≥640 kPa', value: '720 kPa' },
  { key: 'egs', label: 'EGS 接地保护开关', required: '必须断开', value: '断开' },
  { key: 'vcb', label: 'VCB 真空断路器', required: '必须断开', value: '断开' },
  { key: 'panto_cut', label: '受电弓远程切除', required: '未切除', value: '未切除' },
]

function initial(): State {
  return {
    keyInserted: false,
    keyTurned: false,
    brakeFast: false,
    unit: null,
    raiseHeld: false,
    raised: false,
    vcbClosed: false,
    mon: { voltage: false, mr: false, egs: false, vcb: false, panto_cut: false },
    raiseT: 0,
    notice: '',
  }
}

export const session = reactive<State>(initial())

/** 重新开始一次试验。只给 UI 的"重新开始"用，不要在挂载时自动调。 */
export function reset(): void {
  Object.assign(session, initial())
}

/**
 * MON 屏是否点亮。
 *
 * 条件是两个，不是一个（2026-11-13 本人指出：只右旋钥匙屏不会亮）：
 * 主控钥匙右旋只建立司机室占用；MON 显示的是车辆与 MCR 状态，
 * **制动手柄不在「快速」位、MCR 未励磁时它仍是暗的**。
 * 这条判断只在这里定义，组件与文案都来问它——否则"屏亮没亮"会散落成
 * 三处各写一遍的 `keyTurned`。
 */
export function monPowered(): boolean {
  return session.keyTurned && session.brakeFast
}

export function monDone(): number {
  return MON_ITEMS.filter((item) => session.mon[item.key]).length
}

export function monMissing(): MonKey[] {
  return MON_ITEMS.filter((item) => !session.mon[item.key]).map((item) => item.key)
}

/* ------------------------------------------------------------------ 动作 */

export function insertKey(): ActionResult {
  if (session.keyInserted) {
    return session.keyTurned ? OK('钥匙已在运行位') : turnKey()
  }
  session.keyInserted = true
  session.notice = '主控钥匙已插入制动控制器'
  return OK(session.notice)
}

export function turnKey(): ActionResult {
  if (!session.keyInserted) return { ok: false, hint: '先插入主控钥匙，锁芯才转得动' }
  if (session.keyTurned) return OK('司机室已占用')
  session.keyTurned = true
  session.notice = '钥匙右旋到运行位：司机室占用（MON 待 MCR 励磁后点亮）'
  return OK(session.notice)
}

export function moveBrakeFast(): ActionResult {
  if (!session.keyTurned) return { ok: false, hint: '主控未激活：钥匙要先右旋，司机室占用后手柄才有效' }
  if (session.brakeFast) return OK('制动手柄已在快速位')
  session.brakeFast = true
  session.notice = '制动手柄移至快速位：MCR 励磁、MON 屏点亮'
  return OK(session.notice)
}

export function selectUnit(unit: Unit): ActionResult {
  if (!session.brakeFast) return { ok: false, hint: '制动手柄不在快速位，MCR 未励磁，选弓无效' }
  if (session.raised) return { ok: false, hint: '受电弓已升起，运行中不得切换单元' }
  session.unit = unit
  session.notice = unit === '2U' ? '已选择 2U 单元（04 车受电弓）' : '已选择 3U 单元（06 车受电弓）'
  return OK(session.notice)
}

/**
 * 在 MON 上确认一项。
 *
 * 两条前置（2026-11-13 本人指出，此前是错的）：
 * 1. **MON 必须已上电**。屏都没亮就"逐项确认"是假动作——司机台的真实顺序是
 *    插钥匙→右旋→司机室占用、MON 点亮→再确认。这也是原先把上电放在第 3 步
 *    造成的逻辑倒置，现在步骤已对调。
 * 2. **VCB 必须断开才谈得上"确认断开"**。已经合上的 VCB 不能被勾成合格项，
 *    否则同一块屏上会同时出现"要求断开"与"已闭合 ✓"。
 */
export function confirmMon(key: MonKey): ActionResult {
  if (!session.keyTurned) {
    return { ok: false, hint: 'MON 未上电：先插主控钥匙并右旋到运行位' }
  }
  if (!session.brakeFast) {
    return { ok: false, hint: 'MON 未上电：制动手柄推到「快速」位、MCR 励磁后屏才点亮' }
  }
  if (key === 'vcb' && session.vcbClosed) {
    return { ok: false, hint: 'VCB 已闭合：升弓前必须断开（复位后重来）' }
  }
  session.mon[key] = true
  session.notice = 'MON 已确认一项'
  return OK(session.notice)
}

/** 发升弓指令（按住旋钮）。联锁逐条查，缺哪条说哪条。 */
export function holdRaise(): ActionResult {
  if (!session.brakeFast) return { ok: false, hint: '制动手柄未在快速位：MCR 不励磁，升弓回路不通' }
  if (!session.unit) return { ok: false, hint: '未选择受电弓单元：先在切换开关上选 2U 或 3U' }
  const missing = monMissing()
  if (missing.length) {
    const names = MON_ITEMS.filter((i) => missing.includes(i.key))
      .map((i) => i.label)
      .join('、')
    return { ok: false, hint: `MON 确认未完成：${names}；回第 3 步逐项确认后再升弓` }
  }
  if (session.raised) return OK('受电弓已升起，保持即可')
  session.raiseHeld = true
  session.notice = '升弓指令已发出：保持旋钮，待 MON 显示"升起"'
  return OK(session.notice)
}

/** 松开旋钮：没升到位就回落，升到位就保压。 */
export function releaseRaise(): ActionResult {
  if (!session.raiseHeld && !session.raised) return OK('旋钮未在保持位')
  if (session.raiseHeld && !session.raised) {
    session.raiseHeld = false
    session.notice = '提前松开：升弓中断，受电弓回落'
    return OK(session.notice)
  }
  session.raiseHeld = false
  session.notice = '松开旋钮：升弓到位、保压'
  return OK(session.notice)
}

export function closeVcb(): ActionResult {
  if (!session.raised) return { ok: false, hint: '受电弓未升起，VCB 不能闭合（联锁切断）' }
  if (session.vcbClosed) return OK('VCB 已闭合')
  session.vcbClosed = true
  session.notice = 'VCB 闭合：送电完成'
  return OK(session.notice)
}

/* ------------------------------------------------------------------ 推进 */

/**
 * 按时间增量推进升弓动作。返回是否还在动（组件据此决定要不要继续 rAF）。
 *
 * 目标位由 `raiseHeld || raised` 决定：按住就往 0.72 走，松开就往 0 走。
 * 到达 0.72 时把 `raised` 置真——这是"MON 显示升起"的唯一依据，别处不许自行判断。
 */
export function stepRaise(dt: number): boolean {
  const target = session.raiseHeld || session.raised ? RAISE_T : 0
  const speed = target > session.raiseT ? RAISE_T / RAISE_SECONDS : RAISE_T / LOWER_SECONDS
  const delta = Math.max(0, dt) * speed
  if (session.raiseT < target) {
    session.raiseT = Math.min(target, session.raiseT + delta)
  } else if (session.raiseT > target) {
    session.raiseT = Math.max(target, session.raiseT - delta)
  }
  if (session.raiseT >= RAISE_T - 1e-6 && session.raiseHeld && !session.raised) {
    session.raised = true
    session.notice = 'MON 显示受电弓"升起"，网压 25.1 kV'
  }
  return Math.abs(session.raiseT - target) > 1e-6
}

/* ------------------------------------------------------------------ 派生 */

/** 司机操纵台的三维进度：八拍与后端 `DEVICE_MOMENTS['driver_desk']` 对齐。 */
export function deskT(): number {
  if (session.vcbClosed) return 1
  if (session.raised) return 0.8
  if (session.raiseHeld) return 0.64
  if (session.unit) return 0.5
  if (session.brakeFast) return 0.36
  if (session.keyTurned) return 0.22
  if (session.keyInserted) return 0.12
  return 0
}

/** 当前该提醒用户做什么。界面只显示这一句，不再罗列全部条件。 */
export function nextAction(): string {
  if (!session.keyInserted) return '点制动控制器上的钥匙，插入主控钥匙'
  if (!session.keyTurned) return '再把钥匙右旋到运行位（司机室占用）'
  if (!session.brakeFast) return '把制动手柄推到"快速"位：MCR 励磁后 MON 才点亮'
  // 措辞跟着交互走：现在点 MON 屏就能进确认页，不必让人自己找"第 3 步"在哪。
  if (monMissing().length) return 'MON 屏还有确认项未完成，请点击 MON 屏进行逐项确认'
  if (!session.unit) return '在转换开关盘上选择受电弓单元（2U / 3U）'
  if (!session.raised) return '按住升弓旋钮不松手，直到 MON 显示"升起"'
  return '受电弓已升起并保压，可进入下一步确认'
}

/** 一句话状态，给三维面板顶部的状态条用。 */
export function stageText(): string {
  if (session.vcbClosed) return 'VCB 闭合、送电完成'
  if (session.raised) return '升弓到位、保压'
  if (session.raiseHeld) return '升弓中'
  if (session.unit) return '已选弓，待发升弓指令'
  if (session.brakeFast) return 'MCR 励磁、MON 已点亮，可升弓'
  if (session.keyTurned) return '司机室占用（待手柄快速位）'
  if (session.keyInserted) return '钥匙已插入'
  return '未上电'
}
