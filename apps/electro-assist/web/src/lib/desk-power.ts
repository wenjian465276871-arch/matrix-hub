/** 司机室操纵台「得电」状态：三项试验（升弓 / 空调制冷 / 开关门）共用。
 *
 *  ## 为什么要单独一层
 *  三项试验的第一步都是同一串动作：插钥匙 → 右旋 → 制动手柄快速位。
 *  把它抄进两个新会话（空调、车门）看似省事，代价是三条一模一样的联锁各写一遍，
 *  将来改一条（比如 MON 的点亮条件）必然只改到一处——升弓那份有 40 条用例兜着，
 *  新写的那两份没有。
 *
 *  ## 与 `panto-session` 的关系
 *  升弓那套状态机已经稳定、有完整用例，**不动它**（它自带一份同义实现）。
 *  这里只服务 2026-11-14 新增的空调与车门两个场景；两份状态互不干扰，
 *  谁是「一次试验」谁的 `reset()` 说话。
 *
 *  ## 为什么状态活在模块级
 *  阅读器一步一屏、只挂当前页 ±1。状态放进组件，翻页就清零，
 *  「第 2 步上电、第 3 步屏又黑了」——这套演示要证明的恰恰是操作有后果。
 */
import { reactive } from 'vue'

export interface ActionResult {
  ok: boolean
  hint: string
}

const OK = (hint = ''): ActionResult => ({ ok: true, hint })

/** 制动控制器档位（10 档，2026-11-15 本人裁决「钥匙顺时针」时一并确认）。
 *
 * 公开资料（超星《动车组制动系统检修》+ CRH380A 统型作业办法）：
 * 档位是**拔取 / 运行 / B1–B7 / 快速**共 10 档；钥匙插在制动手柄的锁芯里，
 * 顺时针旋 90° 解锁后手柄才能从拔取位转出；快速→拔取还要先**上抬 10°**（本演示未做这个自由度）。 */
export const BRAKE_STOPS = ['拔取', '运行', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', '快速'] as const

interface PowerState {
  keyInserted: boolean
  keyTurned: boolean
  brakeFast: boolean
  /** 制动档位索引（0=拔取 … 9=快速）。 */
  brakePos: number
}

function initial(): PowerState {
  return { keyInserted: false, keyTurned: false, brakeFast: false, brakePos: 0 }
}

export const power = reactive<PowerState>(initial())

export function resetPower(): void {
  Object.assign(power, initial())
}

/**
 * MON 屏是否点亮：**钥匙右旋 + 制动手柄快速位**两条同时成立。
 *
 * 与 `panto-session.monPowered()` 同一个物理判断，不是两套说法：
 * 右旋只建立司机室占用，屏要等 MCR 励磁才亮（2026-11-13 本人当场纠正过的）。
 */
export function powered(): boolean {
  return power.keyTurned && power.brakeFast
}

export function insertKey(): ActionResult {
  if (power.keyInserted) return power.keyTurned ? OK('钥匙已在运行位') : turnKey()
  /* 钥匙插在**制动手柄的锁芯**里，而锁芯只有在「拔取」位才露出来——
     这是公开资料里写死的前置条件（作业办法第一步就是"制动手柄拔取位"）。 */
  if (power.brakePos !== 0) {
    return { ok: false, hint: '手柄不在「拔取」位：先把制动手柄扳回拔取位，钥匙才插得进去' }
  }
  power.keyInserted = true
  return OK('主控钥匙已插入制动手柄的锁芯')
}

export function turnKey(): ActionResult {
  if (!power.keyInserted) return { ok: false, hint: '先插入主控钥匙，锁芯才转得动' }
  if (power.keyTurned) return OK('司机室已占用')
  power.keyTurned = true
  return OK('钥匙顺时针旋 90° 到运行位：司机室占用')
}

export function moveBrakeFast(): ActionResult {
  if (!power.keyTurned) {
    return { ok: false, hint: '主控未激活：钥匙要先顺时针旋 90°，司机室占用后手柄才有效' }
  }
  if (power.brakeFast) return OK('制动手柄已在快速位')
  power.brakePos = BRAKE_STOPS.length - 1
  power.brakeFast = true
  return OK('制动手柄：拔取 → 运行 → B1…B7 → 快速（10 档），MON 屏点亮')
}

/** 操纵台三维进度。四个值必须落在后端 `DEVICE_MOMENTS['driver_desk']` 表里
 *  （0 / 0.12 / 0.22 / 0.36），否则打印出的静态帧与屏上读数对不上。 */
export function deskT(): number {
  if (power.brakeFast) return 0.36
  if (power.keyTurned) return 0.22
  if (power.keyInserted) return 0.12
  return 0
}

/** 一句话状态，给 HUD 的状态条用。 */
export function powerStage(): string {
  if (power.brakeFast) return '上电完成'
  if (power.keyTurned) return `司机室占用（手柄在${BRAKE_STOPS[power.brakePos]}位）`
  if (power.keyInserted) return '钥匙已插入'
  return '未上电'
}

/** 下一步该做什么。只给一句，不罗列全部条件。 */
export function nextPowerAction(): string {
  if (!power.keyInserted) return power.brakePos === 0 ? '点制动手柄上的钥匙，插入主控钥匙' : '先把制动手柄扳回「拔取」位，再插钥匙'
  if (!power.keyTurned) return '再把钥匙顺时针旋 90° 到运行位（司机室占用）'
  if (!power.brakeFast) return '把制动手柄从拔取位推到「快速」位（经运行、B1–B7）：之后 MON 才点亮'
  return ''
}
