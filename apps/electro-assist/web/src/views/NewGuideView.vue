<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ApiError, getJson, postForm, postJson } from '../lib/http'
import type { GenerateAccepted, JobSnapshot, QuotaSnapshot, UploadedAsset } from '../types'

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

// 口令令牌只放 sessionStorage：关掉标签页即失效，不写 localStorage。
const PASSCODE_KEY = 'electro_passcode'
const passcodeOpen = ref(false)
const passcodeInput = ref('')
const passcodeBusy = ref(false)
const passcodeMsg = ref('')
const passcodeToken = ref('')

let pollTimer: number | undefined
let tickTimer: number | undefined
let pollFailures = 0
let pollingStartedAt = 0

/* ---------- 现场素材 ----------
 * 图片只做"排版与标注"，不做识别：模型看不到图，也就不会替你判断图里是什么。
 * 上传后进草稿的「素材区」，生成完再决定挂到哪一步。 */
const MAX_ASSETS = 4
const MAX_ASSET_BYTES = 5 * 1024 * 1024
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp']

interface StagedAsset {
  asset_id: string
  caption: string
  url: string
}

const staged = ref<StagedAsset[]>([])
const uploading = ref(false)
const assetError = ref('')

const busy = computed(
  () => phase.value === 'submitting' || phase.value === 'polling' || uploading.value,
)
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

function uploadErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return '上传失败，请检查网络后重试。'
  switch (err.code) {
    case 'too_large':
      return '单张不能超过 5 MB。'
    case 'too_small':
      return '图片分辨率太低，请换一张更清晰的截图。'
    case 'bad_format':
      return '只支持 PNG / JPEG / WebP。'
    case 'unreadable':
      return '这张图可能已损坏或被截断，无法解析。'
    case 'rate_limited':
      return err.message || '上传过于频繁，请稍后再试。'
    default:
      return err.message || '上传失败，请稍后再试。'
  }
}

async function onPickFiles(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  // 立刻清空：不清的话，同一张图删掉后再选一次不会触发 change
  input.value = ''
  if (!files.length) return

  assetError.value = ''
  const room = MAX_ASSETS - staged.value.length
  if (room <= 0) {
    assetError.value = `最多 ${MAX_ASSETS} 张素材。`
    return
  }
  const picked = files.slice(0, room)
  if (files.length > room) {
    assetError.value = `最多 ${MAX_ASSETS} 张素材，已忽略多余的 ${files.length - room} 张。`
  }

  uploading.value = true
  try {
    for (const file of picked) {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        assetError.value = '只支持 PNG / JPEG / WebP。'
        continue
      }
      if (file.size > MAX_ASSET_BYTES) {
        assetError.value = '单张不能超过 5 MB。'
        continue
      }
      const form = new FormData()
      form.append('file', file)
      try {
        const res = await postForm<UploadedAsset>('/api/electro/uploads', form)
        staged.value.push({
          asset_id: res.asset_id,
          caption: '',
          url: `/api/electro/uploads/${res.asset_id}/${res.asset_id}.png`,
        })
      } catch (err) {
        assetError.value = uploadErrorText(err)
      }
    }
  } finally {
    uploading.value = false
  }
}

