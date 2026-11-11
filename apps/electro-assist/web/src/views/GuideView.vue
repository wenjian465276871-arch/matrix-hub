<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import StepPager from '../components/guide/StepPager.vue'
import PagerNav from '../components/guide/PagerNav.vue'
import ConfirmDialog from '../components/ui/ConfirmDialog.vue'
import AttachPanel from '../components/guide/AttachPanel.vue'
import EditPanel from '../components/guide/EditPanel.vue'
/* 探索台异步加载：它的 scoped CSS 有 7KB，直接 import 会并进 GuideView 的路由包，
   把单路由 CSS 预算（6KB）顶穿。异步后 CSS 跟着独立 chunk 走，
   只在真正打开 /explore 时下载。 */
const GuideExplorer = defineAsyncComponent(() => import('../components/guide/GuideExplorer.vue'))
import { announce } from '../lib/announce'
import { ApiError, getJson, postJson } from '../lib/http'
import { writeStoredJob } from '../lib/jobhandoff'
import { pageCount, pageLabels } from '../lib/paging'
import { resetTopBar, setTopBar } from '../composables/useTopBar'
import type { TopBarAction } from '../composables/useTopBar'
import type { AssetRef, Guide, GuideDetail, GuideStatus, PublishResult, SessionSnapshot } from '../types'

const props = defineProps<{ id: string }>()
const router = useRouter()
const route = useRoute()

/** 版式开关：只有 /guide/:id/read 走分页阅读器（打印与草稿编辑），
 *  其余（含默认的 /guide/:id）都是探索台。 */
const explore = computed(() => route.name !== 'guide-read')

function gotoStep(index: number): void {
  const max = (guide.value?.steps.length ?? 1) - 1
  page.value = Math.min(Math.max(index, 0), Math.max(max, 0))
}

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

/* ---------- 分页阅读（2026-11-10）----------
 * 一步一屏，左右滑动/按钮/键盘翻页。判据与图的分页排版在 `StepPage.vue`，
 * 翻页与滚动同步在 `StepPager.vue`，纯计算在 `lib/paging.ts`。
 * 这一层只保留"整页的东西"：状态条、草稿管理、封面动作。 */
const page = ref(0)
/** 子组件通过 defineExpose 暴露的两个动作：跳页与"打印前铺开全部页" */
const pager = ref<{ goTo: (index: number) => void; preparePrint: () => Promise<void> } | null>(null)
const printing = ref(false)

/** 打印前必须把全部页铺开：只打当前页，纸上就是残缺的指导书。 */
async function printGuide(): Promise<void> {
  if (printing.value) return
  printing.value = true
  try {
    await pager.value?.preparePrint()
    window.print()
  } finally {
    printing.value = false
  }
}

function goStep(seq: number): void {
  pager.value?.goTo(seq)
}

/** 顶栏页码控件用的页名与页数：与 StepPager 内部同一套纯函数，不会各算一套。 */
const hasTail = computed(() => Boolean(guide.value?.assets?.length))
const labels = computed(() => pageLabels(guide.value?.steps ?? [], hasTail.value))
const pageTotal = computed(() => pageCount(guide.value?.steps.length ?? 0, hasTail.value))

