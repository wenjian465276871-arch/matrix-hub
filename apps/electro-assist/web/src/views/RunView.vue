<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import GuideFigure from '../figures/GuideFigure.vue'
import { ApiError, getJson, postJson } from '../lib/http'
import type {
  Criterion,
  CriterionResult,
  Guide,
  RecordItem,
  Session,
  SessionSnapshot,
  Step,
  StepSubmitResponse,
  Verdict,
} from '../types'

const props = defineProps<{ sid: string }>()
const router = useRouter()

const session = ref<Session | null>(null)
const guide = ref<Guide | null>(null)
const records = ref<RecordItem[]>([])
const values = ref<Record<string, string>>({})
const lastStep = ref<Step | null>(null)
const results = ref<CriterionResult[]>([])
const phase = ref<'loading' | 'ready' | 'submitting' | 'passed' | 'exception' | 'error'>(
  'loading',
)
const errorText = ref('')
const errorCode = ref('')
const abortConfirm = ref(false)
const starting = ref(false)
let keySeq = 0

const VERDICT_LABEL: Record<Verdict, string> = {
  pass: '通过',
  warn: '需复测',
  fail: '异常',
  manual: '已记录',
  skipped: '未执行',
}

const total = computed(() => guide.value?.steps.length ?? 0)
const currentStep = computed(() => {
  const seq = session.value?.current_seq ?? 0
  return guide.value?.steps.find((s) => s.seq === seq) ?? null
})
const shownStep = computed(() => {
  if (phase.value === 'passed' || phase.value === 'exception') return lastStep.value
  return currentStep.value
})
const completed = computed(() => {
  if (!guide.value || !session.value) return []
  const latest = new Map<string, RecordItem>()
  for (const record of records.value) latest.set(record.step_id, record)
  return guide.value.steps
    .filter((step) => step.seq < (session.value as Session).current_seq)
    .map((step) => ({ step, record: latest.get(step.id) }))
})
const isLastStep = computed(
  () => !!session.value && session.value.current_seq > total.value,
)

function apply(data: SessionSnapshot): void {
  session.value = data.session
  guide.value = data.guide
  records.value = data.records
}

function resetValues(): void {
  const next: Record<string, string> = {}
  for (const criterion of currentStep.value?.criteria ?? []) next[criterion.id] = ''
  values.value = next
  results.value = []
}

async function load(): Promise<void> {
  phase.value = 'loading'
  errorText.value = ''
  errorCode.value = ''
  try {
    const data = await getJson<SessionSnapshot>(`/api/electro/sessions/${props.sid}`)
    apply(data)
    if (data.session.status !== 'active') {
      await router.replace({ name: 'record', params: { sid: props.sid } })
      return
    }
    resetValues()
    phase.value = 'ready'
  } catch (err) {
    phase.value = 'error'
    if (err instanceof ApiError) {
      errorCode.value = err.code ?? ''
      errorText.value =
        err.kind === 'notfound' ? '这次作业不存在或已失效。' : '无法载入作业，请稍后重试。'
    } else {
      errorText.value = '无法载入作业，请稍后重试。'
    }
  }
}

function setManual(id: string, checked: boolean): void {
  values.value[id] = checked ? 'true' : ''
}

