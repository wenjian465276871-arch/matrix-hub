import type { Criterion, Guide, GuidePatch } from '../types'

/**
 * 草稿修正的纯逻辑：把「用户改了什么」编译成 PATCH 请求体。
 *
 * 抽成独立模块（而不是留在 GuideView 里）的原因只有一个：
 * **这段代码漏一个字段就是静默丢数据**——用户改了下限，保存成功，但值没进请求，
 * 界面刷新后回到旧值。这种 bug 不会报错、不会崩，只能靠精确的单测盯住。
 *
 * 三条不变量，改这里之前先读：
 * 1. 只发**真的改过**的字段。少传 = 少一层覆盖，后端也不会重写无关步骤。
 * 2. 空串 = 不改（不是"清空"）。数值输入框在输入 `-` 或 `1.` 的中间态会给出空串，
 *    把它当成"用户想清空"会把判据的下限悄悄删掉。
 * 3. 非法数字 = 抛错，不发 NaN。宁可让用户看见"不是合法数字"，也不要让后端收到 null。
 */

/** 编辑态的判据：数值一律用字符串存，理由见文件头第 2 条。 */
export interface EditCriterion {
  id: string
  type: string
  label: string
  unit: string
  min: string
  max: string
  options: string
}

export interface EditStep {
  id: string
  title: string
  action: string
  criteria: EditCriterion[]
}

export interface EditDraft {
  title: string
  summary: string
  steps: EditStep[]
}

/** 数值转输入框文本：null / undefined 都是空串，不要显示 "null"。 */
export function numText(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value)
}

/** 服务端的 guide 转成编辑态草稿。只做形状转换，不做校验。 */
export function toEditDraft(guide: Guide): EditDraft {
  return {
    title: guide.title,
    summary: guide.summary,
    steps: guide.steps.map((step) => ({
      id: step.id,
      title: step.title,
      action: step.action,
      criteria: step.criteria.map((c: Criterion) => ({
        id: c.id,
        type: c.type,
        label: c.label,
        unit: c.unit ?? '',
        min: numText(c.min),
        max: numText(c.max),
        options: (c.options ?? []).join(' / '),
      })),
    })),
  }
}

/** 空串 = 不改；非法数字 = 直接报错，不要悄悄发一个 NaN 出去。 */
export function toNumber(raw: string, label: string): number | undefined {
  const text = raw.trim()
  if (!text) return undefined
  const value = Number(text)
  if (!Number.isFinite(value)) throw new Error(`${label}不是合法数字`)
  return value
}

/**
 * 对比草稿与原始 guide，产出最小 PATCH。
 *
 * 没有改动时返回 `{}`（调用方据此提示"没有改动"并退出编辑态）。
 */
export function buildPatch(original: Guide, draft: EditDraft): GuidePatch {
  const patch: GuidePatch = {}
  if (draft.title.trim() !== original.title) patch.title = draft.title.trim()
  if (draft.summary.trim() !== original.summary) patch.summary = draft.summary.trim()

  const steps: NonNullable<GuidePatch['steps']> = []
  original.steps.forEach((origStep, index) => {
    const edit = draft.steps[index]
    if (!edit) return
    const change: NonNullable<GuidePatch['steps']>[number] = { id: edit.id }
    let touched = false
    if (edit.title.trim() !== origStep.title) {
      change.title = edit.title.trim()
      touched = true
    }
    if (edit.action.trim() !== origStep.action) {
      change.action = edit.action.trim()
      touched = true
    }

    const criteria: NonNullable<typeof change.criteria> = []
    origStep.criteria.forEach((orig, ci) => {
      const row = edit.criteria[ci]
      if (!row) return
      const item: NonNullable<typeof criteria>[number] = { id: row.id }
      let dirty = false
      if (row.label.trim() !== orig.label) {
        item.label = row.label.trim()
        dirty = true
      }
      if (row.type === 'range') {
        if (row.unit.trim() !== (orig.unit ?? '')) {
          item.unit = row.unit.trim()
          dirty = true
        }
        const min = toNumber(row.min, `${orig.label} 的下限`)
        const max = toNumber(row.max, `${orig.label} 的上限`)
        if (min !== undefined && min !== orig.min) {
          item.min = min
          dirty = true
        }
        if (max !== undefined && max !== orig.max) {
          item.max = max
          dirty = true
        }
      } else if (row.type === 'enum') {
        const options = row.options
          .split('/')
          .map((part) => part.trim())
          .filter(Boolean)
        if (options.join('/') !== (orig.options ?? []).join('/')) {
          item.options = options
          dirty = true
        }
      }
      if (dirty) criteria.push(item)
    })
    if (criteria.length) {
      change.criteria = criteria
      touched = true
    }
    if (touched) steps.push(change)
  })

  if (steps.length) patch.steps = steps
  return patch
}
