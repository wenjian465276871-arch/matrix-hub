<script setup lang="ts">
/** 单个步骤的整页排版：左边是尽可能大的图示，右边是文字与判据。
 *
 *  ## 为什么单独成页
 *  旧版是长文流：8 步、20 张图从上往下排。现场要一边抬头看设备一边低头找位置，
 *  滚动条一滑就回不到那一步了。改成「一步一屏」之后，屏幕就是这一步，
 *  图示能占到半屏以上——这是把三维图从"配图"变成"作业画面"的前提。
 *
 *  ## 排版取舍
 *  - 图示列用 `1.35fr`，文字列 `minmax(280px, .9fr)`：三维是横长的，给它更多宽度；
 *    文字列有下限，窄到 280px 时改成上下堆叠（见媒体查询）。
 *  - 页面本身可纵向滚动：判据多的步骤（5 条）在手机上一定超过一屏，
 *    藏起来比滚动更糟——现场看不到判据等于没写。
 *  - 3D 场景的高度由页面剩余空间决定（`aspect-ratio: auto`），不再是固定 3:2：
 *    整页布局里那个比例会白白丢掉一半高度。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import GuideFigure from '../../figures/GuideFigure.vue'
import { criterionValue, provenanceText } from '../../lib/criterionfmt'
import type { AssetRef, Step } from '../../types'

/* ---------------- 沉浸态（2026-11-10 决策 #51） ----------------
 *
 * ## 为什么需要它
 * 1097×509 的窗口里，「左图右文」只能给三维 140px 画布——万用表表体剩 85px，
 * 读数根本看不清。而三维是这个项目的核心，不是配图。
 *
 * ## 判据
 * **宽而矮**才切沉浸：≥900px 宽 且 ≤700px 高。
 * 手机（390×844）不触发——竖屏本来就该图文上下排，硬塞抽屉反而更差；
 * 平板竖屏同理。
 *
 * ## 为什么用 class 而不是纯 CSS 媒体查询
 * 沉浸态不只是样式：动作描述要**换一个 DOM 位置**（进抽屉）。
 * 用纯 CSS 做不到跨容器搬节点，只能复制一份；而复制就会有两套判断条件
 * （CSS 一套、`v-if` 一套），迟早漂移。这里让 matchMedia 当唯一真相源，
 * CSS 全部挂在 `.step--compact` 上。
 */
const QUERY = '(min-width: 900px) and (max-height: 700px)'
const compact = ref(false)
/** 抽屉是否展开。只在沉浸态有意义——非沉浸态 `.step__side` 是常驻右栏。 */
const drawerOpen = ref(false)

let mql: MediaQueryList | null = null
function onQuery(event: { matches: boolean }): void {
  compact.value = event.matches
  // 退出沉浸态时把抽屉状态清掉，否则下次进来是"半开"的
  if (!event.matches) drawerOpen.value = false
}

onMounted(() => {
  // happy-dom 没有 matchMedia：缺了就永远停在普通布局，不影响功能
  if (typeof window.matchMedia !== 'function') return
  mql = window.matchMedia(QUERY)
  compact.value = mql.matches
  mql.addEventListener('change', onQuery)
})

onBeforeUnmount(() => {
  mql?.removeEventListener('change', onQuery)
})

/* ---------------- 抽屉的键盘纪律 ----------------
 * 抽屉一滑出来就是一层浮层：焦点不跟进去，键盘用户按 Tab 会跑到后面的画布上，
 * 看不到自己在哪里。关掉之后焦点必须回到触发按钮，否则它掉到 body，
 * 下一次 Tab 从头开始。
 */
const drawerEl = ref<HTMLElement | null>(null)
const drawerBtn = ref<HTMLButtonElement | null>(null)

watch(drawerOpen, async (open) => {
  await nextTick()
  if (open) drawerEl.value?.focus()
  else drawerBtn.value?.focus()
})

