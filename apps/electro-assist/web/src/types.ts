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

export interface VisualSpec {
  primitive: Primitive
  params: Record<string, Scalar>
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
  source_note: string
}

export interface GuideList {
  schema_version: string
  count: number
  items: GuideSummary[]
}