function rangeWarning(criterion: Criterion): string {
  if (criterion.type !== 'range') return ''
  const raw = values.value[criterion.id]
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

function buildPayload(step: Step): { payload: Record<string, unknown>; missing: Criterion[] } {
  const payload: Record<string, unknown> = {}
  const missing: Criterion[] = []
  for (const criterion of step.criteria) {
    const raw = values.value[criterion.id] ?? ''
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

async function submitStep(): Promise<void> {
  const step = currentStep.value
  if (!step || phase.value !== 'ready') return

  const { payload, missing } = buildPayload(step)
  if (missing.length) {
    errorCode.value = 'missing_criterion'
    errorText.value = `请先填写：${missing.map((c) => c.label).join('、')}`
    const first = missing[0]
    document.getElementById(`c-${first.id}`)?.focus()
    return
  }

  phase.value = 'submitting'
  errorText.value = ''
  errorCode.value = ''
  lastStep.value = step
  keySeq += 1
  const key = `${props.sid}:${step.id}:${Date.now().toString(36)}:${keySeq}`

  try {
    const res = await postJson<StepSubmitResponse>(
      `/api/electro/sessions/${props.sid}/steps/${step.seq}`,
      { values: payload },
      { headers: { 'Idempotency-Key': key } },
    )
    session.value = res.session
    if (!res.duplicate) records.value = [...records.value, res.record]
    results.value = res.results
    phase.value = res.verdict === 'fail' || res.verdict === 'warn' ? 'exception' : 'passed'
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      // 顺序冲突/会话已结束：以服务端状态为准，重新拉一次
      await load()
      return
    }
    phase.value = 'ready'
    if (err instanceof ApiError) {
      errorCode.value = err.code ?? ''
      if (err.status === 422) {
        errorText.value = err.message || '判据未填写完整'
      } else {
        errorText.value = '提交失败，已保留填写值，请重试。'
      }
    } else {
      errorText.value = '提交失败，已保留填写值，请重试。'
    }
  }
}

function retest(): void {
  lastStep.value = null
  resetValues()
  errorText.value = ''
  errorCode.value = ''
  phase.value = 'ready'
}

async function continueNext(): Promise<void> {
  if (!session.value) return
  if (isLastStep.value) {
    await finish('done')
    return
  }
  lastStep.value = null
  resetValues()
  errorText.value = ''
  errorCode.value = ''
  phase.value = 'ready'
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

async function finish(status: 'done' | 'aborted'): Promise<void> {
  if (starting.value) return
  starting.value = true
  errorText.value = ''
  try {
    await postJson(`/api/electro/sessions/${props.sid}/finish`, { status })
    await router.push({ name: 'record', params: { sid: props.sid } })
  } catch (err) {
    phase.value = 'ready'
    errorText.value =
      err instanceof ApiError ? err.message || '结束作业失败，请重试' : '结束作业失败，请重试'
  } finally {
    starting.value = false
  }
}

function verdictLabel(verdict?: Verdict): string {
  return verdict ? VERDICT_LABEL[verdict] : '未执行'
}

function formatResult(result: CriterionResult): string {
  if (typeof result.value === 'boolean') return result.value ? '已确认' : '未确认'
  return `${String(result.value)}${result.unit ? ` ${result.unit}` : ''}`
}

onMounted(load)
</script>

<template>
  <div class="run-page">
    <div v-if="phase === 'loading'" class="card state" aria-busy="true">正在载入作业…</div>

    <div v-else-if="phase === 'error'" class="card state state--error">
      <p>{{ errorText }}</p>
      <p v-if="errorCode" class="state__hint">{{ errorCode }}</p>
      <button class="btn" type="button" @click="load">重试</button>
    </div>

    <template v-else-if="guide && session">
      <header class="run-head">
        <p class="run-kicker">{{ guide.title }}</p>
        <h1 class="run-title">
          <template v-if="isLastStep">全部步骤已提交</template>
          <template v-else>第 {{ session.current_seq }} / {{ total }} 步</template>
        </h1>
        <progress class="progress" :value="Math.min(session.current_seq - 1, total)" :max="total" />
        <p class="sr-only" aria-live="polite">第 {{ session.current_seq }} 步已激活</p>
      </header>

      <section v-if="completed.length" class="done-list" aria-label="已完成步骤">
        <p class="block-label">已完成</p>
        <ul>
          <li v-for="item in completed" :key="item.step.id">
            <span class="done-seq">{{ String(item.step.seq).padStart(2, '0') }}</span>
            <span class="done-title">{{ item.step.title }}</span>
            <span class="verdict-chip" :class="`v-${item.record?.verdict ?? 'skipped'}`">
              {{ verdictLabel(item.record?.verdict) }}
            </span>
          </li>
        </ul>
      </section>

      <article v-if="shownStep" class="card run-card">
        <div class="step__head">
          <span class="step__seq">{{ String(shownStep.seq).padStart(2, '0') }}</span>
          <h2 class="step__title">{{ shownStep.title }}</h2>
        </div>
        <p class="step__action">{{ shownStep.action }}</p>

        <div v-if="shownStep.safety.length" class="step__block">
          <p class="block-label">安全</p>
          <ul class="safety">
            <li v-for="item in shownStep.safety" :key="item">{{ item }}</li>
          </ul>
        </div>

        <div v-if="shownStep.tools.length" class="step__block">
          <p class="block-label">工具</p>
          <div class="tool-list">
            <span v-for="item in shownStep.tools" :key="item" class="tag tag--plain">
              {{ item }}
            </span>
          </div>
        </div>

        <div v-if="shownStep.figures.length" class="step__block">
          <p class="block-label">图示</p>
          <GuideFigure
            v-for="(figure, index) in shownStep.figures"
            :key="`${shownStep.id}-fig-${index}`"
            :spec="figure"
          />
        </div>

        <section v-if="phase === 'ready'" class="step__block">
          <p class="block-label">验收判据</p>

          <div
            v-for="criterion in shownStep.criteria"
            :key="criterion.id"
            class="field"
            :class="{ 'field--bad': rangeWarning(criterion) }"
          >
            <label class="field__label" :for="`c-${criterion.id}`">
              {{ criterion.label }}
              <span v-if="criterion.type === 'range'" class="field__hint">
                要求 {{ criterion.min }}–{{ criterion.max }} {{ criterion.unit }}
              </span>
            </label>

            <div v-if="criterion.type === 'range'" class="input-row">
              <input
                :id="`c-${criterion.id}`"
                v-model="values[criterion.id]"
                class="num-input"
                type="number"
                inputmode="decimal"
                step="any"
                placeholder="实测值"
              />
              <span class="unit-chip">{{ criterion.unit }}</span>
            </div>
            <p v-if="rangeWarning(criterion)" class="field__error">{{ rangeWarning(criterion) }}</p>

            <select
              v-else-if="criterion.type === 'enum'"
              :id="`c-${criterion.id}`"
              v-model="values[criterion.id]"
              class="select"
            >
              <option value="" disabled>请选择</option>
              <option v-for="option in criterion.options ?? []" :key="option" :value="option">
                {{ option }}
              </option>
            </select>

            <label v-else-if="criterion.type === 'manual'" class="check-row">
              <input
                :id="`c-${criterion.id}`"
                class="checkbox"
                type="checkbox"
                :checked="values[criterion.id] === 'true'"
                @change="setManual(criterion.id, ($event.target as HTMLInputElement).checked)"
              />
              <span>已确认</span>
            </label>

            <textarea
              v-else
              :id="`c-${criterion.id}`"
              v-model="values[criterion.id]"
              class="textarea"
              rows="2"
              maxlength="500"
              placeholder="记录观察结果"
            />
          </div>
        </section>
      </article>

      <section v-if="phase === 'passed'" class="result-box result-box--ok" aria-live="polite">
        <p class="result-title">本步通过</p>
        <ul class="result-list">
          <li v-for="result in results" :key="result.criterion_id">
            <span>{{ result.label }}</span>
            <span>{{ formatResult(result) }}</span>
            <span class="verdict-chip" :class="`v-${result.verdict}`">
              {{ verdictLabel(result.verdict) }}
            </span>
          </li>
        </ul>
        <button class="btn btn--primary block-btn" type="button" @click="continueNext">
          {{ isLastStep ? '完成并查看记录' : '继续下一步' }}
        </button>
      </section>

      <section v-else-if="phase === 'exception'" class="result-box result-box--bad" aria-live="assertive">
        <p class="result-title">本步异常，需处置</p>
        <ul class="result-list">
          <li v-for="result in results" :key="result.criterion_id">
            <span>{{ result.label }}</span>
            <span>{{ result.message }}</span>
          </li>
        </ul>
        <p class="result-note">异常已记录。复测会生成新的尝试记录，原记录保留。</p>
        <div class="actions">
          <button class="btn btn--primary" type="button" @click="retest">复测本步</button>
          <button class="btn" type="button" disabled title="N2 上线后可用">
            转故障排查
          </button>
          <button class="btn btn--danger" type="button" @click="abortConfirm = true">
            停止作业
          </button>
        </div>
      </section>

      <div v-if="abortConfirm" class="card abort-panel">
        <p><strong>确认中止作业？</strong></p>
        <p class="state__hint">记录编号 {{ sid }}，已完成的步骤会保留。</p>
        <div class="actions">
          <button class="btn" type="button" :disabled="starting" @click="abortConfirm = false">
            继续作业
          </button>
          <button
            class="btn btn--danger"
            type="button"
            :disabled="starting"
            @click="finish('aborted')"
          >
            {{ starting ? '正在结束…' : '确认中止' }}
          </button>
        </div>
      </div>

      <p v-if="errorText && phase === 'ready'" class="inline-error">{{ errorText }}</p>

      <div v-if="phase === 'ready' || phase === 'submitting'" class="run-bar no-print">
        <div class="run-bar__inner">
          <button
            class="bar-secondary"
            type="button"
            :disabled="phase === 'submitting' || starting"
            @click="abortConfirm = true"
          >
            中止
          </button>
          <button
            class="btn btn--primary bar-primary"
            type="button"
            :disabled="phase === 'submitting'"
            @click="submitStep"
          >
            {{ phase === 'submitting' ? '提交中…' : '提交本步' }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.run-page {
  padding-bottom: 96px;
}

.run-head {
  margin-bottom: 16px;
}

.run-kicker {
  margin: 0;
  color: var(--c-ink-2);
  font-size: 14px;
}

.run-title {
  margin: 4px 0 10px;
  font-size: 22px;
}

.progress {
  width: 100%;
  height: 6px;
  appearance: none;
  border: none;
  border-radius: 999px;
  background: var(--c-line-soft);
  overflow: hidden;
}

.progress::-webkit-progress-bar {
  background: var(--c-line-soft);
}

.progress::-webkit-progress-value {
  background: var(--c-primary);
}

.progress::-moz-progress-bar {
  background: var(--c-primary);
}

.done-list {
  margin-bottom: 12px;
  padding: 12px 14px;
  border: 1px solid var(--c-line-soft);
  border-radius: 6px;
  background: var(--c-surface);
}

.done-list ul {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}

.done-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  font-size: 13px;
  color: var(--c-ink-2);
}

.done-seq {
  font-family: var(--font-mono);
  color: var(--c-ink-3);
}

.done-title {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.run-card {
  padding: 20px;
}

.field {
  margin-top: 14px;
  padding: 12px;
  border: 1px solid var(--c-line-soft);
  border-radius: 6px;
}

.field--bad {
  border-color: #d9a3a0;
  background: #fff7f6;
}

.field__label {
  display: block;
  margin-bottom: 8px;
  font-weight: 600;
  font-size: 14px;
  color: var(--c-ink);
}

.field__hint {
  display: block;
  margin-top: 2px;
  color: var(--c-ink-3);
  font-size: 12px;
  font-weight: 400;
}

.field__error {
  margin: 6px 0 0;
  color: var(--c-danger);
  font-size: 13px;
}

.input-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.num-input,
.select,
.textarea {
  width: 100%;
  min-height: 48px;
  padding: 10px 12px;
  border: 1px solid var(--c-line);
  border-radius: 6px;
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
}

.num-input {
  flex: 1;
  min-width: 120px;
  font-family: var(--font-mono);
  font-size: 18px;
}

.textarea {
  min-height: 64px;
  resize: vertical;
}

.unit-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  height: 44px;
  padding: 0 8px;
  border: 1px solid var(--c-primary-line);
  border-radius: 6px;
  background: var(--c-primary-soft);
  color: var(--c-primary-ink);
  font-family: var(--font-mono);
  font-size: 13px;
}

.check-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  font-size: 15px;
  color: var(--c-ink);
}

.checkbox {
  width: 22px;
  height: 22px;
  accent-color: var(--c-primary);
}

.result-box {
  margin-top: 16px;
  padding: 16px;
  border: 1px solid var(--c-line);
  border-radius: 8px;
}

.result-box--ok {
  border-color: #9bc7ad;
  background: #f1f8f4;
}

.result-box--bad {
  border-color: #d9a3a0;
  background: #fff7f6;
}

.result-title {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 700;
}

.result-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.result-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px dashed var(--c-line-soft);
  font-size: 14px;
}

.result-list li:last-child {
  border-bottom: none;
}

.result-note {
  margin: 10px 0 0;
  color: var(--c-ink-2);
  font-size: 13px;
}

.verdict-chip {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 12px;
  white-space: nowrap;
}

.v-pass {
  background: #e6f4ec;
  color: #1a7f4b;
}

.v-fail {
  background: #fdeceb;
  color: #b3261e;
}

.v-warn {
  background: #fff4e0;
  color: #8a5a00;
}

.v-manual {
  background: var(--c-primary-soft);
  color: var(--c-primary-ink);
}

.v-skipped {
  background: var(--c-line-soft);
  color: var(--c-ink-3);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
}

.block-btn {
  width: 100%;
  min-height: 48px;
  margin-top: 14px;
}

.btn--danger {
  border-color: #b3261e;
  background: #b3261e;
  color: #fff;
}

.btn--danger:hover {
  background: #8f1d17;
}

.abort-panel {
  margin-top: 16px;
  padding: 16px;
  border-color: #d9a3a0;
}

.inline-error {
  margin: 12px 0 0;
  color: var(--c-danger);
  font-size: 13px;
}

.run-bar {
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 20;
  border-top: 1px solid var(--c-line);
  background: var(--c-surface);
  padding: 8px 16px calc(8px + env(safe-area-inset-bottom));
}

.run-bar__inner {
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 760px;
  margin: 0 auto;
}

.bar-secondary {
  min-width: 64px;
  min-height: 48px;
  border: none;
  background: transparent;
  color: var(--c-ink-2);
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}

.bar-secondary:disabled {
  color: var(--c-ink-3);
  cursor: default;
}

.bar-primary {
  flex: 1;
  min-height: 48px;
  font-size: 16px;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}

@media (min-width: 1024px) {
  .run-card {
    padding: 24px;
  }
}
</style>
