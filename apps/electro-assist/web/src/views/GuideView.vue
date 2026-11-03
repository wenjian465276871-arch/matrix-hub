<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import GuideFigure from '../figures/GuideFigure.vue'
import ConfirmDialog from '../components/ui/ConfirmDialog.vue'
import { announce } from '../lib/announce'
import { ApiError, getJson, patchJson, postJson, putJson } from '../lib/http'
import { writeStoredJob } from '../lib/jobhandoff'
import type {
  AssetRef,
  AttachResult,
  Criterion,
  Guide,
  GuideDetail,
  GuidePatch,
  GuidePatchResult,
  GuideStatus,
  PublishResult,
  SessionSnapshot,
} from '../types'

const props = defineProps<{ id: string }>()
const router = useRouter()

const SYSTEM_LABEL: Record<string, string> = {
  door: '车门',
  hvac: '空调',
  pantograph: '受电弓',
}

const guide = ref<Guide | null>(null)
const guideStatus = ref<GuideStatus>('published')
const phase = ref<'loading' | 'ready' | 'notfound' | 'error'>('loading')
const errorText = ref('')
let ctrl: AbortController | null = null

/** 素材按"步骤顺序 + 文末素材区"编号，打印出来和正文对得上。 */
const flatAssets = computed<{ asset: AssetRef; stepId: string | null }[]>(() => {
  if (!guide.value) return []
  const rows: { asset: AssetRef; stepId: string | null }[] = []
  for (const step of guide.value.steps) {
    for (const asset of step.assets ?? []) rows.push({ asset, stepId: step.id })
  }
  for (const asset of guide.value.assets ?? []) rows.push({ asset, stepId: null })
  return rows
})

const assetNumbers = computed<Record<string, number>>(() => {
  const map: Record<string, number> = {}
  flatAssets.value.forEach((row, index) => {
    map[row.asset.asset_id] = index + 1
  })
  return map
})

function assetUrl(asset: AssetRef): string {
  return `/api/electro/uploads/${asset.asset_id}/${asset.asset_id}.png`
}

/* ---------- 草稿素材归位 ----------
 * 只改"图放哪"，不改步骤文字与判据：判据能被改一个字，超差就能变合格。 */
const placement = ref<Record<string, string>>({})
const captions = ref<Record<string, string>>({})
const attachBusy = ref(false)
const attachMsg = ref('')
const attachError = ref('')

async function savePlacement(): Promise<void> {
  if (!guide.value || attachBusy.value) return
  attachBusy.value = true
  attachMsg.value = ''
  attachError.value = ''
  try {
    const assets = flatAssets.value.map(({ asset }) => ({
      asset_id: asset.asset_id,
      caption: (captions.value[asset.asset_id] ?? asset.caption).trim() || asset.caption,
      step_id: placement.value[asset.asset_id] || null,
    }))
    const res = await putJson<AttachResult>(`/api/electro/guides/${props.id}/assets`, { assets })
    attachMsg.value = `已保存：${res.attached} 张挂到步骤，${res.loose} 张留在素材区`
    await load()
  } catch (err) {
    attachError.value =
      err instanceof ApiError
        ? err.code === 'published_locked'
          ? '已发布的指导书不能调整素材。'
          : err.message || '保存失败，请稍后重试'
        : '保存失败，请稍后重试'
  } finally {
    attachBusy.value = false
  }
}

function criterionValue(c: Criterion): string {
  if (c.type === 'range') return `${c.min ?? '—'} ~ ${c.max ?? '—'}`
  if (c.type === 'enum') return (c.options ?? []).join(' / ')
  if (c.type === 'manual') return '人工确认'
  return '记录'
}

// 模板里拿不到 window（Vue 只白名单了 Math/Date/JSON 等），必须在这里包一层。
function printGuide(): void {
  window.print()
}

const starting = ref(false)
const startError = ref('')

async function startRun(): Promise<void> {
  if (starting.value) return
  starting.value = true
  startError.value = ''
  try {
    const data = await postJson<SessionSnapshot>('/api/electro/sessions', {
      guide_id: props.id,
    })
    await router.push({ name: 'run', params: { sid: data.session.id } })
  } catch (err) {
    startError.value =
      err instanceof ApiError
        ? err.message || '无法创建引导会话'
        : '无法创建引导会话，请稍后重试'
  } finally {
    starting.value = false
  }
}

