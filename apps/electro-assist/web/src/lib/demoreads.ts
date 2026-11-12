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

import { CAB_T, FEEL_T, MM_T, SIGN_T, TQ_T, phaseFor } from './devphase'
import { PANO_T, airState, travel, type PantoMode } from './panto-air'
import { PGAP, WIRE_Y, armY, compression } from './panto-kin'

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

/** 与 `span` 同义，但参数顺序是 (t, a, b)——工具类读数（警示牌/塞尺/扭矩）按这个写法。 */
const smooth = (t: number, a: number, b: number): number => ease((t - a) / (b - a))

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
  const phase = phaseFor('door', t)
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

/* 几何常量与时间轴都从唯一来源取：`panto-kin`（杆长/摆角/接触线）与
   `panto-air`（气路时序/ADD）。这里不再写第二份副本——
   2026-11-10 重做受电弓时，"读数说差 42mm、画面已顶到线"就是这么来的。 */

/** 时间轴。名字沿用 `PT`：现场口径就叫"PT 时序"，且测试按它取样。 */
export const PT = PANO_T

/** 弓头与接触线之间的自由间隙（m），来自 `panto-kin`。 */
export const PT_GAP = PGAP.free
/** 弓头托架原点到滑板顶面的高度（m）。 */
export const PT_TOP = PGAP.headTop
/** 弹簧最大压缩量（m）。 */
export const PT_COMP = PGAP.maxComp
/** 接触线高度（m）：由满行程自由顶面反推，不写死。 */
export const PT_WIRE = WIRE_Y
/** 额定升弓 / 降弓时间（s）：与页面验收判据的 8.5 ± 1.0 / 3.5 ± 0.5 同源。 */
export const PT_RAISE_S = 8.5
export const PT_LOWER_S = 3.5
/** 接触压力额定值（N）：判据写 110 ± 15，这里取 118 作为压缩到底的峰值。 */
export const PT_CONTACT_MAX = 118

/** 行程 0–1。直接取气路模块的 `travel`，两种工况共用一条曲线。 */
export function pantoP(t: number, mode: PantoMode = 'normal'): number {
  return travel(t, mode)
}

/** 弓臂尖端的绝对高度。纯三角函数，与三维同源。 */
export const pantoArmY = armY

