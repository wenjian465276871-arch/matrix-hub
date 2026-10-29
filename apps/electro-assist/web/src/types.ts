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
  | 'motion_timeline'
  | 'flow_arrow'
  | 'callout'
  | 'gate_state'
  | 'table'
  | 'annotation'

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

/** 用户自带的现场素材（截图/照片）。位置由人挂，不由模型猜。 */
export interface AssetRef {
  asset_id: string
  caption: string
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
  assets: AssetRef[]
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
  /** 还没归位的素材，渲染成末尾「现场素材」区 */
  assets: AssetRef[]
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

/* ---------- 工艺预检（POST /processes） ---------- */

export interface ProcessStepHint {
  seq: number
  action: string
  criterion_hint: string | null
}

export interface ProcessPrecheck {
  process: {
    name: string | null
    station: string | null
    system: System | null
    tools: string[]
    safety: string[]
    steps: ProcessStepHint[]
  }
  missing: string[]
  warnings: string[]
  stats: {
    chars: number
    lines: number
    steps: number
    steps_with_criterion: number
  }
  next: string
}

/* ---------- 图片识别（POST /extract） ---------- */

export interface ExtractedStep {
  seq: number
  action: string
  criterion: string | null
  source_line: number | null
  verified: boolean
}

export interface ExtractResult {
  lines: string[]
  fields: {
    name: string | null
    station: string | null
    tools: string[]
    safety: string[]
    steps: ExtractedStep[]
  }
  warnings: string[]
  unverified: string[]
  needs_review: true
  stats: {
    lines: number
    steps: number
    verified_steps: number
  }
  disclaimer: string
  model: string
  latency_ms: number
  cost_micros: number
}

/* ---------- 现场素材 ---------- */

export interface UploadedAsset {
  asset_id: string
  source_format: string
  source_width: number
  source_height: number
  stored_width: number
  stored_height: number
  stored_bytes: number
  sha256: string
  warnings: string[]
  exif_stripped: boolean
}

/** 归位请求体：step_id 为空 = 留在末尾素材区 */
export interface AttachAsset {
  asset_id: string
  caption: string
  step_id?: string | null
}

export interface AttachResult {
  status: GuideStatus
  guide_id: string
  attached: number
  loose: number
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
  /** 单步耗时：本步最后一次提交 − 上一步最后一次提交；未执行为 null */
  started_at: string | null
  ended_at: string | null
  duration_s: number | null
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

/** A1 记录里回写的 B 结论。只带展示所需字段，不复制结论全文。 */
export interface LinkedDiagnosis {
  id: string
  symptom: string
  system: System
  status: 'active' | 'concluded' | 'aborted'
  current_order: number | null
  conclusion: DiagnoseConclusion | null
  created_at: string
  finished_at: string | null
  checks: number
}

export interface SessionReport {
  session: Session
  guide: Guide
  steps: RecordStep[]
  exceptions: ExceptionItem[]
  diagnoses: LinkedDiagnosis[]
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
