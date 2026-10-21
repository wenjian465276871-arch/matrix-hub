<script setup lang="ts">
/** B 模块：故障排查。
 *
 *  两种模式，共用同一份知识库：
 *  - 快速检索：一次给出候选条目与完整检查清单，适合打印、对照着看；
 *  - 逐步诊断：把条目当故障树走，某一项异常就收敛到结论，适合现场边查边填。
 *
 *  两种模式都不让模型生成事实：模型只在快速检索里对候选排序，
 *  逐步诊断的推进完全由服务端按知识条目的判据决定。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ApiError, getJson, postJson } from '../lib/http'
import type {
  DiagnoseResponse,
  DiagnoseRunResponse,
  KbOverview,
} from '../types'

const route = useRoute()

const mode = ref<'quick' | 'step'>('quick')
const symptom = ref('')
const system = ref<'' | 'door' | 'hvac' | 'pantograph'>('')
const phase = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const result = ref<DiagnoseResponse | null>(null)
const kb = ref<KbOverview | null>(null)
const errorText = ref('')
const context = ref<{ guide_id?: string; step_seq?: number }>({})

// 逐步诊断
const runData = ref<DiagnoseRunResponse | null>(null)
const runBusy = ref(false)
// Vue 3 对 <input type="number"> 的 v-model 会自动转 number，
// 所以这里不能假设是字符串，统一按 string | number 处理。
const measured = ref<string | number>('')
const note = ref('')

const SYSTEM_LABEL: Record<string, string> = {
  door: '客室侧门',
  hvac: '空调',
  pantograph: '受电弓',
}

const currentCheck = computed(() => runData.value?.current_check ?? null)
const isMeasure = computed(() => currentCheck.value?.kind === 'measure')
const measuredNumber = computed(() => {
  const raw = measured.value
  if (raw === '' || raw === null || raw === undefined) return null
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
  return Number.isFinite(value) ? value : null
})
const canSubmitMeasure = computed(
  () => measuredNumber.value !== null && !runBusy.value,
)

const conclusionLabel: Record<string, string> = {
  fail: '已定位到异常点',
  exhausted: '全部检查完成，未定位单一原因',
  aborted: '诊断已中止',
}

function failText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message || fallback : fallback
}

async function submitQuick(): Promise<void> {
  const text = symptom.value.trim()
  if (text.length < 4) {
    errorText.value = '请多描述一点现象，至少 4 个字'
    phase.value = 'error'
    return
  }
  phase.value = 'loading'
  errorText.value = ''
  try {
    result.value = await postJson<DiagnoseResponse>('/api/electro/diagnose', {
      symptom: text,
      system: system.value || null,
      top_k: 3,
      context: context.value.guide_id ? context.value : null,
    })
    phase.value = 'ready'
  } catch (err) {
    errorText.value = failText(err, '网络异常，排查失败，请稍后再试')
    phase.value = 'error'
  }
}

async function submit(): Promise<void> {
  if (mode.value === 'quick') return submitQuick()
  return startRun()
}

async function startRun(entryId?: string): Promise<void> {
  const text = symptom.value.trim()
  if (text.length < 4) {
    errorText.value = '请多描述一点现象，至少 4 个字'
    phase.value = 'error'
    return
  }
  phase.value = 'loading'
  runBusy.value = true
  errorText.value = ''
  try {
    runData.value = await postJson<DiagnoseRunResponse>('/api/electro/diagnose/runs', {
      symptom: text,
      system: system.value || null,
      entry_id: entryId ?? null,
      session_id: null,
    })
    measured.value = ''
    note.value = ''
    phase.value = 'ready'
  } catch (err) {
    errorText.value = failText(err, '网络异常，无法开始逐步诊断')
    phase.value = 'error'
  } finally {
    runBusy.value = false
  }
}

async function submitCheck(verdict: 'pass' | 'fail'): Promise<void> {
  const data = runData.value
  const check = currentCheck.value
  if (!data || !check || runBusy.value) return

  runBusy.value = true
  errorText.value = ''
  try {
    const body = isMeasure.value
      ? { value: measuredNumber.value, note: note.value }
      : { result: verdict, note: note.value }
    runData.value = await postJson<DiagnoseRunResponse>(
      `/api/electro/diagnose/runs/${data.run.id}/checks/${check.order}`,
      body,
    )
    measured.value = ''
    note.value = ''
  } catch (err) {
    errorText.value = failText(err, '提交失败，请重试')
  } finally {
    runBusy.value = false
  }
}

async function abortRun(): Promise<void> {
  const data = runData.value
  if (!data || runBusy.value) return
  runBusy.value = true
  try {
    runData.value = await postJson<DiagnoseRunResponse>(
      `/api/electro/diagnose/runs/${data.run.id}/abort`,
      {},
    )
  } catch (err) {
    errorText.value = failText(err, '中止失败，请重试')
  } finally {
    runBusy.value = false
  }
}

function reset(): void {
  result.value = null
  runData.value = null
  measured.value = ''
  note.value = ''
  phase.value = 'idle'
  errorText.value = ''
}

function switchMode(next: 'quick' | 'step'): void {
  if (mode.value === next) return
  mode.value = next
  reset()
}

onMounted(async () => {
  try {
    kb.value = await getJson<KbOverview>('/api/electro/diagnose/kb')
  } catch {
    // 知识库概览只是提示，取不到不影响主流程
  }

  const query = route.query
  if (typeof query.symptom === 'string' && query.symptom.trim()) {
    symptom.value = query.symptom.slice(0, 200)
    if (typeof query.guide === 'string') context.value.guide_id = query.guide
    if (typeof query.step === 'string' && Number(query.step) > 0) {
      context.value.step_seq = Number(query.step)
    }
    await submitQuick()
  }
})
</script>

<template>
  <div class="page-head">
    <h1 class="page-title">故障排查</h1>
    <p class="page-sub">
      用现场的话描述现象。快速检索给完整清单；逐步诊断按判据往下走，某一项异常就收敛到结论。
    </p>
  </div>

  <div class="mode" role="tablist" aria-label="排查模式">
    <button
      class="mode__btn"
      type="button"
      role="tab"
      :aria-selected="mode === 'quick'"
      :class="{ 'mode__btn--on': mode === 'quick' }"
      @click="switchMode('quick')"
    >
      快速检索
      <span class="mode__hint">一次看完清单</span>
    </button>
    <button
      class="mode__btn"
      type="button"
      role="tab"
      :aria-selected="mode === 'step'"
      :class="{ 'mode__btn--on': mode === 'step' }"
      @click="switchMode('step')"
    >
      逐步诊断
      <span class="mode__hint">边查边填，自动收敛</span>
    </button>
  </div>

  <section class="card ask">
    <label class="field">
      <span class="field__label">现场现象</span>
      <textarea
        id="symptom"
        v-model="symptom"
        class="textarea"
        rows="3"
        maxlength="200"
        placeholder="例如：门关到一半又自己弹开了"
      />
      <span class="field__hint">{{ symptom.length }}/200</span>
    </label>

    <div class="ask__row">
      <select v-model="system" class="select" aria-label="子系统">
        <option value="">自动识别子系统</option>
        <option value="door">客室侧门</option>
        <option value="hvac">空调</option>
        <option value="pantograph">受电弓</option>
      </select>
      <button
        class="btn btn--primary"
        type="button"
        :disabled="runBusy || symptom.trim().length < 4"
        @click="submit"
      >
        {{ runBusy ? '处理中…' : mode === 'quick' ? '开始排查' : '开始逐步诊断' }}
      </button>
    </div>

    <p v-if="kb" class="kb-note">
      知识库 {{ kb.count }} 条 · 覆盖
      {{ kb.systems.map((s) => SYSTEM_LABEL[s] ?? s).join('、') }} ·
      {{ kb.provider === 'hybrid' ? '关键词 + 向量混合召回' : kb.provider }}
    </p>
  </section>

  <p v-if="context.guide_id" class="ctx-note">
    来自作业记录：第 {{ context.step_seq }} 步异常 · 指导书 {{ context.guide_id }}
  </p>

  <p v-if="errorText" class="error-line">{{ errorText }}</p>

  <!-- ---------------- 快速检索 ---------------- -->
  <template v-if="mode === 'quick'">
    <section v-if="phase === 'error' && !errorText" class="card state">
      <p>排查失败，请稍后再试。</p>
      <button class="btn" type="button" @click="phase = 'idle'">返回修改</button>
    </section>

    <section v-else-if="result && !result.matched" class="card uncovered">
      <p class="uncovered__title">未覆盖</p>
      <p class="uncovered__body">{{ result.message }}</p>
      <p class="uncovered__hint">{{ result.suggestion }}</p>
      <button class="btn" type="button" @click="reset">换个说法</button>
    </section>

    <section v-else-if="result" class="results">
      <p class="results__meta">
        匹配 {{ result.count }} 条 · 用时 {{ result.took_ms }}ms · 知识库 v{{ result.kb_version }}
      </p>

      <p v-if="result.rerank" class="rerank-note">
        模型重排：{{ result.rerank.model || 'deepseek' }} · {{ result.rerank.latency_ms }}ms
        <template v-if="result.rerank.reason">· {{ result.rerank.reason }}</template>
      </p>

      <article v-for="(item, index) in result.results" :key="item.id" class="card hit">
        <header class="hit__head">
          <span class="hit__rank">{{ index + 1 }}</span>
          <h2 class="hit__title">{{ item.title }}</h2>
        </header>

        <p v-if="item.signals" class="signals">
          关键词 {{ item.signals.keyword }} · 向量 {{ item.signals.vector }} · 综合
          {{ item.signals.combined }}
        </p>

        <div class="hit__block">
          <p class="hit__label">可能原因</p>
          <ul class="hit__list">
            <li v-for="cause in item.likely_causes" :key="cause">{{ cause }}</li>
          </ul>
        </div>

        <div class="hit__block">
          <p class="hit__label">按顺序检查</p>
          <ol class="check-list">
            <li v-for="check in item.checks" :key="check.order" class="check">
              <span class="check__action">
                {{ check.action }}
                <span v-if="check.kind === 'measure'" class="check__tag">
                  实测 {{ check.unit }}
                </span>
              </span>
              <span class="check__expect">判据：{{ check.expect }}</span>
            </li>
          </ol>
        </div>

        <p class="hit__note"><strong>仍不解决：</strong>{{ item.escalation }}</p>
        <p class="hit__note hit__note--safe"><strong>安全提示：</strong>{{ item.safety }}</p>

        <button class="btn hit__cta" type="button" @click="startRun(item.id)">
          按这条逐步诊断
        </button>
      </article>

      <p class="disclaimer">{{ result.disclaimer }} · 排查建议需专业人员确认后执行</p>
    </section>
  </template>

  <!-- ---------------- 逐步诊断 ---------------- -->
  <template v-else>
    <section v-if="runData" class="run">
      <header class="run__head">
        <div>
          <p class="run__label">排查条目</p>
          <h2 class="run__title">{{ runData.entry.title }}</h2>
          <p class="run__sub">
            {{ SYSTEM_LABEL[runData.entry.system] ?? runData.entry.system }} ·
            已完成 {{ runData.progress.done }} / {{ runData.progress.total }} 项 ·
            状态 {{ runData.run.status === 'active' ? '进行中' : '已结束' }}
          </p>
        </div>
        <button
          v-if="runData.candidates && runData.candidates.length > 1"
          class="btn btn--ghost"
          type="button"
          @click="startRun()"
        >
          重新匹配
        </button>
      </header>

      <div v-if="runData.candidates && runData.candidates.length > 1" class="candidates">
        <span class="candidates__label">也可能是</span>
        <button
          v-for="item in runData.candidates"
          :key="item.id"
          class="chip"
          type="button"
          :class="{ 'chip--on': item.id === runData.entry.id }"
          @click="startRun(item.id)"
        >
          {{ item.title }}
          <span class="chip__score">{{ item.signals.combined }}</span>
        </button>
      </div>

      <!-- 当前检查 -->
      <article v-if="currentCheck" class="card current">
        <p class="current__label">
          第 {{ runData.progress.done + 1 }} 项 ·
          {{ isMeasure ? '回填实测值' : '确认正常 / 异常' }}
        </p>
        <h3 class="current__action">{{ currentCheck.action }}</h3>
        <p class="current__expect">判据：{{ currentCheck.expect }}</p>

        <div v-if="isMeasure" class="measure">
          <label class="measure__field">
            <span class="visually-hidden">实测值</span>
            <input
              v-model="measured"
              class="input"
              type="number"
              inputmode="decimal"
              step="any"
              placeholder="填入实测值"
            />
            <span class="measure__unit">{{ currentCheck.unit }}</span>
          </label>
          <span class="measure__range">
            参考 {{ currentCheck.min }}–{{ currentCheck.max }} {{ currentCheck.unit }}
          </span>
          <p class="measure__tip">按实测值提交，是否超差由服务端判定。</p>
        </div>

        <input
          v-model="note"
          class="input note-input"
          type="text"
          maxlength="120"
          placeholder="备注（可选）：看到的现象、部位、声音"
        />

        <div class="current__actions">
          <template v-if="isMeasure">
            <button
              class="btn btn--primary"
              type="button"
              :disabled="!canSubmitMeasure"
              @click="submitCheck('pass')"
            >
              提交实测值
            </button>
          </template>
          <template v-else>
            <button
              class="btn btn--ok"
              type="button"
              :disabled="runBusy"
              @click="submitCheck('pass')"
            >
              正常
            </button>
            <button
              class="btn btn--warn"
              type="button"
              :disabled="runBusy"
              @click="submitCheck('fail')"
            >
              异常
            </button>
          </template>
          <button class="btn btn--ghost" type="button" :disabled="runBusy" @click="abortRun">
            中止
          </button>
        </div>
      </article>

      <!-- 结论 -->
      <article v-if="runData.conclusion" class="card conclusion" :class="`conclusion--${runData.conclusion.kind}`">
        <p class="conclusion__kind">{{ conclusionLabel[runData.conclusion.kind] }}</p>
        <p class="conclusion__cause">{{ runData.conclusion.cause }}</p>
        <div class="conclusion__block">
          <p class="hit__label">处置与升级</p>
          <p class="conclusion__text">{{ runData.conclusion.action }}</p>
        </div>
        <div class="conclusion__block conclusion__block--safe">
          <p class="hit__label">安全提示</p>
          <p class="conclusion__text">{{ runData.conclusion.safety }}</p>
        </div>
        <p v-if="runData.conclusion.sources.length" class="conclusion__sources">
          来源：{{ runData.conclusion.sources.join('、') }}
        </p>
        <button class="btn btn--primary" type="button" @click="reset">重新排查</button>
      </article>

      <!-- 已填记录 -->
      <section v-if="runData.steps.length" class="steps">
        <p class="hit__label">已完成的检查</p>
        <ol class="steps__list">
          <li v-for="step in runData.steps" :key="step.check_order" class="step">
            <span class="step__order">{{ step.check_order }}</span>
            <span class="step__verdict" :class="`step__verdict--${step.verdict}`">
              {{ step.verdict === 'pass' ? '正常' : '异常' }}
            </span>
            <span v-if="step.value" class="step__value">{{ step.value }}</span>
            <span v-if="step.note" class="step__note">{{ step.note }}</span>
          </li>
        </ol>
      </section>

      <p class="disclaimer">{{ runData.disclaimer }} · 排查建议需专业人员确认后执行</p>
    </section>
  </template>
</template>

<style scoped>
.field {
  display: block;
}

.field__label {
  display: block;
  margin-bottom: 8px;
  font-weight: 600;
  color: var(--c-ink);
}

.field__hint {
  display: block;
  margin-top: 6px;
  color: var(--c-ink-3);
  font-size: 12px;
  text-align: right;
}

.textarea {
  width: 100%;
  min-height: 88px;
  padding: 12px 14px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
  line-height: 1.6;
  resize: vertical;
}

.textarea:focus,
.input:focus {
  outline: 2px solid var(--c-primary);
  outline-offset: 1px;
}

.select {
  height: var(--tap);
  padding: 0 12px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
}

.input {
  height: var(--tap);
  padding: 0 12px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
}

.mode {
  display: flex;
  gap: 8px;
  padding: 4px;
  margin-bottom: 12px;
  border-radius: var(--radius-sm);
  background: var(--c-bg);
  border: 1px solid var(--c-line);
}

.mode__btn {
  flex: 1;
  min-height: var(--tap);
  padding: 6px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--c-ink-2);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.mode__btn--on {
  background: var(--c-surface);
  color: var(--c-primary-ink);
  box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
}

.mode__hint {
  display: block;
  font-weight: 400;
  font-size: 11px;
  color: var(--c-ink-3);
}

.ask {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ask__row {
  display: flex;
  gap: 12px;
  align-items: center;
}

.ask__row .select {
  flex: 0 0 160px;
}

.ask__row .btn {
  flex: 1;
}

.kb-note {
  margin: 0;
  color: var(--c-ink-3);
  font-size: 12px;
}

.ctx-note {
  margin: 12px 2px 0;
  color: var(--c-ink-3);
  font-size: 12px;
}

.error-line {
  margin: 12px 2px 0;
  color: var(--c-warning);
  font-size: 14px;
}

.uncovered {
  margin-top: 16px;
  border-left: 4px solid var(--c-warning);
  background: var(--c-warning-soft);
}

.uncovered__title {
  margin: 0 0 8px;
  font-weight: 600;
  color: var(--c-warning);
}

.uncovered__body {
  margin: 0 0 6px;
}

.uncovered__hint {
  margin: 0 0 12px;
  color: var(--c-ink-2);
  font-size: 14px;
}

.results,
.run {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.results__meta,
.rerank-note {
  margin: 0;
  color: var(--c-ink-3);
  font-size: 12px;
}

.hit__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}

.hit__rank {
  flex: 0 0 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--c-primary);
  color: #fff;
  font-size: 13px;
  line-height: 24px;
  text-align: center;
}

.hit__title {
  margin: 0;
  font-size: 17px;
}

.signals {
  margin: 0 0 10px;
  color: var(--c-ink-3);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.hit__block {
  margin-bottom: 12px;
}

.hit__label {
  margin: 0 0 6px;
  color: var(--c-ink-3);
  font-size: 12px;
  letter-spacing: 0.04em;
}

.hit__list {
  margin: 0;
  padding-left: 20px;
}

.hit__list li {
  margin-bottom: 4px;
}

.check-list {
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: check;
}

.check {
  counter-increment: check;
  position: relative;
  padding: 10px 12px 10px 38px;
  margin-bottom: 8px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius-sm);
  background: var(--c-bg);
}

.check::before {
  content: counter(check);
  position: absolute;
  left: 12px;
  top: 10px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--c-primary-soft);
  color: var(--c-primary-ink);
  font-size: 12px;
  line-height: 18px;
  text-align: center;
}

.check__action {
  display: block;
}

.check__tag {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--c-primary-soft);
  color: var(--c-primary-ink);
  font-size: 11px;
}

.check__expect {
  display: block;
  margin-top: 4px;
  color: var(--c-ink-3);
  font-size: 13px;
}

.hit__note {
  margin: 0 0 6px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--c-primary-soft);
  font-size: 14px;
}

.hit__note--safe {
  background: var(--c-warning-soft);
}

.hit__cta {
  margin-top: 10px;
  width: 100%;
}

.disclaimer {
  margin: 4px 0 0;
  color: var(--c-ink-3);
  font-size: 12px;
  text-align: center;
}

/* ---------- 逐步诊断 ---------- */