function closeDrawer(): void {
  drawerOpen.value = false
}

const props = defineProps<{
  step: Step
  /** 总步数，用来渲染「第 3 步 / 共 8 步」 */
  total: number
  /** 素材编号表：与正文引用一致，由父组件按"步骤顺序 + 文末素材区"算好 */
  numbers: Record<string, number>
  /** 草稿态才提示"可以补图"；已发布的写死就不要再暗示能改 */
  status: 'draft' | 'published'
}>()

function assetUrl(asset: AssetRef): string {
  return `/api/electro/uploads/${asset.asset_id}/${asset.asset_id}.png`
}

/* 判据的显示口径见 lib/criterionfmt.ts：探索台要渲染同一批判据，
   两处各写一份就会出现 `0.5 ~ 1.5` 与 `0.5-1.5` 这种"看起来数据不一致"。 */

/* 图示分两栏：三维是「主图」，占左栏并吃满高度；其余 2D 原语退到右栏。
 *
 * 为什么要拆：第 5 步那种「状态灯 + 三维 + 接线图」的组合里，三张图挤在一列，
 * flex 会把 2D 压成只剩标题的 26px 空盒，三维的 min-height 又顶着容器，
 * 下一张图画在三维上（用户 2026-11-10 截图：接线图盖住受电弓）。
 * 分栏之后两列各管各的，物理上不可能重叠。 */
/* 占主栏的原语：三维、MON 屏、升弓操作台。
   后两个是"带状态的界面"，塞进 330px 的辅图列会连一行字都排不下——
   它们和三维一样，是这一页要看的东西，不是配图。 */
const HERO_PRIMITIVES = new Set(['device_scene', 'mon_panel', 'operation_scene'])
const heroFigures = computed(() =>
  props.step.figures.filter((fig) => HERO_PRIMITIVES.has(fig.primitive)),
)
const aidFigures = computed(() =>
  props.step.figures.filter((fig) => !HERO_PRIMITIVES.has(fig.primitive)),
)

const minutes = (): number | null => {
  const s = props.step.duration_s
  return s ? Math.max(1, Math.round(s / 60)) : null
}
</script>