function removeAsset(index: number): void {
  staged.value.splice(index, 1)
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
  if (err instanceof ApiError && err.code === 'passcode_invalid') {
    clearPasscode('口令已失效，请重新验证后再生成。')
    errorText.value = '口令已失效，请重新验证后再生成。'
    phase.value = 'error'
    lastJobFailed.value = false
    void loadQuota()
    return
  }
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
    console.error('generate request failed', err)
    errorText.value = '页面初始化失败：请升级浏览器，或改用 Chrome / Safari 打开。'
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

function clearPasscode(message = ''): void {
  passcodeToken.value = ''
  dropStoredToken()
  if (message) passcodeMsg.value = message
}

// 隐私模式/旧内核里 sessionStorage 可能直接抛异常：令牌退化为"仅本页有效"，
// 不影响生成，只是刷新后要重新输入。
function readStoredToken(): string {
  try {
    return sessionStorage.getItem(PASSCODE_KEY) || ''
  } catch {
    return ''
  }
}

function storeToken(token: string): void {
  try {
    sessionStorage.setItem(PASSCODE_KEY, token)
  } catch {
    /* 忽略：内存里仍有 token */
  }
}

function dropStoredToken(): void {
  try {
    sessionStorage.removeItem(PASSCODE_KEY)
  } catch {
    /* 忽略 */
  }
}

async function verifyPasscode(): Promise<void> {
  const code = passcodeInput.value.trim()
  if (!code || passcodeBusy.value) return
  passcodeBusy.value = true
  passcodeMsg.value = ''
  try {
    const res = await postJson<{ token: string; expires_in: number }>(
      '/api/electro/passcode/verify',
      { code },
    )
    passcodeToken.value = res.token
    storeToken(res.token)
    passcodeInput.value = ''
    passcodeOpen.value = false
    passcodeMsg.value = `口令已生效：${Math.round(res.expires_in / 3600)} 小时内不受每 IP 次数限制（全站预算仍生效）`
  } catch (err) {
    if (err instanceof ApiError && err.kind === 'ratelimit') {
      passcodeMsg.value = err.message || '验证过于频繁，请稍后再试。'
    } else if (err instanceof ApiError && err.code === 'passcode_disabled') {
      passcodeMsg.value = '本站未启用口令通道。'
    } else if (err instanceof ApiError && err.message) {
      passcodeMsg.value = err.message
    } else {
      passcodeMsg.value = '验证失败，请稍后再试。'
    }
  } finally {
    passcodeBusy.value = false
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
    const res = await postJson<GenerateAccepted>(
      '/api/electro/generate',
      {
        text: trimmed,
        retry_of: retryOf ?? null,
        assets: staged.value.map((item, index) => ({
          asset_id: item.asset_id,
          caption: item.caption.trim() || `图 ${index + 1}`,
        })),
      },
      {
        headers: passcodeToken.value
          ? { 'X-Passcode-Token': passcodeToken.value }
          : undefined,
      },
    )
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

onMounted(() => {
  passcodeToken.value = readStoredToken()
  void loadQuota()
})
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

    <section class="assets">
      <div class="assets__head">
        <span class="field-label field-label--inline">
          现场素材
          <span class="field-label__opt">（可选，最多 {{ MAX_ASSETS }} 张）</span>
        </span>
        <label class="btn btn--ghost" :aria-disabled="busy || staged.length >= MAX_ASSETS">
          {{ uploading ? '上传中…' : '添加图片' }}
          <input
            class="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            :disabled="busy || staged.length >= MAX_ASSETS"
            @change="onPickFiles"
          />
        </label>
      </div>
      <p class="hint">
        图片只做排版，不做识别：系统不会替你判断图里是什么，挂到哪一步由你在草稿页决定。
        请勿上传含企业名称、工号、图纸编号等敏感信息的截图。
      </p>
      <p v-if="assetError" class="asset-error" role="alert">{{ assetError }}</p>

      <ul v-if="staged.length" class="asset-list">
        <li v-for="(item, index) in staged" :key="item.asset_id" class="asset-item">
          <img
            class="asset-item__img"
            :src="item.url"
            :alt="`素材 ${index + 1} 预览`"
            loading="lazy"
            decoding="async"
          />
          <div class="asset-item__body">
            <label class="sr-only" :for="`cap-${item.asset_id}`">素材 {{ index + 1 }} 说明</label>
            <input
              :id="`cap-${item.asset_id}`"
              v-model="item.caption"
              class="asset-item__input"
              type="text"
              maxlength="60"
              :disabled="busy"
              placeholder="说明：这张图拍的是什么（如 门锁间隙测量位置）"
            />
            <button class="linkbtn" type="button" :disabled="busy" @click="removeAsset(index)">
              移除
            </button>
          </div>
        </li>
      </ul>
    </section>

    <div v-if="quota" class="quota">
      <span>本小时剩余 {{ hourLeft }} / {{ quota.hour.limit }}</span>
      <span>今日剩余 {{ dayLeft }} / {{ quota.day.limit }}</span>
      <span>全站预算 ¥{{ quota.site_budget.used_cny }} / ¥{{ quota.site_budget.limit_cny }}</span>
    </div>

    <div class="passcode">
      <template v-if="!passcodeToken">
        <button
          class="linkbtn"
          type="button"
          :aria-expanded="passcodeOpen"
          @click="passcodeOpen = !passcodeOpen"
        >
          {{ passcodeOpen ? '收起口令输入' : '有访问口令？' }}
        </button>
        <div v-if="passcodeOpen" class="passcode__row">
          <input
            v-model="passcodeInput"
            class="passcode__input"
            type="password"
            autocomplete="off"
            placeholder="输入访问口令"
            :disabled="passcodeBusy"
            @keyup.enter="verifyPasscode"
          />
          <button
            class="btn"
            type="button"
            :disabled="passcodeBusy || !passcodeInput.trim()"
            @click="verifyPasscode"
          >
            {{ passcodeBusy ? '验证中…' : '验证' }}
          </button>
        </div>
      </template>
      <template v-else>
        <span class="passcode__ok">口令已生效</span>
        <span class="passcode__hint">本机不受每 IP 次数限制，全站预算仍生效</span>
      </template>
      <p v-if="passcodeMsg" class="hint">{{ passcodeMsg }}</p>
    </div>

    <button class="btn btn--primary submit" type="button" :disabled="!canSubmit" @click="submit()">
      {{ busy ? (phase === 'submitting' ? '提交中…' : `生成中… ${elapsed}s`) : '生成指导书' }}
    </button>
    <p class="hint">
      通常 8–15 秒。每 IP 每小时 2 次、每日 10 次；失败与超时不计入次数。有口令可豁免每 IP 限制。
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

/* ---------- 现场素材 ---------- */

.assets {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px dashed var(--c-line);
}

.assets__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.field-label--inline {
  margin-bottom: 0;
}

.field-label__opt {
  color: var(--c-ink-3);
  font-weight: 400;
}

.asset-error {
  margin: 8px 0 0;
  color: var(--c-danger);
  font-size: 13px;
}

.asset-list {
  display: grid;
  gap: 10px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}

.asset-item {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: 12px;
  align-items: center;
  padding: 8px;
  border: 1px solid var(--c-line);
  border-radius: 6px;
  background: var(--c-surface);
}

.asset-item__img {
  width: 72px;
  height: 72px;
  border-radius: 4px;
  background: var(--c-line-soft);
  object-fit: cover;
}

.asset-item__body {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.asset-item__input {
  flex: 1;
  min-width: 0;
  min-height: 44px;
  padding: 0 10px;
  border: 1px solid var(--c-line);
  border-radius: 6px;
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
  font-size: 14px;
}

.asset-item__input:focus {
  outline: 2px solid var(--c-primary);
  outline-offset: 1px;
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

.passcode {
  margin-top: 12px;
}

.linkbtn {
  padding: 0;
  border: 0;
  background: none;
  color: var(--c-primary);
  font: inherit;
  font-size: 13px;
  text-decoration: underline;
  cursor: pointer;
}

.passcode__row {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.passcode__input {
  flex: 1;
  min-height: 44px;
  padding: 0 12px;
  border: 1px solid var(--c-line);
  border-radius: 6px;
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
}

.passcode__input:focus {
  outline: 2px solid var(--c-primary);
  outline-offset: 1px;
}

.passcode__ok {
  color: var(--c-primary-ink);
  font-size: 13px;
  font-weight: 600;
}

.passcode__hint {
  margin-left: 8px;
  color: var(--c-ink-3);
  font-size: 13px;
}
</style>