function goPage(index: number): void {
  pager.value?.goTo(index)
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

/** 顶栏动作：探索台不带自己的头，这两个入口要由外层给。
 *  为什么是「打印视图」而不是直接 window.print()：纸上要一步一页铺开，
 *  那是阅读器的能力（StepPager.preparePrint），不在探索台里重复实现一遍。 */
const barActions = computed<TopBarAction[]>(() => {
  if (!guide.value) return []
  return [
    {
      label: starting.value ? '正在创建…' : '开始作业',
      onClick: () => void startRun(),
      disabled: starting.value,
      primary: true,
    },
    {
      label: '打印视图',
      onClick: () => void router.push({ name: 'guide-read', params: { id: props.id } }),
    },
  ]
})

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
    repairs.value = detail.repairs ?? []
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
/* 阅读器（/read）也要投稿：顶栏是全站唯一那条，页面自己不画头。
   探索台由 GuideExplorer 自己投稿，这里只管阅读器分支——按 explore 分流，
   两边同时写会把标题刷来刷去。 */
watchEffect(() => {
  if (explore.value) return
  if (!guide.value) return
  setTopBar({
    kicker: '打印视图',
    title: guide.value.title,
    progress: { label: '页码', value: page.value + 1, total: pageTotal.value },
    actions: [
      {
        label: '返回探索台',
        onClick: () => void router.push({ name: 'guide', params: { id: props.id } }),
      },
    ],
  })
})

onBeforeUnmount(() => {
  ctrl?.abort()
  resetTopBar()
})

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
/** 生成期被确定性降级掉的图示说明。空数组 = 正常生成，条子不出现。 */
const repairs = ref<string[]>([])

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

  <GuideExplorer
    v-else-if="guide && explore"
    :guide="guide"
    :page="page"
    :asset-numbers="assetNumbers"
    :actions="barActions"
    @go="gotoStep"
  />

  <article v-else-if="guide" class="card reader">
    <!-- 顶栏常驻：翻到第几步都看得见自己在读哪份、是哪个工位。
         打印时保留标题（纸质稿要有抬头），只藏按钮与返回链接。 -->
    <header class="reader__bar" :aria-label="`阅读器工具栏，第 ${page + 1} 页，共 ${pageTotal} 页`">
      <RouterLink class="reader__back no-print" to="/">‹ 列表</RouterLink>
      <h1 class="reader__title">{{ guide.title }}</h1>
      <div class="reader__tags">
        <span class="tag">{{ SYSTEM_LABEL[guide.meta.system] ?? guide.meta.system }}</span>
        <span v-if="guide.meta.station" class="tag tag--plain">工位 {{ guide.meta.station }}</span>
        <span class="tag tag--plain">{{ guide.steps.length }} 步</span>
      </div>
      <span class="reader__spacer" />
      <!-- 翻页控件与标题同一行：上一版是第二级工具栏，53px 垂直空间白白吃掉 -->
      <PagerNav
        v-if="!editing"
        class="no-print"
        :current="page"
        :labels="labels"
        @go="goPage"
      />
      <button class="btn reader__print no-print" type="button" :disabled="printing" @click="printGuide">
        <span v-if="printing">正在准备…</span>
        <template v-else>
          <span class="reader__print-long">打印 / 导出 PDF</span>
          <span class="reader__print-short">打印</span>
        </template>
      </button>
    </header>

    <div v-if="publishedBanner" class="published-banner no-print">
      <strong>已发布</strong> · {{ publishedBanner }}
      <RouterLink class="published-banner__link" to="/">去列表看</RouterLink>
    </div>
    <div v-if="guideStatus === 'draft'" class="draft-banner no-print">
      <strong>草稿</strong> · 未发布，仅通过此链接可见
    </div>
    <!-- 生成期降级提示：不提示的话，现场只会看到"这一步没有图"，
         而不知道本来该有、是被系统移除的。打印也带上——纸质稿同样需要这句话。 -->
    <div v-if="repairs.length" class="degraded-banner" role="status">
      <strong>本次生成有 {{ repairs.length }} 处图示被移除</strong>
      <span>系统在校验时发现这些图示不合法，删掉了对应步骤的图示（正文与判据未改）。可回到封面「再生成一份草稿」重试。</span>
      <ul>
        <li v-for="item in repairs" :key="item">{{ item }}</li>
      </ul>
    </div>

    <!-- 编辑态整块换成修正面板：旁边还摆着旧的那份，容易对着旧值核对 -->
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

    <StepPager
      v-else
      ref="pager"
      v-model:current="page"
      :guide-id="props.id"
      :steps="guide.steps"
      :status="guideStatus"
      :numbers="assetNumbers"
      :tail="Boolean(guide.assets?.length)"
    >
      <!-- ---------------- 封面 ---------------- -->
      <template #cover>
        <div class="cover">
          <p class="cover__eyebrow">可视化作业指导 · 共 {{ guide.steps.length }} 步</p>
          <p class="cover__title">{{ guide.title }}</p>
          <p class="cover__summary">{{ guide.summary }}</p>

          <div class="meta-row">
            <span class="tag tag--plain">{{ guide.steps.length }} 个步骤</span>
            <span class="tag tag--plain">{{ guide.meta.model }}</span>
            <span>{{ new Date(guide.meta.generated_at).toLocaleString('zh-CN') }}</span>
          </div>

          <p class="disclaimer">{{ guide.disclaimers.join(' · ') }}</p>

          <div class="meta-row no-print">
            <button class="btn btn--primary" type="button" :disabled="starting" @click="startRun">
              {{ starting ? '正在创建会话…' : '开始引导作业' }}
            </button>
            <button class="btn" type="button" @click="goStep(1)">从第 1 步看起</button>
            <button class="btn" type="button" :disabled="printing" @click="printGuide">
              {{ printing ? '正在准备打印…' : '打印 / 导出 PDF' }}
            </button>
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

          <!-- 目录：翻页的替代入口。滑不动的设备（鼠标、无触摸的工控机）靠它跳步 -->
          <nav class="cover__toc no-print" aria-label="步骤目录">
            <p class="block-label">步骤目录（点击跳到该步）</p>
            <ol class="cover__toc-list">
              <li v-for="step in guide.steps" :key="step.id">
                <button class="cover__toc-item" type="button" @click="goStep(step.seq)">
                  <span class="cover__toc-seq">{{ String(step.seq).padStart(2, '0') }}</span>
                  <span class="cover__toc-title">{{ step.title }}</span>
                  <span class="cover__toc-meta">{{ step.criteria.length }} 条判据</span>
                </button>
              </li>
            </ol>
          </nav>

          <AttachPanel
            v-if="guideStatus === 'draft' && flatAssets.length"
            v-model:message="attachMsg"
            :guide-id="props.id"
            :rows="flatAssets"
            :numbers="assetNumbers"
            :steps="guide.steps"
            @saved="load"
          />

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

        </div>
      </template>

      <!-- ---------------- 尾页：未归位的现场素材 ---------------- -->
      <template #tail>
        <div class="tail">
          <p class="tail__title">现场素材</p>
          <p class="tail__hint">未归入具体步骤的照片，编号与正文一致。</p>
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
        </div>
      </template>
    </StepPager>

  <!-- 口令弹层：修正与发布共用。
       两条硬约束：
       ① 必须能盖在任何状态之上——401 可能发生在编辑态内部，也可能发生在翻页器里；
          放在页面流里，用户会看到"请重新验证口令"却因为翻页器占满一屏而找不到输入框。
       ② 不放进封面插槽：编辑态下翻页器整块不渲染，插槽里的东西会一起消失。 -->
  <div
    v-if="passcodeOpen && guideStatus === 'draft'"
    class="sheet no-print"
    role="dialog"
    aria-modal="true"
    aria-labelledby="passcode-title"
    @keydown.esc="
      passcodeOpen = false;
      pending = null
    "
  >
    <div class="sheet__panel publish">
      <h2 id="passcode-title" class="sheet__title">验证口令</h2>
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
  </div>


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

.tail {
  height: 100%;
  overflow-y: auto;
  padding: 26px 30px 40px;
}

.tail__title {
  margin: 0 0 4px;
  font-size: 18px;
}

.tail__hint {
  margin: 0 0 14px;
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

.degraded-banner {
  margin: 0 0 16px;
  padding: 12px 14px;
  border: 1px solid #e8c88a;
  border-left: 4px solid #d99a2b;
  border-radius: var(--radius-sm);
  background: #fdf6e7;
  color: #6b4c12;
  font-size: 13px;
  line-height: 1.6;
}

.degraded-banner strong {
  display: block;
  color: #8a5b00;
}

.degraded-banner ul {
  margin: 6px 0 0;
  padding-left: 18px;
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


/* ---------- 口令弹层 ---------- */

.sheet {
  position: fixed;
  inset: 0;
  z-index: 65;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(12, 14, 18, 0.5);
}

.sheet__panel {
  width: min(440px, 100%);
  margin: 0;
  background: var(--c-surface);
}

.sheet__title {
  margin: 0 0 8px;
  font-size: 17px;
}

/* ---------- 整页阅读器（2026-11-10）----------
 * 高度按视口算：一屏就是一页，翻页只换内容，不带着整页滚。
 * `--nav-h` 是顶部导航条，扣掉它剩下的才是"一屏"。
 * 页脚留在下方（滚一下能看到）——它不是作业内容，不该占掉现场的可视高度。 */
.reader {
  display: flex;
  flex-direction: column;
  height: calc(100dvh - var(--nav-h));
  min-height: 420px;
  overflow: hidden;
  border: none;
  border-radius: 0;
  box-shadow: none;
  background: var(--c-surface);
}

.reader__bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--c-line);
}

.reader__back {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  color: var(--c-ink-2);
  font-size: 13px;
}

/* 书名已经在顶栏上了，这里退成面包屑：13px、灰、不加粗。
   h1 语义保留（读屏与打印都要它），但不再和顶栏抢"抬头"。 */
.reader__title {
  margin: 0;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.2px;
  color: var(--c-ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.reader__tags {
  flex: 0 0 auto;
  display: flex;
  gap: 6px;
}

.reader__spacer {
  flex: 1 1 auto;
}

/* 按钮文案不许换行：390px 下"打印"被挤成两行过（2026-11-10 视觉验收） */
.reader__print {
  white-space: nowrap;
}

/* 草稿/发布/降级三条横幅：都在页轨之外，翻到哪一页都看得见 */
.reader .draft-banner,
.reader .published-banner,
.reader .degraded-banner {
  flex: 0 0 auto;
  margin: 10px 14px 0;
}

/* ---------- 封面 ---------- */

.cover {
  height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 30px 32px 44px;
  max-width: 940px;
  margin: 0 auto;
}

.cover__eyebrow {
  margin: 0;
  color: var(--c-primary);
  font-size: 13px;
  letter-spacing: 0.08em;
}

.cover__title {
  margin: 0;
  font-size: 30px;
  line-height: 1.25;
  font-weight: 600;
}

.cover__summary {
  margin: 0;
  max-width: 64ch;
  color: var(--c-ink-2);
  font-size: 16px;
  line-height: 1.75;
}

.cover__toc {
  margin-top: 4px;
}

.cover__toc-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
}

.cover__toc-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: var(--tap);
  padding: 8px 12px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.cover__toc-item:hover {
  border-color: var(--c-primary-line);
  background: var(--c-primary-soft);
}

.cover__toc-seq {
  flex: 0 0 auto;
  color: var(--c-primary);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.cover__toc-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
}

.cover__toc-meta {
  flex: 0 0 auto;
  color: var(--c-ink-3);
  font-size: 12px;
}

.reader__print-short {
  display: none;
}

/* 窄屏：工具栏要装下「返回 + 标题 + 箭头 + 页码 + 跳页 + 打印」。
   390px 下长文案会把打印按钮挤出屏幕（用户 2026-11-10 截图），
   所以换短文案、缩箭头、去掉计数（下拉里已经有页码）。 */
@media (max-width: 720px) {
  .reader__tags {
    display: none;
  }

  .reader__bar {
    gap: 6px;
    padding: 8px 10px;
  }

  .reader__back {
    padding: 0 4px;
  }

  .reader__title {
    font-size: 14px;
  }

  .reader__print {
    padding: 0 10px;
  }

  .reader__print-long {
    display: none;
  }

  .reader__print-short {
    display: inline;
  }

  .cover {
    padding: 20px 18px 32px;
  }

  .cover__title {
    font-size: 23px;
  }

  .cover__summary {
    font-size: 15px;
  }
}

@media print {
  /* 打印必须还原成文档流：100dvh 会把内容裁到一屏 */
  .reader {
    height: auto;
    min-height: 0;
    overflow: visible;
  }

  .reader__bar {
    padding: 0 0 10px;
    border-bottom: 1px solid #999;
  }

  .cover,
  .tail {
    height: auto;
    overflow: visible;
    padding: 0;
    max-width: none;
  }
}

</style>
