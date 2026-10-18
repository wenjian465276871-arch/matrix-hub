<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ApiError, getJson } from '../lib/http'
import type { Criterion, Guide } from '../types'

const props = defineProps<{ id: string }>()

const SYSTEM_LABEL: Record<string, string> = {
  door: '车门',
  hvac: '空调',
  pantograph: '受电弓',
}

const guide = ref<Guide | null>(null)
const phase = ref<'loading' | 'ready' | 'notfound' | 'error'>('loading')
const errorText = ref('')
let ctrl: AbortController | null = null

function criterionValue(c: Criterion): string {
  if (c.type === 'range') return `${c.min ?? '—'} ~ ${c.max ?? '—'}`
  if (c.type === 'enum') return (c.options ?? []).join(' / ')
  if (c.type === 'manual') return '人工确认'
  return '记录'
}

// 模板里拿不到 window（Vue 只白名单了 Math/Date/JSON 等），必须在这里包一层。
function printGuide(): void {
  window.print()
}

async function load(): Promise<void> {
  ctrl?.abort()
  ctrl = new AbortController()
  phase.value = 'loading'
  errorText.value = ''
  try {
    guide.value = await getJson<Guide>(`/api/electro/guides/${props.id}`, ctrl.signal)
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
        : '未知错误'
    phase.value = 'error'
  }
}

onMounted(load)
watch(() => props.id, load)
onBeforeUnmount(() => ctrl?.abort())
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

  <article v-else-if="guide" class="card">
    <header class="guide-head">
      <h1 class="guide-title">{{ guide.title }}</h1>
      <p class="guide-summary">{{ guide.summary }}</p>
      <div class="meta-row">
        <span class="tag">{{ SYSTEM_LABEL[guide.meta.system] ?? guide.meta.system }}</span>
        <span class="tag tag--plain">{{ guide.steps.length }} 步</span>
        <span class="tag tag--plain">{{ guide.meta.model }}</span>
        <span>{{ new Date(guide.meta.generated_at).toLocaleString('zh-CN') }}</span>
      </div>
      <p class="disclaimer">
        {{ guide.disclaimers.join(' · ') }}
      </p>
      <div class="meta-row no-print">
        <button class="btn" type="button" @click="printGuide">打印 / 导出 PDF</button>
      </div>
    </header>

    <section v-for="step in guide.steps" :key="step.id" class="step">
      <div class="step__head">
        <span class="step__seq">{{ String(step.seq).padStart(2, '0') }}</span>
        <h2 class="step__title">{{ step.title }}</h2>
      </div>
      <p class="step__action">{{ step.action }}</p>

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
            <span class="criterion__value">
              {{ criterionValue(c) }}<span v-if="c.unit" class="criterion__unit">{{ c.unit }}</span>
            </span>
          </div>
        </div>
      </div>

      <div v-if="step.figures.length" class="step__block">
        <p class="block-label">图示</p>
        <div v-for="(fig, i) in step.figures" :key="`${step.id}-fig-${i}`" class="figure">
          <p v-if="fig.caption" class="figure__caption">{{ fig.caption }}</p>
          <p class="figure__fallback">{{ fig.fallback_text }}</p>
          <p class="figure__pending">图元 {{ fig.primitive }} · 渲染器待接入（T07）</p>
        </div>
      </div>

      <div v-if="step.duration_s" class="step__block">
        <p class="block-label">预计耗时</p>
        <p class="figure__fallback">{{ Math.max(1, Math.round(step.duration_s / 60)) }} 分钟</p>
      </div>
    </section>
  </article>
</template>