async function load(): Promise<void> {
  ctrl?.abort()
  ctrl = new AbortController()
  phase.value = 'loading'
  errorText.value = ''
  try {
    const detail = await getJson<GuideDetail>(`/api/electro/guides/${props.id}`, ctrl.signal)
    guide.value = detail.guide
    guideStatus.value = detail.status
    processId.value = detail.process_id ?? null
    // 归位面板的初值来自服务端：本地只保存"用户改了什么"，不猜默认位置。
    const place: Record<string, string> = {}
    const labels: Record<string, string> = {}
    for (const step of detail.guide.steps) {
      for (const asset of step.assets ?? []) {
        place[asset.asset_id] = step.id
        labels[asset.asset_id] = asset.caption
      }
    }
    for (const asset of detail.guide.assets ?? []) {
      place[asset.asset_id] = ''
      labels[asset.asset_id] = asset.caption
    }
    placement.value = place
    captions.value = labels
    // 发布缺口在本地先算一遍：规则与后端 `publish_blockers()` 完全一致
    // （每步都要有验收判据）。让"点发布才发现发不了"变成"一开始就看见"。
    blockers.value =
      detail.status === 'draft'
        ? detail.guide.steps
            .filter((step) => !step.criteria.length)
            .map((step) => `${step.id}「${step.title}」没有验收判据`)
        : []
    phase.value = 'ready'
  } catch (err) {
    if (ctrl.signal.aborted) return
    if (err instanceof ApiError && err.kind === 'notfound') {
      phase.value = 'notfound'
      return
    }
    errorText.value =
      err instanceof ApiError
        ? err.kind === 'timeout'
          ? '请求超时，请检查网络后重试'
          : `服务暂不可用（${err.status ?? err.kind}）`
        : '页面初始化失败：请升级浏览器，或改用 Chrome / Safari 打开'
    if (!(err instanceof ApiError)) console.error('load guide failed', err)
    phase.value = 'error'
  }
}

onMounted(load)
watch(() => props.id, load)
onBeforeUnmount(() => ctrl?.abort())

/* ---------- 草稿修正（决策 #35）----------
 * 只改文字与判据**值**：不能加步骤、不能换判据类型、不能新增判据。
 * 那不是"修正"，那是重新生成——而重新生成有它自己的入口，也更便宜。
 *
 * 数值用字符串存：`<input type="number">` 在输入 `-` 或 `1.` 的中间态会返回
 * 空串或 NaN，直接绑 number 会让输入框在打字过程中自己清空。
 */
interface EditCriterion {
  id: string
  type: string
  label: string
  unit: string
  min: string
  max: string
  options: string
}

interface EditStep {
  id: string
  title: string
  action: string
  criteria: EditCriterion[]
}

const editing = ref(false)
const editSteps = ref<EditStep[]>([])
const editTitle = ref('')
const editSummary = ref('')
const reviseBusy = ref(false)
const reviseMsg = ref('')
const reviseError = ref('')

function numText(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value)
}

function enterEdit(): void {
  if (!guide.value) return
  editTitle.value = guide.value.title
  editSummary.value = guide.value.summary
  editSteps.value = guide.value.steps.map((step) => ({
    id: step.id,
    title: step.title,
    action: step.action,
    criteria: step.criteria.map((c) => ({
      id: c.id,
      type: c.type,
      label: c.label,
      unit: c.unit ?? '',
      min: numText(c.min),
      max: numText(c.max),
      options: (c.options ?? []).join(' / '),
    })),
  }))
  reviseMsg.value = ''
  reviseError.value = ''
  editing.value = true
  announce('进入修正模式：可以改标题、步骤描述与判据数值')
}

/** 修正的入口守卫：没有令牌就先要口令，进编辑态再被 401 拦下是最差体验。 */
function startEdit(): void {
  if (!token.value) {
    pending.value = 'edit'
    passcodeOpen.value = true
    passcodeHint.value = '修正草稿需要口令：验证后 12 小时内有效。'
    passcodeError.value = ''
    return
  }
  enterEdit()
}

function cancelEdit(): void {
  editing.value = false
  reviseError.value = ''
  announce('已退出修正模式，改动未保存')
}

/** 空串 = 不改；非法数字 = 直接报错，不要悄悄发一个 NaN 出去。 */
function toNumber(raw: string, label: string): number | undefined {
  const text = raw.trim()
  if (!text) return undefined
  const value = Number(text)
  if (!Number.isFinite(value)) throw new Error(`${label}不是合法数字`)
  return value
}