<template>
  <section
    class="step step--page"
    :class="{ 'step--compact': compact }"
    @keydown.esc="drawerOpen && closeDrawer()"
  >
    <header class="step__head">
      <span class="step__seq">{{ String(step.seq).padStart(2, '0') }}</span>
      <div class="step__heading">
        <p class="step__kicker">第 {{ step.seq }} 步 · 共 {{ total }} 步</p>
        <h2 class="step__title">{{ step.title }}</h2>
      </div>
    </header>

    <p v-if="!compact" class="step__action">{{ step.action }}</p>

    <div class="step__body">
      <div class="step__media">
        <!-- 有三维时它独占左栏；没有三维时 2D 图示才占左栏 -->
        <div v-if="heroFigures.length" class="step__hero">
          <GuideFigure
            v-for="(fig, i) in heroFigures"
            :key="`${step.id}-hero-${i}`"
            :spec="fig"
          />
        </div>
        <div v-else-if="aidFigures.length" class="step__figures">
          <GuideFigure
            v-for="(fig, i) in aidFigures"
            :key="`${step.id}-fig-${i}`"
            :spec="fig"
          />
        </div>

        <!-- 三级降级的第三级（计划 §2.1）：既没有原语图示、也没有现场素材时，
             必须**显式**说明原因并给出补救动作，不能靠"这块不渲染"静默跳过。 -->
        <div v-else-if="!step.assets?.length" class="step__empty">
          <p class="step__empty-text">
            本步暂无可视化图示，也未附现场素材。
            <template v-if="status === 'draft'">
              可上传照片或截图后在草稿页补到本步；补齐前请以右侧文字与验收判据为准。
            </template>
            <template v-else>请以右侧文字与验收判据为准；如需配图，请对照现场资料。</template>
          </p>
        </div>

        <div v-if="step.assets?.length" class="step__assets">
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
                图 {{ numbers[asset.asset_id] }} · {{ asset.caption }}
              </figcaption>
            </figure>
          </div>
        </div>
      </div>

      <aside
      :id="`step-side-${step.id}`"
      ref="drawerEl"
      class="step__side"
      :class="{ 'step__side--open': drawerOpen }"
      :tabindex="compact ? -1 : undefined"
    >
      <!-- 沉浸态把动作描述搬进来：它属于"说明"，不该占画布的高度 -->
      <p v-if="compact" class="step__action">{{ step.action }}</p>
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
              <span class="criterion__tail">
                <span class="criterion__value">
                  {{ criterionValue(c) }}<span v-if="c.unit" class="criterion__unit">{{ c.unit }}</span>
                </span>
                <!-- 有据/待核只在服务端定位到原文时出现。没有标记不代表数值错，
                     只代表没有证据链（手写输入的指导书就没有），所以不显示"无据"占位。 -->
                <span
                  v-if="c.provenance"
                  class="criterion__src"
                  :class="`criterion__src--${c.provenance.flag ?? 'ok'}`"
                  :title="c.provenance.raw_text || '原文片段未保留'"
                  >{{ provenanceText(c.provenance) }}</span
                >
              </span>
            </div>
          </div>
        </div>

        <div v-if="minutes() !== null" class="step__block">
          <p class="block-label">预计耗时</p>
          <p class="step__duration">{{ minutes() }} 分钟</p>
        </div>

        <!-- 辅图（2D 原语）进右栏，**不再跟主图抢那一列的高度**。
             2026-11-10 实测：1097×509 的窗口里，主图 + 辅图 410px 塞进 261px
             的列，挤出列内滚动，画布被压到 118px——三维是核心，不能这么排。

             条件里必须带 `heroFigures.length`：本步没有三维时，左列的
             `v-else-if` 分支已经在渲染这批 2D 图（整宽更合适），
             这里再渲染一次就是**同一张表在 DOM 里出现两遍**——
             2026-11-10 E2E 的 strict mode violation 就是这么来的。 -->
        <div v-if="heroFigures.length && aidFigures.length" class="step__block">
          <p class="block-label">图示</p>
          <div class="step__aid">
            <GuideFigure
              v-for="(fig, i) in aidFigures"
              :key="`${step.id}-aid-${i}`"
              :spec="fig"
            />
          </div>
        </div>
      </aside>
    </div>

    <!-- 沉浸态底栏：判据常驻、其余进抽屉。
         判据必须一直可见——它是「做到什么程度算对」，现场不能每次去翻。
         安全项与工具是"作业前确认过一遍"的东西，进抽屉可接受。 -->
    <div v-if="compact" class="step__hud">
      <div class="step__hud-crit">
        <span class="step__hud-label">判据</span>
        <span v-for="c in step.criteria" :key="c.id" class="step__hud-item">
          {{ c.label }} <b>{{ criterionValue(c) }}</b>
        </span>
        <span v-if="!step.criteria.length" class="step__hud-item step__hud-item--none">
          本步无判据
        </span>
      </div>
      <button
        ref="drawerBtn"
        class="step__drawer-btn"
        type="button"
        :aria-expanded="drawerOpen"
        :aria-controls="`step-side-${step.id}`"
        @click="drawerOpen = !drawerOpen"
      >
        {{ drawerOpen ? '收起说明' : '安全 · 工具 · 动作' }}
      </button>
    </div>

    <!-- 点空白收抽屉。不放 aria-hidden：它没有信息，读屏跳过即可 -->
    <div v-if="compact && drawerOpen" class="step__scrim" @click="closeDrawer" />
  </section>
</template>

