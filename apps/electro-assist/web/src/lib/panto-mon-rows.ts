/** 升弓 MON 屏的**行数据**：哪一页有哪几行、每行的"要求 / 显示值"。
 *
 * ## 为什么搬出组件（第七轮评审 R23-7，2026-11-15）
 * `PantoMon.vue` 到 1046 行（判据：>1000 行且改动频繁），其中约 60 行是纯派生：
 * 页签 → 行数组。它不碰 DOM，只读会话状态；搬出来之后可以单测，
 * 组件回到"画这块屏"这一件事，改一行文案也不用在千行里找。
 *
 * ## 为什么不拆组件
 * 三块屏（升弓 / 空调 / 车门）的版式差异是真实的，`MonPanel` 已经是分发壳；
 * 再往上套一层会把"哪块屏有哪些行"的判断搬到壳里。只搬"状态 → 行"这一段。
 */
import { MON_ITEMS, session, type MonKey } from './panto-session'

export type MonTab = 'power' | 'vehicle' | 'remote'

/** 每个页签上有哪几项需要确认（远程控制切除页只"看"，没有确认项）。
 *
 *  有了它，页签才能标出"还有几项没确认"——否则用户点完当前页的 2 行、
 *  看到进度写 2/5，却不知道剩下 3 项藏在另外两页里（2026-11-13 实测踩到）。
 */
export const TAB_KEYS: Record<MonTab, MonKey[]> = {
  power: ['voltage', 'mr'],
  vehicle: ['egs', 'vcb', 'panto_cut'],
  remote: [],
}

export interface MonRow {
  key?: MonKey
  label: string
  required: string
  value: string
}

/* 第 6 步（status）是"成功后应该看到的样子"：即使没走过前面步骤，也按成功态显示受电弓。
   否则直接翻到第 6 步会看到一块暗屏 + "未升起"，与"读到升起即可进入下一步"自相矛盾。 */
export function monShownRaised(mode: string): boolean {
  return mode === 'status' ? true : session.raised
}

/* VCB **不能**跟着 status 一起"示意"。
   2026-11-13 本人实测：第 5 步合了 VCB，第 6 步屏上仍写"断开"——因为这里写死了 false。
   VCB 是人操作的直接结果，屏必须如实反映；"升起了但还没合闸"本身也是合法中间态，
   显示"断开"不算矛盾。 */
export function monShownVcb(): boolean {
  return session.vcbClosed
}

/** 当前选中的受电弓单元。2U = 04 车，3U = 06 车。 */
export function monUnit(): '2U' | '3U' {
  return session.unit ?? '2U'
}

/** 有些项的"显示值"是活的，不能写死在 `MON_ITEMS` 里默认值中：
 *  VCB 是人操作的结果，写死"断开"会在用户合闸后自相矛盾。 */
function liveValue(key: MonKey, fallback: string): string {
  if (key === 'vcb') return monShownVcb() ? '闭合' : '断开'
  return fallback
}

function pick(
  key: MonKey,
  mode: string,
  requiredInStatus?: string,
): { label: string; required: string; value: string } {
  const item = MON_ITEMS.find((i) => i.key === key)!
  return {
    label: item.label,
    required: mode === 'status' && requiredInStatus ? requiredInStatus : item.required,
    value: liveValue(key, item.value),
  }
}

/** VCB 在两种场景下的含义不同：
 *  - 升弓前（check）：必须断开，否则升弓回路被联锁切断；
 *  - 升弓后（status）：按需要，合闸是下一步的事，不是判据。 */
function vcbRequired(mode: string): string {
  return mode === 'status' ? '视需要' : '必须断开'
}

export function monRows(tab: MonTab, mode: string): MonRow[] {
  if (tab === 'power') {
    return [
      { key: 'voltage', ...pick('voltage', mode) },
      { key: 'mr', ...pick('mr', mode) },
      { label: '蓄电池电压', required: '≥87 V', value: '110.0 V' },
    ]
  }
  if (tab === 'vehicle') {
    return [
      { key: 'egs', ...pick('egs', mode) },
      { key: 'vcb', ...pick('vcb', mode, '视需要') },
      // 这一行的"要求"与"显示"不能都写"未切除"：两列同字，看着像重复渲染。
      { key: 'panto_cut', label: '受电弓远程切除', required: '应未切除', value: '均未切除' },
    ]
  }
  // 远程控制切除页：先看"切没切"，再看"升没升"。
  // 原来把"升起"塞进切除行，出现"未切除 升起"这种两种语义挤在一行的读法。
  const unit = monUnit()
  const other = unit === '2U' ? '3U' : '2U'
  return [
    { label: `${unit} 受电弓切除`, required: '应未切除', value: '未切除' },
    { label: `${other} 受电弓切除`, required: '应未切除', value: '未切除' },
    {
      label: '受电弓状态',
      required: mode === 'status' ? '已确认' : '应升起',
      value: monShownRaised(mode) ? '升起' : '未升起',
    },
    { label: 'VCB', required: vcbRequired(mode), value: monShownVcb() ? '闭合' : '断开' },
  ]
}
