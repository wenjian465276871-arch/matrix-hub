/** 与后端 `models/guide.py` 对应的最小类型集。
 *
 * 只映前端真正用到的字段。契约以 `GET /api/electro/schema/guide` 为准，
 * 这里手写而不是生成，是为了让"字段缺失"在编译期就暴露；
 * W2 接生成管线时改为由 schema 自动生成，避免两份定义漂移。
 */

export type System = 'door' | 'hvac' | 'pantograph'

export type CriterionType = 'range' | 'enum' | 'text' | 'manual'

export interface Criterion {
  id: string
  label: string
  type: CriterionType
  unit?: string | null
  min?: number | null
  max?: number | null
  options?: string[] | null
}

export type Primitive =
  | 'step_card'
  | 'meter'
  | 'status_light'
  | 'wiring'
  | 'connector'
  | 'torque_gauge'
  | 'checklist'

export type Scalar = string | number | boolean

/** 参数值：标量或字符串列表。
 *  清单类参数（items / terminals / pins）本质是列表，模型也倾向输出数组；
 *  后端已放宽为 `Scalar | string[]`（决策 #15），前端同步。 */
export type ParamValue = Scalar | string[]

export interface VisualSpec {
  primitive: Primitive
  params: Record<string, ParamValue>
  caption?: string | null
  fallback_text: string
}

export interface Step {
  id: string
  seq: number
  title: string
  action: string
  safety: string[]
  tools: string[]
  criteria: Criterion[]
  figures: VisualSpec[]
  duration_s: number | null
}

export interface GuideMeta {
  system: System
  source_note: string
  model: string
  generated_at: string
  is_demo: boolean
}

export interface Guide {
  schema_version: string
  id: string
  title: string
  summary: string
  meta: GuideMeta
  steps: Step[]
  disclaimers: string[]
}

export interface GuideSummary {
  id: string
  title: string
  summary: string
  system: System
  step_count: number
  estimated_s: number | null
  generated_at: string
  is_demo: boolean
  status: GuideStatus
  source_note: string
}

export interface GuideList {
  schema_version: string
  count: number
  items: GuideSummary[]
}

export type GuideStatus = 'draft' | 'published'

/** 详情信封：status 不属于指导书文档本身，单独回传。 */
export interface GuideDetail {
  status: GuideStatus
  guide: Guide
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout'

export interface JobSnapshot {
  id: string
  status: JobStatus
  guide_id: string | null
  error_code: string | null
  error_message: string | null
  created_at: string
  finished_at: string | null
  duration_ms: number | null
  usage: {
    prompt_tokens: number
    completion_tokens: number
    reasoning_tokens: number
  }
  cost_micros: number
  poll_after_ms: number
}

export interface GenerateAccepted {
  job_id: string
  status: 'queued'
  poll_after_ms: number
}

export interface QuotaBucket {
  used: number
  limit: number
  reset_in_s: number
}

export interface QuotaSnapshot {
  hour: QuotaBucket
  day: QuotaBucket
  site_budget: {
    used_micros: number
    limit_micros: number
    used_cny: number
    limit_cny: number
  }
  queue: { pending: number; limit: number }
}
