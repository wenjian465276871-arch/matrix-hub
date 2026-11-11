<script setup lang="ts">
/** 全站唯一顶栏（88px，参考站同构）。
 *
 *  四段：品牌 / 正在看什么 / 模块 chip / 进度。
 *  模块 chip 用编号而不是图标：编号能同时表达"有四个模块"和"我现在在第几个"，
 *  图标只能表达"这是什么"。
 *
 *  不在这里放外观开关：作业中误触变暗再切回来要翻菜单（视觉规范 §6 的既有结论，
 *  开关仍在抽屉里）。
 */
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useTopBar } from '../../composables/useTopBar'

const props = defineProps<{ onMore: () => void; moreOpen: boolean }>()
defineEmits<{ 'update:moreOpen': [value: boolean] }>()

const route = useRoute()
const bar = useTopBar()

/** 模块编号即导航顺序：与抽屉里的排列一致，不另立一套。 */
const MODULES = [
  { n: '01', label: '作业库', to: '/', match: ['library', 'guide', 'run', 'record'] },
  { n: '02', label: '生成指导书', to: '/new', match: ['new'] },
  { n: '03', label: '故障排查', to: '/diagnose', match: ['diagnose'] },
  { n: '04', label: '三维演示', to: '/demo/device', match: ['device-demo'] },
]

const activeName = computed(() => String(route.name ?? ''))
const isActive = (m: string[]): boolean => m.includes(activeName.value)

/** 没投稿的页面用路由标题兜底：顶栏永远有话说，不会空半条。 */
const FALLBACK: Record<string, { kicker: string; title: string }> = {
  library: { kicker: '作业库', title: '作业指导书' },
  new: { kicker: '生成', title: '从一句话到一份指导书' },
  diagnose: { kicker: '故障排查', title: '现场现象 → 可能原因' },
  'device-demo': { kicker: '三维演示', title: '电气设备结构演示' },
  run: { kicker: '现场引导', title: '交互式作业引导' },
  record: { kicker: '作业记录', title: '本次作业记录' },
  privacy: { kicker: '说明', title: '隐私与数据' },
}

const kicker = computed(() => bar.kicker || FALLBACK[activeName.value]?.kicker || '')
const title = computed(() => bar.title || FALLBACK[activeName.value]?.title || '电气调试 AI 作业助手')
const pct = computed(() => {
  const p = bar.progress
  if (!p || p.total <= 0) return 0
  return Math.min(100, Math.round((p.value / p.total) * 100))
})
const pad2 = (n: number): string => String(n).padStart(2, '0')
</script>

<template>
  <header class="topbar">
    <RouterLink class="brand" to="/">
      <!-- 受电弓几何标记：接触线 / 弓头 / 上下臂 / 底架。抽象到 4 笔仍认得出，
           比拿"AI 生成的图标"或字母方块诚实。 -->
      <svg class="brand__mark" viewBox="0 0 40 44" aria-hidden="true">
        <path d="M3 7h34" />
        <path d="M20 11v7" />
        <path d="M6 37 20 18l14 19" />
        <path d="M11 37h18" />
      </svg>
      <span class="brand__text">
        <b>ELECTRO <em>EXPLORER</em></b>
        <small>电气调试 · 交互式作业指导</small>
      </span>
    </RouterLink>

    <div class="now">
      <small>
        <span>{{ kicker }}</span>
        <span v-if="bar.progress" class="now__count">{{ pad2(bar.progress.value) }} / {{ pad2(bar.progress.total) }}</span>
      </small>
      <strong :title="title">{{ title }}</strong>
    </div>

    <nav class="parts" aria-label="主导航">
      <RouterLink
        v-for="m in MODULES"
        :key="m.to"
        class="part"
        :class="{ 'is-active': isActive(m.match) }"
        :to="m.to"
      >
        <span>{{ m.n }}</span><em>{{ m.label }}</em>
      </RouterLink>
    </nav>

    <!-- 页面动作放在这里而不是标题下面：塞进"正在查看"那块会让它变成三行，
         整条栏的重心被拉到顶部，品牌与进度都不再垂直居中。 -->
    <div v-if="bar.actions.length" class="bar-actions">
      <button
        v-for="a in bar.actions"
        :key="a.label"
        type="button"
        class="bar-action"
        :class="{ 'is-primary': a.primary }"
        :disabled="a.disabled"
        @click="a.onClick()"
      >
        {{ a.label }}
      </button>
    </div>

    <div v-if="bar.progress" class="progress">
      <div class="progress__row">
        <small>{{ bar.progress.label }}</small>
        <strong>{{ bar.progress.value }} / {{ bar.progress.total }}</strong>
      </div>
      <div class="progress__track"><span :style="{ width: `${pct}%` }" /></div>
    </div>

    <a class="portal" href="/">返回门户</a>

    <button
      id="nav-more"
      class="more"
      type="button"
      aria-haspopup="dialog"
      :aria-expanded="props.moreOpen"
      @click="props.onMore()"
    >
      <span aria-hidden="true">⋯</span>
      <span class="sr-only">打开菜单</span>
    </button>
  </header>
</template>

