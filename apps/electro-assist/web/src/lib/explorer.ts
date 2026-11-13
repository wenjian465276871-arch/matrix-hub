/** 探索台（默认版式）的纯逻辑：步骤归类、搜索过滤、舞台视图回落、右栏页签回落。
 *
 *  ## 为什么抽出来（第六轮评审 P2-2 / R20-2）
 *
 *  `GuideExplorer.vue` 是默认页，2026-11-13 已到 1,799 行，而它只有 3 条用例。
 *  本轮 +306 行（聚焦判据、页签回落、轨迹折叠）几乎全落在无断言区。
 *
 *  这里的每一条都是**纯函数**：输入 guide/figures，输出该显示什么。抽出来的好处
 *  不是"文件变短"，而是这些判断第一次能被断言——"切到三维再翻到只有烘焙图的步骤
 *  该显示什么"这种事，以前只能靠人点。
 *
 *  ## 边界
 *
 *  不碰 DOM、不碰状态机、不读 window。需要窗口尺寸的（短屏自动收轨迹）留在组件里，
 *  那是交互策略，不是数据映射。
 */
import type { AssetRef, Step, VisualSpec } from '../types'

/** 舞台里的"主图"分三类，各自吃满同一块地方，用页签切换。 */
export type StageView = 'still' | 'scene' | 'ops'

/** 右栏详解的四个页签。 */
export type PanelTab = 'safety' | 'tools' | 'criteria' | 'note'

/** 左栏目录的筛选条件。 */
export type StepFilter = 'all' | 'figure' | 'criteria'

/** 步骤性质：只在眉标与轨迹表里用，判断依据是标题里的动词，**不做模型调用**。
 *
 *  2026-11-14（R20-7）：`准备` 那一组原来写的是 `确认条件`（四字连写），于是
 *  「升弓前必须满足的条件」不含"确认"二字就被归成「作业」——而这一屏讲的就是
 *  作业前的条件确认。改成按 `条件` 命中。**改前扫描全部 7 份样例：只有这一条变**，
 *  其余标题的归类一字未动（`explorer.spec.ts` 里有用例钉住）。
 */
const KINDS: Array<[RegExp, string]> = [
  [/准备|安全|隔离|条件/, '准备'],
  [/测量|测|读表|计时/, '测量'],
  [/检查|查看|外观|确认/, '检查'],
  [/记录|填写|签字/, '记录'],
]

export function kindOf(step: Pick<Step, 'title'>): string {
  for (const [pattern, name] of KINDS) if (pattern.test(step.title)) return name
  return '作业'
}

/** 分钟数（四舍五入）；没有估时就返回 null，让界面自己决定要不要显示。 */
export function minutesOf(step: Pick<Step, 'duration_s'>): number | null {
  const seconds = step.duration_s
  return seconds === null || seconds === undefined ? null : Math.round(seconds / 60)
}

export function sumMinutes(steps: Array<Pick<Step, 'duration_s'>>): number {
  return steps.reduce((sum, step) => sum + (minutesOf(step) ?? 0), 0)
}

/** "有图"的口径：视觉图示或现场素材，有一项就算。 */
export function hasFigure(step: Pick<Step, 'figures'> & { assets?: AssetRef[] }): boolean {
  return step.figures.length > 0 || (step.assets?.length ?? 0) > 0
}

/**
 * 左栏目录：按关键词 + 条件筛选，但**保留原始下标**。
 *
 * 下标必须留下来：点击目录要 `go(index)` 翻到那一步，用筛选后的位置会跳错。
 */
export function filterSteps(
  steps: Step[],
  query: string,
  filter: StepFilter,
): Array<{ s: Step; index: number }> {
  const needle = query.trim().toLowerCase()
  return steps
    .map((s, index) => ({ s, index }))
    .filter(({ s }) => {
      if (filter === 'figure' && !hasFigure(s)) return false
      if (filter === 'criteria' && !s.criteria.length) return false
      if (!needle) return true
      const hay = [s.title, s.action, ...s.criteria.map((c) => c.label), ...s.tools]
        .join(' ')
        .toLowerCase()
      return hay.includes(needle)
    })
}

export interface ViewGroup {
  id: StageView
  label: string
  figs: VisualSpec[]
}