<style scoped>
.step--page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  padding: 16px 22px 20px;
  overflow-y: auto;
  /* 翻页容器负责横向手势，页面内部只处理纵向——不写这条，横滑会被这里吃掉 */
  overscroll-behavior-y: contain;
  /* 全局 .step 是长文流的样式（左侧悬停色条 + 上下分隔线），整页布局里是噪音 */
  border: none;
}

.step__head {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}

.step__heading {
  min-width: 0;
}

.step__kicker {
  margin: 0 0 2px;
  color: var(--c-ink-3);
  font-size: 12px;
  letter-spacing: 0.04em;
}

.step__title {
  margin: 0;
  font-size: 21px;
  line-height: 1.3;
}

.step__action {
  margin: 0;
  color: var(--c-ink-2);
  font-size: 15px;
  line-height: 1.7;
}

.step__body {
  /* 有余量时撑满，不够时压缩（压缩由主图的 max-height 兜住，见下） */
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  /* 三维是这一页的主角：左列 2.1fr，右栏只留判据与辅图 */
  grid-template-columns: minmax(0, 2.1fr) minmax(280px, 0.9fr);
  gap: 18px;
  align-items: stretch;
}

.step__media {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* ---------- 主图（三维）：独占左栏，吃满剩余高度 ---------- */

.step__hero {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  /* 主图独占整列：辅图已挪到右栏，这里没有第二个消费者，不再需要列内滚动。
     溢出兜底保留——宁可裁一像素，也不要像上一版那样盖到隔壁栏。 */
  overflow: hidden;
}

/* 主图：吃满剩余高度，但有上下界——
   下界 38vh 保证矮窗口里不被辅图挤成一条；
   上界 58vh 保证 600px 的窗口里「主图 + 辅图 + 控制条」还是一屏放得下，
   不用滚动就能看到播放按钮（上一版没有上界，3D 长到 509px，控制条掉到屏外）。 */
/* `:not(.figure--zoomed)` 不是可选的：放大态把同一个 figure 改成 position:fixed，
   它的 DOM 位置没变，仍然命中这条规则——`max-height: 58vh` 会把"全屏放大"
   砍成 295px（实测：宽 1061、高只有 108，等于只放大了宽度）。 */
.step__hero > *:not(.step__aid):not(.figure--zoomed) {
  flex: 1 1 auto;
  min-height: max(220px, 38vh);
  max-height: 58vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 画布容器必须一起参与 flex，否则 `.scene` 的 height:100% 没有参照物 */
.step__hero :deep(.figure__canvas) {
  flex: 1 1 auto;
  min-height: 0;
  /* 只挂当前页与左右各一页，content-visibility 在这里没有收益，反而会锁住高度 */
  content-visibility: visible;
}

/* 整页布局里 3:2 会浪费近一半高度：让场景跟着容器走。
   链条要一路 flex 到底：`.device` 是 DeviceFigure 的根，里面还有画布、控制条与说明，
   只给 `.scene` 写 height:100% 时父级高度是 auto，这一条会被忽略——
   实测画布塌到 150px，上下留一大块白（2026-11-10 二次视觉验收）。 */
.step__hero :deep(.device) {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* 120px 而不是 160：控制条（32）与说明（18）也要在这张卡里，
   主图 220 高时画布只剩 ~200，min-height 定 160 会把播放按钮顶出卡外被裁掉。 */
.step__hero :deep(.device > .scene) {
  flex: 1 1 auto;
  height: auto;
  aspect-ratio: auto;
  min-height: 120px;
}

.step__hero :deep(.device__controls),
.step__hero :deep(.device__note) {
  flex: 0 0 auto;
}

.step__hero :deep(.figure__caption) {
  flex: 0 0 auto;
}

/* ---------- 2D 图示（本步没有三维时才占左栏） ---------- */

.step__figures {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
}

.step__figures > * {
  flex: 0 0 auto;
  overflow: hidden;
}

/* 2D 原语是 SVG，按宽度自适应；给个上限，别让一张清单吃掉整页 */
.step__figures :deep(svg) {
  max-height: 46vh;
}

/* ---------- 辅图（跟在主图下面，同一列） ---------- */

.step__aid {
  display: grid;
  gap: 10px;
  align-items: start;
}

.step__aid > * {
  overflow: hidden;
}

/* 右栏只有 ~330px 宽：2D 原语按宽度自适应，高度封顶 150px。
   仪表条与接线图在这个尺寸下仍读得清（2026-11-10 视觉验收）。 */
.step__aid :deep(.figure__canvas) {
  max-height: 150px;
  overflow: hidden;
}

.step__aid :deep(svg) {
  max-height: 150px;
}

.step__side {
  overflow-y: auto;
  overscroll-behavior-y: contain;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-left: 18px;
  border-left: 1px solid var(--c-line);
  overflow-y: auto;
}

.step__block {
  min-width: 0;
}

.step__duration {
  margin: 0;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}

.step__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-height: 160px;
  padding: 18px;
  border: 1px dashed var(--c-line);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
}

.step__empty-text {
  margin: 0;
  max-width: 44ch;
  color: var(--c-ink-2);
  font-size: 14px;
  line-height: 1.7;
}

.step__assets {
  flex: 0 0 auto;
}

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
  max-height: 220px;
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

@media (max-width: 900px) {
  /* 窄屏直接退回文档流（display:block）：
     grid 的 auto 行在定高容器里会把行压到容器高度以内，而图片内容照样溢出，
     结果判据列叠在图上（视觉验收 390×844 发现）。block 排布没有这个副作用。 */
  .step__body {
    display: block;
  }

  /* 窄屏改成「文档流」：图按内容高度排，页面整体滚动。
     上一版沿用桌面的 flex 分配，2D 图被压成 40px 的空盒子（视觉验收发现）。 */
  .step__hero,
  .step__figures {
    flex: 0 0 auto;
    display: block;
    overflow: visible;
  }

  .step__hero > *,
  .step__figures > * {
    flex: 0 0 auto;
    min-height: 0;
    max-height: none;
    margin-bottom: 10px;
    overflow: hidden;
  }

  .step__hero :deep(.scene) {
    height: 42vh;
    min-height: 220px;
  }

  .step__figures :deep(svg) {
    max-height: none;
  }

  .step__figures :deep(.figure__canvas) {
    flex: 0 0 auto;
  }

  .step__media {
    min-height: 0;
  }

  .step__side {
  overflow-y: auto;
  overscroll-behavior-y: contain;
    margin-top: 16px;
  }

  .step__side {
  overflow-y: auto;
  overscroll-behavior-y: contain;
    padding-left: 0;
    border-left: none;
    border-top: 1px solid var(--c-line);
    padding-top: 14px;
    overflow: visible;
  }
}

@media (max-width: 900px) and (orientation: landscape) {
  .step__body {
    /* 横屏短高：左右分栏才不会把图压成一条 */
    grid-template-columns: minmax(0, 1.2fr) minmax(240px, 1fr);
    grid-template-rows: minmax(0, 1fr);
  }

  .step__hero :deep(.scene) {
    height: 100%;
    min-height: 160px;
  }

  .step__side {
  overflow-y: auto;
  overscroll-behavior-y: contain;
    border-top: none;
    border-left: 1px solid var(--c-line);
    padding-top: 0;
    padding-left: 14px;
    overflow-y: auto;
  }
}

/* ================= 沉浸态（宽而矮的桌面窗口） =================
 *
 * 目标只有一个：**把高度全部还给三维**。
 * 1097×509 的窗口里，常规布局给画布 140px（表体 85px，读数看不清）；
 * 沉浸态把标题压成画布上的一个胶囊、判据压成底部一行、
 * 其余说明收进抽屉，画布能拿到约 400px。
 *
 * 只改布局，不改语义：判据始终可见，抽屉是可见内容的重新排列，
 * 不是把东西藏起来。
 */
.step--compact {
  /* 画布要贴到边：padding 会从三维身上扣掉两倍 */
  padding: 0;
  gap: 0;
  overflow: hidden;
  /* 标题胶囊与底部 HUD 都是 absolute：没有这条，它们会以 reader 为参照系
     一路顶到导航条下面（实测标题被顶栏压掉一半）。 */
  position: relative;
}

/* 标题变成画布上的胶囊：绝对定位，不占高度。
   半透明底 + 背景模糊，盖住的是三维顶部的留白区（取景居中，顶部本来就空）。 */
.step--compact .step__head {
  position: absolute;
  top: 10px;
  left: 12px;
  z-index: 3;
  max-width: calc(100% - 24px);
  padding: 6px 12px 7px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--c-surface) 86%, transparent);
  box-shadow: 0 1px 3px rgba(12, 14, 18, 0.12);
  pointer-events: none;
}

