<script setup lang="ts">
/**
 * 逐条溯源：把"这条内容是原图第几行"从统计数字变成可点开的证据。
 *
 * 为什么单独一个组件：`ExtractPanel` 是**摘要**（转录几行、识别几步、覆盖率），
 * 这里是**逐条**（每一步、每条判据的来源）。两者消费者不同——摘要给"要不要重识别"，
 * 逐条给"这条能不能信"。合成一个组件会让那块面板很快变成第二个千行文件。
 *
 * 三态文案（`ok` / `suspect` / `unverified`）由服务端判定，前端只负责不撒谎：
 * `suspect` 必须显示「待核」，`unverified` 必须显示「指不回原文」，不许渲染成绿色。
 */
import { ref } from 'vue'
import type { ExtractResult, TraceRef } from '../../types'

const props = defineProps<{ result: ExtractResult }>()

/** 当前展开的条目：`s{seq}` = 动作来源，`c{seq}` = 判据来源 */
const open = ref<string | null>(null)

function toggle(key: string) {
  open.value = open.value === key ? null : key
}

/** 行号内部分 0 基，给人看一律 +1。显示 0 基会让人以为"第 0 行"是标题行。 */
function chipLabel(trace: TraceRef): string {
  if (trace.line === null) return '指不回原文'
  return `第 ${trace.line + 1} 行`
}

function clickable(trace: TraceRef | null): boolean {
  return !!trace && trace.flag !== 'unverified' && trace.line !== null
}

const TOTAL = props.result.lines.length
</script>

<template>
  <section class="trace" aria-labelledby="trace-title">
    <header class="trace__head">
      <h3 id="trace-title" class="trace__title">逐条溯源</h3>
      <p class="trace__stat">
        {{ result.stats.steps }} 步中
        <b>{{ result.stats.located_steps }}</b> 步能指回原文具体行
      </p>
    </header>
    <p class="trace__hint">
      点「第 N 行」展开那一行转录原文。标「待核」的是模型改写或只对得上数字——
      是线索，不是证据；「指不回原文」表示定位不到，必须人工核对。
    </p>

    <ol class="trace__list">
      <li v-for="step in result.fields.steps" :key="step.seq" class="trace__item">
        <div class="trace__row">
          <span class="trace__seq">{{ step.seq }}</span>
          <span class="trace__text">{{ step.action }}</span>
          <button
            v-if="clickable(step.trace)"
            type="button"
            class="trace__chip"
            :class="`trace__chip--${step.trace.flag}`"
            :aria-expanded="open === `s${step.seq}`"
            :aria-controls="`trace-s${step.seq}`"
            @click="toggle(`s${step.seq}`)"
          >
            {{ chipLabel(step.trace) }}
            <span v-if="step.trace.flag === 'suspect'" class="trace__tag">待核</span>
          </button>
          <span v-else class="trace__chip trace__chip--unverified">指不回原文</span>
        </div>
        <div
          v-if="open === `s${step.seq}` && step.trace.text"
          :id="`trace-s${step.seq}`"
          class="trace__source"
        >
          <span class="trace__source-label">原文</span>
          <span class="trace__source-text">{{ step.trace.text }}</span>
        </div>

        <div v-if="step.criterion" class="trace__row trace__row--criterion">
          <span class="trace__seq trace__seq--sub">判据</span>
          <span class="trace__text trace__text--criterion">{{ step.criterion }}</span>
          <button
            v-if="clickable(step.criterion_trace)"
            type="button"
            class="trace__chip"
            :class="`trace__chip--${step.criterion_trace!.flag}`"
            :aria-expanded="open === `c${step.seq}`"
            :aria-controls="`trace-c${step.seq}`"
            @click="toggle(`c${step.seq}`)"
          >
            {{ chipLabel(step.criterion_trace!) }}
            <span v-if="step.criterion_trace!.flag === 'suspect'" class="trace__tag">待核</span>
          </button>
          <span v-else class="trace__chip trace__chip--unverified">指不回原文</span>
        </div>
        <div
          v-if="open === `c${step.seq}` && step.criterion_trace?.text"
          :id="`trace-c${step.seq}`"
          class="trace__source"
        >
          <span class="trace__source-label">原文</span>
          <span class="trace__source-text">{{ step.criterion_trace.text }}</span>
        </div>
      </li>
    </ol>

    <details class="trace__all">
      <summary>全部转录（{{ TOTAL }} 行）</summary>
      <ol class="trace__lines">
        <li v-for="(line, index) in result.lines" :key="index">
          <span class="trace__lineno">{{ index + 1 }}</span>
          <span>{{ line }}</span>
        </li>
      </ol>
    </details>
  </section>
