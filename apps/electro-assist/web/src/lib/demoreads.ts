/** 演示页的读数计算（纯函数，不依赖 Vue / three）。
 *
 * ## 为什么单独抽出来
 *
 * 这些数字是页面右栏显示的东西：门扇行程多少毫米、接触压力多少牛、断路器手柄在
 * 哪个位置。它们必须与三维动作**同一时刻**——三维顶到接触线了，读数还是 0 N，
 * 现场会直接判定"仪表坏了"。
 *
 * 而三维那边的时间线写在 `figures/devices/*.ts` 里，这里只能是同一套常量的副本
 * （每处都注了"改一处要改两处"）。副本就是隐患，所以把它抽成纯函数并加测试：
 * 至少在数值层面能断言"这些读数在物理上说得通、在关键时刻对得上"。
 *
 * 另一个理由是可测：原先是 `computed(() => t.value)`，要测就得挂载整个页面，
 * 而页面要 WebGL。纯函数没有这个负担。
 */

export type ReadoutDot = 'ok' | 'idle' | 'warn'

export interface Readout {
  label: string
  value: string
  unit?: string
  dot?: ReadoutDot
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

const ease = (v: number): number => {
  const x = clamp01(v)
  return x * x * (3 - 2 * x)
}

/** 把 [a, b] 区间映射成 0–1 的平滑进度。 */
const span = (t: number, a: number, b: number): number => ease((t - a) / (b - a))

/* ------------------------------------------------------------------ 车门 */

/** 单扇行程上限 660mm：与 `devices/door.ts` 的 `DIM.slide` 同源。 */
export const DOOR_STROKE = 660
/** 塞拉外移上限 55mm：与 `devices/door.ts` 同源。 */
export const DOOR_POP = 55

/** 时序与 `devices/door.ts` 的 `setT` 同源：0.02 解锁、0.08 外移、0.20 滑移、0.88 到位。 */
export function doorReads(t: number): Readout[] {
  const stroke = Math.round(span(t, 0.2, 0.88) * DOOR_STROKE)
  const popped = Math.round(span(t, 0.08, 0.2) * DOOR_POP)
  // 锁闭只在解锁之前成立；门一动，锁闭信号就没了
  const locked = t < 0.02
  let current = 0.18
  if (t >= 0.2 && t < 0.88) {
    current = 1.05 + 2.3 * Math.exp(-3.4 * span(t, 0.2, 0.88))
  } else if (t >= 0.88) {
    current = 0.12
  }
  const phase =
    t < 0.02
      ? '关闭锁定'
      : t < 0.08
        ? '门锁解锁'
        : t < 0.2
          ? '退出密封面'
          : t < 0.88
            ? '门扇开启'
            : t < 0.92
              ? '到位检测'
              : '完全开启'
  return [
    { label: '动作阶段', value: phase },
    // 「门锁」是机械状态，「锁闭信号」是电气状态。现场要先看信号再动车
    { label: '门锁', value: locked ? '锁闭' : '已解锁', dot: locked ? 'ok' : 'idle' },
    { label: '锁闭信号', value: locked ? '有' : '无', dot: locked ? 'ok' : 'warn' },
    { label: '塞拉外移', value: String(popped), unit: 'mm' },
    { label: '单扇行程', value: String(stroke), unit: 'mm' },
    { label: '电机电流', value: current.toFixed(2), unit: 'A' },
  ]
}

/* -------------------------------------------------------------- 受电弓 */

/** 与 `devices/pantograph.ts` 的 `T` 同源。改一处必须改两处。 */
export const PT = {
  airOn: 0.04,
  airFull: 0.12,
  raise0: 0.12,
  raise1: 0.54,
  press1: 0.68,
  hold1: 0.78,
  lower0: 0.8,
  lower1: 0.94,
} as const

/** 弓头与接触线之间的初始间隙（m），与 `pantograph.ts` 的 `GAP_FREE` 同源。 */
export const PT_GAP = 0.07
/** 弓头滑板厚度（m）。 */
export const PT_TOP = 0.0855
/** 弹簧最大压缩量（m）。 */
export const PT_COMP = 0.055
/** 接触线高度（m）。 */
export const PT_WIRE = 2.9175
/** 额定升弓 / 降弓时间（s）：与页面验收判据的 8.5 ± 1.0 / 3.5 ± 0.5 同源。 */
export const PT_RAISE_S = 8.5
export const PT_LOWER_S = 3.5
/** 接触压力额定值（N）：判据写 110 ± 15，这里取 118 作为压缩到底的峰值。 */
export const PT_CONTACT_MAX = 118

const smooth = (t: number, a: number, b: number): number => ease((t - a) / (b - a))

/** 行程 0–1。按四段算，跟 `pantograph.ts` 的 `setT` 一一对应。 */
export function pantoP(t: number): number {
  if (t < PT.raise0) return 0
  if (t < PT.raise1) return 0.94 * smooth(t, PT.raise0, PT.raise1)
  if (t < PT.press1) return 0.94 + 0.06 * smooth(t, PT.raise1, PT.press1)
  if (t < PT.lower0) return 1
  return 1 - clamp01((t - PT.lower0) / (PT.lower1 - PT.lower0))
}

/** 弓臂尖端的绝对高度，纯三角函数，不依赖 three。角度同源：4°→56°、10°→62°。 */
export function pantoArmY(p: number): number {
  const a1 = ((4 + 52 * p) * Math.PI) / 180
  const a2 = ((10 + 52 * p) * Math.PI) / 180
  return 0.34 + 1.55 * Math.sin(a1) + 1.35 * Math.sin(a2)
}

export function pantoReads(t: number): Readout[] {
  const p = pantoP(t)
  const armY = pantoArmY(p)

  /* 弓头高度取**滑板顶面**：现场量的是弓头到车顶的距离，不是臂尖。
     接触线挡住弓头之后，臂还在上行、弹簧被压缩，所以要按间隙算。 */
  const freeTop = armY + PT_GAP + PT_TOP
  const comp = Math.min(Math.max(freeTop - PT_WIRE, 0), PT_COMP)
  const headTop = Math.round((armY + (PT_GAP - comp) + PT_TOP) * 1000)

  // 压力与压缩量成正比：碰到的瞬间是 0，压到底才是额定值
  const contactN = Math.round(PT_CONTACT_MAX * Math.min(comp / 0.052, 1))

  let air = 0
  if (t >= PT.airOn) air = 0.62 * smooth(t, PT.airOn, PT.airFull)
  if (t >= PT.lower0) air *= 1 - smooth(t, PT.lower0, PT.lower0 + 0.05)

  const raising = t >= PT.raise0 && t < PT.press1
  const lowering = t >= PT.lower0 && t < PT.lower1
  const seconds = raising
    ? Math.min(p / 0.94, 1) * PT_RAISE_S
    : lowering
      ? (1 - p) * PT_LOWER_S
      : 0

  const riseOk = t >= PT.press1 && t < PT.lower0
  const lowOk = t < PT.raise0 || t >= PT.lower1

  const phase =
    t < PT.airOn
      ? '落弓锁定'
      : t < PT.raise0
        ? '气路建压'
        : t < PT.raise1
          ? '升弓中'
          : t < PT.press1
            ? '接触压力建立'
            : t < PT.hold1
              ? '升弓到位'
              : t < PT.lower0
                ? '保压'
                : t < PT.lower1
                  ? '降弓中（阻尼）'
                  : '落弓到位'

  return [
    { label: '动作阶段', value: phase },
    { label: '弓头高度', value: String(headTop), unit: 'mm' },
    // 只有顶到接触线之后才有压力；未接触显示 0，不编一个近似值
    { label: '接触压力', value: String(contactN), unit: 'N' },
    { label: '气路压力', value: air.toFixed(2), unit: 'MPa' },
    {
      label: raising ? '升弓计时' : lowering ? '降弓计时' : '计时',
      value: seconds.toFixed(1),
      unit: 's',
    },
    {
      label: '到位信号',
      value: riseOk ? '升弓到位' : lowOk ? '落弓到位' : '均无',
      dot: riseOk || lowOk ? 'ok' : 'warn',
    },
  ]
}

/* -------------------------------------------------------------- 电气柜 */

/** 与 `devices/cabinet.ts` 的 `setT` 同源：0.78 脱扣、0.88 复位、0.94 再合闸。 */
export const CAB_TRIP = 0.78
export const CAB_RESET = 0.88
export const CAB_RECLOSE = 0.94

export function cabinetReads(t: number): Readout[] {
  const closed = t >= 0.12
  // 主回路带电：合闸后、脱扣前；再合闸到位后恢复
  const live = (closed && t < 0.82) || t >= 0.99
  // 控制回路取自断路器上游，**脱扣后仍有电**——主回路没了、控制回路还在，本身就是判据
  const ctrlV = t >= 0.28 ? '220' : '0'
  const pulled = (t >= 0.44 && t < 0.82) || t >= 0.97
  const relayCount = t < 0.82 ? [0, 1, 2].filter((i) => t >= 0.48 + i * 0.06).length : t >= 0.99 ? 3 : 0
  const running = (t >= 0.72 && t < 0.8) || t >= 0.99

  const phase =
    t < 0.13
      ? '主断路器合闸'
      : t < 0.26
        ? '分路断路器合闸'
        : t < 0.3
          ? '控制回路得电'
          : t < 0.46
            ? '接触器吸合'
            : t < 0.68
              ? '继电器自检'
              : t < CAB_TRIP
                ? '系统就绪'
                : t < CAB_RESET
                  ? '过载脱扣'
                  : t < CAB_RECLOSE
                    ? '复位（手柄扳到底）'
                    : t < 0.999
                      ? '重新合闸'
                      : '系统就绪'

  /* 手柄位置是这一页最要紧的一条：中间位既非合闸也非断开，
     现场见到它不能直接往上扳，必须先扳到底复位。 */
  const handleState =
    t < 0.12
      ? { value: '断开位', dot: 'idle' as const }
      : t < CAB_TRIP
        ? { value: '合闸位', dot: 'ok' as const }
        : t < CAB_RESET
          ? { value: '中间位（已脱扣）', dot: 'warn' as const }
          : t < CAB_RECLOSE
            ? { value: '断开位（已复位）', dot: 'idle' as const }
            : t < 0.99
              ? { value: '合闸中', dot: 'warn' as const }
              : { value: '合闸位', dot: 'ok' as const }

  return [
    { label: '动作阶段', value: phase },
    { label: '主回路电压', value: live ? '380' : '0', unit: 'V' },
    { label: '控制回路电压', value: ctrlV, unit: 'V' },
    { label: '接触器', value: pulled ? '吸合' : '断开', dot: pulled ? 'ok' : 'idle' },
    { label: '继电器', value: `${relayCount} / 3`, unit: '个' },
    { label: '运行指示', value: running ? '亮' : '灭', dot: running ? 'ok' : 'idle' },
    { label: '断路器手柄', value: handleState.value, dot: handleState.dot },
  ]
}

export type SceneKey = 'door' | 'pantograph' | 'cabinet'

export function readoutsFor(scene: SceneKey, t: number): Readout[] {
  if (scene === 'door') return doorReads(t)
  if (scene === 'pantograph') return pantoReads(t)
  return cabinetReads(t)
}
