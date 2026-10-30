<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { ApiError, getJson, postForm, postJson } from '../lib/http'
import type {
  ExtractResult,
  GenerateAccepted,
  JobSnapshot,
  ProcessPrecheck,
  QuotaSnapshot,
  UploadedAsset,
} from '../types'

const router = useRouter()

const MIN_CHARS = 10
const MAX_CHARS = 20_000
/** 服务端总预算 90s（单次 40s、最多 2 次）。客户端只负责"不再等了"：
 *  多给 5s 容差，否则第 90 秒服务端刚写库、前端先掐断，配额白扣一次。 */
const SERVER_BUDGET_MS = 90_000
const CLIENT_GRACE_MS = 5_000
const HARD_TIMEOUT_MS = SERVER_BUDGET_MS + CLIENT_GRACE_MS

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

/* 取消：计划 §12.4 的口径是"前端停止轮询并忽略结果，服务端任务继续到完成/超时"。
   不去打断 LLM（也打断不了），但用户必须能拿回控制权——否则一次 20 秒的等待
   会把人锁在页面上，连改一个错字都要等它跑完。
   代价要如实说：任务仍在后台跑，结果会落进草稿箱。 */
const cancelledJobId = ref('')
const resumed = ref(false)

/* 刷新续接：job_id 与 startedAt 存 sessionStorage（关标签页即失效）。
   startedAt 是 90s 预算的唯一基准，**不能因为刷新而重置**——
   否则每刷一次就能重新等 90 秒，把"超时"变成"无限等"。 */
const JOB_KEY = 'electro:job'

interface StoredJob {
  jobId: string
  startedAt: number
}