</template>

<style scoped>
.trace {
  margin-top: 16px;
  padding: 16px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius);
  background: var(--c-surface);
}

.trace__head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  align-items: baseline;
  justify-content: space-between;
}

.trace__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--c-ink);
}

.trace__stat {
  margin: 0;
  font-size: 13px;
  color: var(--c-ink-3);
}

.trace__stat b {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--c-ink);
}

.trace__hint {
  margin: 6px 0 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--c-ink-3);
}

.trace__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.trace__item + .trace__item {
  border-top: 1px solid var(--c-line-soft);
}

.trace__row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 8px 0;
}

.trace__row--criterion {
  padding-top: 0;
  padding-bottom: 8px;
  padding-left: 26px;
}

.trace__seq {
  flex: 0 0 18px;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  color: var(--c-ink-3);
  text-align: right;
}

.trace__seq--sub {
  flex-basis: 26px;
  font-size: 11px;
  color: var(--c-ink-3);
}

.trace__text {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--c-ink);
  overflow-wrap: anywhere;
}

.trace__text--criterion {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  color: var(--c-ink-2);
}

.trace__chip {
  position: relative;
  flex: 0 0 auto;
  display: inline-flex;
  gap: 4px;
  align-items: center;
  min-height: 28px;
  padding: 2px 8px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius-sm);
  background: var(--c-bg);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--c-ink-2);
  cursor: pointer;
}

/* 视觉 28px，热区 44px：规范要求的是「可点区域 ≥44×44」，不是「看起来多大」。
   次要控件做成 44px 视觉高度，会把正文挤成碎片；用伪元素把命中区上下各扩 8px，
   观感不变而手指点得中。 */
.trace__chip::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 44px;
  transform: translateY(-50%);
}

.trace__chip:hover {
  background: var(--c-surface);
}

.trace__chip:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 1px;
}

.trace__chip--ok {
  border-color: var(--c-success);
  background: var(--c-success-soft);
  color: var(--c-success);
}

.trace__chip--suspect {
  border-color: var(--c-warning-line);
  background: var(--c-warning-soft);
  color: var(--c-warning);
}

/* unverified 不是按钮，就不该留按钮的形状：虚线框 + 28px 高会和旁边可点的
   chip 混成同一类东西。2026-11-08 视觉验收发现的就是这个问题——文案写了
   "点不开的东西不该长得像按钮"，渲染出来却还是个禁用按钮。改成纯文字。 */
.trace__chip--unverified {
  min-height: 0;
  padding: 0;
  border: 0;
  background: none;
  font-family: var(--font-sans);
  color: var(--c-ink-3);
  cursor: default;
}

.trace__tag {
  font-family: var(--font-sans);
  font-size: 11px;
}

.trace__source {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin: 0 0 8px 26px;
  padding: 6px 10px;
  border-left: 2px solid var(--c-primary);
  background: var(--c-primary-soft);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}

.trace__source-label {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--c-ink-3);
}

.trace__source-text {
  font-size: 13px;
  line-height: 1.6;
  color: var(--c-ink-2);
  overflow-wrap: anywhere;
}

.trace__all {
  margin-top: 12px;
  font-size: 12px;
  color: var(--c-ink-3);
}

.trace__all summary {
  cursor: pointer;
  min-height: 28px;
  line-height: 28px;
}

.trace__lines {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
  max-height: 260px;
  overflow-y: auto;
}

.trace__lines li {
  display: flex;
  gap: 8px;
  padding: 2px 0;
  line-height: 1.6;
  color: var(--c-ink-2);
}

.trace__lineno {
  flex: 0 0 28px;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  text-align: right;
  color: var(--c-ink-3);
}

/* 确认页一般不打印，但 Ctrl+P 是随手动作。纸上留彩色描边只会糊成灰块，
   而"哪一步有几行"这个信息在纸面上仍然有用，所以只去装饰、不留白。 */
@media print {
  .trace__chip {
    padding: 0;
    border-color: transparent;
    background: none;
  }

  .trace__source {
    border-left-color: #999;
    background: none;
  }
}
</style>
