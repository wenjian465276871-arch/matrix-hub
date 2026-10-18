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
        : '未知错误'
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
      当前为演示样例库：内容由公开资料整理并虚构化改写，用于验证「结构化作业数据 → 可视化指导书」这条链路。
    </p>
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
    <p>还没有可用的指导书。</p>
    <p class="state__hint">生成管线在 P1a-W2 接入后，这里会出现生成结果。</p>
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
