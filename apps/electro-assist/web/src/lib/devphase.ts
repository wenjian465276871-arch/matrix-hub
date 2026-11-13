/** 动作阶段文案的**唯一来源**。
 *
 *  ## 为什么要有这个文件
 *
 *  "动作阶段"这句话在同一份时间轴上原来被写了三遍：
 *  1. `devices/*.ts` 的 `rig.phase(t)`（三维侧）；
 *  2. `lib/demoreads.ts` 的 `动作阶段` 读数（界面上真正显示的那一句）；
 *  3. `api/models/visual.py` 的 `DEVICE_MOMENTS[].label`（契约里的时刻标签）。
 *
 *  这三份各自带一套阈值，于是必然漂：2026-11-12 实测 `door` 的三维说"完全开启"、
 *  界面说"到位检测"（`devices/door.ts` 里 `if (t < 0.88)` 写了两遍，第二支是死代码）；
 *  受电弓、塞尺、扭矩扳手也都有一句措辞不同。
 *
 *  现在 1 与 2 合并到这里，`devices/*.ts` 只做转发。3 仍是后端的事实（它同时
 *  带着可拖动的 `t`），由 `figures/devices/phase-contract.spec.ts` 钉住
 *  "每个时刻落在它该在的那一段"。
 *
 *  ## 阈值口径
 *
 *  每段边界都对应 `devices/*.ts` 里某个 `seg(t, a, b)` 的端点。改动画时序时
 *  必须同步改这里的常量——`phase-contract.spec.ts` 会红，别绕过去改断言。
 */
import { PANO_T, phase as airPhase, type PantoMode } from './panto-air'

/** `devices/door.ts`：0.02 解锁、0.08 外移、0.20 滑移、0.88 到位、0.92 检测。 */
export const DOOR_T = { unlock: 0.02, pop: 0.08, slide0: 0.2, slide1: 0.88, detect: 0.92 } as const

/** `devices/cabinet.ts`：0.02 主断、0.13–0.28 分路、0.30 接触器、0.78 脱扣、0.88 复位、0.94 再合闸。 */
export const CAB_T = {
  main: 0.02,
  branches: 0.13,
  ctrl: 0.26,
  contactor: 0.3,
  contactorEnd: 0.46,
  relay: 0.68,
  trip: 0.78,
  reset: 0.88,
  reclose: 0.94,
} as const

/** `devices/multimeter.ts`：0.12 档位、0.30 红笔、0.55 黑笔、0.58 显示、0.70 稳定、0.90 撤笔。 */
export const MM_T = { dial: 0.12, red: 0.3, black: 0.55, lcd: 0.58, settle: 0.7, stable: 0.9, away: 0.9 } as const

/** `devices/feeler_gauge.ts`：0.32 选片、0.35 对缝、0.62 插入到底、0.82 滑动到位、0.90 抽出。 */
export const FEEL_T = { fold: 0.32, align: 0.35, inserted: 0.62, slid: 0.82, out: 0.9 } as const

/** `devices/torque_wrench.ts`：0.42 落位、0.70 预紧完成、0.78–0.86 脱扣、0.92 移开。 */
export const TQ_T = { seated: 0.42, loaded: 0.7, click0: 0.78, click1: 0.86, away: 0.92 } as const

/** `devices/warning_sign.ts`：0.40 绳到位、0.62 离手、0.82 摆正。 */
export const SIGN_T = { seated: 0.4, released: 0.62, settled: 0.82 } as const

/** `devices/driver_desk.ts`：0.12 钥匙插入、0.22 右旋、0.36 手柄快速位、
 *  0.50 选 2U、0.64 旋钮保持、0.80 弓起、1.00 VCB 闭合。 */
export const DESK_T = {
  keyIn: 0.12,
  keyOn: 0.22,
  brake: 0.36,
  unit: 0.5,
  raise: 0.64,
  raised: 0.8,
} as const

/** `devices/hvac.ts`：0.10 掀盖、0.155 盖板取下、0.24 盒盖、0.30–0.40 合闸、0.50 风机、0.68 制冷。 */
export const HVAC_T = {
  open: 0.1,
  coverOff: 0.16,
  lid: 0.24,
  breakers: 0.3,
  powered: 0.4,
  vent: 0.5,
  cool: 0.68,
  stable: 0.86,
} as const

/** 有动作阶段文案的设备。`hvac` 没有读数面板，但仍要有阶段文案。 */
export type PhaseKey =
  | 'door'
  | 'pantograph'
  | 'cabinet'
  | 'hvac'
  | 'multimeter'
  | 'warning_sign'
  | 'feeler_gauge'
  | 'torque_wrench'
  | 'driver_desk'

