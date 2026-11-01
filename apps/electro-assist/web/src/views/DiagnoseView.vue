<script setup lang="ts">
/** B 模块：故障排查（页面壳）。
 *
 *  两种模式共用同一份知识库：
 *  - 快速检索：一次给出候选与完整清单，适合打印、对照着看；
 *  - 逐步诊断：把条目当故障树走，一项异常就收敛到结论。
 *
 *  页面只管"问什么、切哪个模式"；结果渲染与诊断推进分别在
 *  QuickResult / StepRun 里，判定与推进仍然全在服务端。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import '../components/diagnose/diagnose.css'
import QuickResult from '../components/diagnose/QuickResult.vue'
import ThemeNoticeBar from '../components/ui/ThemeNoticeBar.vue'
import StepRun from '../components/diagnose/StepRun.vue'
import { useDiagnoseRun } from '../composables/useDiagnoseRun'
import { announce } from '../lib/announce'
import { errorText as describeError } from '../lib/errors'
import { ApiError, getJson, postJson } from '../lib/http'
import { postStream } from '../lib/sse'
import type { DiagnoseResponse, KbOverview } from '../types'

const route = useRoute()
const {
  runData,
  busy: runBusy,
  error: runError,
  start: startDiagnosis,
  submit: submitDiagnosis,
  abort: abortDiagnosis,
  reset: resetDiagnosis,
} = useDiagnoseRun()

const mode = ref<'quick' | 'step'>('quick')
const symptom = ref('')
const system = ref<'' | 'door' | 'hvac' | 'pantograph'>('')
const phase = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const result = ref<DiagnoseResponse | null>(null)
const kb = ref<KbOverview | null>(null)
const errorText = ref('')
const context = ref<{ guide_id?: string; step_seq?: number }>({})

const SYSTEM_LABEL: Record<string, string> = {
  door: '客室侧门',
  hvac: '空调',
  pantograph: '受电弓',
}

/** 流式的三个阶段。`recall` 之后候选已经能上屏，重排在后台跑。 */
const stage = ref<'idle' | 'recall' | 'rerank' | 'done'>('idle')
const candidates = ref<{ id: string; title: string; score: number }[]>([])
let quickCtrl: AbortController | null = null

async function submitQuick(): Promise<void> {
  const text = symptom.value.trim()
  if (text.length < 4) {
    errorText.value = '请多描述一点现象，至少 4 个字'
    phase.value = 'error'
    return
  }
  quickCtrl?.abort()
  quickCtrl = new AbortController()

  phase.value = 'loading'
  errorText.value = ''
  stage.value = 'recall'
  candidates.value = []

  const body = {
    symptom: text,
    system: system.value || null,
    top_k: 3,
    context: context.value.guide_id ? context.value : null,
  }

  let done = false
  let frameError = ''
  try {
    await postStream('/api/electro/diagnose?stream=1', body, {
      signal: quickCtrl.signal,
      onEvent: (event, data) => {
        if (event === 'recall') {
          const payload = data as { candidates?: typeof candidates.value }
          candidates.value = payload.candidates ?? []
          stage.value = 'rerank'
        } else if (event === 'done') {
          result.value = data as DiagnoseResponse
          stage.value = 'done'
          done = true
        } else if (event === 'error') {
          frameError = (data as { message?: string }).message ?? ''
        }
      },
    })
  } catch (err) {
    if (quickCtrl.signal.aborted) return
    // 老内核或中间代理不支持流：落到下面的一次性请求。多花一次检索是毫秒级的，
    // 比"整块结果拿不到"划算得多。
    if (err instanceof ApiError && err.kind === 'timeout') {
      errorText.value = describeError(err, '排查超时，请稍后再试')
      phase.value = 'error'
      return
    }
  }

  if (!done) {
    // 流没给出最终结果（中断、代理吞帧、服务端没有流能力）：走一次性 JSON。
    try {
      result.value = await postJson<DiagnoseResponse>('/api/electro/diagnose', body, {
        signal: quickCtrl.signal,
      })
      stage.value = 'done'
      done = true
    } catch (err) {
      if (quickCtrl.signal.aborted) return
      errorText.value = describeError(err, frameError || '网络异常，排查失败，请稍后再试')
      phase.value = 'error'
      return
    }
  }

  phase.value = 'ready'
  const hit = result.value
  announce(
    hit?.matched
      ? `排查完成，找到 ${hit.count} 条候选，建议先查：${hit.suggestion}`
      : '排查完成，知识库未覆盖这个现象，建议记录后上报',
  )
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
  errorText.value = ''
  const ok = await startDiagnosis(text, system.value, entryId)
  phase.value = ok ? 'ready' : 'error'
}