.step--compact .step__seq {
  display: none;
}

.step--compact .step__kicker {
  margin: 0;
  font-size: 11px;
}

.step--compact .step__title {
  font-size: 15px;
  line-height: 1.25;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.step--compact .step__body {
  display: block;
  height: 100%;
}

.step--compact .step__media {
  height: 100%;
}

/* 主图吃满：把常规布局的 38vh 下界 / 58vh 上界一并解除 */
.step--compact .step__hero {
  height: 100%;
}

.step--compact .step__hero > *:not(.step__aid):not(.figure--zoomed) {
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
}

/* ---------- 右栏 → 抽屉 ---------- */

.step--compact .step__side {
  /* `absolute` 而不是 `fixed`：fixed 会从视口顶算起，把阅读器顶栏
     （返回 / 翻页 / 打印）一起盖掉——用户正看着说明想翻页，却找不到按钮。
     相对 `.step--page` 定位，抽屉正好落在内容区里。 */
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 70;
  width: min(420px, 88vw);
  padding: 18px 20px 28px;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  background: var(--c-surface);
  box-shadow: -8px 0 24px rgba(12, 14, 18, 0.16);
  /* 收起时用 visibility 而不是只靠 transform：
     移出视口的元素仍然能被 Tab 聚焦，焦点会跑到屏幕外看不见。 */
  visibility: hidden;
  transform: translateX(100%);
  transition:
    transform 0.22s ease,
    visibility 0s linear 0.22s;
}

.step--compact .step__side:focus {
  /* 容器拿到焦点只是为了给读屏一个起点，不该画出焦点环 */
  outline: none;
}

.step--compact .step__side--open {
  visibility: visible;
  transform: none;
  transition:
    transform 0.22s ease,
    visibility 0s linear 0s;
}

.step--compact .step__scrim {
  /* 同上：只压暗内容区，顶栏保持可点——抽屉开着也能直接翻到下一步。 */
  position: absolute;
  inset: 0;
  z-index: 65;
  background: rgba(12, 14, 18, 0.34);
}

/* ---------- 底部 HUD ---------- */

.step__hud {
  display: none;
}

.step--compact .step__hud {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 46px;
  padding: 6px 12px;
  background: color-mix(in srgb, var(--c-surface) 92%, transparent);
  border-top: 1px solid var(--c-line);
}

.step__hud-crit {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  white-space: nowrap;
}

.step__hud-label {
  flex: 0 0 auto;
  color: var(--c-ink-3);
  font-size: 11px;
  letter-spacing: 0.08em;
}

.step__hud-item {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
  color: var(--c-ink-2);
}

.step__hud-item b {
  color: var(--c-ink);
  font-variant-numeric: tabular-nums;
}

.step__hud-item--none {
  color: var(--c-ink-3);
}

.step__drawer-btn {
  flex: 0 0 auto;
  min-height: 34px;
  padding: 0 12px;
  border: 1px solid var(--c-primary-line);
  border-radius: var(--radius-sm);
  background: var(--c-primary-soft);
  color: var(--c-primary-ink);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

/* 底栏悬浮在画布上：给画布留出等高的下边距，否则控制条会被压住 */
.step--compact .step__hero {
  padding-bottom: 46px;
}

/* ---------- 沉浸态把"重复的话"让出高度 ----------
 *
 * 题注（「万用表测输入电压（示意）」）与标题说的是同一件事；
 * 「结构示意，参数为演示虚构值」是合规声明，打印稿上有就够。
 * 两处加起来 42px，在 400px 的内容区里占 10%。
 *
 * **只做视觉隐藏，不 display:none**：读屏仍能读到，打印样式会把它们放回来
 * （见 print 段）。删掉就是删内容，那是另一回事。
 */
.step--compact .step__hero :deep(.figure__caption),
.step--compact .step__hero :deep(.device__note) {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* 图的 12px 内边距在这里是纯损耗：画布已经贴到卡片边缘 */
.step--compact .step__hero :deep(.figure) {
  padding: 10px 0 0;
}

/* 题注被隐藏后，画布要能顶到卡片顶边 */
.step--compact .step__hero :deep(.figure__canvas) {
  margin-top: 0;
}

/* 窄屏（<900）永不进沉浸态；这条是兜底——CSS 与 matchMedia 条件必须一致 */
@media (max-width: 899px) {
  .step--compact .step__side {
    position: static;
    visibility: visible;
    transform: none;
    width: auto;
    box-shadow: none;
  }

  .step--compact .step__hud {
    display: none;
  }
}

/* ---------- 打印：必须还原成文档流 ---------- */
@media print {
  /* 打印时 matchMedia 仍是"屏幕尺寸"，`.step--compact` 会留在 DOM 上。
     不还原的话：标题浮在纸上、判据被裁、抽屉内容整段丢失——
     而打印稿是现场要拿在手里的东西，丢内容比难看严重得多。 */
  .step--compact {
    padding: 0;
    overflow: visible;
  }

  .step--compact .step__head {
    position: static;
    display: flex;
    padding: 0;
    background: none;
    box-shadow: none;
    max-width: none;
  }

  /* HUD 在纸上必须消失：它的判据与右栏「验收判据」是同一份数据，
     一起打出来就是同一行判据印两遍。屏幕上是"压缩显示"，纸上是重复。 */
  .step--compact .step__hud {
    display: none;
  }

  .step--compact .step__title {
    font-size: 21px;
    white-space: normal;
    overflow: visible;
  }

  .step--compact .step__body {
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(220px, 1fr);
    gap: 14px;
  }

  .step--compact .step__hero {
    padding-bottom: 0;
  }

  /* 抽屉：常驻展开、不要阴影、不要位移 */
  .step--compact .step__side,
  .step--compact .step__side:focus {
  /* 容器拿到焦点只是为了给读屏一个起点，不该画出焦点环 */
  outline: none;
}

.step--compact .step__side--open {
    position: static;
    visibility: visible;
    transform: none;
    width: auto;
    max-height: none;
    overflow: visible;
    box-shadow: none;
    padding: 0;
    background: none;
  }

  .step--compact .step__scrim,
  .step__drawer-btn {
    display: none;
  }

  /* 沉浸态为了省高度藏起来的两处，打印必须放回来：
     题注是图与正文的对应关系，合规声明是必须随稿出现的东西。 */
  .step--compact .step__hero :deep(.figure__caption),
  .step--compact .step__hero :deep(.device__note) {
    position: static;
    width: auto;
    height: auto;
    margin: 0;
    overflow: visible;
    clip-path: none;
    white-space: normal;
  }

  .step--compact .step__hero :deep(.figure) {
    padding: 12px;
  }
}
</style>
