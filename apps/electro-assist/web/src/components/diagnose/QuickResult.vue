<script setup lang="ts">
/** 快速检索结果：候选条目 + 完整检查清单。
 *
 *  刻意做成"一次看完、能打印"的静态结构，不做折叠与交互——
 *  现场对照着做的时候，任何需要点开的东西都会被跳过。
 */
import type { DiagnoseResponse } from '../../types'

defineProps<{ result: DiagnoseResponse }>()
const emit = defineEmits<{ run: [entryId: string]; reset: [] }>()
</script>

<template>
  <section v-if="!result.matched" class="card uncovered">
    <p class="uncovered__title">未覆盖</p>
    <p class="uncovered__body">{{ result.message }}</p>
    <p class="uncovered__hint">{{ result.suggestion }}</p>
    <button class="btn" type="button" @click="emit('reset')">换个说法</button>
  </section>

  <section v-else class="results">
    <p class="results__meta">
      匹配 {{ result.count }} 条 · 用时 {{ result.took_ms }}ms · 知识库 v{{ result.kb_version }}
    </p>

    <p v-if="result.rerank" class="rerank-note">
      模型重排：{{ result.rerank.model || 'deepseek' }} · {{ result.rerank.latency_ms }}ms
      <template v-if="result.rerank.reason">· {{ result.rerank.reason }}</template>
      <template v-if="result.rerank.cached">· 缓存命中</template>
    </p>

    <article v-for="(item, index) in result.results" :key="item.id" class="card hit">
      <header class="hit__head">
        <span class="hit__rank">{{ index + 1 }}</span>
        <h2 class="hit__title">{{ item.title }}</h2>
      </header>

      <p v-if="item.signals" class="signals">
        关键词 {{ item.signals.keyword }} · 向量 {{ item.signals.vector }} · 综合
        {{ item.signals.combined }}
      </p>

      <div class="hit__block">
        <p class="hit__label">可能原因</p>
        <ul class="hit__list">
          <li v-for="cause in item.likely_causes" :key="cause">{{ cause }}</li>
        </ul>
      </div>

      <div class="hit__block">
        <p class="hit__label">按顺序检查</p>
        <ol class="check-list">
          <li v-for="check in item.checks" :key="check.order" class="check">
            <span class="check__action">
              {{ check.action }}
              <span v-if="check.kind === 'measure'" class="check__tag">
                实测 {{ check.unit }}
              </span>
            </span>
            <span class="check__expect">判据：{{ check.expect }}</span>
          </li>
        </ol>
      </div>

      <p class="hit__note"><strong>仍不解决：</strong>{{ item.escalation }}</p>
      <p class="hit__note hit__note--safe"><strong>安全提示：</strong>{{ item.safety }}</p>

      <button class="btn hit__cta" type="button" @click="emit('run', item.id)">
        按这条逐步诊断
      </button>
    </article>

    <p class="diag-disclaimer">{{ result.disclaimer }} · 排查建议需专业人员确认后执行</p>
  </section>
</template>