/** 只把**真的改过的**字段放进请求：少传就少一层覆盖，后端也不会重写无关步骤。 */
function buildPatch(): GuidePatch {
  if (!guide.value) return {}
  const patch: GuidePatch = {}
  if (editTitle.value.trim() !== guide.value.title) patch.title = editTitle.value.trim()
  if (editSummary.value.trim() !== guide.value.summary) patch.summary = editSummary.value.trim()

  const steps: NonNullable<GuidePatch['steps']> = []
  guide.value.steps.forEach((original, index) => {
    const edit = editSteps.value[index]
    if (!edit) return
    const change: NonNullable<GuidePatch['steps']>[number] = { id: edit.id }
    let touched = false
    if (edit.title.trim() !== original.title) {
      change.title = edit.title.trim()
      touched = true
    }
    if (edit.action.trim() !== original.action) {
      change.action = edit.action.trim()
      touched = true
    }

    const criteria: NonNullable<typeof change.criteria> = []
    original.criteria.forEach((orig, ci) => {
      const row = edit.criteria[ci]
      if (!row) return
      const item: NonNullable<typeof criteria>[number] = { id: row.id }
      let dirty = false
      if (row.label.trim() !== orig.label) {
        item.label = row.label.trim()
        dirty = true
      }
      if (row.type === 'range') {
        if (row.unit.trim() !== (orig.unit ?? '')) {
          item.unit = row.unit.trim()
          dirty = true
        }
        const min = toNumber(row.min, `${orig.label} 的下限`)
        const max = toNumber(row.max, `${orig.label} 的上限`)
        if (min !== undefined && min !== orig.min) {
          item.min = min
          dirty = true
        }
        if (max !== undefined && max !== orig.max) {
          item.max = max
          dirty = true
        }
      } else if (row.type === 'enum') {
        const options = row.options
          .split('/')
          .map((part) => part.trim())
          .filter(Boolean)
        if (options.join('/') !== (orig.options ?? []).join('/')) {
          item.options = options
          dirty = true
        }
      }
      if (dirty) criteria.push(item)
    })
    if (criteria.length) {
      change.criteria = criteria
      touched = true
    }
    if (touched) steps.push(change)
  })

  if (steps.length) patch.steps = steps
  return patch
}

async function saveEdit(): Promise<void> {
  if (!guide.value || reviseBusy.value) return
  reviseBusy.value = true
  reviseMsg.value = ''
  reviseError.value = ''
  try {
    const patch = buildPatch()
    if (!Object.keys(patch).length) {
      reviseMsg.value = '没有改动'
      editing.value = false
      return
    }
    const res = await patchJson<GuidePatchResult>(`/api/electro/guides/${props.id}`, patch, {
      headers: { 'X-Passcode-Token': token.value ?? '' },
    })
    guide.value = res.guide
    blockers.value = res.blockers
    editing.value = false
    reviseMsg.value = `已保存${res.blockers.length ? `，还差 ${res.blockers.length} 处才能发布` : '，可以发布了'}`
    announce(reviseMsg.value)
  } catch (err) {
    reviseError.value = describeReviseError(err)
    if (err instanceof ApiError && err.status === 401) {
      token.value = null
      sessionStorage.removeItem(TOKEN_KEY)
      pending.value = 'edit'
      passcodeOpen.value = true
      passcodeHint.value = '令牌已过期，重新验证后再保存。'
      passcodeError.value = ''
    }
    announce(reviseError.value, 'assertive')
  } finally {
    reviseBusy.value = false
  }
}

/* ---------- 发布 ----------
 * 决策 #16 拒绝的是"没有鉴权的后台"，不是"发布入口"。这里沿用口令令牌：
 * 先 `POST /passcode/verify` 换令牌，再带上 `X-Passcode-Token` 发布。
 * 令牌只存在内存与 sessionStorage，不写进 URL、不进日志。
 */
const TOKEN_KEY = 'electro-passcode-token'
const token = ref<string | null>(null)
const publishOpen = ref(false)
const publishCode = ref('')
const publishBusy = ref(false)
const publishError = ref('')
/** 发布成功的提示：挂在草稿控制条之外，控制条卸载后仍然可见。 */
const publishedBanner = ref('')
const confirmOpen = ref(false)
const blockers = ref<string[]>([])

/* 口令面板与「发布」分开：修正也要令牌，把它塞进发布面板会让人以为
 * "只有发布才要口令"，点开修正改半天再被 401 拦下。 */
const passcodeOpen = ref(false)
const passcodeHint = ref('')
const passcodeError = ref('')
/** 验证完口令之后要做什么。修正与发布是两条不同的后续动作。 */
const pending = ref<'edit' | 'publish' | null>(null)

const canPublish = computed(() => guideStatus.value === 'draft' && blockers.value.length === 0)

/* ---------- 重新生成 ----------
 * 工艺原文已随生成落库（`processes` 表），所以不必回生成页重粘一段一模一样的文字。
 *
 * 代价要说清：这不是"重试"，是一次**新的生成**——花同一份额度、出另一份草稿。
 * 所以按钮文案写"再生成一份草稿"，不写"重试"。
 */
const processId = ref<string | null>(null)
const regenerating = ref(false)
const regenError = ref('')

async function regenerate(): Promise<void> {
  if (!processId.value || regenerating.value) return
  regenerating.value = true
  regenError.value = ''
  try {
    const res = await postJson<{ job_id: string }>(
      `/api/electro/processes/${processId.value}/generate`,
      { retry_of: null },
      token.value ? { headers: { 'X-Passcode-Token': token.value } } : undefined,
    )
    // 交给生成页的轮询：它按 job_id 续接，超时预算从这一刻算起
    writeStoredJob(res.job_id, Date.now())
    await router.push({ name: 'new' })
  } catch (err) {
    regenError.value =
      err instanceof ApiError
        ? err.message || '无法重新生成'
        : '无法重新生成，请稍后重试'
  } finally {
    regenerating.value = false
  }
}

