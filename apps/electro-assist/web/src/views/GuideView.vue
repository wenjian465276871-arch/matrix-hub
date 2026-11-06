<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import GuideFigure from '../figures/GuideFigure.vue'
import ConfirmDialog from '../components/ui/ConfirmDialog.vue'
import AttachPanel from '../components/guide/AttachPanel.vue'
import EditPanel from '../components/guide/EditPanel.vue'
import { announce } from '../lib/announce'
import { ApiError, getJson, postJson } from '../lib/http'
import { writeStoredJob } from '../lib/jobhandoff'
import type {
  AssetRef,
  Criterion,
  Guide,
  GuideDetail,
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
/** 归位面板的成功提示必须留在父组件：保存后 load() 会把子树重建，子组件内的提示会被抹掉 */
const attachMsg = ref('')
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

/* 草稿素材归位已拆到 components/guide/AttachPanel.vue（2026-11-06）。
 * 那块只改"图放哪"，不改步骤文字与判据——判据能被改一个字，超差就能变合格。 */

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
    // 归位面板的初值（哪张图在哪一步、说明写什么）由 AttachPanel 自己从 rows 推导，
    // 这里不再各自算一遍——两处各算一次是上一版的重复。
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
const editing = ref(false)
/** 修正结果提示：挂在草稿控制条里（!editing 时才可见），所以不能放进编辑面板内部 */
const reviseMsg = ref('')

/** 进入编辑态。口令验证成功后也走这里，保证两条入口的行为一致。 */
function beginEdit(): void {
  reviseMsg.value = ''
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
  beginEdit()
}

/* 编辑面板的四个回调。共同点：**状态推进都留在父组件**——
 * 成功提示要在面板卸载之后仍然可见，401 要牵动令牌与口令弹层，
 * 这些都不是面板自己的事。 */

function onEditSaved(next: Guide, nextBlockers: string[]): void {
  guide.value = next
  blockers.value = nextBlockers
  editing.value = false
  reviseMsg.value = `已保存${nextBlockers.length ? `，还差 ${nextBlockers.length} 处才能发布` : '，可以发布了'}`
  announce(reviseMsg.value)
}

function onEditUnchanged(): void {
  editing.value = false
  reviseMsg.value = '没有改动'
}

function onEditCancel(): void {
  editing.value = false
  announce('已退出修正模式，改动未保存')
}

function onEditAuthExpired(): void {
  token.value = null
  sessionStorage.removeItem(TOKEN_KEY)
  pending.value = 'edit'
  passcodeOpen.value = true
  passcodeHint.value = '令牌已过期，重新验证后再保存。'
  passcodeError.value = ''
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
    if (action === 'edit') beginEdit()
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
        <span v-if="guide.meta.station" class="tag tag--plain">工位 {{ guide.meta.station }}</span>
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

    <!-- 口令面板：修正与发布共用。放在控制条之外，因为 401 可能发生在**编辑态内部**——
         若把它关在 `!editing` 的控制条里，用户会看到"请重新验证口令"却找不到输入框。 -->
    <div v-if="passcodeOpen && guideStatus === 'draft'" class="publish no-print">
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

    <!-- 修正面板：只改文字与判据值，不能加步骤、不能换判据类型 -->
    <EditPanel
      v-if="editing"
      :guide-id="props.id"
      :guide="guide"
      :token="token"
      @saved="onEditSaved"
      @unchanged="onEditUnchanged"
      @cancel="onEditCancel"
      @auth-expired="onEditAuthExpired"
    />

    <AttachPanel
      v-if="guideStatus === 'draft' && flatAssets.length"
      v-model:message="attachMsg"
      :guide-id="props.id"
      :rows="flatAssets"
      :numbers="assetNumbers"
      :steps="guide.steps"
      @saved="load"
    />

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

/* ---------- 素材归位 ----------
 * 样式已随组件移到 components/guide/AttachPanel.vue（2026-11-06）。 */

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

</style>