.run__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.run__label {
  margin: 0 0 4px;
  color: var(--c-ink-3);
  font-size: 12px;
}

.run__title {
  margin: 0 0 4px;
  font-size: 18px;
}

.run__sub {
  margin: 0;
  color: var(--c-ink-3);
  font-size: 12px;
}

.candidates {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.candidates__label {
  color: var(--c-ink-3);
  font-size: 12px;
}

.chip {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  max-width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--c-line);
  border-radius: 999px;
  background: var(--c-surface);
  color: var(--c-ink-2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.chip--on {
  border-color: var(--c-primary);
  color: var(--c-primary-ink);
  background: var(--c-primary-soft);
}

.chip__score {
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--c-ink-3);
}

.current__label {
  margin: 0 0 6px;
  color: var(--c-ink-3);
  font-size: 12px;
}

.current__action {
  margin: 0 0 6px;
  font-size: 17px;
}

.current__expect {
  margin: 0 0 12px;
  color: var(--c-ink-2);
  font-size: 14px;
}

.measure {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.measure__field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.measure__field .input {
  width: 130px;
  font-variant-numeric: tabular-nums;
}

.measure__unit {
  color: var(--c-ink-2);
  font-size: 14px;
}

.measure__range {
  color: var(--c-ink-3);
  font-size: 12px;
}

.measure__tip {
  flex: 1 0 100%;
  margin: 0;
  color: var(--c-ink-3);
  font-size: 12px;
}

.note-input {
  width: 100%;
  margin-bottom: 12px;
}

.current__actions {
  display: flex;
  gap: 10px;
}

.current__actions .btn {
  flex: 1;
}

.conclusion {
  border-left: 4px solid var(--c-primary);
}

.conclusion--fail {
  border-left-color: var(--c-warning);
}

.conclusion--aborted {
  border-left-color: var(--c-ink-3);
}

.conclusion__kind {
  margin: 0 0 8px;
  font-weight: 600;
  color: var(--c-primary-ink);
}

.conclusion--fail .conclusion__kind {
  color: var(--c-warning);
}

.conclusion__cause {
  margin: 0 0 12px;
  font-size: 15px;
}

.conclusion__block {
  margin-bottom: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--c-primary-soft);
}

.conclusion__block--safe {
  background: var(--c-warning-soft);
}

.conclusion__text {
  margin: 0;
  font-size: 14px;
}

.conclusion__sources {
  margin: 0 0 12px;
  color: var(--c-ink-3);
  font-size: 12px;
}

.steps__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.step {
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 8px 0;
  border-bottom: 1px dashed var(--c-line);
  font-size: 14px;
}

.step:last-child {
  border-bottom: 0;
}

.step__order {
  flex: 0 0 20px;
  color: var(--c-ink-3);
  font-variant-numeric: tabular-nums;
}

.step__verdict {
  flex: 0 0 auto;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 12px;
}

.step__verdict--pass {
  background: var(--c-primary-soft);
  color: var(--c-primary-ink);
}

.step__verdict--fail {
  background: var(--c-warning-soft);
  color: var(--c-warning);
}

.step__value {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.step__note {
  color: var(--c-ink-3);
  font-size: 13px;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@media (max-width: 640px) {
  .ask__row {
    flex-direction: column;
    align-items: stretch;
  }

  .ask__row .select {
    flex: none;
  }

  .current__actions {
    flex-wrap: wrap;
  }

  .current__actions .btn--ghost {
    flex: 1 0 100%;
  }
}
</style>
