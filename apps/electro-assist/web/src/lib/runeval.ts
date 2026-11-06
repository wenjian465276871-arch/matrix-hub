import type { Criterion, CriterionResult, Step, Verdict } from '../types'

/**
 * A1 作业引导的判据求值逻辑。
 *
 * 抽成纯函数的理由和 `guidepatch` 一样：这里的失败模式全是"静默"的——
 * - `buildPayload` 漏一个类型，现场会反复卡在"请先填写"而不知道该填什么
 * - `rangeWarning` 口径错（比如边界值判成超差），会让合格件被判异常、返工
 * - 两者都不会抛异常，只会在现场悄悄给出错误结论
 *
 * 三条口径，改之前先读：
 * 1. **超差只提示、不阻断**（计划 §12.4）。前端不让替现场下判断，
 *    服务端判 fail 才是结论；所以 `rangeWarning` 永远只返回文案。
 * 2. **边界值算合格**：`min` / `max` 是闭区间，`number < min` 才超差。
 * 3. **空 ≠ 0**：range 判据填空串是"没填"，不是"测得 0"。
 */

export const VERDICT_LABEL: Record<Verdict, string> = {
  pass: '通过',
  warn: '需复测',
  fail: '异常',
  manual: '已记录',
  skipped: '未执行',
}

export function verdictLabel(verdict?: Verdict): string {
  return verdict ? VERDICT_LABEL[verdict] : '未执行'
}

/** 结果展示：布尔值说人话，数值带单位。 */
export function formatResult(result: CriterionResult): string {
  if (typeof result.value === 'boolean') return result.value ? '已确认' : '未确认'
  return `${String(result.value)}${result.unit ? ` ${result.unit}` : ''}`
}

/**
 * 数值判据的即时提示。返回空串表示"没问题或不该提示"。
 *
 * 注意它**不影响能否提交**——超差照样能提交，提交后由服务端判 fail。
 * 前端的职责是"让人看见"，不是"替人拦住"。
 */
export function rangeWarning(criterion: Criterion, raw: string | undefined): string {
  if (criterion.type !== 'range') return ''
  if (raw === undefined || raw === '') return ''
  const number = Number(raw)
  if (!Number.isFinite(number)) return '请输入有效数值'
  if (criterion.min != null && number < criterion.min) {
    return `低于下限 ${criterion.min} ${criterion.unit ?? ''}`
  }
  if (criterion.max != null && number > criterion.max) {
    return `超出上限 ${criterion.max} ${criterion.unit ?? ''}`
  }
  return ''
}

export interface StepPayload {
  payload: Record<string, unknown>
  /** 未填写的判据，按步骤里的顺序。用于"请先填写：A、B"与聚焦第一项 */
  missing: Criterion[]
}

/**
 * 把页面上的字符串输入编译成提交载荷。
 *
 * 四种判据的规则不一样，逐一对应：
 * - `manual`：必须勾选（`'true'`）才算填了；载荷是布尔 true
 * - `range`：空串或非数字都算没填；载荷是**数字**（不是字符串，否则后端按类型拒）
 * - 其余（`text` / `enum`）：trim 后为空算没填
 */
export function buildPayload(step: Step, values: Record<string, string>): StepPayload {
  const payload: Record<string, unknown> = {}
  const missing: Criterion[] = []
  for (const criterion of step.criteria) {
    const raw = values[criterion.id] ?? ''
    if (criterion.type === 'manual') {
      if (raw !== 'true') missing.push(criterion)
      else payload[criterion.id] = true
    } else if (criterion.type === 'range') {
      if (raw === '' || !Number.isFinite(Number(raw))) missing.push(criterion)
      else payload[criterion.id] = Number(raw)
    } else {
      if (raw.trim() === '') missing.push(criterion)
      else payload[criterion.id] = raw.trim()
    }
  }
  return { payload, missing }
}