export function pantoReads(t: number, mode: PantoMode = 'normal'): Readout[] {
  const p = travel(t, mode)
  const tipY = armY(p)
  const comp = compression(p)

  /* 弓头高度取**滑板顶面**：现场量的是弓头到车顶的距离，不是臂尖。
     接触线挡住弓头之后，臂还在上行、弹簧被压缩，所以要按间隙算。 */
  const headTop = Math.round((tipY + (PGAP.free - comp) + PGAP.headTop) * 1000)

  // 压力与压缩量成正比：碰到的瞬间是 0，压到底才是额定值
  const contactN = Math.round(PT_CONTACT_MAX * Math.min(comp / PGAP.maxComp, 1))

  const air = airState(t, mode)

  const raising = t >= PT.raise0 && t < PT.press1
  const lowering =
    t >= PT.lower0 && (mode === 'add' ? t < PANO_T.addLanded : t < PT.lower1)
  const seconds = raising
    ? Math.min(p / 0.94, 1) * PT_RAISE_S
    : lowering
      ? (1 - p) * PT_LOWER_S
      : 0

  const riseOk = t >= PT.press1 && t < PT.lower0
  const lowOk = t < PT.raise0 || (mode === 'add' ? t >= PANO_T.addLanded : t >= PT.lower1)

  /* 阶段名：正常工况沿用原来那套（测试与判据都按这几句核对）；
     ADD 工况直接用气路模块的说法，因为那一段的"证据"就是压差与快排。 */
  const phase = phaseFor('pantograph', t, mode)
  return [
    { label: '动作阶段', value: phase },
    { label: '弓头高度', value: String(headTop), unit: 'mm' },
    // 只有顶到接触线之后才有压力；未接触显示 0，不编一个近似值
    { label: '接触压力', value: String(contactN), unit: 'N' },
    { label: '气路压力', value: air.bag.toFixed(2), unit: 'MPa' },
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

/** 阈值唯一来源在 `lib/devphase.ts`（`CAB_T`）；这里保留旧名字给既有用例。 */
export const CAB_TRIP = CAB_T.trip
export const CAB_RESET = CAB_T.reset
export const CAB_RECLOSE = CAB_T.reclose

export function cabinetReads(t: number): Readout[] {
  const closed = t >= 0.12
  // 主回路带电：合闸后、脱扣前；再合闸到位后恢复
  const live = (closed && t < 0.82) || t >= 0.99
  // 控制回路取自断路器上游，**脱扣后仍有电**——主回路没了、控制回路还在，本身就是判据
  const ctrlV = t >= 0.28 ? '220' : '0'
  const pulled = (t >= 0.44 && t < 0.82) || t >= 0.97
  const relayCount = t < 0.82 ? [0, 1, 2].filter((i) => t >= 0.48 + i * 0.06).length : t >= 0.99 ? 3 : 0
  const running = (t >= 0.72 && t < 0.8) || t >= 0.99

  const phase = phaseFor('cabinet', t)

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

/* ------------------------------------------------------- 工具四台（2026-11-10） */

/** 阈值唯一来源在 `lib/devphase.ts`（`MM_T`）；这里只做别名，防止两处各写一套。 */
export const MM = { dial: MM_T.dial, red: MM_T.red, black: MM_T.black, read: MM_T.lcd, settle: MM_T.settle } as const

export function multimeterReads(t: number): Readout[] {
  const dialed = t >= MM.dial
  const red = t >= MM.red
  const black = t >= MM.black
  const reading = t >= MM.read
  const value = !reading ? '—' : t >= MM.settle ? '110.3' : '109.8'
  const phase = phaseFor('multimeter', t)
  return [
    { label: '动作阶段', value: phase },
    { label: '档位', value: dialed ? 'V⎓ 直流' : 'OFF', dot: dialed ? 'ok' : 'idle' },
    { label: '红表笔', value: red ? '正极端子' : '未接', dot: red ? 'ok' : 'idle' },
    { label: '黑表笔', value: black ? '公共端' : '未接', dot: black ? 'ok' : 'idle' },
    { label: '读数', value, unit: reading ? 'V' : undefined, dot: reading ? 'ok' : 'idle' },
    // 判据是演示虚构值：110 ± 5.5V（与样例「输入电压 110V」同源）
    {
      label: '判定',
      value: reading ? '在 110±5.5V 内' : '等待读数',
      dot: reading ? 'ok' : 'idle',
    },
  ]
}

/** 阈值唯一来源在 `lib/devphase.ts`（`SIGN_T`）。 */
export const SIGN = { seated: SIGN_T.seated, released: SIGN_T.released, settled: SIGN_T.settled } as const

export function signReads(t: number): Readout[] {
  const settled = t >= SIGN.settled
  const phase = phaseFor('warning_sign', t)
  // 摆角只作展示：0.42rad ≈ 24°，摆正后归零
  const tilt = Math.round((24 * (1 - smooth(t, 0, 0.4)) + (t < 0.62 ? 0 : 4 * Math.exp(-9 * (t - 0.62)))) * 10) / 10

  return [
    { label: '动作阶段', value: phase },
    { label: '挂牌点', value: '门边操作把手' },
    { label: '牌面朝向', value: settled ? '朝向作业面' : '偏转', dot: settled ? 'ok' : 'warn' },
    { label: '摆角', value: String(tilt), unit: '°' },
    { label: '状态', value: settled ? '已挂牌' : '未摆正', dot: settled ? 'ok' : 'warn' },
  ]
}

/** 阈值唯一来源在 `lib/devphase.ts`（`FEEL_T`）。 */
export const FEEL = { fold: FEEL_T.fold, align: FEEL_T.align, inserted: FEEL_T.inserted, slid: FEEL_T.slid } as const

export function feelerReads(t: number): Readout[] {
  const phase = phaseFor('feeler_gauge', t)
  const depth = Math.round(
    25 * smooth(t, FEEL.align, FEEL.inserted) * (1 - smooth(t, FEEL_T.out, 1)),
  )
  const slide = Math.round(55 * smooth(t, FEEL.inserted, FEEL.slid) * (1 - smooth(t, FEEL_T.out, 1)))

  return [
    { label: '动作阶段', value: phase },
    // 不写具体片厚：样例的判据是 2.0mm，写 0.50 就成了"图上的实测值"
    { label: '塞尺', value: phase === '展开选片、翻成竖直' ? '叠片中' : '单片已翻出' },
    { label: '插入深度', value: String(depth), unit: 'mm' },
    { label: '沿缝滑动', value: String(slide), unit: 'mm' },
    // 只演示 0.50 一片：真实现场是"进得去/进不去"两片夹逼，这里不编第二个数
    { label: '判定', value: depth > 0 ? '该片能入、沿缝滑动无阻滞' : '未插入', dot: depth > 0 ? 'ok' : 'idle' },
  ]
}

/** 阈值唯一来源在 `lib/devphase.ts`（`TQ_T`）。 */
export const TQ = { seated: TQ_T.seated, loaded: TQ_T.loaded, clicked: TQ_T.click1 } as const
export const TQ_TARGET = 25

export function torqueReads(t: number): Readout[] {
  const seated = t >= TQ.seated
  const torque = Math.round(
    TQ_TARGET * Math.min(1, smooth(t, TQ.seated, TQ.loaded) * 0.94 + (t >= 0.78 ? 0.06 : 0)),
  )
  const clicked = t >= TQ.clicked
  const phase = phaseFor('torque_wrench', t)
  return [
    { label: '动作阶段', value: phase },
    { label: '设定扭矩', value: String(TQ_TARGET), unit: 'N·m' },
    { label: '当前扭矩', value: String(torque), unit: 'N·m' },
    { label: '套筒', value: seated ? '已落位' : '悬空', dot: seated ? 'ok' : 'warn' },
    {
      label: '状态',
      value: clicked ? '已脱扣（咔嗒）' : '施力中',
      dot: clicked ? 'ok' : 'idle',
    },
  ]
}

export type SceneKey =
  | 'door'
  | 'pantograph'
  | 'cabinet'
  | 'multimeter'
  | 'warning_sign'
  | 'feeler_gauge'
  | 'torque_wrench'

export function readoutsFor(
  scene: SceneKey,
  t: number,
  mode: PantoMode = 'normal',
): Readout[] {
  if (scene === 'door') return doorReads(t)
  if (scene === 'pantograph') return pantoReads(t, mode)
  if (scene === 'cabinet') return cabinetReads(t)
  if (scene === 'multimeter') return multimeterReads(t)
  if (scene === 'warning_sign') return signReads(t)
  if (scene === 'feeler_gauge') return feelerReads(t)
  return torqueReads(t)
}
