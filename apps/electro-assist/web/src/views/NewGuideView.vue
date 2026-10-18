<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ApiError, getJson, postJson } from '../lib/http'
import type { GenerateAccepted, JobSnapshot, QuotaSnapshot } from '../types'

const router = useRouter()

const MIN_CHARS = 10
const MAX_CHARS = 20_000
const HARD_TIMEOUT_MS = 120_000

const SAMPLE_TEXT = `工序：客室侧门开关门功能试验（演示文本，参数为示例值）

1. 确认车辆处于静止状态，断开主控，挂检修牌。
2. 检查门控器供电 110V，确认上电自检无故障码。
3. 单门开关门各 3 次，记录开门时间与关门时间，应在 2.0–3.5s。
4. 检查门到位信号 S4/S5，关门后两路信号均应导通。
5. 检查门机紧固件力矩，应为 0.7–0.9 N·m。
安全提示：作业前确认门区无人，禁止把手放在门缝处。`

const text = ref('')
const phase = ref<'idle' | 'submitting' | 'polling' | 'error'>('idle')
const errorText = ref('')
const errorCode = ref('')
const jobId = ref('')
const job = ref<JobSnapshot | null>(null)
const quota = ref<QuotaSnapshot | null>(null)
const elapsed = ref(0)
const lastJobFailed = ref(false)

let pollTimer: number | undefined
let tickTimer: number | undefined
let pollFailures = 0
let pollingStartedAt = 0

const busy = computed(() => phase.value === 'submitting' || phase.value === 'polling')
const canSubmit = computed(() => !busy.value && text.value.trim().length >= MIN_CHARS)
const hourLeft = computed(() =>
  quota.value ? Math.max(0, quota.value.hour.limit - quota.value.hour.used) : null,
)
const dayLeft = computed(() =>
  quota.value ? Math.max(0, quota.value.day.limit - quota.value.day.used) : null,
)

function stopTimers(): void {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer)
  if (tickTimer !== undefined) window.clearInterval(tickTimer)
  pollTimer = undefined
  tickTimer = undefined
}

function fillSample(): void {
  text.value = SAMPLE_TEXT
}

function humanError(code: string | null, fallback: string | null): string {
  switch (code) {
    case 'budget_exhausted':
      return '今日全站生成预算已用尽，请明日再试。'
    case 'auth':
      return '服务端尚未配置模型密钥，请联系维护者（不是你的操作问题）。'
    case 'timeout':
      return '生成超时。可以重试一次，失败不计入次数。'
    case 'validation':
      return '生成结果未通过结构校验。可以直接重试；若反复失败，请把文本拆小一些。'
    case 'truncated':
      return '输出过长被截断，自动重试后仍未通过。请删减步骤或图示数量后重试。'
    case 'rate_limit':
      return '模型服务繁忙，请稍后再试。'
    case 'stale':
      return '服务重启导致任务中断。请重试一次，失败不计入次数。'
    default:
      return fallback || '生成失败，请稍后再试。'
  }
}

function handleError(err: unknown): void {
  if (err instanceof ApiError) {
    errorCode.value = err.code ?? ''
    if (err.kind === 'ratelimit') {
      errorText.value = err.message || '额度已用完，请稍后再试。'
    } else if (err.kind === 'timeout') {
      errorText.value = '请求超时，请检查网络后重试。'
    } else if (err.kind === 'network') {
      errorText.value = '网络不可用，请检查连接后重试。'
    } else {
      errorText.value = humanError(err.code ?? null, err.message)
    }
  } else {
    errorText.value = '未知错误，请稍后再试。'
  }
  phase.value = 'error'
  lastJobFailed.value = false
  void loadQuota()
}

async function loadQuota(): Promise<void> {
  try {
    quota.value = await getJson<QuotaSnapshot>('/api/electro/quota')
  } catch {
    /* 配额展示失败不阻塞生成：真正的约束在服务端 */
  }
}

async function poll(): Promise<void> {
  if (!jobId.value) return
  if (Date.now() - pollingStartedAt > HARD_TIMEOUT_MS) {
    stopTimers()
    errorText.value = '等待超过 2 分钟仍未完成。请稍后在“我的任务”里重试，或重新提交。'
    errorCode.value = 'client_timeout'
    phase.value = 'error'
    return
  }

  try {
    const snap = await getJson<JobSnapshot>(`/api/electro/jobs/${jobId.value}`)
    job.value = snap
    pollFailures = 0

    if (snap.status === 'succeeded' && snap.guide_id) {
      stopTimers()
      await router.push({ name: 'guide', params: { id: snap.guide_id }, query: { draft: '1' } })
      return
    }
    if (snap.status === 'failed' || snap.status === 'timeout') {
      stopTimers()
      lastJobFailed.value = true
      errorCode.value = snap.error_code ?? ''
      errorText.value = humanError(snap.error_code, snap.error_message)
      phase.value = 'error'
      void loadQuota()
      return
    }
    pollTimer = window.setTimeout(poll, Math.max(800, snap.poll_after_ms || 1000))
  } catch {
    // 单次网络抖动不判死：轮询连续失败 5 次才放弃
    pollFailures += 1
    if (pollFailures >= 5) {
      stopTimers()
      errorText.value = '与服务器的连接中断，无法确认任务状态。请稍后重试。'
      phase.value = 'error'
      return
    }
    pollTimer = window.setTimeout(poll, 2000)
  }
}

