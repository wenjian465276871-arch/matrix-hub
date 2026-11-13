<script setup lang="ts">
/** 指导书「探索台」：三栏 + 底部轨迹。
 *
 *  版式参考 https://kejun.github.io/cs-systems-design/（2026-11-11 拆其 styles.css 后重做）：
 *  左目录 / 中舞台 / 右详解 / 底轨迹，四块都是细线面板，序号用等宽字体，
 *  当前步用主色描边而不是填充——填充会把"可点"和"已选"混成一件事。
 *
 *  2026-11-11 第二版（本人裁决）：**这就是指导书的默认版式**，不再有"点阅读进度
 *  才进得来"的第二套风格。原来本组件自带的 88px 头已删除，内容改为投稿给
 *  全站唯一的 TopBar（composables/useTopBar）——页面自己再画一条头，
 *  就又会回到"两条栏叠着"的老样子。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import GuideFigure from '../../figures/GuideFigure.vue'
import { resetTopBar, setTopBar, type TopBarAction } from '../../composables/useTopBar'
import { criterionValue, provenanceText } from '../../lib/criterionfmt'
import type { AssetRef, Criterion, Guide, Step, VisualSpec } from '../../types'

const props = defineProps<{
  guide: Guide
  /** 当前步下标（0 起） */
  page: number
  /** 素材编号表：与阅读器同一份，打印/对照时编号不会各算一套 */
  assetNumbers: Record<string, number>
  /** 顶栏动作由外层给：开始作业/打印要碰路由与会话状态，不该由版式组件持有 */
  actions?: TopBarAction[]
}>()

const emit = defineEmits<{ go: [index: number] }>()

const steps = computed(() => props.guide.steps)
const step = computed<Step | undefined>(() => steps.value[props.page])
const total = computed(() => steps.value.length)

/** 步骤性质：只在眉标与轨迹表里用，判断依据是标题里的动词，**不做模型调用**。 */
const KINDS: Array<[RegExp, string]> = [
  [/准备|安全|隔离|确认条件/, '准备'],
  [/测量|测|读表|计时/, '测量'],
  [/检查|查看|外观|确认/, '检查'],
  [/记录|填写|签字/, '记录'],
]
function kindOf(s: Step): string {
  for (const [re, name] of KINDS) if (re.test(s.title)) return name
  return '作业'
}

const minutesOf = (s: Step): number | null =>
  s.duration_s === null || s.duration_s === undefined ? null : Math.round(s.duration_s / 60)

const totalMinutes = computed(() =>
  steps.value.reduce((sum, s) => sum + (minutesOf(s) ?? 0), 0),
)

/* ---------------------------------------------------------------- 左：目录 */
const query = ref('')
const filter = ref<'all' | 'figure' | 'criteria'>('all')

const hasFigure = (s: Step): boolean => s.figures.length > 0 || (s.assets?.length ?? 0) > 0

const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  return steps.value
    .map((s, index) => ({ s, index }))
    .filter(({ s }) => {
      if (filter.value === 'figure' && !hasFigure(s)) return false
      if (filter.value === 'criteria' && !s.criteria.length) return false
      if (!q) return true
      const hay = [s.title, s.action, ...s.criteria.map((c) => c.label), ...s.tools]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
})

/* ---------------------------------------------------------------- 中：舞台 */
/* 舞台里"主图"分两类，各自吃满同一块地方：
   - still：烘焙图（看这一帧的画质）
   - scene：可交互三维（拖时间轴、播放、放大看）
   两者都有时用页签切换，而不是并排——并排时每张只剩一半宽，两个都看不清。
   2026-11-11 本人明确：实物渲染图与三维画面都要保留，且都要尽可能大。 */
type StageView = 'still' | 'scene' | 'ops'

const figures = computed<VisualSpec[]>(() => step.value?.figures ?? [])

const viewGroups = computed<{ id: StageView; label: string; figs: VisualSpec[] }[]>(() => {
  const out: { id: StageView; label: string; figs: VisualSpec[] }[] = []
  const still = figures.value.filter((f) => f.primitive === 'baked_figure')
  const scene = figures.value.filter((f) => f.primitive === 'device_scene')
  // MON 屏与升弓操作台：带状态的界面，给它们一个独立页签，不与"看动作"混在一起
  const ops = figures.value.filter(
    (f) => f.primitive === 'mon_panel' || f.primitive === 'operation_scene',
  )
  if (still.length) out.push({ id: 'still', label: '实物示意图', figs: still })
  if (scene.length) out.push({ id: 'scene', label: '三维动作', figs: scene })
  if (ops.length) out.push({ id: 'ops', label: '操作台', figs: ops })
  return out
})

const view = ref<StageView>('still')
/** 当前步没有这个视图时回落到第一个可用视图：切到"三维动作"再翻到只有烘焙图的步骤，
 *  不该出现一块空白。 */
const activeView = computed(
  () => viewGroups.value.find((g) => g.id === view.value) ?? viewGroups.value[0],
)

/* 既没有烘焙图也没有三维的步骤（比如"作业前安全确认"只有一张清单图），
   把第一张 2D 图提为主图——否则它会被塞进 168px 的辅图列，一张清单缩成邮票。 */
const heroFigures = computed<VisualSpec[]>(() =>
  viewGroups.value.length ? (activeView.value?.figs ?? []) : figures.value.slice(0, 1),
)
const aidFigures = computed<VisualSpec[]>(() =>
  viewGroups.value.length
    ? figures.value.filter(
        (f) =>
          f.primitive !== 'baked_figure' &&
          f.primitive !== 'device_scene' &&
          f.primitive !== 'mon_panel' &&
          f.primitive !== 'operation_scene',
      )
    : figures.value.slice(1),
)
const assets = computed<AssetRef[]>(() => step.value?.assets ?? [])

function assetUrl(asset: AssetRef): string {
  return `/api/electro/uploads/${asset.asset_id}/${asset.asset_id}.png`
}

/* ---------------------------------------------------------------- 右：详解 */
type Tab = 'safety' | 'tools' | 'criteria' | 'note'
const tab = ref<Tab>('criteria')

const tabs = computed<{ id: Tab; label: string; n: number }[]>(() => [
  { id: 'safety', label: '安全', n: step.value?.safety.length ?? 0 },
  { id: 'tools', label: '工具', n: step.value?.tools.length ?? 0 },
  { id: 'criteria', label: '判据', n: step.value?.criteria.length ?? 0 },
  { id: 'note', label: '说明', n: 0 },
])

/** 没有安全项时不要停在空标签上——点进来第一眼是空白会被当成加载失败。 */
const activeTab = computed<Tab>(() => {
  const t = tabs.value.find((x) => x.id === tab.value)
  if (t && t.n > 0) return tab.value
  return tabs.value.find((x) => x.n > 0)?.id ?? 'note'
})

/* 判据的"目标值"与来源标签都取 lib/criterionfmt：与阅读器同一份，
   否则同一条判据在两处会显示成两种写法。 */