function readStoredJob(): StoredJob | null {
  try {
    const raw = sessionStorage.getItem(JOB_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredJob>
    if (typeof parsed.jobId !== 'string' || typeof parsed.startedAt !== 'number') return null
    if (!/^j_[0-9a-f]{16}$/.test(parsed.jobId)) return null
    return { jobId: parsed.jobId, startedAt: parsed.startedAt }
  } catch {
    return null
  }
}

function writeStoredJob(id: string, startedAt: number): void {
  try {
    sessionStorage.setItem(JOB_KEY, JSON.stringify({ jobId: id, startedAt }))
  } catch {
    // 隐私模式写不进：只影响"刷新续接"，不影响本次生成
  }
}

function clearStoredJob(): void {
  try {
    sessionStorage.removeItem(JOB_KEY)
  } catch {
    /* 同上 */
  }
}

/* 429 倒计时：服务端给 Retry-After，这里只做展示与禁点。
   不自动重试——额度是钱，什么时候再花必须由人决定。 */
const cooldownUntil = ref(0)
const clock = ref(Date.now())
const cooldownLeft = computed(() =>
  Math.max(0, Math.ceil((cooldownUntil.value - clock.value) / 1000)),
)
let cooldownTimer: number | undefined

function startCooldown(seconds: number | undefined): void {
  if (!seconds || seconds <= 0) return
  cooldownUntil.value = Date.now() + seconds * 1000
  clock.value = Date.now()
  if (cooldownTimer !== undefined) window.clearInterval(cooldownTimer)
  cooldownTimer = window.setInterval(() => {
    clock.value = Date.now()
    if (cooldownLeft.value === 0 && cooldownTimer !== undefined) {
      window.clearInterval(cooldownTimer)
      cooldownTimer = undefined
    }
  }, 1000)
}

function cancelWait(): void {
  if (phase.value !== 'polling') return
  stopTimers()
  clearStoredJob()
  resumed.value = false
  cancelledJobId.value = jobId.value
  job.value = null
  elapsed.value = 0
  phase.value = 'idle'
}

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
const canSubmit = computed(
  () => !busy.value && text.value.trim().length >= MIN_CHARS && cooldownLeft.value === 0,
)
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

/* ---------- 结构化预检 ----------
 * 提交前先看一眼"系统认出了什么、缺什么"。它不调模型、不扣次数，
 * 所以可以随便点——这也是它存在的理由：让人觉得"先检查一下"是零成本的。 */
const precheck = ref<ProcessPrecheck | null>(null)
const precheckBusy = ref(false)
const precheckError = ref('')

async function runPrecheck(): Promise<void> {
  if (precheckBusy.value || !text.value.trim()) return
  precheckBusy.value = true
  precheckError.value = ''
  try {
    precheck.value = await postJson<ProcessPrecheck>('/api/electro/processes', {
      text: text.value,
    })
  } catch (err) {
    precheck.value = null
    precheckError.value =
      err instanceof ApiError && err.code === 'input_too_short'
        ? '文本太短，先写至少 10 个字。'
        : '预检失败，不影响直接生成。'
  } finally {
    precheckBusy.value = false
  }
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

/* ---------- 切图选择 ----------
 * 整页截图直接入稿，字只有几像素；切块是"同一张图的局部放大"。
 * 采纳 = 把切块复制成一个独立素材（后端做），这里只负责让人挑哪一块。
 * 注意：不做自动选择——切图算法不知道哪块是"判据表"，猜错等于给了错的依据。 */
interface SliceRegion {
  id: string
  reason: 'full' | 'table_band' | 'table' | 'dense_text'
  bbox: number[]
  scale: number
  width: number
  height: number
  path: string
  bytes: number
}

const REGION_LABEL: Record<SliceRegion['reason'], string> = {
  full: '整图',
  table_band: '表格行带',
  table: '表格区',
  dense_text: '密集文字',
}

const sliceFor = ref<StagedAsset | null>(null)
const sliceRegions = ref<SliceRegion[]>([])
const sliceNote = ref('')
const sliceBusy = ref(false)
const sliceAdopting = ref('')
const sliceError = ref('')
const sliceCloseBtn = ref<HTMLButtonElement | null>(null)

async function openSlice(item: StagedAsset): Promise<void> {
  if (sliceBusy.value) return
  sliceFor.value = item
  sliceRegions.value = []
  sliceNote.value = ''
  sliceError.value = ''
  sliceBusy.value = true
  try {
    const res = await postJson<{ regions: SliceRegion[]; note: string }>(
      `/api/electro/uploads/${item.asset_id}/slice`,
      {},
    )
    sliceRegions.value = res.regions
    sliceNote.value = res.note
  } catch (err) {
    if (err instanceof ApiError && err.code === 'slice_limit') {
      sliceError.value = '这张图已经切过多次，达到上限；请重新上传。'
    } else if (err instanceof ApiError && err.kind === 'ratelimit') {
      sliceError.value = err.message || '切图过于频繁，请稍后再试。'
    } else {
      sliceError.value = err instanceof ApiError ? err.message : '切图失败，请稍后再试。'
    }
  } finally {
    sliceBusy.value = false
    await nextTick()
    sliceCloseBtn.value?.focus()
  }
}

function closeSlice(): void {
  sliceFor.value = null
  sliceRegions.value = []
  sliceError.value = ''
}

async function adoptRegion(region: SliceRegion): Promise<void> {
  const source = sliceFor.value
  if (!source || sliceAdopting.value) return
  sliceAdopting.value = region.id
  sliceError.value = ''
  try {
    const res = await postJson<UploadedAsset>(
      `/api/electro/uploads/${source.asset_id}/slice/${region.id}/adopt`,
      {},
    )
    const adopted: StagedAsset = {
      asset_id: res.asset_id,
      caption: source.caption,
      url: `/api/electro/uploads/${res.asset_id}/${res.asset_id}.png`,
    }
    if (staged.value.length < MAX_ASSETS) {
      staged.value.push(adopted)
    } else {
      // 位置满了就替换原图：用户点"选区域"的意图本来就是"用这一块代替整页"。
      const index = staged.value.findIndex((item) => item.asset_id === source.asset_id)
      if (index >= 0) staged.value.splice(index, 1, adopted)
    }
    closeSlice()
  } catch (err) {
    if (err instanceof ApiError && err.code === 'adopt_limit') {
      sliceError.value = '这张图采纳次数已达上限，请重新上传。'
    } else {
      sliceError.value = err instanceof ApiError ? err.message : '采纳失败，请稍后再试。'
    }
  } finally {
    sliceAdopting.value = ''
  }
}

/* ---------- 图片识别 ----------
 * 识别结果只回填到文本框，不直接生成：模型读图会漏行、会改写，
 * 人必须对着原图确认一遍。这也是它不自动发布的原因。 */
const extractBusy = ref(false)
const extractResult = ref<ExtractResult | null>(null)
const extractError = ref('')

async function runExtract(): Promise<void> {
  if (extractBusy.value || !staged.value.length) return
  extractBusy.value = true
  extractError.value = ''
  try {
    extractResult.value = await postJson<ExtractResult>('/api/electro/extract', {
      asset_ids: staged.value.slice(0, 3).map((item) => item.asset_id),
    })
  } catch (err) {
    extractResult.value = null
    if (err instanceof ApiError && err.code === 'vision_not_configured') {
      extractError.value = '服务端未配置视觉模型，图片识别不可用；可以手工录入文本。'
    } else if (err instanceof ApiError && err.kind === 'ratelimit') {
      extractError.value = err.message || '识别过于频繁，请稍后再试。'
    } else if (err instanceof ApiError && err.code === 'extract_invalid') {
      extractError.value = '这张图没读出可用的结构，换一张更清晰的截图试试。'
    } else {
      extractError.value = err instanceof ApiError ? err.message : '识别失败，请稍后再试。'
    }
  } finally {
    extractBusy.value = false
  }
}

function composeExtraction(result: ExtractResult): string {
  const { fields } = result
  const lines: string[] = []
  if (fields.name) lines.push(`工序：${fields.name}`)
  if (fields.station) lines.push(`工位：${fields.station}`)
  if (fields.tools.length) lines.push(`工具：${fields.tools.join('、')}`)
  fields.steps.forEach((step, index) => {
    const criterion = step.criterion ? `（判据 ${step.criterion}）` : ''
    lines.push(`${index + 1}. ${step.action}${criterion}`)
  })
  if (fields.safety.length) lines.push(`安全提示：${fields.safety.join('；')}`)
  return lines.join('\n')
}

function applyExtraction(): void {
  if (!extractResult.value) return
  const block = composeExtraction(extractResult.value)
  if (!block) {
    extractError.value = '没识别到可回填的内容。'
    return
  }
  text.value = text.value.trim() ? `${text.value.trim()}\n\n${block}` : block
  extractResult.value = null
}

function clearExtraction(): void {
  extractResult.value = null
  extractError.value = ''
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
      startCooldown(err.retryAfter)
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
    clearStoredJob()
    resumed.value = false
    errorText.value =
      '等待超过 90 秒仍未完成（服务端总预算也是 90 秒）。任务可能仍在后台跑，稍后重试不扣配额。'
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
      clearStoredJob()
      resumed.value = false
      await router.push({ name: 'guide', params: { id: snap.guide_id }, query: { draft: '1' } })
      return
    }
    if (snap.status === 'failed' || snap.status === 'timeout') {
      stopTimers()
      clearStoredJob()
      resumed.value = false
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
  cancelledJobId.value = ''

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
    writeStoredJob(res.job_id, pollingStartedAt)
    resumed.value = false
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

  const stored = readStoredJob()
  if (!stored) return
  const age = Date.now() - stored.startedAt
  if (age >= HARD_TIMEOUT_MS) {
    // 超过预算的任务不该继续等：清掉，让人重新提交
    clearStoredJob()
    return
  }
  jobId.value = stored.jobId
  pollingStartedAt = stored.startedAt
  elapsed.value = Math.floor(age / 1000)
  resumed.value = true
  phase.value = 'polling'
  tickTimer = window.setInterval(() => {
    elapsed.value += 1
  }, 1000)
  pollTimer = window.setTimeout(poll, 300)
})

onBeforeUnmount(() => {
  stopTimers()
  if (cooldownTimer !== undefined) window.clearInterval(cooldownTimer)
})
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

    <p class="hint hint--privacy">
      请勿输入真实企业敏感信息（客户名、工号、未公开参数、图纸编号）。
      演示站：正文只用于本次生成，草稿 30 天后自动清理，
      <RouterLink to="/privacy">数据怎么处理</RouterLink>。
    </p>

    <div class="row">
      <span class="hint">{{ text.trim().length }} / {{ MAX_CHARS }} 字符</span>
      <button class="btn" type="button" :disabled="busy" @click="fillSample">填入示例</button>
      <button
        class="btn btn--ghost"
        type="button"
        :disabled="busy || precheckBusy || !text.trim()"
        @click="runPrecheck"
      >
        {{ precheckBusy ? '预检中…' : '结构化预检' }}
      </button>
    </div>

    <p v-if="precheckError" class="asset-error" role="alert">{{ precheckError }}</p>

    <section v-if="precheck" class="precheck" aria-live="polite">
      <div class="precheck__head">
        <strong>结构化预检</strong>
        <span class="hint">不消耗次数、不调用模型</span>
        <button class="linkbtn" type="button" @click="precheck = null">收起</button>
      </div>
      <p v-if="precheck.missing.length" class="precheck__missing">
        缺：{{ precheck.missing.join('、') }}——生成时会留空，不会替你编。
      </p>
      <p v-else class="hint">字段齐全，可以直接生成。</p>
      <p class="hint">
        识别到 {{ precheck.stats.steps }} 步，其中
        {{ precheck.stats.steps_with_criterion }} 步带可核对判据。
      </p>
      <ol v-if="precheck.process.steps.length" class="precheck__steps">
        <li v-for="step in precheck.process.steps" :key="step.seq">
          <span>{{ step.action }}</span>
          <span v-if="step.criterion_hint" class="precheck__criterion">
            判据 {{ step.criterion_hint }}
          </span>
        </li>
      </ol>
      <p v-for="(warning, index) in precheck.warnings" :key="index" class="hint">
        · {{ warning }}
      </p>
    </section>

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
        <button
          class="btn btn--ghost"
          type="button"
          :disabled="busy || extractBusy || !staged.length"
          @click="runExtract"
        >
          {{ extractBusy ? '识别中…' : '识别图中内容' }}
        </button>
      </div>
      <p class="hint">
        图片可用于排版（挂到哪一步由你在草稿页决定），也可以点「识别图中内容」转成文本草稿；
        识别会把图片发送到模型服务，结果必须对着原图核对。请勿上传含企业名称、工号、图纸编号等敏感信息的截图。
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
            <button class="linkbtn" type="button" :disabled="busy" @click="openSlice(item)">
              选择区域
            </button>
          </div>
        </li>
      </ul>

      <section v-if="extractResult || extractError" class="extract" aria-live="polite">
        <div class="extract__head">
          <strong>识别结果</strong>
          <span class="hint">只做录入，不自动生成</span>
          <button class="linkbtn" type="button" @click="clearExtraction">关闭</button>
        </div>

        <p v-if="extractError" class="asset-error" role="alert">{{ extractError }}</p>

        <template v-if="extractResult">
          <p class="extract__note">{{ extractResult.disclaimer }}</p>
          <p class="hint">
            转录 {{ extractResult.stats.lines }} 行，识别 {{ extractResult.stats.steps }} 步，其中
            {{ extractResult.stats.verified_steps }} 步逐字匹配原文。
          </p>
          <p
            v-for="(item, index) in extractResult.unverified.slice(0, 6)"
            :key="`u-${index}`"
            class="asset-error"
          >
            · {{ item }}
          </p>
          <p v-if="extractResult.unverified.length > 6" class="hint">
            另有 {{ extractResult.unverified.length - 6 }} 处待核对。
          </p>
          <p v-for="(item, index) in extractResult.warnings" :key="`w-${index}`" class="hint">
            · {{ item }}
          </p>

          <details class="extract__lines">
            <summary>查看转录原文（{{ extractResult.lines.length }} 行）</summary>
            <pre class="extract__pre">{{ extractResult.lines.join('\n') }}</pre>
          </details>

          <div class="row">
            <button class="btn btn--primary" type="button" @click="applyExtraction">
              填入工艺文本
            </button>
            <button class="btn" type="button" @click="extractResult = null">放弃</button>
          </div>
        </template>
      </section>
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
      {{
        cooldownLeft > 0
          ? `额度恢复后可生成 · ${cooldownLeft}s`
          : busy
            ? phase === 'submitting'
              ? '提交中…'
              : `生成中… ${elapsed}s`
            : '生成指导书'
      }}
    </button>
    <p class="hint">
      通常 8–15 秒。每 IP 每小时 2 次、每日 10 次；失败与超时不计入次数。有口令可豁免每 IP 限制。
    </p>
  </div>

  <div v-if="phase === 'polling'" class="card state" aria-live="polite">
    <p>正在生成… 已等待 {{ elapsed }} 秒</p>
    <p v-if="resumed" class="state__hint">
      已续接刷新前的任务：90 秒预算不因刷新重置，超时后会提示重试。
    </p>
    <p class="state__hint">任务 {{ jobId }}</p>
    <button class="btn" type="button" @click="cancelWait">停止等待</button>
  </div>

  <div v-if="cooldownLeft > 0" class="card state" role="status" aria-live="polite">
    <p>额度已用完，{{ cooldownLeft }} 秒后可以再生成。</p>
    <p class="state__hint">
      倒计时结束按钮自动解禁；不自动重试——额度是钱，什么时候再花由你决定。有口令可豁免每 IP 限制。
    </p>
  </div>

  <div v-if="cancelledJobId" class="card state" aria-live="polite">
    <p>已停止等待，可以继续修改文本或单独提交。</p>
    <p class="state__hint">
      任务 {{ cancelledJobId }} 仍在后台运行；跑完只会生成一份草稿，不会进入公开列表。
    </p>
  </div>

  <div v-if="phase === 'error'" class="card state state--error">
    <p>{{ errorText }}</p>
    <p v-if="errorCode" class="state__hint">错误码：{{ errorCode }}</p>
    <button class="btn" type="button" @click="retry">
      {{ lastJobFailed ? '免费重试一次' : '重试' }}
    </button>
  </div>

  <div
    v-if="sliceFor"
    class="sheet"
    role="dialog"
    aria-modal="true"
    aria-labelledby="slice-title"
    tabindex="-1"
    @click.self="closeSlice"
    @keydown.esc="closeSlice"
  >
    <div class="sheet__panel">
      <header class="sheet__head">
        <h2 id="slice-title" class="sheet__title">选择区域</h2>
        <button ref="sliceCloseBtn" class="linkbtn" type="button" @click="closeSlice">
          关闭
        </button>
      </header>
      <p class="hint">
        切块是同一张图的局部放大。选中后它会作为一张新素材加入草稿，原图保留。
      </p>
      <p v-if="sliceError" class="asset-error" role="alert">{{ sliceError }}</p>
      <p v-if="sliceBusy" class="hint" aria-live="polite">正在切图…</p>
      <p v-else-if="sliceNote" class="hint">{{ sliceNote }}</p>

      <ul v-if="sliceRegions.length" class="slice-grid">
        <li v-for="region in sliceRegions" :key="region.id" class="slice-card">
          <img
            class="slice-card__img"
            :src="`/api/electro/uploads/${sliceFor.asset_id}/${region.path}`"
            :alt="`${REGION_LABEL[region.reason]} ${region.width}×${region.height}`"
            loading="lazy"
            decoding="async"
          />
          <div class="slice-card__meta">
            <span>{{ REGION_LABEL[region.reason] }}</span>
            <span class="mono">{{ region.width }}×{{ region.height }}</span>
          </div>
          <button
            class="btn btn--ghost"
            type="button"
            :disabled="!!sliceAdopting"
            @click="adoptRegion(region)"
          >
            {{ sliceAdopting === region.id ? '加入中…' : '用这块' }}
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.field-label {
  display: block;
  margin-bottom: 8px;
  font-weight: 600;
  color: var(--c-ink);
}

.hint--privacy {
  margin: 8px 0 0;
  line-height: 20px;
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
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
}

/* 预检结果：贴在被检文本下面，而不是弹窗——改一个字就要重看一次，弹窗会挡路。 */
.precheck {
  margin-top: 12px;
  padding: 12px;
  border: 1px solid var(--c-line);
  border-radius: 8px;
  background: var(--c-bg);
}

.precheck__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}