/** 当前处于哪一段。`t` 是 0–1 的行程比例，与 `setT` 同一口径。 */
export function phaseFor(scene: PhaseKey, t: number, mode: PantoMode = 'normal'): string {
  switch (scene) {
    case 'door':
      // 0.88 之后门已滑到位，0.88–0.92 是"到位检测"：锁闭信号要重新确认。
      // `devices/door.ts` 上一版把 `< 0.88` 写了两遍，这一支永远走不到。
      if (t < DOOR_T.unlock) return '关闭锁定'
      if (t < DOOR_T.pop) return '门锁解锁'
      if (t < DOOR_T.slide0) return '退出密封面'
      if (t < DOOR_T.slide1) return '门扇开启'
      if (t < DOOR_T.detect) return '到位检测'
      return '完全开启'

    case 'cabinet':
      // 0 时刻还没合闸：主断在 0.02 才动。这里原来直接说"主断路器合闸"，
      // 与同页的"断路器手柄：断开位"自相矛盾。
      if (t < CAB_T.main) return '未上电（全部断开）'
      if (t < CAB_T.branches) return '主断路器合闸'
      if (t < CAB_T.ctrl) return '分路断路器合闸'
      if (t < CAB_T.contactor) return '控制回路得电'
      if (t < CAB_T.contactorEnd) return '接触器吸合'
      if (t < CAB_T.relay) return '继电器自检'
      if (t < CAB_T.trip) return '系统就绪'
      if (t < CAB_T.reset) return '过载脱扣'
      if (t < CAB_T.reclose) return '复位（手柄扳到底）'
      if (t < 1) return '重新合闸'
      // 再合闸在 1.0 结束：这一句要同时交代"合上了"和"系统可用"
      return '重新合闸完成、系统就绪'

    case 'hvac':
      if (t < HVAC_T.open) return '检修盖板关闭、机组停用'
      // 盖板 0.10–0.20 抬起、0.155 取下（见 `hvac.ts` 的 `cover.visible`）
      if (t < HVAC_T.coverOff) return '掀开并取下检修盖板'
      if (t < HVAC_T.lid) return '检修盖板已拆下、机内可见'
      if (t < HVAC_T.breakers) return '掀开控制盒盖、检查接线'
      if (t < HVAC_T.powered) return '三只断路器依次合闸'
      if (t < HVAC_T.cool) return '通风模式运行'
      if (t < HVAC_T.stable) return '制冷模式起动'
      return '稳定运行'

    case 'multimeter':
      if (t < MM_T.dial) return '档位置于直流电压档'
      if (t < MM_T.red) return '红表笔接近正极端子'
      if (t < MM_T.black) return '红表笔搭上正极（显示 OL）'
      // 0.55 黑笔落位、0.58 才真正显示读数
      if (t < MM_T.lcd) return '黑表笔搭上公共端'
      if (t < MM_T.settle) return '读数建立中'
      if (t < MM_T.stable) return '读数稳定 110.3 V'
      return '撤笔、读数保持'

    case 'warning_sign':
      if (t < SIGN_T.seated) return '牌已挂上、尚未摆正'
      if (t < SIGN_T.released) return '挂绳滑入把手内侧'
      if (t < SIGN_T.settled) return '牌面离手、摆动中'
      return '挂牌到位、牌面摆正'

    case 'feeler_gauge':
      if (t < FEEL_T.fold) return '展开选片、翻成竖直'
      if (t < FEEL_T.align) return '片端对准门缝'
      if (t < FEEL_T.inserted) return '塞尺插入门缝'
      // 滑动在 0.82 到位，但抽出现在 0.90 才开始：0.82–0.90 这一段不能说"抽出"，
      // 否则文案比画面早 0.08（上一版就是这样）。
      if (t < FEEL_T.out) return '沿缝滑动找最紧处'
      if (t < 1) return '抽出塞尺'
      return '读出片厚、判定间隙'

    case 'torque_wrench':
      if (t < TQ_T.seated) return '套筒套入螺栓'
      if (t < TQ_T.loaded) return '施力、刻度上升'
      // 0.70–0.78 刻度已到设定值但扳手还没脱扣：这一段原来直接说"咔嗒脱扣"，
      // 早 0.08。
      if (t < TQ_T.click0) return '刻度到达设定值'
      if (t < TQ_T.click1) return '到 25 N·m 咔嗒脱扣'
      if (t < TQ_T.away) return '移开扳手'
      return '复检并做防松标记'

    case 'driver_desk':
      // 八拍就是升弓试验里"人做的部分"。阈值与 `driver_desk.ts` 的 setT 同源，
      // 改动画必须同步改这里，`phase-contract.spec.ts` 会红。
      if (t < DESK_T.keyIn) return '主控未激活、MON 屏熄灭'
      if (t < DESK_T.keyOn) return '主控钥匙已插入'
      if (t < DESK_T.brake) return '钥匙右旋、司机室占用'
      if (t < DESK_T.unit) return '制动手柄快速位、MCR 励磁'
      if (t < DESK_T.raise) return '受电弓选择完成'
      if (t < DESK_T.raised) return '升弓旋钮保持、升弓中'
      if (t < 1) return '受电弓升起、网压正常'
      return 'VCB 闭合、送电完成'

    default: {
      // 受电弓：正常工况沿用现场口径的短句，ADD 工况直接取气路模块的说法
      if (mode === 'add' && t >= PANO_T.lower0) return airPhase(t, mode)
      if (t < PANO_T.airOn) return '落弓锁定'
      if (t < PANO_T.raise0) return '气路建压'
      if (t < PANO_T.raise1) return '升弓中'
      if (t < PANO_T.press1) return '接触压力建立'
      if (t < PANO_T.hold1) return '升弓到位'
      if (t < PANO_T.lower0) return '保压'
      if (t < PANO_T.lower1) return '降弓中（阻尼）'
      return '落弓到位'
    }
  }
}