function criterionFlag(c: Criterion): { text: string; tone: 'ok' | 'warn' } | null {
  if (!c.provenance) return null
  return c.provenance.flag === 'ok'
    ? { text: provenanceText(c.provenance), tone: 'ok' }
    : { text: provenanceText(c.provenance), tone: 'warn' }
}

/* ---------------------------------------------------------------- 底：轨迹 */
function go(index: number): void {
  const clamped = Math.min(Math.max(index, 0), total.value - 1)
  if (clamped !== props.page) emit('go', clamped)
}

function prev(): void {
  go(props.page - 1)
}
function next(): void {
  go(props.page + 1)
}
function restart(): void {
  go(0)
}

/** 键盘：← → 逐步。输入框里不拦（搜索时按方向键要能移动光标）。 */
function onKey(e: KeyboardEvent): void {
  const el = e.target as HTMLElement | null
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
  if (e.key === 'ArrowLeft') {
    e.preventDefault()
    prev()
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    next()
  }
}

/* 当前行必须自己滚进来：轨迹表 196px 高，第 4、5 步默认在折叠线以下，
   不滚的话"当前在哪"这条信息等于没给。
   **不能用 scrollIntoView**：它会把整个 window 一起滚走，页面一打开就停在半截
   （1100×560 实测：顶部条被滚没了）。这里只动容器自己的 scrollTop。 */
/** 底轨是否展开。收起时把 148px 让给图示（487 → 635），默认展开。
 *  为什么给这个开关：车间大屏上"图更大"和"看到全流程"是两个真实需求，
 *  而它们抢的是同一块垂直空间，让本人一键切换比替他挑一个更合适。 */
const traceOpen = ref(true)

/** 本步是否有"要动手操作"的图元。短屏下用它做两件事：自动收轨迹、收掉标题块，
 *  把高度让给操作台（1090×614 实测：标题块吃掉 ~110px）。 */
const hasOpsFigure = computed(() =>
  (step.value?.figures ?? []).some((f) => f.primitive === 'operation_scene'),
)

/** 需要"整屏"的步骤：三维操作台与 MON 屏。
 *
 *  这两类图元的价值全在"看得清、点得中"：1090×614 下三栏布局会把它们压到
 *  200px 高。聚焦模式把目录 / 详解 / 轨迹全部让位，舞台独占整屏；
 *  用户点「显示目录与判据」随时回到三栏。 */
const hasStageFocus = computed(() =>
  (step.value?.figures ?? []).some(
    (f) => f.primitive === 'operation_scene' || f.primitive === 'mon_panel',
  ),
)

/** 本步主图是一台设备的静态三维（不是操作台）。
 *
 *  这类步骤一进来就要"看得出这是台什么设备"，但三栏布局里标题块 + 作业动作
 *  会先吃掉 ~200px，1090×614 下三维只剩 177px。这里只做两件低风险的事：
 *  作业动作压成一行、标题块收紧，把省下的 ~50px 让给三维。
 *  想铺满仍走「聚焦操作」——那是用户主动选择，标题与判据的取舍由他决定。 */
const hasSceneHero = computed(() =>
  (step.value?.figures ?? []).some((f) => f.primitive === 'device_scene'),
)

/** 聚焦开关。切到普通步骤自动退出，切回操作步自动进入——但不覆盖用户当次选择。 */
const focusOn = ref(false)

/* 短窗口 + 交互图元：自动把轨迹收起，把高度让给操作台。
   1090×614 实测：轨迹展开时操作区只剩 65px、三维画布 42px，点不中任何件；
   收起后舞台多出 ~250px。只在**进入这类步骤**时自动收一次，用户自己再展开就不干预。 */
let autoCollapsedTrace = false
watch(
  () => step.value?.id,
  () => {
    focusOn.value = hasStageFocus.value
    const hasOps = (step.value?.figures ?? []).some((f) => f.primitive === 'operation_scene')
    if (hasOps && traceOpen.value && window.innerHeight < 900) {
      traceOpen.value = false
      autoCollapsedTrace = true
    } else if (!hasOps && autoCollapsedTrace) {
      traceOpen.value = true
      autoCollapsedTrace = false
    }
  },
  { immediate: true },
)

const currentRow = ref<HTMLElement | null>(null)
const traceBox = ref<HTMLElement | null>(null)
watch(
  () => props.page,
  async () => {
    await nextTick()
    const box = traceBox.value
    const row = currentRow.value
    if (!box || !row) return
    const bb = box.getBoundingClientRect()
    const rb = row.getBoundingClientRect()
    if (rb.top < bb.top || rb.bottom > bb.bottom) {
      box.scrollTop += rb.top - bb.top - (bb.height - rb.height) / 2
    }
  },
  { immediate: true },
)

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  // 离开时把顶栏还回路由标题：不还的话，回到作业库还挂着上一本书的书名。
  resetTopBar()
})

const pad = (n: number): string => String(n).padStart(2, '0')

/* ---------------------------------------------------------------- 顶栏投稿 */
/* 顶栏是全站唯一的那一条（App.vue 渲染）。这里只投稿，不画头。
 * 依赖里带上 actions：外层可能在数据加载完之后才把「开始作业」塞进来。 */
watch(
  [() => props.guide.title, () => props.page, () => props.actions],
  () => {
    setTopBar({
      kicker: '正在查看',
      title: props.guide.title,
      progress: { label: '阅读进度', value: props.page + 1, total: total.value },
      actions: props.actions ?? [],
    })
  },
  { immediate: true },
)

</script>