.precheck__head .linkbtn {
  margin-left: auto;
}

.precheck__missing {
  margin: 4px 0;
  color: var(--c-warning);
  font-size: 13px;
}

.precheck__steps {
  margin: 8px 0;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.6;
}

.precheck__criterion {
  margin-left: 8px;
  color: var(--c-primary-ink);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
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
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* 识别结果：一段带原文的"待确认草稿"，不是成品。视觉上要弱于正文，
   但 unverified 必须显眼——那几行是"模型写了、图里没有"的地方。 */
.extract {
  margin-top: 12px;
  padding: 12px;
  border: 1px solid var(--c-line);
  border-radius: 8px;
  background: var(--c-bg);
}

.extract__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}

.extract__head .linkbtn {
  margin-left: auto;
}

.extract__note {
  margin: 6px 0;
  color: var(--c-warning);
  font-size: 13px;
}

.extract__lines {
  margin: 8px 0;
  font-size: 13px;
}

.extract__pre {
  max-height: 220px;
  overflow: auto;
  margin: 6px 0 0;
  padding: 8px;
  border: 1px solid var(--c-line);
  border-radius: 6px;
  background: var(--c-surface);
  font-family: var(--font-mono, ui-monospace, Menlo, Consolas, monospace);
  font-size: 12px;
  white-space: pre-wrap;
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

/* 切图选择弹层：移动端从底部上来，桌面端居中；宽度用 min() 而不是媒体查询，
   390px 与 1280px 共用一套规则，少一个断点就少一处漏改。 */
.sheet {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: rgb(18 24 28 / 55%);
  padding: 0;
}

.sheet__panel {
  width: min(560px, 100%);
  max-height: 86vh;
  overflow-y: auto;
  padding: 16px;
  border-radius: 12px 12px 0 0;
  background: var(--c-surface);
  box-shadow: 0 -8px 24px rgb(18 24 28 / 18%);
}

.sheet__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.sheet__title {
  margin: 0;
  font-size: 16px;
}

.slice-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}

.slice-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--c-line);
  border-radius: 8px;
  background: var(--c-bg);
}

.slice-card__img {
  width: 100%;
  height: 108px;
  object-fit: contain;
  border-radius: 4px;
  background: var(--c-surface);
}

.slice-card__meta {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  color: var(--c-ink-3);
  font-size: 12px;
}

@media (min-width: 640px) {
  .sheet {
    align-items: center;
    padding: 24px;
  }

  .sheet__panel {
    border-radius: 12px;
  }
}
</style>
