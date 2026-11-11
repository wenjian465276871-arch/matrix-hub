<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { announce } from '../lib/announce'
import { ApiError, getJson } from '../lib/http'
import type { GuideList, GuideSummary } from '../types'

/** 计划 §12.6：不做虚拟滚动，「加载更多」每页 12。与服务端 PAGE_SIZE 同值。 */
const PAGE_SIZE = 12
/** 输入防抖：250ms 够快，又不会每敲一个字打一次接口。 */
const DEBOUNCE_MS = 250

const SYSTEM_LABEL: Record<string, string> = {
  door: '车门',
  hvac: '空调',
  pantograph: '受电弓',
}

const items = ref<GuideSummary[]>([])
const total = ref(0)
const hasMore = ref(false)
const loadingMore = ref(false)
const phase = ref<'loading' | 'ready' | 'error'>('loading')
const errorText = ref('')
const query = ref('')
/** 真正发给服务端的词。输入框在防抖期间与它不同步，这是故意的。 */
const applied = ref('')
const searching = ref(false)
let ctrl: AbortController | null = null
let debounceTimer: number | null = null

const searchingHint = computed(() => applied.value !== '')

function minutes(seconds: number | null): string | null {
  if (!seconds) return null
  return `约 ${Math.max(1, Math.round(seconds / 60))} 分钟`
}

function listPath(offset: number): string {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
  })
  if (applied.value) params.set('q', applied.value)
  return `/api/electro/guides?${params.toString()}`
}

/** 搜索词进 URL：刷新与分享都保持当前视图，不让人重新输一遍。 */
function syncUrl(): void {
  const params = new URLSearchParams(window.location.search)
  if (applied.value) params.set('q', applied.value)
  else params.delete('q')
  const tail = params.toString()
  const next = `${window.location.pathname}${tail ? `?${tail}` : ''}`
  window.history.replaceState(null, '', next)
}

async function load(reset = true): Promise<void> {
  ctrl?.abort()
  ctrl = new AbortController()
  if (reset) {
    // 已有内容时不切骨架：搜索是"在现有结果上过滤"，整页闪一下会让输入框失焦。
    if (!items.value.length) phase.value = 'loading'
    searching.value = items.value.length > 0
  } else {
    loadingMore.value = true
  }
  errorText.value = ''
  const offset = reset ? 0 : items.value.length
  try {
    const data = await getJson<GuideList>(listPath(offset), ctrl.signal)
    // 翻页之间可能有新发布的插到前面，`offset` 会错位——按 id 去重比相信偏移稳
    const seen = new Set(items.value.map((item) => item.id))
    const fresh = reset ? data.items : data.items.filter((item) => !seen.has(item.id))
    items.value = reset ? data.items : [...items.value, ...fresh]
    total.value = data.total
    hasMore.value = data.has_more
    phase.value = 'ready'
    if (reset) {
      // 让读屏用户也知道过滤结果，而不用自己数卡片。
      announce(
        applied.value
          ? data.total
            ? `找到 ${data.total} 份匹配「${applied.value}」的指导书`
            : `没有匹配「${applied.value}」的指导书`
          : `共 ${data.total} 份指导书`,
      )
    }
  } catch (err) {
    if (ctrl.signal.aborted) return
    if (!reset) {
      // 加载更多失败不该把已经看到的列表整个换成错误页
      errorText.value = '加载更多失败，请重试'
      return
    }
    errorText.value =
      err instanceof ApiError
        ? err.kind === 'timeout'
          ? '请求超时，请检查网络后重试'
          : `服务暂不可用（${err.status ?? err.kind}）`
        : '页面初始化失败：请升级浏览器，或改用 Chrome / Safari 打开'
    if (!(err instanceof ApiError)) console.error('load guides failed', err)
    phase.value = 'error'
  } finally {
    loadingMore.value = false
    searching.value = false
  }
}

function applySearch(value: string): void {
  const next = value.trim().slice(0, 40)
  if (next === applied.value) return
  applied.value = next
  syncUrl()
  void load(true)
}

watch(query, (value) => {
  if (debounceTimer !== null) window.clearTimeout(debounceTimer)
  // 清空是明确动作，不等防抖：按 Esc 或点 × 之后应该立刻恢复全部。
  if (!value.trim()) {
    applySearch('')
    return
  }
  debounceTimer = window.setTimeout(() => applySearch(value), DEBOUNCE_MS)
})