<template>
  <div class="ex" :class="{ 'ex--focus': focusOn }">
    <!-- 页面级 h1 只能有一处：视觉上书名在顶栏，但**顶栏是全区共用的**，
         它不能在不同页面变 h1/h2。所以这里留一个只给读屏的 h1，
         路由切换后的焦点归位（router/index.ts 找 main h1）也靠它。 -->
    <h1 class="sr-only">{{ guide.title }}</h1>

    <div class="ex__grid" :class="{ 'trace-collapsed': !traceOpen, 'is-focus': focusOn }">
      <!-- 左：步骤目录 -->
      <aside class="panel ex__side" aria-label="步骤目录">
        <div class="panel-head">
          <h2>步骤目录 <span>{{ total }}</span></h2>
        </div>
        <div class="search-wrap">
          <svg class="ui-icon" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 14 14" />
          </svg>
          <input v-model="query" type="search" placeholder="搜索步骤、判据、工具…" aria-label="搜索步骤" />
        </div>
        <div class="filter-row" role="group" aria-label="筛选">
          <button type="button" :class="{ selected: filter === 'all' }" @click="filter = 'all'">全部</button>
          <button type="button" :class="{ selected: filter === 'figure' }" @click="filter = 'figure'">有图</button>
          <button type="button" :class="{ selected: filter === 'criteria' }" @click="filter = 'criteria'">有判据</button>
        </div>

        <ol class="topic-list" tabindex="0" aria-label="步骤列表（可滚动）">
          <li v-for="{ s, index } in shown" :key="s.id">
            <button
              class="topic"
              type="button"
              :class="{ active: index === page, done: index < page }"
              :aria-current="index === page ? 'step' : undefined"
              :title="s.title"
              @click="go(index)"
            >
              <span class="topic-dot" aria-hidden="true" />
              <span class="topic-body">
                <strong>{{ s.title }}</strong>
                <small>STEP {{ pad(s.seq) }} · {{ kindOf(s) }}<template v-if="s.criteria.length"> · 判据 {{ s.criteria.length }}</template></small>
              </span>
              <span class="chev" aria-hidden="true">›</span>
            </button>
            <!-- 当前步展开它的判据：目录本身就是导航，不该再点一次才知道这一步要验收什么 -->
            <ol v-if="index === page && s.criteria.length" class="topic-steps">
              <li v-for="(c, i) in s.criteria" :key="c.id" class="topic-step">
                <span>{{ i + 1 }}</span>{{ c.label }}
              </li>
            </ol>
          </li>
          <li v-if="!shown.length" class="empty">没有匹配的步骤。清掉搜索词或换一个筛选条件。</li>
        </ol>

        <div class="sidebar-foot">
          <span class="live-dot" aria-hidden="true" />
          {{ total }} 步<template v-if="totalMinutes > 0"> · 预计 {{ totalMinutes }} 分钟</template>
        </div>
      </aside>

      <!-- 中：步骤舞台 -->
      <section
        class="panel ex__stage"
        :class="{ 'ex__stage--ops': hasOpsFigure, 'ex__stage--scene': hasSceneHero }"
        aria-labelledby="ex-stage-title"
      >
        <!-- 顶行：看哪一种图。实物示意图与三维动作各自吃满同一块舞台，
             而不是并排各占一半——两个都看不清等于两个都没有。 -->
        <div v-if="focusOn" class="focus-bar">
          <button
            class="focus-arrow"
            type="button"
            aria-label="上一步"
            :disabled="page === 0"
            @click="prev"
          >
            ‹
          </button>
          <label class="focus-step">
            <span class="sr-only">跳到步骤</span>
            <select :value="String(page)" @change="go(Number(($event.target as HTMLSelectElement).value))">
              <option v-for="(s, i) in steps" :key="s.id" :value="String(i)">
                {{ pad(s.seq) }} · {{ s.title }}
              </option>
            </select>
          </label>
          <button
            class="focus-arrow"
            type="button"
            aria-label="下一步"
            :disabled="page >= total - 1"
            @click="next"
          >
            ›
          </button>
          <span class="focus-note">三维实时渲染 · 拖动旋转 / 滚轮缩放 / 点件操作</span>
          <button class="focus-exit" type="button" @click="focusOn = false">显示目录与判据</button>
        </div>

        <div v-else class="stage-toolbar">
          <div v-if="viewGroups.length > 1" class="view-tabs" role="tablist" aria-label="图示种类">
            <button
              v-for="g in viewGroups"
              :key="g.id"
              type="button"
              role="tab"
              :aria-selected="activeView?.id === g.id"
              @click="view = g.id"
            >
              {{ g.label }}
            </button>
          </div>
          <span v-else class="view-static">步骤图示</span>
          <button
            v-if="hasStageFocus"
            class="focus-enter"
            type="button"
            @click="focusOn = true"
          >
            聚焦操作（铺满整屏）
          </button>
          <span class="model-label">图示为自动生成，非实测照片</span>
        </div>

        <!-- 标题压到两行：眉标（步骤 / 性质 / 工具 / 耗时）＋ 标题。
             原来标题 23px 加一个 52px 的序号占掉 80px，图示只剩 100px——
             那才是"画面太小"的根因，不是图本身的问题。 -->
        <div class="scene-heading">
          <div class="scene-heading__main">
            <p class="eyebrow">
              <span>STEP {{ pad(step?.seq ?? 0) }} · {{ step ? kindOf(step) : '—' }}</span>
              <template v-if="step?.tools.length">
                <span class="eyebrow-sep" aria-hidden="true">|</span>
                <span class="eyebrow-sub">工具 {{ step.tools.join('、') }}</span>
              </template>
              <template v-if="step && minutesOf(step) !== null">
                <span class="eyebrow-sep" aria-hidden="true">|</span>
                <span class="eyebrow-sub">预计 {{ minutesOf(step) }} 分钟</span>
              </template>
            </p>
            <h2 id="ex-stage-title">{{ step?.title ?? '' }}</h2>
          </div>
          <!-- 大号序号用水印**图形**而不是文字节点：它是纯装饰（序号在眉标、
               轨迹表里都有），而 56px 的极淡主色做文字节点过不了 3:1。
               写成 SVG 后语义上确实不是文本，读屏与 axe 都不再把它当正文。 -->
          <svg class="scene-index" viewBox="0 0 150 64" aria-hidden="true" focusable="false">
            <text x="148" y="52" text-anchor="end">{{ pad(step?.seq ?? 0) }}</text>
          </svg>
        </div>

        <div class="diagram">
          <div v-if="heroFigures.length || aidFigures.length" class="diagram__stack">
            <!-- 主图吃满舞台；辅图退到下面一条 92px 的带子里横向排。
                两张图平分 260px 的舞台时，主图会缩成邮票大小——第一版就是这样。 -->
            <div v-if="heroFigures.length" class="diagram__main">
              <GuideFigure v-for="(f, i) in heroFigures" :key="`h-${i}`" :spec="f" />
            </div>
            <div
              v-if="aidFigures.length"
              class="diagram__aids"
              tabindex="0"
              role="region"
              aria-label="辅助图示（可滚动）"
            >
              <!-- 辅图区只有 184px 宽：表格/清单在上面读不清，所以整块可点放大，
                   同时保留一个角标按钮给键盘用户 -->
              <GuideFigure
                v-for="(f, i) in aidFigures"
                :key="`a-${i}`"
                :spec="f"
                zoom-on-click
              />
            </div>
          </div>
          <div v-else-if="assets.length" class="diagram__assets">
            <figure v-for="asset in assets" :key="asset.asset_id" class="asset">
              <img :src="assetUrl(asset)" :alt="asset.caption" loading="lazy" decoding="async" />
              <figcaption>图 {{ assetNumbers[asset.asset_id] }} · {{ asset.caption }}</figcaption>
            </figure>
          </div>
          <p v-else class="empty">
            本步暂无可视化图示，也未附现场素材。请以右侧文字与验收判据为准。
          </p>
        </div>

        <div class="scene-caption">
          <span class="step-chip">{{ pad(step?.seq ?? 0) }}</span>
          <div>
            <strong>作业动作</strong>
            <p :title="step?.action">{{ step?.action ?? '' }}</p>
          </div>
        </div>
      </section>

      <!-- 右：要点详解 -->
      <aside class="panel ex__inspect" aria-label="要点详解">
        <div class="panel-head">
          <h2>要点详解</h2>
          <span>{{ pad(step?.seq ?? 0) }}</span>
        </div>
        <div class="detail-tabs" role="tablist" aria-label="详解分类">
          <button
            v-for="t in tabs"
            :key="t.id"
            type="button"
            role="tab"
            :aria-selected="activeTab === t.id"
            :disabled="t.n === 0 && t.id !== 'note'"
            @click="tab = t.id"
          >
            {{ t.label }}<em v-if="t.n">{{ t.n }}</em>
          </button>
        </div>

        <div class="detail-content" role="tabpanel" tabindex="0">
          <template v-if="activeTab === 'safety'">
            <h3>安全措施</h3>
            <ul class="safety">
              <li v-for="s in step?.safety" :key="s">{{ s }}</li>
            </ul>
          </template>

          <template v-else-if="activeTab === 'tools'">
            <h3>工具与仪表</h3>
            <div class="tool-list">
              <span v-for="t in step?.tools" :key="t">{{ t }}</span>
            </div>
            <p v-if="step && minutesOf(step) !== null" class="detail-note">
              本步预计耗时 {{ minutesOf(step) }} 分钟。
            </p>
          </template>

          <template v-else-if="activeTab === 'criteria'">
            <h3>验收判据</h3>
            <p class="detail-note">判据不达标不得进入下一步；待核项需回原始资料确认。</p>
            <div class="crit-list">
              <div v-for="c in step?.criteria" :key="c.id" class="crit">
                <div class="crit__head">
                  <span class="crit__label">{{ c.label }}</span>
                  <span v-if="criterionFlag(c)" class="crit__flag" :class="`crit__flag--${criterionFlag(c)?.tone}`">
                    {{ criterionFlag(c)?.text }}
                  </span>
                </div>
                <div class="crit__value">
                  {{ criterionValue(c) }}<span v-if="c.unit">{{ c.unit }}</span>
                </div>
              </div>
            </div>
          </template>

          <template v-else>
            <h3>来源与说明</h3>
            <p class="detail-note">{{ guide.meta.source_note }}</p>
            <div class="detail-section">
              <h4>本份指导书</h4>
              <p class="detail-note">
                {{ guide.summary }}
              </p>
            </div>
            <div class="detail-section">
              <h4>元信息</h4>
              <p class="detail-note">
                生成时间 {{ guide.meta.generated_at }}<br />
                模型 {{ guide.meta.model }}<br />
                <template v-if="guide.meta.station">工位 {{ guide.meta.station }}<br /></template>
                图示与参数为演示虚构值，不代表任何车型图纸或实测结果。
              </p>
            </div>
          </template>
        </div>
      </aside>

      <!-- 底：步骤轨迹 -->
      <section class="panel ex__trace" :class="{ 'is-collapsed': !traceOpen }" aria-label="步骤轨迹">
        <div class="flow-toolbar">
          <h2>步骤轨迹 <span>{{ pad(page + 1) }} / {{ pad(total) }}</span></h2>
          <button
            class="trace-toggle"
            type="button"
            :aria-expanded="traceOpen"
            @click="traceOpen = !traceOpen"
          >
            {{ traceOpen ? '收起轨迹，放大图示' : '展开轨迹表' }}
          </button>
          <div class="controls">
            <button type="button" :disabled="page === 0" title="上一步（←）" @click="prev">‹</button>
            <button class="play-button" type="button" :disabled="page >= total - 1" @click="next">
              下一步 ›
            </button>
            <button type="button" title="回到第一步" @click="restart">⟲</button>
          </div>
        </div>
        <div
          ref="traceBox"
          class="trace-scroll"
          tabindex="0"
          role="region"
          aria-label="步骤轨迹表（可滚动）"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">步骤</th>
                <th scope="col">名称</th>
                <th scope="col">性质</th>
                <th scope="col">验收判据</th>
                <th scope="col">状态</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(s, i) in steps"
                :key="s.id"
                :ref="i === page ? (el) => (currentRow = el as HTMLElement | null) : undefined"
                :class="{ current: i === page, done: i < page }"
                tabindex="0"
                @click="go(i)"
                @keydown.enter.prevent="go(i)"
                @keydown.space.prevent="go(i)"
              >
                <td><span class="row-no">{{ pad(s.seq) }}</span></td>
                <td class="cell-name">{{ s.title }}</td>
                <td>{{ kindOf(s) }}</td>
                <td class="cell-crit">
                  {{ s.criteria[0]?.label ?? '—' }}<template v-if="s.criteria.length > 1"> 等 {{ s.criteria.length }} 项</template>
                </td>
                <td class="cell-state">{{ i === page ? '进行中' : i < page ? '已读' : '待读' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="flow-foot">
          <span>点击行跳转；键盘 ← → 逐步探索；Space 无绑定（避免误触翻页）</span>
          <span>{{ guide.steps.length }} 步 · 判据共 {{ guide.steps.reduce((n, s) => n + s.criteria.length, 0) }} 项</span>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* 版式令牌只在本组件内生效：三栏宽度与参考站一致（258/1fr/310）。
   2026-11-11：本条不再自带顶栏——顶栏是全站唯一那条（TopBar），
   原来那 120 行 .ex__bar 已随模板一起删掉。 */
.ex {
  --ex-side: 258px;
  --ex-inspect: 310px;
  --ex-gap: 12px;
  --ex-ink: var(--c-ink);
  --ex-muted: var(--c-ink-3);
  display: flex;
  flex-direction: column;
  gap: var(--ex-gap);
  padding: 14px;
  background: var(--c-bg);
  /* 定高而不是"至少一屏"：参考站的做法是四块面板撑满视口、各自内部滚动。
     用 min-height 时底部轨迹会被顶到折叠线以下——第一版就是这么丢的。 */
  height: calc(100dvh - var(--nav-h));
  min-height: 600px;
  overflow: hidden;
}

/* ---------------------------------------------------------------- 栅格 */
.ex__grid {
  display: grid;
  gap: var(--ex-gap);
  grid-template-columns: var(--ex-side) minmax(0, 1fr) var(--ex-inspect);
  /* 底轨 250（与参考站同值）：表头 26 + 5 行 ×30 + 页脚 30 + 工具栏 44 = 250，
     刚好一屏看完 5 步不滚动。7 步的指导书会滚动——那是"当前行自动滚入"负责的事。 */
  grid-template-rows: minmax(380px, 1fr) 252px;
  /* min-height: 0 与 flex: 1 必须留在 .ex__grid 本体上。
     2026-11-11 把它们误挪进下面的 .trace-collapsed 块，结果是
     栅格容器被内容撑到 1119px（应 902），整页溢出、图片按宽度铺成 681 高被裁。 */
  min-height: 0;
  flex: 1;
}

/* 收起底轨：图示多拿 166px。
   默认展开——轨迹表是"我在整份流程的哪儿"的唯一视图，收起是主动选择。
   注意：2.1:1 的图在这是**宽度受限**的，多给高度不会让它变大；
   真正"看得更大"靠图右上角的「放大看」（全屏按原分辨率铺）。 */
.ex__grid.trace-collapsed {
  grid-template-rows: minmax(380px, 1fr) 46px;
}
/* 收起时辅图列一起让位：主图是 2.1:1，多给高度它不会变大（宽度才是瓶颈），
   所以真正让图变大的是**把辅图那 220px 拿回来**（850 → 1078 宽）。
   这是"收起轨迹，放大图示"这个名字该有的效果；不这么做，按钮只兑现了一半。 */
.ex__grid.trace-collapsed .diagram__aids {
  display: none;
}

/* ---------------------------------------------------------------- 聚焦模式
   操作台与 MON 屏的可用性全押在尺寸上：三栏布局在 1090×614 下只给它们
   200px 高，点不中、读不清。聚焦时把目录 / 详解 / 轨迹整体让位，
   舞台独占一屏；顶栏换成一个步骤下拉 + 前后箭头，导航不丢。 */
.ex.ex--focus {
  /* 必须写成 .ex.ex--focus：<1180 的媒体查询里有一条 `.ex { height:auto }`，
     同为单类选择器且在后面，单靠 `.ex--focus` 会被它盖掉（实测舞台撑到 731px）。 */
  height: calc(100dvh - var(--nav-h));
  /* 基础规则里有 min-height:600px：614 高的窗口下它会顶出 42px，
     MON 屏底部被裁掉。聚焦模式必须让高度完全由视口决定。 */
  min-height: 0;
  overflow: hidden;
}
.ex--focus .ex__grid,
.ex__grid.is-focus {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
}
.ex--focus .ex__side,
.ex--focus .ex__inspect,
.ex--focus .ex__trace {
  display: none;
}
.ex--focus .ex__stage {
  grid-column: 1;
  grid-row: 1;
  /* 覆盖 <1180 的那条定高：聚焦时舞台由栅格行决定，不再按内容撑 */
  height: auto;
  min-height: 0;
}
.ex--focus .scene-heading,
.ex--focus .scene-caption,
.ex--focus .diagram__aids {
  display: none;
}
.ex--focus .diagram {
  padding: 4px 10px 6px;
}
/* 聚焦时 GuideFigure 自己的题注（"司机操纵台：点钥匙…"）与顶栏、HUD 重复，
   却在 1090×614 下吃掉 24px——正好是三维缺的高度。 */
.ex--focus .diagram__main :deep(.figure > figcaption) {
  display: none;
}

.focus-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--c-line-soft);
  background: var(--c-bg);
}
.focus-arrow {
  flex: none;
  width: 34px;
  height: 32px;
  border: 1px solid var(--c-line);
  border-radius: 4px;
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.focus-arrow:disabled {
  color: var(--c-ink-3);
  cursor: default;
}
.focus-step {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
}
.focus-step select {
  width: 100%;
  min-width: 0;
  height: 32px;
  padding: 0 8px;
  border: 1px solid var(--c-line);
  border-radius: 4px;
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
  font-size: 13px;
}
.focus-note {
  color: var(--ex-muted);
  font-size: 11.5px;
  white-space: nowrap;
}
.focus-exit,
.focus-enter {
  flex: none;
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid var(--c-primary-line);
  border-radius: 4px;
  background: var(--c-primary-soft);
  color: var(--c-primary-ink);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}
.focus-enter {
  margin-left: auto;
  margin-right: 10px;
}
@media (max-width: 720px) {
  .focus-note {
    display: none;
  }
}
.panel {
  border: 1px solid var(--c-line);
  background: var(--c-surface);
  min-width: 0;
  /* grid item 默认 min-height:auto：图一高就把行撑破，舞台跟着长高、整页溢出。
     必须是 0，让"内容超了就内部滚动/收缩"，而不是"内容多高舞台就多高"。 */
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.panel-head {
  height: 52px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  border-bottom: 1px solid var(--c-line-soft);
}
.panel-head h2 {
  margin: 0;
  font-size: 16px;
  letter-spacing: 1px;
  font-weight: 650;
  color: var(--c-ink);
}
.panel-head h2 span {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ex-muted);
  margin-left: 6px;
}
.panel-head > span {
  background: var(--c-primary-soft);
  color: var(--c-primary-ink);
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 2px 6px;
}

.ex__side {
  grid-row: 1 / 3;
}

/* ---------------------------------------------------------------- 左栏 */
.search-wrap {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 10px 10px 8px;
  padding: 7px 9px;
  background: var(--c-bg);
  border: 1px solid var(--c-line-soft);
}
.search-wrap .ui-icon {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: var(--ex-muted);
  stroke-width: 1.6;
  flex: none;
}
.search-wrap input {
  width: 100%;
  min-width: 0;
  border: 0;
  background: none;
  color: var(--c-ink);
  font: inherit;
  font-size: 13px;
  outline: none;
}
.filter-row {
  display: flex;
  margin: 0 10px 8px;
  border: 1px solid var(--c-line);
}
.filter-row button {
  background: var(--c-surface);
  flex: 1;
  padding: 6px 0;
  font-size: 12px;
  color: var(--c-ink-3);
  border-right: 1px solid var(--c-line-soft);
}
.filter-row button:last-child {
  border-right: 0;
}
.filter-row .selected {
  background: var(--c-primary);
  color: var(--c-on-primary);
}

.topic-list {
  flex: 1;
  overflow: auto;
  margin: 0;
  padding: 0 10px 12px;
  list-style: none;
  scrollbar-width: thin;
}
.topic {
  width: 100%;
  background: transparent;
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 52px;
  padding: 7px 8px;
  text-align: left;
  border: 1px solid transparent;
  border-bottom: 1px solid var(--c-line-soft);
  color: var(--c-ink);
}
.topic-dot {
  width: 9px;
  height: 9px;
  flex: none;
  border: 1.5px solid var(--c-line);
  border-radius: 50%;
}
.topic.done .topic-dot {
  background: var(--c-primary);
  border-color: var(--c-primary);
  box-shadow: inset 0 0 0 2px var(--c-surface);
}
.topic-body {
  min-width: 0;
  flex: 1;
}
.topic strong {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
}
.topic small {
  display: block;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.3px;
  color: var(--ex-muted);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.topic .chev {
  font-size: 17px;
  color: var(--ex-muted);
}
.topic.active {
  border-color: var(--c-primary);
  background: var(--c-primary-soft);
  color: var(--c-primary-ink);
}
.topic.active .chev {
  color: var(--c-primary);
}
/* 选中卡片是 primary-soft 底，ink-3 的 10px 小字在暗色下只有 3.4:1；
   换成 primary-ink（亮/暗都 >8:1）。 */
.topic.active small {
  color: var(--c-primary-ink);
}
/* 选中卡片是 primary-soft 底，ink-3 的 10px 小字在暗色下只有 3.4:1；
   换成 primary-ink（亮/暗都 >8:1）。 */
.topic.active small {
  color: var(--c-primary-ink);
}
.topic-steps {
  position: relative;
  margin: 0;
  padding: 6px 4px 10px 22px;
  list-style: none;
}
.topic-steps::before {
  content: '';
  position: absolute;
  left: 16px;
  top: 10px;
  bottom: 14px;
  border-left: 1px dashed var(--c-line);
}
.topic-step {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
  color: var(--c-ink-2);
}
.topic-step span {
  width: 16px;
  height: 16px;
  display: grid;
  place-items: center;
  flex: none;
  border: 1px solid var(--c-primary-line);
  border-radius: 50%;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--c-primary-ink);
  background: var(--c-surface);
}
.sidebar-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid var(--c-line-soft);
  font-size: 11px;
  color: var(--ex-muted);
}
.live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--c-success);
}

