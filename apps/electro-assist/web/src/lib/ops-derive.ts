/** 作业台的**派生显示**：底部状态灯 / 本步提示 / 完成判据。
 *
 * ## 为什么搬出组件（第七轮评审 R23-7，2026-11-15）
 * `OpsBoard.vue` 顶到 994 行，其中约 90 行是这三段纯派生——它们不碰 DOM、不碰 rAF，
 * 只读四份会话状态。搬出来之后：① 组件回到"画界面"这一件事；② 这三段可以单测
 * （原来只能靠 E2E 间接验）；③ 改文案不用在千行文件里找。
 *
 * ## 为什么不拆组件
 * 空调与车门两块场景的**版式**差异是真实的（门有六个按钮的灯、空调有机组徽标），
 * 强行共用一层壳会把"哪块该显示什么"的判断搬到壳里，反而更难读。
 * 只搬"数据 → 文案"这一段。
 */
import { nextPowerAction, power } from './desk-power'
import {
  confirmDone as hvacDone,
  confirmMissing,
  coolingStable,
  hvac,
  nextAction as hvacNext,
  ventConfirmDone,
  ventConfirmMissing,
} from './hvac-session'
import {
  confirmDone as doorConfirmed,
  door,
  nextAction as doorNext,
} from './door-session'

export type OPScene = 'hvac' | 'door'

/** 底部只读状态灯：`done` 决定是否点亮，点它没有任何反应。 */
export interface Chip {
  label: string
  done: boolean
}

/** 上电三件（三项试验共用）。 */
function powerChips(): Chip[] {
  return [
    { label: '钥匙插入', done: power.keyInserted },
    { label: '钥匙右旋', done: power.keyTurned },
    { label: '手柄快速位', done: power.brakeFast },
  ]
}

export function opsChips(scene: OPScene, phase: string): Chip[] {
  if (phase === 'power') return powerChips()

  if (scene === 'door') {
    if (phase === 'check') {
      const n = doorConfirmed()
      return [{ label: `MON 已确认 ${n}/3`, done: n >= 3 }]
    }
    return [
      { label: door.released ? `集控投入（${door.side === 'L' ? '左' : '右'}）` : '集控切除', done: door.released },
      { label: `开门 ${Math.round(door.openT * 100)}%`, done: door.openT > 0.999 },
      { label: door.blocked ? '试块在门洞' : '试块在门外', done: door.blocked },
      { label: `防夹反开 ${door.bumps} 次`, done: door.bumps > 0 },
      { label: door.closedLed ? '关门灯亮' : '关门灯灭', done: door.closedLed },
    ]
  }

  const modeLabel =
    hvac.mode === 'cool' ? '制冷' : hvac.mode === 'vent' ? '通风' : hvac.mode === 'heat' ? '制热' : '停止'
  // 通风阶段只有三项可判（压缩机不转，没有电流与高压）：状态灯也只在报三项
  const ventPhase = phase === 'vent' || (hvac.ventRunning && !hvac.cooling)
  const confirmChip = ventPhase
    ? { label: `MON 已确认 ${ventConfirmDone()}/3`, done: ventConfirmDone() >= 3 }
    : { label: `MON 已确认 ${hvacDone()}/5`, done: hvacDone() >= 5 }
  return [
    { label: `模式 ${modeLabel}`, done: hvac.applied },
    { label: `设定 ${hvac.setTemp} ℃`, done: hvac.applied },
    { label: hvac.cooling ? '压缩机运行' : hvac.ventRunning ? '通风运行' : '机组停止', done: hvac.ventRunning },
    confirmChip,
  ]
}

/** 本步该做什么：只给一句，且**只说本步**（不催后面几步的事）。 */
export function opsNext(scene: OPScene, phase: string): string {
  if (!power.keyTurned || !power.brakeFast) return nextPowerAction()
  if (scene === 'door') {
    if (phase === 'check' && doorConfirmed() < 3) return '点 MON 屏：在「车门状态」页把三项逐项确认'
    if (phase === 'operate' && !door.released) return '把转换开关盘的「集控」扳到「投入」，再把「开关门」扳到「开」'
    if (phase === 'operate') return '门开到位即可进入下一步（防夹验证）'
    if (phase === 'pinch' && !door.blocked) return '点三维里门外侧的试块，把它移到门洞关闭边（左门框侧）'
    if (phase === 'pinch' && door.bumps === 0) return '把「开关门」扳到「关」：门扇前缘碰到试块应停止并反向开门'
    // 06 是「正常关门」：门洞里那块必须先撤回原位，否则一关就又触发防夹
    if (phase === 'close' && door.blocked) {
      return '点三维里门洞地板上的试块：把它移回门外原位（撤除障碍物）'
    }
    if (phase === 'close' && door.openT > 0.001) {
      return '把「开关门」扳到「关」：无障碍物时门扇应正常关闭并锁闭，不再反开'
    }
    /* 不再写"…本步完成"（评审 R23-6）：门关到位就已经给出「本步完成」按钮，
       同一时刻两句话互相打架；末步更糟——按钮按设计不出现，提示却说"本步完成"。
       复位是收工整理，不该卡工步。 */
    if (phase === 'close') return '门已关到位；释放未复位时按「释放」可复位（不影响本步判定）'
    return doorNext()
  }
  if (phase === 'set' && !hvac.applied) return '点 MON 屏：选「通风」、设定 24 ℃，点「下发设定」'
  if (phase === 'vent') {
    if (ventConfirmMissing().length) {
      return '在 MON「机组状态」页确认三项：全列机组通信、冷凝/送风机、排水与滤网（压缩机与高压侧压力在通风模式下不判）'
    }
    return '通风三项已确认：测送风口风速与送风温度，完成后进入下一工步'
  }
  if (phase === 'cool' && hvac.mode !== 'cool') return '点 MON 屏：模式切「制冷」并「下发设定」，压缩机随即起动'
  if (phase === 'cool' && hvac.coolT < 1) return '制冷运行中：等读数稳定（现场约 15 分钟）'
  if (phase === 'cool' && confirmMissing().length) return '点 MON 屏：在「机组状态」页把五项逐项确认'
  return hvacNext()
}

/** 本步是否做完：做完了才给"进入下一步"的出口。 */
export function opsStepDone(scene: OPScene, phase: string): boolean {
  if (phase === 'power') return power.keyInserted && power.keyTurned && power.brakeFast
  if (scene === 'door') {
    if (phase === 'check') return doorConfirmed() >= 3
    if (phase === 'operate') return door.openT > 0.999
    if (phase === 'pinch') return door.bumps > 0 && door.openT > 0.99
    // 关门到位**且试块已撤回**才算完成：块还在门洞就"完成"，等于跳过了正常关门试验
    if (phase === 'close') return !door.blocked && door.openT <= 0.001
    return false
  }
  if (phase === 'set') return hvac.applied && hvac.mode !== 'off'
  if (phase === 'vent') return hvac.ventRunning && !hvac.cooling && ventConfirmMissing().length === 0
  if (phase === 'cool') return coolingStable() && confirmMissing().length === 0
  return false
}