function describeReviseError(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return err instanceof Error ? err.message : '保存失败，请稍后重试'
  }
  if (err.code === 'passcode_required' || err.status === 401) return '口令已过期，请重新验证口令。'
  if (err.code === 'passcode_disabled') return '服务端未启用修正通道（未配置口令）。'
  if (err.code === 'published_locked') return '这份指导书已被发布，不能再修改。'
  if (err.code === 'rate_limited') return `操作过于频繁，请 ${err.retryAfter ?? 60} 秒后再试。`
  return err.message || '保存失败，请稍后重试'
}

async function verifyCode(): Promise<boolean> {
  passcodeError.value = ''
  publishError.value = ''
  const code = publishCode.value.trim()
  if (!code) {
    passcodeError.value = '请输入口令'
    return false
  }
  try {
    const res = await postJson<{ token: string; expires_in: number }>(
      '/api/electro/passcode/verify',
      { code },
    )
    token.value = res.token
    sessionStorage.setItem(TOKEN_KEY, res.token)
    publishCode.value = ''
    passcodeOpen.value = false
    passcodeHint.value = ''
    const action = pending.value
    pending.value = null
    if (action === 'edit') enterEdit()
    if (action === 'publish') publishOpen.value = true
    announce('口令已验证，12 小时内有效')
    return true
  } catch (err) {
    passcodeError.value =
      err instanceof ApiError
        ? err.code === 'passcode_disabled'
          ? '服务端未启用口令通道。'
          : err.code === 'rate_limited'
            ? `尝试过于频繁，请 ${err.retryAfter ?? 60} 秒后再试。`
            : '口令不正确。'
        : '验证失败，请稍后重试。'
    return false
  }
}

function openPublish(): void {
  publishError.value = ''
  if (!token.value) {
    pending.value = 'publish'
    passcodeOpen.value = true
    passcodeHint.value = '发布需要口令：验证后 12 小时内有效。'
    passcodeError.value = ''
    return
  }
  publishOpen.value = true
}

async function doPublish(): Promise<void> {
  confirmOpen.value = false
  publishBusy.value = true
  publishError.value = ''
  try {
    const res = await postJson<PublishResult>(
      `/api/electro/guides/${props.id}/publish`,
      {},
      { headers: { 'X-Passcode-Token': token.value ?? '' } },
    )
    guideStatus.value = 'published'
    publishOpen.value = false
    // 提示必须挂在控制条之外：草稿条会随 status 变化整块卸载，
    // 挂在里面的"已发布"永远来不及被看到。
    publishedBanner.value = `已发布${
      res.published_at ? `（${new Date(res.published_at).toLocaleString('zh-CN')}）` : ''
    }：现在出现在公开列表里`
    announce('已发布：这份指导书现在出现在公开列表里')
    await load()
  } catch (err) {
    if (err instanceof ApiError && err.code === 'publish_blocked') {
      const list = (err as ApiError & { blockers?: string[] }).blockers
      if (list?.length) blockers.value = list
      publishError.value = '还有步骤缺验收判据，补齐后才能发布。'
    } else if (err instanceof ApiError && err.status === 401) {
      token.value = null
      sessionStorage.removeItem(TOKEN_KEY)
      pending.value = null
      passcodeOpen.value = true
      passcodeHint.value = '令牌已过期，重新验证后再发布。'
      passcodeError.value = ''
      publishOpen.value = false
    } else {
      publishError.value = err instanceof ApiError ? err.message || '发布失败' : '发布失败，请稍后重试。'
    }
    announce(publishError.value, 'assertive')
  } finally {
    publishBusy.value = false
  }
}

function restoreToken(): void {
  // sessionStorage 而不是 localStorage：关掉标签页就该失效，减少被借用的窗口。
  const saved = sessionStorage.getItem(TOKEN_KEY)
  if (saved) token.value = saved
}

restoreToken()
</script>