/* ---------------------------------------------------------------- 中栏 */
.stage-toolbar {
  height: 52px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  border-bottom: 1px solid var(--c-line-soft);
}
.view-tabs {
  display: flex;
  border: 1px solid var(--c-line);
}
.view-tabs button {
  background: var(--c-surface);
  font-size: 12px;
  padding: 6px 11px;
  color: var(--c-ink-2);
  border: 0;
  cursor: pointer;
}
.view-tabs button[aria-selected='true'] {
  background: var(--c-primary);
  color: var(--c-on-primary);
}
/* 只有一种图时不给页签：两个按钮里有一个永远 disabled，是噪音 */
.view-static {
  font-size: 12px;
  letter-spacing: 0.6px;
  color: var(--c-ink-3);
}
.model-label {
  font-size: 11px;
  letter-spacing: 0.4px;
  color: var(--ex-muted);
  white-space: nowrap;
}
.scene-heading {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 22px 8px;
  flex: none;
}
.scene-heading__main {
  min-width: 0;
  flex: 1;
}
.eyebrow {
  margin: 0 0 5px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 1.4px;
  color: var(--c-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.eyebrow-sep {
  color: var(--c-line);
}
.eyebrow-sub {
  font-family: var(--font-sans);
  letter-spacing: 0.2px;
  color: var(--c-ink-3);
}
.scene-heading h2 {
  margin: 0;
  font-size: 21px;
  line-height: 1.28;
  letter-spacing: 0.7px;
  font-weight: 600;
  color: var(--c-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 大号序号是水印不是标题：参考站给到 56px / 字距 -4px / 主色 16% 淡染。
   它必须在图示**上层之外的角落**，且不参与点击（pointer-events: none）。 */
.scene-index {
  position: absolute;
  top: 6px;
  right: 18px;
  width: 150px;
  height: 64px;
  pointer-events: none;
  user-select: none;
}
.scene-index text {
  font-family: var(--font-mono);
  font-size: 56px;
  letter-spacing: -4px;
  fill: color-mix(in srgb, var(--c-primary) 16%, var(--c-surface));
}
/* 舞台底：等轴测网格。参考站用两道 30°/150° 渐变叠出"斜向菱形格"，
   这是整页"工程制图"气质的来源——纯白底会让透明背景的渲染图浮不起来。 */
.diagram {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
  justify-content: center;
  padding: 6px 14px 4px;
  overflow: hidden;
  background-image:
    linear-gradient(
      30deg,
      transparent 49.4%,
      color-mix(in srgb, var(--c-line) 26%, transparent) 50%,
      transparent 50.6%
    ),
    linear-gradient(
      150deg,
      transparent 49.4%,
      color-mix(in srgb, var(--c-line) 26%, transparent) 50%,
      transparent 50.6%
    );
  background-size: 36px 62px;
}
.diagram__stack {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: row;
  gap: 8px;
  min-height: 0;
}
.diagram__main {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 8px;
}
/* 辅图放右侧竖列，不占主图的高度：舞台只有 ~300px，横向铺一条 92px 的带子
   会把主图压到 190px 高（3:2 的图只剩 285px 宽），还不如阅读器里的缩略图。 */
.diagram__aids {
  flex: none;
  /* 220 而不是更窄：主图的宽度受高度限制（730 < 1150），辅图加宽**不损失主图**，
     而 168px 下清单类 SVG 每行只有五六个字，等于不可读。 */
  width: 220px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
}
.diagram__aids :deep(figure) {
  flex: none;
  border: 1px solid var(--c-line);
  margin: 0;
}
/* 主图不再描边：图是透明背景的渲染片（2026-11-11 重烘），描边会画出
   一整块"空框"——框住的是舞台不是设备。三维画布自带底色，单独给它描边。 */
.diagram__main :deep(figure) {
  border: 0;
  /* base.css 给 .figure 留了 12px 内边距（阅读器里图要离文字远一点）。
     舞台里这 24×24 是纯损耗——四周本来就有面板与舞台的留白。 */
  padding: 0;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin: 0;
}
/* 舞台是定高的：图必须按 max-height 收缩，否则 1200×800 的烘焙图按宽度铺开
   （高度 467px）会把 260px 的舞台撑出滚动条，画面被裁掉下半截。 */
.diagram__stack :deep(.figure__canvas) {
  flex: 1;
  /* height: 100% 是给图片用的基准：img 的 height:100% 只有在父级高度可解析时才算数，
     否则回退到按宽度铺开（1200×800 的图在 1022 宽处变成 681 高，超出 537 的舞台）。 */
  height: 100%;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
/* 2D 原语（清单/仪表/接线）是内联 SVG：默认 width:100%，高度随比例走，
   在 200px 高的舞台里会被裁掉下半截。给一个 max-height，让 preserveAspectRatio
   自己把内容缩进框里。 */
.diagram__main :deep(svg) {
  max-height: 100%;
}
/* 必须 width/height 都写满再 contain，不能靠 max-width + max-height：
   百分比 max-height 在"高度由 flex 解算"的父级里解析成 auto，于是 1200×800 的图
   按宽度铺成 1022×681，超出 537 的舞台被裁掉下沿（1920 实测）。
   写满 + object-fit: contain 是唯一不依赖父级高度可解析性的做法。 */
/* 特异性要压过 BakedFigure 自己的 `.baked`（也是 width:100% + height:auto，
   同为 0,2,0，而组件 CSS 后插入会赢）。所以这里用三级选择器，并且必须写死
   height:100% + object-fit: contain——百分比 max-height 在"高度由 flex 解算"的
   父级里解析成 auto，图会按宽度铺成 1022×681，超出 537 的舞台被裁掉下沿（1920 实测）。 */
.diagram__main :deep(.figure__canvas .baked) {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
/* 图注压到一行 22px：它只说"这张画的是什么"（弓头与滑板），
   不是标题。原来这里的选择器写错了类名（.figure__cap），注脚按默认行高
   吃掉 48px，实测画布只剩 365/413——图小一圈的元凶之一。 */
.diagram__stack :deep(.figure__caption) {
  flex: none;
  margin: 0 0 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.6px;
  line-height: 1.5;
  color: var(--c-ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 舞台里的图必须首屏就画：content-visibility:auto 会在滚动时重算高度，
   在这里只会制造抖动，省不下什么。 */
.diagram__stack :deep(.figure__canvas) {
  content-visibility: visible;
}

/* 三维在探索台里必须"塞满"而不是守 3:2：DeviceScene 的 .scene 默认 aspect-ratio: 3/2，
   宽 900 时高 600，比舞台还高，下沿（读数与控制条）会被裁掉。
   flex 链要一路通到 .scene，断在任何一级都拿不到确定高度。 */
.diagram__main :deep(.ops) {
  width: 100%;
  height: 100%;
}

.diagram__main :deep(.device) {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.diagram__main :deep(.device > .scene) {
  flex: 1 1 auto;
  height: auto;
  aspect-ratio: auto;
  min-height: 0;
  border: 1px solid var(--c-line);
}
.diagram__main :deep(.device__controls) {
  flex: none;
  margin-top: 6px;
}
.diagram__main :deep(.device__note) {
  flex: none;
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.4;
  /* 舞台高度就是"画面"，这句提示留一行即可，不换行 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 三维的"放大看"入口：舞台已经很大，但全屏仍是要给的能力（本人明确要求） */
.diagram__main :deep(.figure__zoom) {
  background: var(--c-surface);
}
.diagram__assets {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: center;
}
.asset {
  margin: 0;
  max-width: 46%;
}
.asset img {
  width: 100%;
  height: auto;
  display: block;
  border: 1px solid var(--c-line);
}
.asset figcaption {
  font-size: 11px;
  color: var(--ex-muted);
  margin-top: 4px;
}
/* 作业动作卡：原来 padding 10 + 不截断，一条长动作能占 90px。
   压到两行、完整文本走 title —— 详细描述在右栏"说明"页签里另有全文。 */
.scene-caption {
  flex: none;
  display: flex;
  gap: 12px;
  margin: 0 18px 14px;
  padding: 12px;
  border: 1px solid var(--c-line-soft);
  background: var(--c-surface);
  box-shadow: var(--shadow-1);
}
.step-chip {
  width: 28px;
  height: 28px;
  flex: none;
  display: grid;
  place-items: center;
  background: var(--c-primary);
  color: var(--c-on-primary);
  font-family: var(--font-mono);
  font-size: 14px;
}
.scene-caption strong {
  font-size: 14px;
  color: var(--c-ink);
  letter-spacing: 0.2px;
}
.scene-caption p {
  margin: 3px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--c-ink-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* ---------------------------------------------------------------- 右栏 */
.ex__inspect {
  min-height: 0;
}
.detail-tabs {
  display: flex;
  flex: none;
  border-bottom: 1px solid var(--c-line-soft);
  padding: 0 10px;
}
.detail-tabs button {
  background: transparent;
  flex: 1;
  padding: 9px 4px;
  font-size: 12px;
  color: var(--c-ink-3);
  border-bottom: 2px solid transparent;
}
.detail-tabs button em {
  font-style: normal;
  font-family: var(--font-mono);
  font-size: 10px;
  margin-left: 3px;
  color: var(--ex-muted);
}
.detail-tabs button[aria-selected='true'] {
  color: var(--c-primary);
  border-bottom-color: var(--c-primary);
}
.detail-tabs button:disabled {
  opacity: 0.4;
}
.detail-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 14px 16px 18px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--c-ink-2);
  scrollbar-width: thin;
}
.detail-content h3 {
  margin: 0 0 8px;
  font-family: var(--font-mono);
  font-size: 14px;
  letter-spacing: 0.4px;
  color: var(--c-primary-ink);
}
.detail-note {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--c-ink-3);
  line-height: 1.75;
}
.safety {
  list-style: none;
  margin: 0;
  padding: 0;
}
.safety li {
  position: relative;
  padding-left: 14px;
  margin-bottom: 8px;
  font-size: 13px;
  color: var(--c-ink);
}
.safety li::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  width: 5px;
  height: 5px;
  background: var(--c-warning);
}
.tool-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tool-list span {
  border: 1px solid var(--c-line);
  padding: 3px 8px;
  font-size: 12px;
  color: var(--c-ink);
}
.crit-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.crit {
  border: 1px solid var(--c-line-soft);
  border-left: 2px solid var(--c-primary);
  padding: 8px 10px;
}
.crit__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.crit__label {
  font-size: 12px;
  color: var(--c-ink-3);
}
.crit__flag {
  font-size: 10px;
  padding: 1px 5px;
  border: 1px solid;
}
.crit__flag--ok {
  color: var(--c-success);
  border-color: var(--c-success);
}
.crit__flag--warn {
  color: var(--c-warning);
  border-color: var(--c-warning-line);
  background: var(--c-warning-soft);
}
.crit__value {
  font-family: var(--font-mono);
  font-size: 15px;
  color: var(--c-ink);
  margin-top: 2px;
}
.crit__value span {
  font-size: 11px;
  color: var(--c-ink-3);
  margin-left: 3px;
}
.crit__note {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--ex-muted);
}
.detail-section {
  border-top: 1px solid var(--c-line-soft);
  margin-top: 12px;
  padding-top: 10px;
}
.detail-section h4 {
  margin: 0 0 6px;
  font-size: 11px;
  letter-spacing: 1px;
  font-weight: 500;
  color: var(--ex-muted);
}

/* ---------------------------------------------------------------- 底栏 */
/* 2026-11-11 修：原来这里把 `.trace-scroll` 和 `.trace-toggle` 写在同一个
   选择器组里，收起时**整块表格容器被刷成了按钮样式**（描边 + 3px 内边距），
   表格还留在 42px 的行高里，看起来像一条断层。收起就是收起：表格与页脚
   一起消失，只留工具栏，开关自己留在原位。 */
.ex__trace.is-collapsed .trace-scroll,
.ex__trace.is-collapsed .flow-foot {
  display: none;
}
.ex__trace.is-collapsed .flow-toolbar {
  border-bottom: none;
  height: 100%;
}
.ex__trace.is-collapsed .trace-toggle {
  margin-left: auto;
}
.trace-toggle {
  margin-left: auto;
  margin-right: 4px;
  padding: 5px 9px;
  border: 1px solid var(--c-line);
  background: var(--c-surface);
  color: var(--c-ink-2);
  font-size: 11px;
  letter-spacing: 0.3px;
  white-space: nowrap;
  cursor: pointer;
}
.trace-toggle:hover {
  color: var(--c-primary);
  border-color: var(--c-primary-line);
  background: var(--c-primary-soft);
}
.ex__trace {
  grid-column: 2 / 4;
}
.flow-toolbar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 14px;
  min-height: 44px;
  border-bottom: 1px solid var(--c-line-soft);
}
.flow-toolbar h2 {
  margin: 0;
  font-size: 15px;
  letter-spacing: 0.8px;
  white-space: nowrap;
}
.flow-toolbar h2 span {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ex-muted);
  margin-left: 8px;
  letter-spacing: 0;
}
.controls {
  display: flex;
  gap: 5px;
  align-items: center;
}
.controls button {
  background: var(--c-surface);
  height: 30px;
  min-width: 32px;
  padding: 0 10px;
  border: 1px solid var(--c-line);
  font-size: 12px;
  color: var(--c-ink);
  cursor: pointer;
}
.controls .play-button {
  background: var(--c-primary);
  border-color: var(--c-primary);
  color: var(--c-on-primary);
  min-width: 86px;
}
.controls button:disabled {
  color: var(--c-ink-3);
  border-color: var(--c-line-soft);
  background: var(--c-surface);
}
.trace-scroll {
  flex: 1;
  overflow: auto;
  padding: 0 8px;
  scrollbar-width: thin;
}
table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
}
th {
  position: sticky;
  top: 0;
  background: var(--c-surface);
  color: var(--ex-muted);
  font-size: 10px;
  letter-spacing: 1px;
  font-weight: 500;
  padding: 5px 9px;
  border-bottom: 1px solid var(--c-line-soft);
  white-space: nowrap;
}
/* 行高 31（= 12px 字 + 2×3 内边距 + 行高）：5 步必须一屏看完。
   34 是"好看"的高度，但 5 行就会把第 5 步推到滚动线以下，
   而"我在整份流程的哪儿"正是这张表唯一的作用。 */
td {
  font-size: 12px;
  padding: 3px 9px;
  border-bottom: 1px solid var(--c-line-soft);
  color: var(--c-ink-3);
  white-space: nowrap;
}
tbody tr {
  cursor: pointer;
}
tbody tr:hover {
  background: var(--c-bg);
}
tbody tr.current {
  background: var(--c-primary-soft);
  color: var(--c-ink);
}
/* td 自己带颜色，会盖过 tr 的继承；当前行必须整行都提到 ink，
   否则 primary-soft 上的 ink-3 在暗色下只有 3.4:1。 */
tbody tr.current td {
  color: var(--c-ink);
}
tbody tr.done {
  color: var(--c-ink-2);
}
.row-no {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: 1px solid var(--c-line);
  border-radius: 50%;
  font-family: var(--font-mono);
  font-size: 10px;
}
.current .row-no {
  background: var(--c-primary);
  border-color: var(--c-primary);
  color: var(--c-on-primary);
}
.cell-name {
  color: var(--c-ink);
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cell-crit {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cell-state {
  font-family: var(--font-mono);
  font-size: 11px;
}
.current .cell-state {
  color: var(--c-primary);
}
.flow-foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 2px 14px;
  border-top: 1px solid var(--c-line-soft);
  font-size: 11px;
  color: var(--ex-muted);
}
.empty {
  padding: 22px 12px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--ex-muted);
  list-style: none;
}

/* 1366×768 这类矮屏：底轨 188 占掉三分之一强，图示只剩 175px。
   矮屏把底轨收到 150（仍显示 3 行），标题行的眉标也跟着收一行高度。 */
@media (max-height: 820px) {
  /* 交互步的标题在左栏与顶栏都有；短屏把它收掉，把 ~110px 让给三维。
     判据是"这一步有没有操作图元"，不是无条件隐藏——纯读的步骤仍然要标题。 */
  .ex__stage--ops .scene-heading {
    display: none;
  }
  /* 作业动作压成一行：短屏下它吃掉 91px，正好是三维缺的高度。
     全文仍在 title 上（悬停可读），右栏判据不受影响。 */
  .ex__stage--ops .scene-caption {
    padding: 5px 12px;
  }
  .ex__stage--ops .scene-caption p {
    display: -webkit-box;
    -webkit-line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* 三维主图（车门 / 受电弓 / 柜体）在矮屏也让位给三维。
     标题与工具在左栏目录（"STEP 01 · 作业 · 判据 6"）与顶栏都有，
     这里重复一遍要付 110px——1090×614 下那正是三维"看不出是台什么"的原因。
     与交互步（`--ops`）同一条策略：矮屏优先保证图示可读。 */
  .ex__stage--scene .scene-heading {
    display: none;
  }
  .ex__stage--scene .scene-caption {
    margin: 0 12px 8px;
    padding: 5px 10px;
  }
  .ex__stage--scene .scene-caption p {
    display: -webkit-box;
    -webkit-line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .ex__grid {
    grid-template-rows: minmax(320px, 1fr) 150px;
  }
  .scene-heading {
    padding: 5px 16px 3px;
  }
}

/* 1440 / 1366 的工位电脑：左右两栏各收 30px，中栏多出 60px 给三维。
   侧栏收到 228 / 286 仍能放下目录标题与判据，只是行更长。 */
@media (max-width: 1550px) {
  .ex {
    --ex-side: 228px;
    --ex-inspect: 286px;
  }
  .diagram__aids {
    width: 184px;
  }
}

/* ---------------------------------------------------------------- 自适应 */
/* 本页面只服务两种屏：车间大屏（1920 及以上）与工位电脑（1440 / 1280）。
   工人作业时不许带手机，所以**不做手机竖屏适配**（2026-11-11 本人明确）。
   下面这个两栏降级不是移动端方案，而是 1280 笔记本 / 1024 投影的最小可用形态：
   三栏在 1180 以下会窄到读不出目录标题，且整页放不进一屏，改为自然高度 + 整页滚动。
   定高 + overflow:hidden 会把底部轨迹裁掉（1100×560 实测）。 */
@media (max-width: 1180px) {
  .ex {
    height: auto;
    overflow: visible;
  }
  /* 窄屏是纵向堆叠（舞台 / 详解 / 轨迹）。舞台必须按"一屏"定高：
     不定高时它会被内容撑到 822px（1090×614 实测），操作条掉到折线以下，
     用户看得到三维却点不到按钮。详解与轨迹仍然往下滚。 */
  .ex__stage {
    height: calc(100dvh - var(--nav-h) - 44px);
    min-height: 440px;
  }
  .ex__grid {
    grid-template-columns: 220px minmax(0, 1fr);
    grid-template-rows: auto 300px 260px;
  }
  .ex__side {
    grid-row: 1 / 3;
  }
  .ex__inspect {
    grid-column: 2;
    grid-row: 2;
  }
  .ex__trace {
    grid-column: 1 / 3;
    grid-row: 3;
  }
  .ex__parts {
    display: none;
  }
  .ex__now {
    min-width: 0;
  }
  .cell-name,
  .cell-crit {
    max-width: 180px;
  }
}
</style>
