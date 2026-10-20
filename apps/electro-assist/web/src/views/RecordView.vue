<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ApiError, getJson } from '../lib/http'
import type { CriterionResult, RecordItem, SessionReport, Verdict } from '../types'

const props = defineProps<{ sid: string }>()
const router = useRouter()

const report = ref<SessionReport | null>(null)
const phase = ref<'loading' | 'ready' | 'error'>('loading')
const errorText = ref('')

const VERDICT_LABEL: Record<Verdict, string> = {
  pass: '通过',
  warn: '需复测',
  fail: '异常',
  manual: '已记录',
  skipped: '未执行',
}

const statusLabel = computed(() => {
  const status = report.value?.summary.status
  if (status === 'done') return '已完成'
  if (status === 'aborted') return '已中止'
  return '进行中'
})

async function load(): Promise<void> {
  phase.value = 'loading'
  errorText.value = ''
  try {
    report.value = await getJson<SessionReport>(`/api/electro/records/${props.sid}`)
    phase.value = 'ready'
  } catch (err) {
    phase.value = 'error'
    errorText.value =
      err instanceof ApiError && err.kind === 'notfound'
        ? '这份记录不存在或已失效。'
        : '无法载入记录，请稍后重试。'
  }
}

function verdictLabel(verdict?: Verdict): string {
  return verdict ? VERDICT_LABEL[verdict] : '未执行'
}