<template>
  <div v-if="phase === 'loading'" class="card state" aria-busy="true">正在加载指导书…</div>

  <div v-else-if="phase === 'notfound'" class="card state state--error">
    <p>这份指导书不存在。</p>
    <p class="state__hint">GET /api/electro/guides/{{ id }}</p>
    <RouterLink class="btn" to="/">返回列表</RouterLink>
  </div>

  <div v-else-if="phase === 'error'" class="card state state--error">
    <p>{{ errorText }}</p>
    <p class="state__hint">GET /api/electro/guides/{{ id }}</p>
    <button class="btn" type="button" @click="load">重试</button>
  </div>

  <article v-else-if="guide" class="card">
    <div v-if="publishedBanner" class="published-banner no-print">
      <strong>已发布</strong> · {{ publishedBanner }}
      <RouterLink class="published-banner__link" to="/">去列表看</RouterLink>
    </div>
    <div v-if="guideStatus === 'draft'" class="draft-banner no-print">
      <strong>草稿</strong> · 未发布，仅通过此链接可见
    </div>
    <header class="guide-head">
      <h1 class="guide-title">{{ guide.title }}</h1>
      <p class="guide-summary">{{ guide.summary }}</p>
      <div class="meta-row">
        <span class="tag">{{ SYSTEM_LABEL[guide.meta.system] ?? guide.meta.system }}</span>
        <span class="tag tag--plain">{{ guide.steps.length }} 步</span>
        <span class="tag tag--plain">{{ guide.meta.model }}</span>
        <span>{{ new Date(guide.meta.generated_at).toLocaleString('zh-CN') }}</span>
      </div>
      <p class="disclaimer">
        {{ guide.disclaimers.join(' · ') }}
      </p>
      <div class="meta-row no-print">
        <button class="btn btn--primary" type="button" :disabled="starting" @click="startRun">
          {{ starting ? '正在创建会话…' : '开始引导作业' }}
        </button>
        <button class="btn" type="button" @click="printGuide">打印 / 导出 PDF</button>
        <button
          v-if="processId"
          class="btn"
          type="button"
          :disabled="regenerating"
          title="用同一份工艺文本再生成一份草稿；与首次生成共用配额"
          @click="regenerate"
        >
          {{ regenerating ? '正在提交…' : '再生成一份草稿' }}
        </button>
      </div>
      <p v-if="startError" class="start-error no-print">{{ startError }}</p>
      <p v-if="regenError" class="start-error no-print">{{ regenError }}</p>
    </header>

    <!-- 草稿控制条：修正 / 发布。已发布的内容不显示，避免"看起来能改"。 -->
    <section v-if="guideStatus === 'draft' && !editing" class="revise no-print">
      <div class="revise__row">
        <button class="btn" type="button" @click="startEdit">修正内容</button>
        <button
          class="btn btn--primary"
          type="button"
          :disabled="!canPublish || publishBusy"
          :aria-describedby="!canPublish ? 'blockers' : undefined"
          @click="openPublish"
        >
          发布到列表
        </button>
        <span v-if="token" class="revise__token">口令已生效</span>
      </div>

      <ul v-if="blockers.length" id="blockers" class="revise__blockers">
        <li v-for="item in blockers" :key="item">{{ item }}</li>
      </ul>
      <p v-if="blockers.length" class="revise__hint">
        草稿允许留空，但发布前每一步都要有验收判据——否则现场照着做，没有"做到什么程度算对"的依据。
      </p>

      <p v-if="reviseMsg" class="revise__ok">{{ reviseMsg }}</p>

      <!-- 口令面板：修正与发布共用。先验证，再决定接着做什么（pending）。 -->
      <div v-if="passcodeOpen" class="publish">
        <p class="publish__warn">{{ passcodeHint }}</p>
        <p v-if="passcodeError" class="publish__error">{{ passcodeError }}</p>

        <div class="publish__field">
          <label class="publish__label" for="passcode">口令</label>
          <input
            id="passcode"
            v-model="publishCode"
            class="publish__input"
            type="password"
            autocomplete="current-password"
            enterkeyhint="go"
            @keyup.enter="verifyCode"
          />
          <p class="publish__hint">口令只用于换 12 小时令牌，不会存进浏览器。</p>
        </div>

        <div class="publish__actions">
          <button class="btn btn--primary" type="button" @click="verifyCode">验证口令</button>
          <button
            class="btn"
            type="button"
            @click="
              passcodeOpen = false;
              pending = null
            "
          >
            取消
          </button>
        </div>
      </div>

      <div v-if="publishOpen" class="publish">
        <p class="publish__warn">
          发布后不能修改，会立刻出现在公开列表里。确认内容已过专业复核。
        </p>
        <p v-if="publishError" class="publish__error">{{ publishError }}</p>

        <div class="publish__actions">
          <button
            class="btn btn--primary"
            type="button"
            :disabled="publishBusy"
            @click="confirmOpen = true"
          >
            确认发布
          </button>
          <button class="btn" type="button" @click="publishOpen = false">取消</button>
        </div>
      </div>
    </section>

    <!-- 修正面板：只改文字与判据值，不能加步骤、不能换判据类型 -->
    <section v-if="editing" class="edit no-print">
      <h2 class="edit__title">修正草稿</h2>
      <p class="edit__hint">
        只能改文字与判据数值。增删步骤、换判据类型请重新生成——那不是在改一份稿子，是在换一份内容。
      </p>

      <label class="edit__label" for="edit-title">标题</label>
      <input id="edit-title" v-model="editTitle" class="edit__input" maxlength="60" />

      <label class="edit__label" for="edit-summary">摘要</label>
      <textarea id="edit-summary" v-model="editSummary" class="edit__text" rows="2" maxlength="300" />

      <div v-for="(step, index) in editSteps" :key="step.id" class="edit__step">
        <h3 class="edit__step-title">第 {{ index + 1 }} 步 · {{ step.id }}</h3>

        <label class="edit__label" :for="`edit-t-${step.id}`">小标题</label>
        <input
          :id="`edit-t-${step.id}`"
          v-model="step.title"
          class="edit__input"
          maxlength="40"
        />

        <label class="edit__label" :for="`edit-a-${step.id}`">动作描述</label>
        <textarea
          :id="`edit-a-${step.id}`"
          v-model="step.action"
          class="edit__text"
          rows="3"
          maxlength="600"
        />

        <div v-for="c in step.criteria" :key="c.id" class="edit__crit">
          <label class="edit__label" :for="`edit-c-${step.id}-${c.id}`">
            判据 · {{ c.type === 'range' ? '数值区间' : c.type === 'enum' ? '枚举' : '文本/人工' }}
          </label>
          <input
            :id="`edit-c-${step.id}-${c.id}`"
            v-model="c.label"
            class="edit__input"
            maxlength="60"
          />

          <template v-if="c.type === 'range'">
            <div class="edit__range">
              <label :for="`edit-min-${step.id}-${c.id}`">下限</label>
              <input
                :id="`edit-min-${step.id}-${c.id}`"
                v-model="c.min"
                class="edit__input edit__input--num"
                inputmode="decimal"
              />
              <label :for="`edit-max-${step.id}-${c.id}`">上限</label>
              <input
                :id="`edit-max-${step.id}-${c.id}`"
                v-model="c.max"
                class="edit__input edit__input--num"
                inputmode="decimal"
              />
              <label :for="`edit-unit-${step.id}-${c.id}`">单位</label>
              <input
                :id="`edit-unit-${step.id}-${c.id}`"
                v-model="c.unit"
                class="edit__input edit__input--unit"
                maxlength="3"
              />
            </div>
          </template>

          <template v-else-if="c.type === 'enum'">
            <label class="edit__label" :for="`edit-opt-${step.id}-${c.id}`">选项（用 / 分隔）</label>
            <input
              :id="`edit-opt-${step.id}-${c.id}`"
              v-model="c.options"
              class="edit__input"
              maxlength="200"
            />
          </template>
        </div>
      </div>

      <p v-if="reviseError" class="edit__error">{{ reviseError }}</p>
      <div class="edit__actions">
        <button class="btn btn--primary" type="button" :disabled="reviseBusy" @click="saveEdit">
          {{ reviseBusy ? '保存中…' : '保存修正' }}
        </button>
        <button class="btn" type="button" :disabled="reviseBusy" @click="cancelEdit">取消</button>
      </div>
    </section>

    <section v-if="guideStatus === 'draft' && flatAssets.length" class="attach no-print">
      <h2 class="attach__title">素材归位</h2>
      <p class="attach__hint">
        系统不会识别图片内容，所以位置由你决定：选好步骤后保存。已发布的指导书不能再改。
      </p>
      <ul class="attach__list">
        <li v-for="row in flatAssets" :key="row.asset.asset_id" class="attach__row">
          <img
            class="attach__thumb"
            :src="assetUrl(row.asset)"
            :alt="`图 ${assetNumbers[row.asset.asset_id]} 预览`"
            loading="lazy"
            decoding="async"
          />
          <div class="attach__fields">
            <label class="attach__label" :for="`cap-${row.asset.asset_id}`">
              图 {{ assetNumbers[row.asset.asset_id] }} 说明
            </label>
            <input
              :id="`cap-${row.asset.asset_id}`"
              v-model="captions[row.asset.asset_id]"
              class="attach__input"
              type="text"
              maxlength="60"
              :disabled="attachBusy"
            />
            <label class="attach__label" :for="`pos-${row.asset.asset_id}`">放在</label>
            <select
              :id="`pos-${row.asset.asset_id}`"
              v-model="placement[row.asset.asset_id]"
              class="attach__select"
              :disabled="attachBusy"
            >
              <option value="">素材区（文末）</option>
              <option v-for="step in guide.steps" :key="step.id" :value="step.id">
                第 {{ step.seq }} 步 · {{ step.title }}
              </option>
            </select>
          </div>
        </li>
      </ul>
      <div class="attach__actions">
        <button class="btn" type="button" :disabled="attachBusy" @click="savePlacement">
          {{ attachBusy ? '保存中…' : '保存归位' }}
        </button>
        <span v-if="attachMsg" class="attach__ok">{{ attachMsg }}</span>
        <span v-if="attachError" class="attach__error">{{ attachError }}</span>
      </div>
    </section>

    <!-- 编辑态隐藏正文：同一份内容在页面上只出现一次，
         否则改完一处、旁边还摆着旧的那份，容易对着旧值核对。 -->
    <template v-if="!editing">
    <section v-for="step in guide.steps" :key="step.id" class="step">
      <div class="step__head">
        <span class="step__seq">{{ String(step.seq).padStart(2, '0') }}</span>
        <h2 class="step__title">{{ step.title }}</h2>
      </div>
      <p class="step__action">{{ step.action }}</p>

      <div v-if="step.safety.length" class="step__block">
        <p class="block-label">安全</p>
        <ul class="safety">
          <li v-for="s in step.safety" :key="s">{{ s }}</li>
        </ul>
      </div>

      <div v-if="step.tools.length" class="step__block">
        <p class="block-label">工具</p>
        <div class="tool-list">
          <span v-for="t in step.tools" :key="t" class="tag tag--plain">{{ t }}</span>
        </div>
      </div>

      <div v-if="step.criteria.length" class="step__block">
        <p class="block-label">验收判据</p>
        <div class="criteria">
          <div v-for="c in step.criteria" :key="c.id" class="criterion">
            <span class="criterion__label">{{ c.label }}</span>
            <span class="criterion__value">
              {{ criterionValue(c) }}<span v-if="c.unit" class="criterion__unit">{{ c.unit }}</span>
            </span>
          </div>
        </div>
      </div>

      <div v-if="step.figures.length" class="step__block">
        <p class="block-label">图示</p>
        <GuideFigure v-for="(fig, i) in step.figures" :key="`${step.id}-fig-${i}`" :spec="fig" />
      </div>

      <!-- 三级降级的第三级（计划 §2.1）：既没有原语图示、也没有现场素材时，
           必须**显式**说明原因并给出补救动作，不能靠"这块不渲染"静默跳过。
           现场照着文字做完一步、才发现本该有张接线图，是这套系统最不该出现的失败。 -->
      <div v-else-if="!step.assets?.length" class="step__block step__empty">
        <p class="block-label">图示</p>
        <p class="step__empty-text">
          本步暂无可视化图示，也未附现场素材。
          <template v-if="guideStatus === 'draft'">
            可上传照片或截图后在草稿页补到本步；补齐前请以下方文字与验收判据为准。
          </template>
          <template v-else>请以下方文字与验收判据为准；如需配图，请对照现场资料。</template>
        </p>
      </div>

      <div v-if="step.assets?.length" class="step__block">
        <p class="block-label">现场素材</p>
        <div class="asset-row">
          <figure v-for="asset in step.assets" :key="asset.asset_id" class="asset">
            <img
              class="asset__img"
              :src="assetUrl(asset)"
              :alt="asset.caption"
              loading="lazy"
              decoding="async"
            />
            <figcaption class="asset__cap">
              图 {{ assetNumbers[asset.asset_id] }} · {{ asset.caption }}
            </figcaption>
          </figure>
        </div>
      </div>

      <div v-if="step.duration_s" class="step__block">
        <p class="block-label">预计耗时</p>
        <p class="step__duration">{{ Math.max(1, Math.round(step.duration_s / 60)) }} 分钟</p>
      </div>
    </section>

    <section v-if="guide.assets?.length" class="guide-assets">
      <h2 class="guide-assets__title">现场素材</h2>
      <p class="guide-assets__hint">未归入具体步骤的照片，编号与正文一致。</p>
      <div class="asset-row">
        <figure v-for="asset in guide.assets" :key="asset.asset_id" class="asset">
          <img
            class="asset__img"
            :src="assetUrl(asset)"
            :alt="asset.caption"
            loading="lazy"
            decoding="async"
          />
          <figcaption class="asset__cap">
            图 {{ assetNumbers[asset.asset_id] }} · {{ asset.caption }}
          </figcaption>
        </figure>
      </div>
    </section>
    </template>

    <!-- 发布二次确认：不可逆动作不放行到"点一下就走" -->
    <ConfirmDialog
      v-if="confirmOpen"
      title="发布这份指导书？"
      hint="发布后内容不可修改，会立刻出现在公开列表里。"
      confirm-text="发布"
      :busy="publishBusy"
      @confirm="doPublish"
      @cancel="confirmOpen = false"
    />
  </article>