function clearSearch(): void {
  query.value = ''
  applySearch('')
  document.getElementById('guide-search')?.focus()
}

async function loadMore(): Promise<void> {
  if (loadingMore.value || !hasMore.value) return
  const before = items.value.length
  await load(false)
  await nextTick()
  if (!hasMore.value) {
    // 最后一页之后按钮消失，焦点会掉回 body——交给第一条新卡片，键盘用户不至于丢位置
    document.querySelectorAll<HTMLElement>('.guide-card')[before]?.focus()
  }
}

onMounted(() => {
  const initial = new URLSearchParams(window.location.search).get('q') ?? ''
  if (initial) {
    query.value = initial
    applied.value = initial.trim().slice(0, 40)
  }
  void load()
})

onBeforeUnmount(() => {
  ctrl?.abort()
  if (debounceTimer !== null) window.clearTimeout(debounceTimer)
})
</script>

<template>
  <!-- 作业库也是"工作台"：左侧目录栏放搜索与说明，右侧列表面板。
       为什么要改：一列 860px 的卡片放在 1728 的屏上，右边全是空的，
       与指导书页的三栏语言完全是两套；统一成面板 + 细线之后才像同一个系统。 -->
  <div class="lib">
    <h1 class="sr-only">作业指导书</h1>

    <aside class="panel lib__side" aria-label="作业库">
      <div class="panel-head">
        <h2>作业库</h2>
      </div>

      <div class="search">
        <label class="search__label" for="guide-search">搜索指导书</label>
        <div class="search__field">
          <input
            id="guide-search"
            v-model="query"
            class="search__input"
            type="search"
            maxlength="40"
            placeholder="工序名、工位或关键词"
            autocomplete="off"
            enterkeyhint="search"
            :aria-describedby="searchingHint ? 'search-status' : undefined"
          />
          <button
            v-if="query"
            class="search__clear"
            type="button"
            aria-label="清空搜索"
            @click="clearSearch"
          >
            ×
          </button>
        </div>
        <p v-if="searchingHint" id="search-status" class="search__status">
          {{ searching ? '搜索中…' : total ? `找到 ${total} 份` : '没有匹配的指导书' }}
        </p>
      </div>

      <div class="lib__acts">
        <RouterLink class="btn btn--primary lib__new" to="/new">生成一份新的指导书</RouterLink>
      </div>

      <div class="lib__note">
        <p>已发布的演示指导书。生成结果默认是草稿，凭生成完成后的链接查看，不会进入这个列表。</p>
      </div>

      <div class="sidebar-foot">
        <span class="live-dot" aria-hidden="true" />
        <span>{{ total }} 份 · 演示数据</span>
      </div>
    </aside>

    <section class="panel lib__main" aria-labelledby="lib-list-title">
      <div class="panel-head">
        <h2 id="lib-list-title">指导书 <span>{{ total }}</span></h2>
        <span class="lib__hint">按发布时间倒序</span>
      </div>

      <div v-if="phase === 'loading'" class="skeleton-list" aria-busy="true" aria-label="加载中">
        <div class="skeleton" />
        <div class="skeleton" />
        <div class="skeleton" />
      </div>

      <div v-else-if="phase === 'error'" class="state state--error">
        <p>{{ errorText }}</p>
        <p class="state__hint">GET /api/electro/guides</p>
        <button class="btn" type="button" @click="load()">重试</button>
      </div>

      <div v-else-if="items.length === 0" class="state">
        <template v-if="searchingHint">
          <p>没有匹配「{{ applied }}」的指导书。</p>
          <p class="state__hint">只搜标题、摘要与来源说明；换一个词或清空搜索试试。</p>
          <button class="btn" type="button" @click="clearSearch">清空搜索</button>
        </template>
        <template v-else>
          <p>还没有已发布的指导书。</p>
          <p class="state__hint">可以先<RouterLink to="/new">生成一份草稿</RouterLink>，确认后再发布。</p>
        </template>
      </div>

      <div v-else class="lib__list" tabindex="0" role="region" aria-label="指导书列表（可滚动）">
        <RouterLink
          v-for="item in items"
          :key="item.id"
          class="guide-card"
          :to="{ name: 'guide', params: { id: item.id } }"
        >
          <h3 class="guide-card__title">{{ item.title }}</h3>
          <p class="guide-card__summary">{{ item.summary }}</p>
          <div class="meta-row">
            <span class="tag">{{ SYSTEM_LABEL[item.system] ?? item.system }}</span>
            <span>{{ item.step_count }} 步</span>
            <template v-if="minutes(item.estimated_s)">
              <span>·</span>
              <span>{{ minutes(item.estimated_s) }}</span>
            </template>
            <span>·</span>
            <span>AI 生成 · 需专业复核</span>
          </div>
        </RouterLink>

        <div v-if="hasMore" class="list-more">
          <p v-if="errorText" class="hint">{{ errorText }}</p>
          <p class="hint">已显示 {{ items.length }} / 共 {{ total }} 份</p>
          <button class="btn" type="button" :disabled="loadingMore" @click="loadMore">
            {{ loadingMore ? '加载中…' : `加载更多（还有 ${total - items.length} 份）` }}
          </button>
        </div>
        <p v-else class="hint list-end">已全部显示（共 {{ total }} 份）</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* 两栏工作台：目录 258 + 列表 1fr，与指导书页左侧栏同宽——
   两页之间切换时左边界不跳。 */