async function submit(retryOf?: string): Promise<void> {
  if (busy.value) return
  const trimmed = text.value.trim()
  if (trimmed.length < MIN_CHARS) {
    errorText.value = `工艺文本至少需要 ${MIN_CHARS} 个字符。`
    phase.value = 'error'
    return
  }

  phase.value = 'submitting'
  errorText.value = ''
  errorCode.value = ''
  lastJobFailed.value = false
  job.value = null

  try {
    const res = await postJson<GenerateAccepted>('/api/electro/generate', {
      text: trimmed,
      retry_of: retryOf ?? null,
    })
    jobId.value = res.job_id
    phase.value = 'polling'
    elapsed.value = 0
    pollFailures = 0
    pollingStartedAt = Date.now()
    stopTimers()
    tickTimer = window.setInterval(() => {
      elapsed.value += 1
    }, 1000)
    pollTimer = window.setTimeout(poll, Math.max(300, res.poll_after_ms || 1000))
    void loadQuota()
  } catch (err) {
    handleError(err)
  }
}

function retry(): void {
  if (lastJobFailed.value && jobId.value) {
    void submit(jobId.value)
  } else {
    void submit()
  }
}

onMounted(loadQuota)
onBeforeUnmount(stopTimers)
</script>

<template>
  <div class="page-head">
    <h1 class="page-title">生成作业指导书</h1>
    <p class="page-sub">
      粘贴一段工艺文本，系统会生成结构化步骤、验收判据与图示。结果默认是
      <strong>草稿</strong>，不会进入公开列表。
    </p>
  </div>

  <div class="card">
    <label class="field-label" for="process-text">工艺文本</label>
    <textarea
      id="process-text"
      v-model="text"
      class="textarea"
      :maxlength="MAX_CHARS"
      :disabled="busy"
      placeholder="例如：工序名称、步骤、判据范围、工具与安全提示。事实没写就留空，系统不会替你编。"
    />

    <div class="row">
      <span class="hint">{{ text.trim().length }} / {{ MAX_CHARS }} 字符</span>
      <button class="btn" type="button" :disabled="busy" @click="fillSample">填入示例</button>
    </div>

    <div v-if="quota" class="quota">
      <span>本小时剩余 {{ hourLeft }} / {{ quota.hour.limit }}</span>
      <span>今日剩余 {{ dayLeft }} / {{ quota.day.limit }}</span>
      <span>全站预算 ¥{{ quota.site_budget.used_cny }} / ¥{{ quota.site_budget.limit_cny }}</span>
    </div>

    <button class="btn btn--primary submit" type="button" :disabled="!canSubmit" @click="submit()">
      {{ busy ? (phase === 'submitting' ? '提交中…' : `生成中… ${elapsed}s`) : '生成指导书' }}
    </button>
    <p class="hint">
      通常 8–15 秒。每 IP 每小时 2 次、每日 10 次；失败与超时不计入次数。
    </p>
  </div>

  <div v-if="phase === 'polling'" class="card state" aria-live="polite">
    <p>正在生成… 已等待 {{ elapsed }} 秒</p>
    <p class="state__hint">任务 {{ jobId }}</p>
  </div>

  <div v-if="phase === 'error'" class="card state state--error">
    <p>{{ errorText }}</p>
    <p v-if="errorCode" class="state__hint">错误码：{{ errorCode }}</p>
    <button class="btn" type="button" @click="retry">
      {{ lastJobFailed ? '免费重试一次' : '重试' }}
    </button>
  </div>
</template>

<style scoped>
.field-label {
  display: block;
  margin-bottom: 8px;
  font-weight: 600;
  color: var(--c-ink);
}

.textarea {
  width: 100%;
  min-height: 220px;
  padding: 12px 14px;
  border: 1px solid var(--c-line);
  border-radius: 6px;
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
  line-height: 1.7;
  resize: vertical;
}

.textarea:focus {
  outline: 2px solid var(--c-primary);
  outline-offset: 1px;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
}

.quota {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin: 14px 0 4px;
  padding: 10px 12px;
  border: 1px solid var(--c-line-soft);
  border-radius: 6px;
  background: var(--c-primary-soft);
  color: var(--c-ink-2);
  font-size: 13px;
}

.submit {
  width: 100%;
  min-height: 48px;
  margin-top: 14px;
  font-size: 16px;
}

.hint {
  margin: 8px 0 0;
  color: var(--c-ink-3);
  font-size: 13px;
}
</style>