</template>

<style scoped>
.draft-banner {
  margin-bottom: 16px;
  padding: 10px 14px;
  border: 1px solid #e8c98a;
  border-radius: 6px;
  background: #fff4e0;
  color: #8a5a00;
  font-size: 13px;
}

/* 发布成功用成功色：和草稿的琥珀色区分开，否则"已发布"看起来像另一条警告 */
.published-banner {
  margin-bottom: 16px;
  padding: 10px 14px;
  border: 1px solid var(--c-success);
  border-radius: 6px;
  background: var(--c-success-soft);
  color: var(--c-success);
  font-size: 13px;
}

.published-banner__link {
  margin-left: 8px;
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.start-error {
  margin: 10px 0 0;
  color: var(--c-danger);
  font-size: 13px;
}

/* ---------- 素材归位（仅草稿、仅屏显） ---------- */

.attach {
  margin: 0 0 20px;
  padding: 14px;
  border: 1px solid var(--c-primary-line);
  border-radius: 8px;
  background: var(--c-primary-soft);
}

.attach__title {
  margin: 0 0 6px;
  font-size: 15px;
}

.attach__hint {
  margin: 0 0 10px;
  color: var(--c-ink-2);
  font-size: 13px;
}

.attach__list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.attach__row {
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: 12px;
  align-items: start;
  padding: 10px;
  border-radius: 6px;
  background: var(--c-surface);
}

.attach__thumb {
  width: 64px;
  height: 64px;
  border-radius: 4px;
  background: var(--c-line-soft);
  object-fit: cover;
}

.attach__fields {
  display: grid;
  gap: 6px;
}

.attach__label {
  color: var(--c-ink-3);
  font-size: 12px;
}

.attach__input,
.attach__select {
  width: 100%;
  min-height: 44px;
  padding: 0 10px;
  border: 1px solid var(--c-line);
  border-radius: 6px;
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
  font-size: 14px;
}

.attach__input:focus,
.attach__select:focus {
  outline: 2px solid var(--c-primary);
  outline-offset: 1px;
}

.attach__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.attach__ok {
  color: var(--c-success);
  font-size: 13px;
}

.attach__error {
  color: var(--c-danger);
  font-size: 13px;
}

/* ---------- 素材渲染 ---------- */

.asset-row {
  display: grid;
  gap: 12px;
}

.asset {
  margin: 0;
}

.asset__img {
  display: block;
  width: 100%;
  max-height: 360px;
  border: 1px solid var(--c-line);
  border-radius: 6px;
  background: var(--c-surface);
  object-fit: contain;
}

.asset__cap {
  margin-top: 6px;
  color: var(--c-ink-2);
  font-size: 13px;
}

.guide-assets {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--c-line);
}

