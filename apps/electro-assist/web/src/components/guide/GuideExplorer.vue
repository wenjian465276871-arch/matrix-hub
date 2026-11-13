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
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import GuideFigure from '../../figures/GuideFigure.vue'
import { resetTopBar, setTopBar, type TopBarAction } from '../../composables/useTopBar'
import { criterionValue, provenanceText } from '../../lib/criterionfmt'
import {
  aidFiguresOf,
  effectiveTab,
  effectiveView,
  filterSteps,
  hasOpsFigure as opsFigureIn,
  heroFiguresOf,
  isSceneHero,
  kindOf,
  minutesOf,
  needsStageFocus,
  panelTabs,
  sumMinutes,
  viewGroupsOf,
  type PanelTab,
  type StageView,
  type StepFilter,
} from '../../lib/explorer'
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

const totalMinutes = computed(() => sumMinutes(steps.value))

/* ---------------------------------------------------------------- 左：目录 */
const query = ref('')
const filter = ref<StepFilter>('all')

/** 筛选结果保留原始下标：点击目录要跳到那一步，用筛选后的位置会跳错。 */
const shown = computed(() => filterSteps(steps.value, query.value, filter.value))

/* ---------------------------------------------------------------- 中：舞台 */
/* 舞台里"主图"分三类，各自吃满同一块地方（仍是「实物示意图 / 三维动作 / 操作台」）：
   - still：烘焙图（看这一帧的画质）
   - scene：可交互三维（拖时间轴、播放、放大看）
   - ops  ：MON 屏与升弓操作台（带状态、可点）
   两者都有时用页签切换，而不是并排——并排时每张只剩一半宽，两个都看不清。
   2026-11-11 本人明确：实物渲染图与三维画面都要保留，且都要尽可能大。
   分组与回落规则见 `lib/explorer.ts`（2026-11-13 从本文件抽出并补测）。 */
const figures = computed<VisualSpec[]>(() => step.value?.figures ?? [])
const viewGroups = computed(() => viewGroupsOf(figures.value))
const view = ref<StageView>('still')
const activeView = computed(() => effectiveView(view.value, viewGroups.value))
const heroFigures = computed(() => heroFiguresOf(figures.value, viewGroups.value, view.value))
const aidFigures = computed(() => aidFiguresOf(figures.value, viewGroups.value))
const assets = computed<AssetRef[]>(() => step.value?.assets ?? [])

function assetUrl(asset: AssetRef): string {
  return `/api/electro/uploads/${asset.asset_id}/${asset.asset_id}.png`
}

/* ---------------------------------------------------------------- 右：详解 */
const tab = ref<PanelTab>('criteria')
const tabs = computed(() => panelTabs(step.value))
const activeTab = computed(() => effectiveTab(tab.value, tabs.value))

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

/**
 * 跳到「MON 屏逐项确认」那一步。
 *
 * 给操作台一个钩子：点三维里的 MON 屏就能过去确认，不必自己找目录。
 * 在 MON 屏已经确认完的情况下，操作台会改走"放大看读数"，不会调它。
 */
provide('guide-goto-mon', () => {
  const index = steps.value.findIndex((s) =>
    (s.figures ?? []).some((f) => f.primitive === 'mon_panel'),
  )
  if (index < 0) return false
  go(index)
  return true
})
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

/** 短屏下自动收轨迹、收标题块的判据；规则见 `lib/explorer.ts`。 */
const hasOpsFigure = computed(() => opsFigureIn(figures.value))
const hasStageFocus = computed(() => needsStageFocus(figures.value))
const hasSceneHero = computed(() => isSceneHero(figures.value))

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

<style scoped src="./guide-explorer.css"></style>