async function submitCheck(payload: {
  verdict: 'pass' | 'fail'
  value: number | null
  note: string
}): Promise<void> {
  const order = runData.value?.current_check?.order
  if (!order) return
  await submitDiagnosis(order, payload)
}

function resetQuick(): void {
  result.value = null
  phase.value = 'idle'
  errorText.value = ''
}

function resetStep(): void {
  resetDiagnosis()
  phase.value = 'idle'
  errorText.value = ''
}

function switchMode(next: 'quick' | 'step'): void {
  if (mode.value === next) return
  mode.value = next
  result.value = null
  resetDiagnosis()
  phase.value = 'idle'
  errorText.value = ''
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
onBeforeUnmount(() => quickCtrl?.abort())
</script>

<template>
  <ThemeNoticeBar />
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

  <p v-if="errorText || runError" class="error-line">{{ errorText || runError }}</p>

  <template v-if="mode === 'quick'">
    <section v-if="phase === 'error' && !errorText" class="card state">
      <p>排查失败，请稍后再试。</p>
      <button class="btn" type="button" @click="phase = 'idle'">返回修改</button>
    </section>

    <section v-else-if="phase === 'loading'" class="card state" aria-busy="true">
      <p class="stage">
        <span
          class="stage__dot"
          :class="{ 'stage__dot--on': stage === 'recall' }"
          aria-hidden="true"
        />
        {{ stage === 'recall' ? '正在检索知识库…' : '已找到候选，正在按可能性排序…' }}
      </p>
      <ol v-if="candidates.length" class="cands">
        <li v-for="item in candidates" :key="item.id" class="cands__item">
          {{ item.title }}
        </li>
      </ol>
      <p v-if="candidates.length" class="state__hint">
        排序结果出来后会替换成完整清单；候选列表已经可以对照着看了。
      </p>
      <button v-else class="btn" type="button" @click="quickCtrl?.abort(); phase = 'idle'">
        停止等待
      </button>
    </section>

    <QuickResult v-else-if="result" :result="result" @run="startRun" @reset="resetQuick" />
  </template>

  <StepRun
    v-else
    :run-data="runData"
    :busy="runBusy"
    @start="startRun"
    @submit="submitCheck"
    @abort="abortDiagnosis"
    @reset="resetStep"
  />
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

.textarea:focus {
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

@media (max-width: 640px) {
  .ask__row {

      flex-direction: column;

      align-items: stretch;

    }

  .ask__row .select {

      flex: none;

    }
}

/* 流式的阶段提示：不是装饰，它告诉用户"还在算"以及"算到哪一步了"。
   召回阶段随时可能结束（毫秒），所以不做进度条——那是假精确。 */
.stage {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
  color: var(--c-ink-2);
  font-size: 15px;
}

.stage__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--c-primary);
  animation: stage-pulse 1.2s ease-in-out infinite;
}

.stage__dot--on {
  animation-duration: 0.9s;
}

@keyframes stage-pulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .stage__dot {
    animation: none;
    opacity: 1;
  }
}

.cands {
  margin: 8px 0 0;
  padding-left: 20px;
  color: var(--c-ink);
  font-size: 14px;
  line-height: 1.8;
}

.cands__item {
  color: var(--c-ink-2);
}
</style>