.guide-assets__title {
  margin: 0 0 4px;
  font-size: 16px;
}

.guide-assets__hint {
  margin: 0 0 12px;
  color: var(--c-ink-3);
  font-size: 13px;
}

@media (min-width: 640px) {
  .asset-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

/* ---------- 修正与发布 ---------- */

.revise {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--c-line);
}

.revise__row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
}

.revise__blockers {
  margin: 10px 0 0;
  padding-left: 20px;
  color: var(--c-warning);
  font-size: 14px;
  line-height: 1.6;
}

.revise__hint {
  margin: 6px 0 0;
  color: var(--c-ink-3);
  font-size: 13px;
  line-height: 1.6;
}

.revise__ok {
  margin: 10px 0 0;
  color: var(--c-success);
  font-size: 14px;
}

.revise__token {
  color: var(--c-success);
  font-size: 13px;
}

.publish {
  margin-top: 12px;
  padding: 12px 14px;
  border: 1px solid var(--c-warning-line);
  border-radius: 6px;
  background: var(--c-warning-soft);
}

.publish__warn {
  margin: 0 0 10px;
  color: var(--c-warning);
  font-size: 14px;
  line-height: 1.6;
}

.publish__error {
  margin: 0 0 10px;
  color: var(--c-danger);
  font-size: 14px;
}