<style scoped>
.topbar {
  position: sticky;
  top: 0;
  z-index: 30;
  height: var(--nav-h);
  display: flex;
  align-items: center;
  gap: 22px;
  padding: 0 20px;
  border-bottom: 1px solid var(--c-line);
  background: var(--c-surface);
  color: var(--c-ink);
}

/* ---------- 品牌 ---------- */
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 268px;
  color: var(--c-ink);
  text-decoration: none;
}
.brand:hover {
  text-decoration: none;
}
.brand__mark {
  width: 38px;
  height: 42px;
  flex: none;
  fill: none;
  stroke: var(--c-primary);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.brand__text b {
  display: block;
  font-family: var(--font-mono);
  font-size: 19px;
  font-weight: 700;
  line-height: 1.35;
  letter-spacing: 1px;
  white-space: nowrap;
}
.brand__text em {
  font-style: italic;
  color: var(--c-primary);
}
.brand__text small {
  display: block;
  font-size: 11px;
  letter-spacing: 2px;
  color: var(--c-ink-3);
  margin-top: 2px;
  white-space: nowrap;
}

/* ---------- 正在查看 ---------- */
.now {
  border-left: 1px solid var(--c-line);
  padding-left: 20px;
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.now small {
  display: flex;
  gap: 14px;
  font-size: 11px;
  letter-spacing: 1.2px;
  color: var(--c-ink-3);
  margin-bottom: 5px;
}
.now__count {
  font-family: var(--font-mono);
  letter-spacing: 0.5px;
}
.now strong {
  display: block;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: var(--c-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 页面动作 ---------- */
.bar-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  border-left: 1px solid var(--c-line);
  padding-left: 16px;
}
.bar-action {
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--c-line);
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
  font-size: 12px;
  letter-spacing: 0.3px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.bar-action:hover {
  border-color: var(--c-primary);
  color: var(--c-primary);
  background: var(--c-primary-soft);
}
.bar-action.is-primary {
  border-color: var(--c-primary);
  background: var(--c-primary);
  color: var(--c-on-primary);
}
.bar-action.is-primary:hover {
  background: var(--c-primary-ink);
  border-color: var(--c-primary-ink);
}
.bar-action:disabled {
  opacity: 0.55;
  cursor: default;
}

/* ---------- 模块 chip ---------- */
.parts {
  display: flex;
  gap: 8px;
  align-items: center;
}
.part {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--c-ink-2);
  text-decoration: none;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}
.part span {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--c-line);
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
}
.part em {
  font-style: normal;
}
.part em {
  font-style: normal;
}
.part:hover {
  background: var(--c-primary-soft);
  color: var(--c-primary);
  text-decoration: none;
}
.part.is-active {
  color: var(--c-primary);
}
.part.is-active span {
  background: var(--c-primary);
  border-color: var(--c-primary);
  color: var(--c-on-primary);
}

/* ---------- 进度 ---------- */
.progress {
  min-width: 138px;
  border-left: 1px solid var(--c-line);
  padding-left: 18px;
}
.progress__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.progress__row small {
  font-size: 11px;
  letter-spacing: 0.6px;
  color: var(--c-ink-3);
}
.progress__row strong {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
}
.progress__track {
  height: 6px;
  background: var(--c-line-soft);
  margin-top: 9px;
}
.progress__track span {
  display: block;
  height: 100%;
  background: var(--c-primary);
  transition: width 0.4s;
}

.portal {
  font-size: 12px;
  color: var(--c-ink-3);
  white-space: nowrap;
  text-decoration: none;
}
.portal:hover {
  color: var(--c-primary);
}
.more {
  background: none;
  color: inherit;
  cursor: pointer;
  font: inherit;
  width: 33px;
  height: 33px;
  display: none;
  place-items: center;
  border: 1px solid var(--c-line);
  font-size: 20px;
  line-height: 1;
}
.more:hover {
  background: var(--c-primary-soft);
}

/* 焦点环：全站统一用主色 2px；不跟参考站的暖黄——它在白底上只有 1.9:1，
   键盘用户更难看见（本项目 30 次 axe 扫描与人工键盘走查都按主色验收）。 */
.brand:focus-visible,
.part:focus-visible,
.portal:focus-visible,
.more:focus-visible,
.bar-action:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 2px;
}

/* 1500 以下先收"返回门户"与模块文字，只留编号方块——把宽度让给标题与进度。
   1366 实测：四段文字（约 400px）+ 两个动作 + 进度会一起把标题挤到省略号。 */
@media (max-width: 1500px) {
  .portal {
    display: none;
  }
  .part em {
    display: none;
  }
  .part {
    padding: 6px 4px;
  }
}
@media (max-width: 1240px) {
  .parts {
    display: none;
  }
  .more {
    display: grid;
  }
}
@media (max-width: 860px) {
  .progress {
    display: none;
  }
  .brand {
    min-width: 0;
  }
}
@media (max-width: 719px) {
  .topbar {
    gap: 12px;
    padding: 0 12px;
  }
  .brand__text b {
    font-size: 15px;
  }
  .brand__text small,
  .now small {
    display: none;
  }
  .now strong {
    font-size: 14px;
  }
}
</style>