/** 把本步的图按"看得清的方式"分组成页签，顺序固定：实物示意图 → 三维动作 → 操作台。 */
export function viewGroupsOf(figures: VisualSpec[]): ViewGroup[] {
  const groups: ViewGroup[] = []
  const still = figures.filter((f) => f.primitive === 'baked_figure')
  const scene = figures.filter((f) => f.primitive === 'device_scene')
  // MON 屏与升弓操作台：带状态的界面，给它们一个独立页签，不与"看动作"混在一起
  const ops = figures.filter(
    (f) => f.primitive === 'mon_panel' || f.primitive === 'operation_scene',
  )
  if (still.length) groups.push({ id: 'still', label: '实物示意图', figs: still })
  if (scene.length) groups.push({ id: 'scene', label: '三维动作', figs: scene })
  if (ops.length) groups.push({ id: 'ops', label: '操作台', figs: ops })
  return groups
}

/**
 * 当前选中的视图，若本步没有就回落到第一个可用视图。
 *
 * 典型场景：在"三维动作"页签上点下一步，翻到只有烘焙图的步骤 —— 不回落的
 * 结果是一块空白，用户以为图挂了。
 */
export function effectiveView(
  selected: StageView,
  groups: ViewGroup[],
): ViewGroup | undefined {
  return groups.find((g) => g.id === selected) ?? groups[0]
}

/**
 * 主图：有分组就取当前分组；一张分组图都没有（比如只有清单图的步骤），
 * 把第一张 2D 图提上来——否则它会被塞进 168px 的辅图列，一张清单缩成邮票。
 */
export function heroFiguresOf(
  figures: VisualSpec[],
  groups: ViewGroup[],
  selected: StageView,
): VisualSpec[] {
  if (!groups.length) return figures.slice(0, 1)
  return effectiveView(selected, groups)?.figs ?? []
}

/** 辅图：分组视图之外的那些 2D 图元（清单 / 表格 / 标注…）。 */
export function aidFiguresOf(figures: VisualSpec[], groups: ViewGroup[]): VisualSpec[] {
  if (!groups.length) return figures.slice(1)
  return figures.filter(
    (f) =>
      f.primitive !== 'baked_figure' &&
      f.primitive !== 'device_scene' &&
      f.primitive !== 'mon_panel' &&
      f.primitive !== 'operation_scene',
  )
}

/** 右栏四个页签及其条数（"说明"页没有条目，只放正文）。 */
export function panelTabs(
  step: Pick<Step, 'safety' | 'tools' | 'criteria'> | undefined,
): Array<{ id: PanelTab; label: string; n: number }> {
  return [
    { id: 'safety', label: '安全', n: step?.safety.length ?? 0 },
    { id: 'tools', label: '工具', n: step?.tools.length ?? 0 },
    { id: 'criteria', label: '判据', n: step?.criteria.length ?? 0 },
    { id: 'note', label: '说明', n: 0 },
  ]
}

/**
 * 右栏当前页签，落在空页签上就跳到第一个有内容的。
 *
 * 没有安全项时不要停在空标签上——点进来第一眼是空白会被当成加载失败。
 * "说明"永远有正文，所以它是兜底而不是"第一个有内容的"。
 */
export function effectiveTab(
  selected: PanelTab,
  tabs: Array<{ id: PanelTab; n: number }>,
): PanelTab {
  const current = tabs.find((t) => t.id === selected)
  if (current && current.n > 0) return selected
  return tabs.find((t) => t.n > 0)?.id ?? 'note'
}

/** 本步是否有"要动手操作"的图元（短屏下自动收轨迹、收标题块）。 */
export function hasOpsFigure(figures: VisualSpec[]): boolean {
  return figures.some((f) => f.primitive === 'operation_scene')
}

/** 需要"整屏"的步骤：三维操作台与 MON 屏（价值全在看得清、点得中）。 */
export function needsStageFocus(figures: VisualSpec[]): boolean {
  return figures.some(
    (f) => f.primitive === 'operation_scene' || f.primitive === 'mon_panel',
  )
}

/** 本步主图是一台设备的静态三维（不是操作台）——只做收标题块这类低风险让位。 */
export function isSceneHero(figures: VisualSpec[]): boolean {
  return figures.some((f) => f.primitive === 'device_scene')
}
