<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { ApiError, getJson } from '../lib/http'
import type { GuideList, GuideSummary } from '../types'

/** 计划 §12.6：不做虚拟滚动，「加载更多」每页 12。与服务端 PAGE_SIZE 同值。 */
const PAGE_SIZE = 12

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
let ctrl: AbortController | null = null

function minutes(seconds: number | null): string | null {
  if (!seconds) return null
  return `约 ${Math.max(1, Math.round(seconds / 60))} 分钟`
}

async function load(reset = true): Promise<void> {
  ctrl?.abort()
  ctrl = new AbortController()
  if (reset) {
    phase.value = 'loading'
    items.value = []
  } else {
    loadingMore.value = true
  }
  errorText.value = ''
  const offset = reset ? 0 : items.value.length
  try {
    const data = await getJson<GuideList>(
      `/api/electro/guides?limit=${PAGE_SIZE}&offset=${offset}`,
      ctrl.signal,
    )
    // 翻页之间可能有新发布的插到前面，`offset` 会错位——按 id 去重比相信偏移稳
    const seen = new Set(items.value.map((item) => item.id))
    const fresh = reset ? data.items : data.items.filter((item) => !seen.has(item.id))
    items.value = reset ? data.items : [...items.value, ...fresh]
    total.value = data.total
    hasMore.value = data.has_more
    phase.value = 'ready'
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
  }
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

onMounted(() => load())
onBeforeUnmount(() => ctrl?.abort())
</script>

<template>
  <div class="page-head">
    <h1 class="page-title">作业指导书</h1>
    <p class="page-sub">
      已发布的演示指导书。生成结果默认是草稿，凭生成完成后的链接查看，不会进入这个列表。
    </p>
    <div class="meta-row">
      <RouterLink class="btn btn--primary" to="/new">生成一份新的指导书</RouterLink>
    </div>
  </div>

  <div v-if="phase === 'loading'" class="skeleton-list" aria-busy="true" aria-label="加载中">
    <div class="skeleton" />
    <div class="skeleton" />
  </div>

  <div v-else-if="phase === 'error'" class="card state state--error">
    <p>{{ errorText }}</p>
    <p class="state__hint">GET /api/electro/guides</p>
    <button class="btn" type="button" @click="load()">重试</button>
  </div>

  <div v-else-if="items.length === 0" class="card state">
    <p>还没有已发布的指导书。</p>
    <p class="state__hint">可以先<RouterLink to="/new">生成一份草稿</RouterLink>，确认后再发布。</p>
  </div>

  <div v-else class="card-list">
    <RouterLink
      v-for="item in items"
      :key="item.id"
      class="card guide-card"
      :to="{ name: 'guide', params: { id: item.id } }"
    >
      <h2 class="guide-card__title">{{ item.title }}</h2>
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
</template>

<style scoped>
/* 「加载更多」是列表的延伸，不是页面动作：贴着列表、居中，不抢主按钮的视觉 */
.list-more {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 8px 0 4px;
}

.list-more .hint,
.list-end {
  margin: 0;
  text-align: center;
}
</style>