.lib {
  display: grid;
  grid-template-columns: 258px minmax(0, 1fr);
  gap: 12px;
  padding: 14px;
  height: calc(100dvh - var(--nav-h));
  min-height: 560px;
  overflow: hidden;
}

.lib__side {
  min-height: 0;
}

.lib__acts {
  padding: 0 14px;
  margin-top: 12px;
}

.lib__new {
  display: block;
  width: 100%;
  text-align: center;
}

.lib__note {
  padding: 14px;
  margin-top: 4px;
  border-top: 1px solid var(--c-line-soft);
  color: var(--c-ink-3);
  font-size: 12px;
  line-height: 1.8;
}

.lib__note p {
  margin: 0;
}

.sidebar-foot {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 14px;
  border-top: 1px solid var(--c-line-soft);
  font-size: 11px;
  letter-spacing: 0.4px;
  color: var(--c-ink-3);
}

.live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--c-success);
}

.lib__hint {
  font-size: 11px;
  letter-spacing: 0.5px;
  color: var(--c-ink-3);
  white-space: nowrap;
}

.lib__list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  scrollbar-width: thin;
}

.lib__list :deep(.guide-card:last-of-type) {
  border-bottom: 0;
}

.state {
  padding: 28px 20px;
  color: var(--c-ink-2);
  font-size: 14px;
}

.state p {
  margin: 0 0 8px;
}

.state--error {
  color: var(--c-danger);
}

.state__hint {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--c-ink-3);
}

/* 「加载更多」是列表的延伸，不是页面动作：贴着列表、居中，不抢主按钮的视觉 */
.list-more {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 14px 0;
}

.list-more .hint,
.list-end {
  margin: 0;
  text-align: center;
  font-size: 12px;
  color: var(--c-ink-3);
}

.list-end {
  padding: 12px 0;
}

/* 搜索在左侧栏内部：不出边框的"内嵌输入"，与参考站的 .search-wrap 同构 */
.search {
  padding: 12px 14px 0;
}

.search__label {
  display: block;
  font-size: 11px;
  letter-spacing: 0.8px;
  color: var(--c-ink-3);
  margin-bottom: 6px;
}

.search__field {
  position: relative;
  display: flex;
  align-items: center;
}

.search__input {
  width: 100%;
  min-height: 38px;
  padding: 0 34px 0 10px;
  border: 1px solid var(--c-line-soft);
  border-radius: 0;
  background: var(--c-bg);
  color: var(--c-ink);
  font: inherit;
  font-size: 13px;
}

.search__input::placeholder {
  color: var(--c-ink-3);
}

.search__input:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 1px;
}

/* 原生 search 输入框的自带 × 在 Chrome 与 Safari 里位置不一致，统一换成自己的 */
.search__input::-webkit-search-cancel-button {
  display: none;
}

.search__clear {
  position: absolute;
  right: 0;
  width: 32px;
  height: 38px;
  border: none;
  background: transparent;
  color: var(--c-ink-2);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

.search__clear:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: -2px;
}

.search__status {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--c-ink-2);
}

/* 1024 以下两栏挤成一条缝：退回单栏，目录在上、列表在下，整页滚动。 */
@media (max-width: 1024px) {
  .lib {
    grid-template-columns: 1fr;
    height: auto;
    overflow: visible;
  }
  .lib__list {
    max-height: 70vh;
  }
}
</style>