function formatDuration(seconds: number): string {
  if (!seconds) return '—'
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`
}

function formatTime(value: string | null): string {
  if (!value) return '—'
  // 不用 hour12:false：部分内核（荣耀/旧 WebView 的 ICU）会按 h24 输出
  // "24:42:45"。显式 hourCycle:'h23' 才能稳定得到 00:42:45。
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
}

function resultValue(result: CriterionResult): string {
  if (typeof result.value === 'boolean') return result.value ? '已确认' : '未确认'
  return `${String(result.value)}${result.unit ? ` ${result.unit}` : ''}`
}

function attemptTitle(record: RecordItem): string {
  return `第 ${record.attempt} 次`
}

function printRecord(): void {
  window.print()
}

function backToGuide(): void {
  if (report.value) {
    void router.push({ name: 'guide', params: { id: report.value.guide.id } })
  } else {
    void router.push('/')
  }
}

onMounted(load)
</script>

<template>
  <div class="record-page">
    <div v-if="phase === 'loading'" class="card state" aria-busy="true">正在载入记录…</div>

    <div v-else-if="phase === 'error'" class="card state state--error">
      <p>{{ errorText }}</p>
      <button class="btn" type="button" @click="load">重试</button>
    </div>

    <template v-else-if="report">
      <header class="card record-head">
        <p class="record-kicker">作业记录</p>
        <h1 class="record-title">{{ report.guide.title }}</h1>
        <div class="meta-row">
          <span class="tag" :class="{ 'tag--plain': report.session.status === 'aborted' }">
            {{ statusLabel }}
          </span>
          <span class="mono">{{ report.session.id }}</span>
          <span v-if="report.session.device">设备 {{ report.session.device }}</span>
          <span v-if="report.session.location">位置 {{ report.session.location }}</span>
        </div>
        <p class="record-time">
          {{ formatTime(report.session.created_at) }} 开始 ·
          {{ formatDuration(report.summary.duration_s) }}
        </p>
        <p class="disclaimer">{{ report.guide.disclaimers.join(' · ') }}</p>
        <div class="meta-row no-print">
          <button class="btn btn--primary" type="button" @click="printRecord">
            打印 / 导出 PDF
          </button>
          <button class="btn" type="button" @click="backToGuide">返回指导书</button>
        </div>
      </header>

      <section class="summary-grid" aria-label="记录摘要">
        <div class="summary-item">
          <span class="summary-value">
            {{ report.summary.recorded_steps }} / {{ report.summary.total_steps }}
          </span>
          <span class="summary-label">已执行步骤</span>
        </div>
        <div class="summary-item">
          <span class="summary-value">{{ report.summary.pass }}</span>
          <span class="summary-label">通过</span>
        </div>
        <div class="summary-item">
          <span class="summary-value">{{ report.summary.manual }}</span>
          <span class="summary-label">已记录</span>
        </div>
        <div class="summary-item">
          <span class="summary-value">{{ report.exceptions.length }}</span>
          <span class="summary-label">异常尝试</span>
        </div>
      </section>

      <section class="card record-body">
        <h2 class="section-title">逐步记录</h2>

        <article v-for="step in report.steps" :key="step.step_id" class="record-step">
          <header class="record-step__head">
            <span class="step-seq">{{ String(step.seq).padStart(2, '0') }}</span>
            <h3 class="record-step__title">{{ step.title }}</h3>
            <span class="verdict-chip" :class="`v-${step.final_verdict}`">
              {{ verdictLabel(step.final_verdict) }}
            </span>
          </header>

          <p v-if="!step.attempts.length" class="empty-step">未执行</p>

          <div v-for="attempt in step.attempts" :key="attempt.id" class="attempt">
            <p class="attempt-head">
              <span>{{ attemptTitle(attempt) }}</span>
              <span class="verdict-chip" :class="`v-${attempt.verdict}`">
                {{ verdictLabel(attempt.verdict) }}
              </span>
              <span class="attempt-time">{{ formatTime(attempt.created_at) }}</span>
            </p>

            <ul class="result-list">
              <li v-for="result in attempt.payload.results ?? []" :key="result.criterion_id">
                <span class="result-label">{{ result.label }}</span>
                <span class="result-value">{{ resultValue(result) }}</span>
                <span class="verdict-chip" :class="`v-${result.verdict}`">
                  {{ verdictLabel(result.verdict) }}
                </span>
                <span class="result-message">{{ result.message }}</span>
              </li>
            </ul>

            <p v-if="attempt.payload.note" class="attempt-note">
              备注：{{ attempt.payload.note }}
            </p>
          </div>
        </article>
      </section>

      <section class="card exception-box">
        <h2 class="section-title">异常链</h2>
        <p v-if="!report.exceptions.length" class="no-exception">
          本次作业没有异常记录。
        </p>
        <div v-for="item in report.exceptions" :key="`${item.step_id}-${item.attempt}`" class="exception-item">
          <p class="exception-head">
            第 {{ item.seq }} 步 · 第 {{ item.attempt }} 次 ·
            <span class="verdict-chip" :class="`v-${item.verdict}`">
              {{ verdictLabel(item.verdict) }}
            </span>
          </p>
          <ul>
            <li v-for="message in item.messages" :key="message">{{ message }}</li>
          </ul>
          <p v-if="item.note" class="attempt-note">备注：{{ item.note }}</p>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.record-page {
  padding-bottom: 32px;
}

.record-head {
  padding: 20px;
}

.record-kicker {
  margin: 0;
  color: var(--c-ink-3);
  font-size: 12px;
  letter-spacing: 0.08em;
}

.record-title {
  margin: 6px 0 0;
  font-size: 22px;
}

.record-time {
  margin: 8px 0 0;
  color: var(--c-ink-2);
  font-size: 13px;
}

.mono {
  font-family: var(--font-mono);
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin: 16px 0;
}

.summary-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px;
  border: 1px solid var(--c-line);
  border-radius: 6px;
  background: var(--c-surface);
}

.summary-value {
  font-family: var(--font-mono);
  font-size: 20px;
  font-weight: 700;
  color: var(--c-ink);
}

.summary-label {
  color: var(--c-ink-3);
  font-size: 12px;
}

.record-body {
  padding: 20px;
}

.section-title {
  margin: 0 0 12px;
  font-size: 16px;
}

.record-step {
  padding: 14px 0;
  border-top: 1px solid var(--c-line-soft);
  break-inside: avoid;
  page-break-inside: avoid;
}

.record-step:first-of-type {
  border-top: none;
  padding-top: 0;
}

.record-step__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.step-seq {
  font-family: var(--font-mono);
  color: var(--c-ink-3);
  font-size: 13px;
}

.record-step__title {
  flex: 1;
  margin: 0;
  font-size: 15px;
}

.empty-step {
  margin: 8px 0 0;
  color: var(--c-ink-3);
  font-size: 13px;
}

.attempt {
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid var(--c-line-soft);
  border-radius: 6px;
  background: var(--c-primary-soft);
}

.attempt-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--c-ink-2);
}

.attempt-time {
  margin-left: auto;
  font-family: var(--font-mono);
  color: var(--c-ink-3);
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
  gap: 6px;
  padding: 4px 0;
  font-size: 13px;
  color: var(--c-ink-2);
}

.result-label {
  min-width: 84px;
  color: var(--c-ink);
}

.result-value {
  font-family: var(--font-mono);
}

.result-message {
  color: var(--c-ink-3);
}

.attempt-note {
  margin: 6px 0 0;
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

.exception-box {
  margin-top: 16px;
  padding: 20px;
}

.no-exception {
  margin: 0;
  color: var(--c-ink-3);
  font-size: 13px;
}

.exception-item {
  padding: 10px 0;
  border-top: 1px dashed var(--c-line-soft);
}

.exception-item:first-of-type {
  border-top: none;
}

.exception-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0 0 4px;
  font-size: 13px;
  color: var(--c-ink);
}

.exception-item ul {
  margin: 0;
  padding-left: 18px;
  color: var(--c-ink-2);
  font-size: 13px;
}

@media (max-width: 640px) {
  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media print {
  .record-page {
    padding-bottom: 0;
  }

  .record-step {
    border-top: 1px solid #bbb;
  }

  .attempt {
    background: #fff;
    border-color: #ccc;
  }

  .exception-box {
    break-inside: avoid;
  }
}
</style>
