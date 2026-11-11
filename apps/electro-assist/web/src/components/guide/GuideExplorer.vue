<script setup lang="ts">
/** 指导书「探索台」：三栏 + 底部轨迹。
 *
 *  版式参考 https://kejun.github.io/cs-systems-design/（2026-11-11 拆其 styles.css 后重做）：
 *  左目录 / 中舞台 / 右详解 / 底轨迹，四块都是细线面板，序号用等宽字体，
 *  当前步用主色描边而不是填充——填充会把"可点"和"已选"混成一件事。
 *
 *  为什么先做成独立路由（/guide/:id/explore）而不直接替换阅读器：
 *  阅读器承载分页、打印铺页、草稿编辑三件事，换版式会一起动摇。
 *  先让本人比对两种版式，确认后再决定谁做默认。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import GuideFigure from '../../figures/GuideFigure.vue'
import { criterionValue, provenanceText } from '../../lib/criterionfmt'
import type { AssetRef, Criterion, Guide, Step, VisualSpec } from '../../types'

const props = defineProps<{
  guide: Guide
  /** 当前步下标（0 起） */
  page: number
  /** 素材编号表：与阅读器同一份，打印/对照时编号不会各算一套 */
  assetNumbers: Record<string, number>
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
type StageView = 'still' | 'scene'

const figures = computed<VisualSpec[]>(() => step.value?.figures ?? [])

