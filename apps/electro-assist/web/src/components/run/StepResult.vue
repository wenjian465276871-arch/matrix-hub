<script setup lang="ts">
import type { CriterionResult } from '../../types'
import { formatResult, verdictLabel } from '../../lib/runeval'

/**
 * 本步判定结果面板：通过 / 异常两个分支。
 *
 * 为什么值得单独拆：这是现场唯一"必须看懂"的地方——通过就继续，异常就复测、
 * 排查或停工，三条路完全不同。它也是 `aria-live` 区域，读屏播报的边界在这里。
 *
 * 注意两个分支是 `v-if` / `v-else-if` 互斥的：同时渲染会让读屏连播两段相反的结论。
 */

defineProps<{
  /** 只有 passed / exception 会进来；其它阶段父组件不渲染本组件 */
  phase: 'passed' | 'exception'
  results: CriterionResult[]
  /** 最后一步通过后按钮改成「完成并查看记录」 */
  isLastStep: boolean
}>()

const emit = defineEmits<{
  next: []
  retest: []
  diagnose: []
  abort: []
}>()
</script>

<template>
  <section v-if="phase === 'passed'" class="result-box result-box--ok" aria-live="polite">
    <p class="result-title">本步通过</p>
    <ul class="result-list">
      <li v-for="result in results" :key="result.criterion_id">
        <span>{{ result.label }}</span>
        <span>{{ formatResult(result) }}</span>
        <span class="verdict-chip" :class="`v-${result.verdict}`">
          {{ verdictLabel(result.verdict) }}
        </span>
      </li>
    </ul>
    <button class="btn btn--primary block-btn" type="button" @click="emit('next')">
      {{ isLastStep ? '完成并查看记录' : '继续下一步' }}
    </button>
  </section>

  <section v-else class="result-box result-box--bad" aria-live="assertive">
    <p class="result-title">本步异常，需处置</p>
    <ul class="result-list">
      <li v-for="result in results" :key="result.criterion_id">
        <span>{{ result.label }}</span>
        <span>{{ result.message }}</span>
      </li>
    </ul>
    <p class="result-note">异常已记录。复测会生成新的尝试记录，原记录保留。</p>
    <div class="actions">
      <button class="btn btn--primary" type="button" @click="emit('retest')">复测本步</button>
      <button class="btn" type="button" @click="emit('diagnose')">转故障排查</button>
      <button class="btn btn--danger" type="button" @click="emit('abort')">停止作业</button>
    </div>
  </section>
</template>

<style scoped>
.result-box {
  margin-top: 16px;
  padding: 16px;
  border: 1px solid var(--c-line);
  border-radius: 8px;
}

.result-box--ok {
  border-color: #9bc7ad;
  background: #f1f8f4;
}

.result-box--bad {
  border-color: #d9a3a0;
  background: #fff7f6;
}

.result-title {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 700;
}

.result-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.result-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px dashed var(--c-line-soft);
  font-size: 14px;
}

.result-list li:last-child {
  border-bottom: none;
}

.result-note {
  margin: 10px 0 0;
  color: var(--c-ink-2);
  font-size: 13px;
}

/* verdict-chip 与父组件的「已完成步骤」列表共用同一套视觉，scoped 不穿透，
   只能各存一份。改配色时两处要一起改。 */
.verdict-chip {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 12px;
  white-space: nowrap;
}

.v-pass {
  background: #e6f4ec;
  color: #1a7f4b;
}

.v-fail {
  background: #fdeceb;
  color: #b3261e;
}

.v-warn {
  background: #fff4e0;
  color: #8a5a00;
}

.v-manual {
  background: var(--c-primary-soft);
  color: var(--c-primary-ink);
}

.v-skipped {
  background: var(--c-line-soft);
  color: var(--c-ink-3);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
}

.block-btn {
  width: 100%;
  min-height: 48px;
  margin-top: 14px;
}

.btn--danger {
  border-color: #b3261e;
  background: #b3261e;
  color: #fff;
}
</style>
