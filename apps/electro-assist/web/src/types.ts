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

/* ---------- A1 引导 ---------- */

export type Verdict = 'pass' | 'warn' | 'fail' | 'manual' | 'skipped'
export type SessionStatus = 'active' | 'done' | 'aborted'

export interface Session {
  id: string
  guide_id: string
  status: SessionStatus
  current_seq: number
  device: string
  location: string
  note: string
  created_at: string
  updated_at: string
  finished_at: string | null
}

export interface CriterionResult {
  criterion_id: string
  label: string
  type: CriterionType
  value: unknown
  unit: string | null
  verdict: Verdict
  message: string
}

export interface RecordPayload {
  step_title?: string
  results?: CriterionResult[]
  note?: string
}

export interface RecordItem {
  id: string
  session_id: string
  step_id: string
  seq: number
  attempt: number
  verdict: Verdict
  payload: RecordPayload
  created_at: string
}

export interface SessionProgress {
  total_steps: number
  recorded_steps: number
  attempts: number
  current_seq: number
}

export interface SessionSnapshot {
  session: Session
  guide: Guide
  records: RecordItem[]
  progress: SessionProgress
}

export interface StepSubmitResponse {
  record: RecordItem
  session: Session
  verdict: Verdict
  results: CriterionResult[]
  messages: string[]
  duplicate: boolean
}

export interface RecordStep {
  seq: number
  step_id: string
  title: string
  attempts: RecordItem[]
  final_verdict: Verdict
}

export interface ExceptionItem {
  seq: number
  step_id: string
  attempt: number
  verdict: Verdict
  messages: string[]
  note: string
  created_at: string
}

export interface SessionReport {
  session: Session
  guide: Guide
  steps: RecordStep[]
  exceptions: ExceptionItem[]
  summary: {
    status: SessionStatus
    total_steps: number
    recorded_steps: number
    attempts: number
    pass: number
    manual: number
    fail: number
    warn: number
    aborted: boolean
    duration_s: number
  }
}

/* ---------- B 模块：故障排查 ---------- */

export interface DiagnoseCheck {
  order: number
  action: string
  expect: string
  kind?: 'confirm' | 'measure'
  unit?: string | null
  min?: number | null
  max?: number | null
  next?: number | null
  on_fail?: string | null
}

export interface DiagnoseSignals {
  keyword: number
  vector: number
  combined: number
}

export interface DiagnoseResult {
  id: string
  title: string
  system: System
  score: number
  signals?: DiagnoseSignals
  likely_causes: string[]
  checks: DiagnoseCheck[]
  escalation: string
  safety: string
  sources: string[]
}

export interface DiagnoseRerank {
  order: string[]
  reason: string
  model?: string
  latency_ms?: number
  cost_micros?: number
  /** 命中 10 分钟缓存时为 true：同一句话重复问不再计费 */
  cached?: boolean
}

export type UncoveredReason = 'system_not_covered' | 'no_match' | null

export interface DiagnoseResponse {
  query: string
  matched: boolean
  uncovered_reason: UncoveredReason
  message: string
  suggestion: string
  results: DiagnoseResult[]
  count: number
  took_ms: number
  kb_version: string
  provider?: string
  rerank?: DiagnoseRerank | null
  disclaimer: string
  context?: {
    guide_id?: string | null
    step_seq?: number | null
    criterion_id?: string | null
  }
}

/* ---------- B 模块：逐步诊断（故障树） ---------- */

export interface DiagnoseRunCandidate {
  id: string
  title: string
  system: System
  score: number
  signals: DiagnoseSignals
}

export interface DiagnoseRunInfo {
  id: string
  entry_id: string
  symptom: string
  system: System
  session_id: string | null
  status: 'active' | 'concluded' | 'aborted'
  current_order: number | null
  conclusion: DiagnoseConclusion | null
  created_at: string
  updated_at: string
  finished_at: string | null
}

export interface DiagnoseConclusion {
  kind: 'fail' | 'exhausted' | 'aborted'
  check_order: number | null
  cause: string
  action: string
  safety: string
  sources: string[]
}

export interface DiagnoseStepRecord {
  check_order: number
  verdict: 'pass' | 'fail'
  value: string
  note: string
  created_at: string
}

export interface DiagnoseRunResponse {
  run: DiagnoseRunInfo
  entry: DiagnoseResult
  current_check: DiagnoseCheck | null
  steps: DiagnoseStepRecord[]
  progress: { done: number; total: number }
  conclusion: DiagnoseConclusion | null
  disclaimer: string
  candidates?: DiagnoseRunCandidate[]
  rerank?: DiagnoseRerank | null
}

export interface KnowledgeEntrySummary {
  id: string
  title: string
  system: System
}

export interface KbOverview {
  version: string
  provider: string
  systems: System[]
  count: number
  entries: KnowledgeEntrySummary[]
}