const viewGroups = computed<{ id: StageView; label: string; figs: VisualSpec[] }[]>(() => {
  const out: { id: StageView; label: string; figs: VisualSpec[] }[] = []
  const still = figures.value.filter((f) => f.primitive === 'baked_figure')
  const scene = figures.value.filter((f) => f.primitive === 'device_scene')
  if (still.length) out.push({ id: 'still', label: '实物示意图', figs: still })
  if (scene.length) out.push({ id: 'scene', label: '三维动作', figs: scene })
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
        (f) => f.primitive !== 'baked_figure' && f.primitive !== 'device_scene',
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
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const pad = (n: number): string => String(n).padStart(2, '0')
</script>

<template>
  <div class="ex">
    <!-- 顶条：品牌 / 正在读 / 系统与工位 / 进度 -->
    <header class="ex__bar">
      <RouterLink class="ex__back" :to="`/guide/${guide.id}`" title="切回分页阅读器">
        ‹ 阅读器
      </RouterLink>
      <div class="ex__brand">
        <b>ELECTRO <em>EXPLORER</em></b>
        <small>电气调试 · 交互式作业指导</small>
      </div>
      <!-- 页面级标题只能是指导书名：屏幕阅读器的 h1 是"这份文档是什么"。
           当前步骤是 h2（在舞台里），两处都放 h1 会让标题导航出现重复项。 -->
      <div class="ex__now">
        <small>正在查看 <span>{{ pad(page + 1) }} / {{ pad(total) }}</span></small>
        <h1>{{ guide.title }}</h1>
      </div>
      <div class="ex__parts">
        <button class="is-active" type="button">
          <span>{{ pad(step?.seq ?? 0) }}</span>当前步骤
        </button>
        <button type="button" @click="go(0)">
          <span>01</span>从头开始
        </button>
      </div>
      <div class="ex__prog">
        <div>
          <small>阅读进度</small>
          <strong>{{ page + 1 }} / {{ total }}</strong>
        </div>
        <div class="ex__track"><span :style="{ width: `${((page + 1) / total) * 100}%` }" /></div>
      </div>
    </header>

    <div class="ex__grid" :class="{ 'trace-collapsed': !traceOpen }">
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
      <section class="panel ex__stage" aria-labelledby="ex-stage-title">
        <!-- 顶行：看哪一种图。实物示意图与三维动作各自吃满同一块舞台，
             而不是并排各占一半——两个都看不清等于两个都没有。 -->
        <div class="stage-toolbar">
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
          <span class="scene-index" aria-hidden="true">{{ pad(step?.seq ?? 0) }}</span>
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
              <GuideFigure v-for="(f, i) in aidFigures" :key="`a-${i}`" :spec="f" />
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
/* 版式令牌只在本组件内生效：三栏宽度与参考站一致（258/1fr/310），
   行高与字号按本项目的 12–14px 体系取值，不照搬对方的 88px 顶条。 */
.ex {
  --ex-side: 250px;
  --ex-inspect: 316px;
  --ex-gap: 12px;
  --ex-ink: var(--c-ink);
  --ex-muted: var(--c-ink-3);
  display: flex;
  flex-direction: column;
  gap: var(--ex-gap);
  padding: 12px 14px;
  background: var(--c-bg);
  /* 定高而不是"至少一屏"：参考站的做法是四块面板撑满视口、各自内部滚动。
     用 min-height 时底部轨迹会被顶到折叠线以下——第一版就是这么丢的。 */
  height: calc(100dvh - var(--nav-h));
  min-height: 600px;
  overflow: hidden;
}

/* ---------------------------------------------------------------- 顶条 */
.ex__bar {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 10px 14px;
  border: 1px solid var(--c-line);
  background: var(--c-surface);
  flex: none;
}
.ex__back {
  font-size: 13px;
  color: var(--c-primary);
  text-decoration: none;
  white-space: nowrap;
}
.ex__brand b {
  display: block;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 15px;
  letter-spacing: 1px;
  color: var(--c-ink);
}
.ex__brand em {
  font-style: italic;
  color: var(--c-primary);
}
.ex__brand small {
  display: block;
  white-space: nowrap;
  font-size: 11px;
  letter-spacing: 1.4px;
  color: var(--ex-muted);
  margin-top: 2px;
}
.ex__now {
  border-left: 1px solid var(--c-line);
  padding-left: 16px;
  min-width: 0;
  flex: 1;
  overflow: hidden;
}
.ex__now small {
  display: flex;
  gap: 14px;
  font-size: 11px;
  color: var(--ex-muted);
  margin-bottom: 3px;
}
.ex__now small span {
  font-family: var(--font-mono);
}
.ex__now h1 {
  margin: 0;
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  font-weight: 600;
  color: var(--c-ink);
}
.ex__parts {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
.ex__parts button {
  background: transparent;
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--c-ink-3);
  padding: 5px 8px;
  border: 1px solid transparent;
}
.ex__parts span {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--c-line);
  font-family: var(--font-mono);
  font-size: 12px;
}
.ex__parts .is-active span {
  background: var(--c-primary);
  border-color: var(--c-primary);
  color: var(--c-on-primary);
}
.ex__parts .is-active {
  color: var(--c-primary);
}
.ex__prog {
  border-left: 1px solid var(--c-line);
  padding-left: 16px;
  min-width: 140px;
}
.ex__prog > div:first-child {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}
.ex__prog small {
  font-size: 11px;
  color: var(--ex-muted);
}
.ex__prog strong {
  font-family: var(--font-mono);
  font-size: 13px;
}
.ex__track {
  height: 5px;
  background: var(--c-line-soft);
  margin-top: 8px;
}
.ex__track span {
  display: block;
  height: 100%;
  background: var(--c-primary);
  transition: width 0.3s;
}

/* ---------------------------------------------------------------- 栅格 */
.ex__grid {
  display: grid;
  gap: var(--ex-gap);
  grid-template-columns: var(--ex-side) minmax(0, 1fr) var(--ex-inspect);
  /* 底轨从 196 收到 188：这一步只为了把 8px 让给图示，
     不是压缩轨迹表本身——它现在正好显示 5–6 行。 */
  grid-template-rows: minmax(360px, 1fr) 188px;
  /* min-height: 0 与 flex: 1 必须留在 .ex__grid 本体上。
     2026-11-11 把它们误挪进下面的 .trace-collapsed 块，结果是
     栅格容器被内容撑到 1119px（应 902），整页溢出、图片按宽度铺成 681 高被裁。 */
  min-height: 0;
  flex: 1;
}

/* 收起底轨：图示多拿 148px。
   默认展开——本人给的版式里轨迹表是露出来的，收起是"看得更大"的主动选择。 */
.ex__grid.trace-collapsed {
  grid-template-rows: minmax(360px, 1fr) 38px;
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
  height: 44px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
  border-bottom: 1px solid var(--c-line-soft);
}
.panel-head h2 {
  margin: 0;
  font-size: 14px;
  letter-spacing: 0.6px;
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
  height: 40px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
  border-bottom: 1px solid var(--c-line-soft);
}
.view-tabs {
  display: flex;
  border: 1px solid var(--c-line);
}
.view-tabs button {
  background: var(--c-surface);
  font-size: 12px;
  padding: 5px 9px;
  color: var(--c-ink-3);
}
.view-tabs button[aria-selected='true'] {
  background: var(--c-primary);
  color: var(--c-on-primary);
}
/* 只有一种图时不给页签：两个按钮里有一个永远 disabled，是噪音 */
.view-static {
  font-size: 12px;
  letter-spacing: 0.4px;
  color: var(--c-ink-3);
}
.model-label {
  font-size: 11px;
  color: var(--ex-muted);
}
.scene-heading {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 16px 5px;
  flex: none;
}
.scene-heading__main {
  min-width: 0;
  flex: 1;
}
.eyebrow {
  margin: 0 0 2px;
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  letter-spacing: 0.6px;
  color: var(--c-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.eyebrow-sep {
  color: var(--c-line);
}
.eyebrow-sub {
  font-family: var(--font-mono);
  color: var(--c-ink-3);
}
.scene-heading h2 {
  margin: 0;
  font-size: 17px;
  line-height: 1.3;
  letter-spacing: 0.2px;
  font-weight: 650;
  color: var(--c-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 大号序号退成右上角的水印：52px 时它自己就占 80px 高，把图示挤到 100px。
   34px 仍是大字号（≥24px），按 3:1 的要求给 ink-3（5.2:1）。 */
.scene-index {
  position: absolute;
  top: 4px;
  right: 14px;
  font-family: var(--font-mono);
  font-size: 34px;
  line-height: 1;
  letter-spacing: -2px;
  color: var(--c-ink-3);
  pointer-events: none;
}
.diagram {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
  justify-content: center;
  padding: 4px 12px 2px;
  overflow: hidden;
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
/* 图片自带影棚背景，给一层细边框把它和面板"隔"开，而不是浮在白纸上 */
.diagram__main :deep(figure) {
  border: 1px solid var(--c-line);
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
.diagram__stack :deep(.figure__cap) {
  flex: none;
}

/* 三维在探索台里必须"塞满"而不是守 3:2：DeviceScene 的 .scene 默认 aspect-ratio: 3/2，
   宽 900 时高 600，比舞台还高，下沿（读数与控制条）会被裁掉。
   flex 链要一路通到 .scene，断在任何一级都拿不到确定高度。 */
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
  gap: 10px;
  margin: 0 12px 10px;
  padding: 8px 10px;
  border: 1px solid var(--c-line-soft);
  background: var(--c-surface);
  box-shadow: var(--shadow-1);
}
.step-chip {
  width: 26px;
  height: 26px;
  flex: none;
  display: grid;
  place-items: center;
  background: var(--c-primary);
  color: var(--c-on-primary);
  font-family: var(--font-mono);
  font-size: 13px;
}
.scene-caption strong {
  font-size: 13px;
  color: var(--c-ink);
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
.ex__trace.is-collapsed .trace-scroll,
.ex__trace.is-collapsed .trace-toggle {
  margin-left: auto;
  margin-right: 10px;
  padding: 3px 8px;
  border: 1px solid var(--c-line);
  background: var(--c-surface);
  color: var(--c-ink-2);
  font-size: 11px;
  white-space: nowrap;
}
.trace-toggle:hover {
  color: var(--c-primary);
  border-color: var(--c-primary-line);
}
.flow-foot {
  display: none;
}
.ex__trace.is-collapsed .flow-toolbar {
  border-bottom: none;
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
  padding: 8px 12px;
  border-bottom: 1px solid var(--c-line-soft);
}
.flow-toolbar h2 {
  margin: 0;
  font-size: 14px;
  letter-spacing: 0.6px;
  white-space: nowrap;
}
.flow-toolbar h2 span {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ex-muted);
  margin-left: 8px;
}
.controls {
  display: flex;
  gap: 5px;
  align-items: center;
}
.controls button {
  background: var(--c-surface);
  height: 28px;
  min-width: 30px;
  padding: 0 9px;
  border: 1px solid var(--c-line);
  font-size: 12px;
  color: var(--c-ink);
}
.controls .play-button {
  background: var(--c-primary);
  border-color: var(--c-primary);
  color: var(--c-on-primary);
  min-width: 80px;
}
.controls button:disabled {
  color: var(--c-ink-3);
  border-color: var(--c-line-soft);
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
  padding: 6px 8px;
  border-bottom: 1px solid var(--c-line-soft);
  white-space: nowrap;
}
td {
  font-size: 12px;
  padding: 6px 8px;
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
  padding: 5px 12px;
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
  .ex__grid {
    grid-template-columns: 220px minmax(0, 1fr);
    grid-template-rows: minmax(440px, 66vh) 300px 260px;
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
