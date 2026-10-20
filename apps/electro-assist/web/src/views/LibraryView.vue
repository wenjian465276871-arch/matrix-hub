<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { ApiError, getJson } from '../lib/http'
import type { GuideList, GuideSummary } from '../types'

const SYSTEM_LABEL: Record<string, string> = {
  door: '车门',
  hvac: '空调',
  pantograph: '受电弓',
}

const items = ref<GuideSummary[]>([])
const phase = ref<'loading' | 'ready' | 'error'>('loading')
const errorText = ref('')
let ctrl: AbortController | null = null

function minutes(seconds: number | null): string | null {
  if (!seconds) return null
  return `约 ${Math.max(1, Math.round(seconds / 60))} 分钟`
}

async function load(): Promise<void> {
  ctrl?.abort()
  ctrl = new AbortController()
  phase.value = 'loading'
  errorText.value = ''
  try {
    const data = await getJson<GuideList>('/api/electro/guides', ctrl.signal)
    items.value = data.items
    phase.value = 'ready'
  } catch (err) {
    if (ctrl.signal.aborted) return
    errorText.value =
      err instanceof ApiError
        ? err.kind === 'timeout'
          ? '请求超时，请检查网络后重试'
          : `服务暂不可用（${err.status ?? err.kind}）`
        : '页面初始化失败：请升级浏览器，或改用 Chrome / Safari 打开'
    if (!(err instanceof ApiError)) console.error('load guides failed', err)
    phase.value = 'error'
  }
}

onMounted(load)
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
    <button class="btn" type="button" @click="load">重试</button>
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
  </div>
</template>
