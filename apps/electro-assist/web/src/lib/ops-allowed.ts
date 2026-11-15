/** 按步裁剪（`act`）的**唯一口径表** + fail-closed 判定。
 *
 * ## 为什么从组件里搬出来（第七轮评审 R23-1，2026-11-15）
 * 原来 `OpsBoard.vue` 与 `PantoOps.vue` 各写一张 `ALLOWED` 表，判定是
 * `table[phase] ?? table.all`——**未知 `act` 会回退成"全部放开"**。
 * 评审用临时用例复现过：`act='nope'` 时点门控「释放」直接生效，回执正常、
 * 没有拒绝。方向是反的（fail-open），而且前端表与后端 `INTERACTIVE_SCENES`
 * 之间没有任何机检，只要有人只改一边，页面看着正常、越界动作全放行。
 *
 * 搬到独立模块之后有三件事同时成立：
 * 1. 判定可以**单测**（`ops-allowed.spec.ts`），不必挂组件；
 * 2. 可以用契约里的 `scenes[].ops_acts` 断言"表覆盖了后端允许的每一个 act"，
 *    漂移当场变红；
 * 3. 未知值一律**拒绝 + 告警一次**，不再静默。
 *
 * ## 新增一个 act 的正确姿势
 * ① 后端 `models/visual.py` 的 `INTERACTIVE_SCENES[scene]["ops_acts"]` 加值 →
 * ② `python scripts/export_contract.py` → ③ 本文件对应的表加键与允许的件 →
 * ④ `ops-allowed.spec.ts` 会自动要求第 ③ 步存在。四步顺序不能省第 ① 步，
 * 否则样例写不出来（后端会拒）。
 */

export type AllowTable = Record<string, readonly string[]>

/** 作业台（空调 / 车门）两块场景的按步裁剪表。键与样例里的 `act` 一一对应。 */
export const OPS_ALLOWED: Record<'hvac' | 'door', AllowTable> = {
  hvac: {
    all: ['key', 'brake', 'mon'],
    power: ['key', 'brake', 'mon'],
    set: ['mon'],
    vent: ['mon'],
    cool: ['mon'],
    done: ['mon'],
  },
  door: {
    all: [
      'key',
      'brake',
      'mon',
      'block',
      'door_l_release',
      'door_l_open',
      'door_l_close',
      'door_r_release',
      'door_r_open',
      'door_r_close',
    ],
    power: ['key', 'brake', 'mon'],
    // 只确认门状态：六个按钮一颗都不该动
    check: ['mon'],
    operate: ['mon', 'door_l_release', 'door_l_open', 'door_r_release', 'door_r_open'],
    pinch: ['mon', 'block', 'door_l_close', 'door_r_close'],
    close: ['mon', 'block', 'door_l_close', 'door_r_close', 'door_l_release', 'door_r_release'],
  },
}

/** 升弓操作台的按步裁剪表（按键名裁剪，与作业台不是同一套键）。 */
export const PANTO_ALLOWED: AllowTable = {
  // 上电：只到"手柄快速位"为止
  power: ['key', 'brake', 'mon'],
  // 选单元：只动转换开关
  unit: ['switch', 'mon'],
  // 升弓与 VCB 闭合
  raise: ['knob', 'vcb', 'mon', 'gauge'],
  // 结论：只看
  done: ['mon', 'gauge'],
  all: ['key', 'brake', 'switch', 'knob', 'vcb', 'mon', 'gauge'],
}

/**
 * 取本步允许的件列表。**取不到就是 `null`，由调用方拒绝**——不要在这里兜底成
 * `table.all`：兜底会把"配置写错了"变成"什么都能点"，而那正是要防的事。
 */
export function allowList(table: AllowTable | undefined, phase: string): readonly string[] | null {
  if (!table) return null
  return table[phase] ?? null
}

const warned = new Set<string>()

/** 同一个问题只告警一次：渲染路径里 `console.warn` 刷屏比不告警更糟。 */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  if (typeof console !== 'undefined') console.warn(message)
}

/** 测试用：清掉"已告警"记录，避免用例之间互相影响。 */
export function resetWarnings(): void {
  warned.clear()
}