.publish__field {
  margin-bottom: 10px;
}

.publish__label {
  display: block;
  margin-bottom: 4px;
  font-size: 13px;
  color: var(--c-ink-2);
}

.publish__input {
  width: 100%;
  max-width: 320px;
  min-height: var(--tap);
  padding: 0 10px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-ink);
  font-size: 15px;
}

.publish__hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--c-ink-3);
}

.publish__actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

/* ---------- 修正面板 ---------- */

.edit {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--c-line);
}

.edit__title {
  margin: 0 0 6px;
  font-size: 18px;
}

.edit__hint {
  margin: 0 0 12px;
  color: var(--c-ink-3);
  font-size: 13px;
  line-height: 1.6;
}

.edit__label {
  display: block;
  margin: 10px 0 4px;
  font-size: 13px;
  color: var(--c-ink-2);
}

.edit__input,
.edit__text {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-ink);
  font-size: 15px;
  font-family: inherit;
}

.edit__input {
  min-height: var(--tap);
}

.edit__text {
  line-height: 1.5;
  resize: vertical;
}

.edit__input:focus-visible,
.edit__text:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 1px;
}

.edit__step {
  margin-top: 18px;
  padding-top: 12px;
  border-top: 1px dashed var(--c-line);
}

.edit__step-title {
  margin: 0;
  font-size: 15px;
  color: var(--c-ink-2);
}

.edit__crit {
  margin-top: 10px;
  padding-left: 10px;
  border-left: 2px solid var(--c-primary-line);
}

/* 上下限用 flex 而不是网格：窄屏两列网格会让「标签-输入」错位成两行半 */
.edit__range {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 10px;
  align-items: center;
  margin-top: 6px;
  font-size: 13px;
  color: var(--c-ink-2);
}

.edit__input--num {
  width: 96px;
}

.edit__input--unit {
  width: 72px;
}

.edit__error {
  margin: 12px 0 0;
  color: var(--c-danger);
  font-size: 14px;
}

.edit__actions {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}
</style>
