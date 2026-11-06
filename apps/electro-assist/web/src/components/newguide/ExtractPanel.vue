<script setup lang="ts">
/**
 * 识别结果面板：一段"待确认草稿"，不是成品。
 *
 * 从 NewGuideView 拆出来的第三块（2026-11-06）。这次只拆**展示**，
 * `runExtract`（调模型）与"识别图中内容"按钮仍留在父组件：
 * - 按钮在素材区 head 里，移走会改布局；
 * - runExtract 直接读 staged（素材列表），拆出来要跨两层传 props，得不偿失。
 *
 * 所以这里是纯展示组件：result / error 进，apply / clear 出。
 * 视觉上要弱于正文，但 unverified 必须显眼——那几行是"模型写了、图里没有"的地方。
 */
import type { ExtractResult } from '../../types'

const props = defineProps<{
  result: ExtractResult | null
  error: string
}>()

const emit = defineEmits<{ apply: []; clear: [] }>()
</script>

<template>
  <section v-if="props.result || props.error" class="extract" aria-live="polite">
    <div class="extract__head">
      <strong>识别结果</strong>
      <span class="hint">只做录入，不自动生成</span>
      <button class="linkbtn" type="button" @click="emit('clear')">关闭</button>
    </div>

    <p v-if="props.error" class="asset-error" role="alert">{{ props.error }}</p>

    <template v-if="props.result">
      <p class="extract__note">{{ props.result.disclaimer }}</p>
      <p class="hint">
        转录 {{ props.result.stats.lines }} 行，识别 {{ props.result.stats.steps }} 步，其中
        {{ props.result.stats.verified_steps }} 步逐字匹配原文。
      </p>
      <p class="hint">
        <template v-if="props.result.channels.mode === 'dual'">
          双通道：转录 {{ props.result.channels.transcribe?.lines ?? 0 }} 行 →
          结构化 {{ props.result.channels.structure?.steps ?? 0 }} 步，
          引用 {{ Math.round((props.result.channels.structure?.coverage ?? 0) * 100) }}% 的转录行
        </template>
        <template v-else>单通道识别（一次调用出结果）</template>
      </p>
      <p v-if="props.result.channels.fallback" class="asset-error">
        · 已降级到单通道（{{ props.result.channels.fallback }}）：少了一层"字段必须能在原文里找到"的校验，请逐条核对。
      </p>
      <p
        v-for="(item, index) in props.result.unverified.slice(0, 6)"
        :key="`u-${index}`"
        class="asset-error"
      >
        · {{ item }}
      </p>
      <p v-if="props.result.unverified.length > 6" class="hint">
        另有 {{ props.result.unverified.length - 6 }} 处待核对。
      </p>
      <p v-for="(item, index) in props.result.warnings" :key="`w-${index}`" class="hint">
        · {{ item }}
      </p>

      <details class="extract__lines">
        <summary>查看转录原文（{{ props.result.lines.length }} 行）</summary>
        <pre class="extract__pre">{{ props.result.lines.join('\n') }}</pre>
      </details>

      <div class="row">
        <button class="btn btn--primary" type="button" @click="emit('apply')">
          填入工艺文本
        </button>
        <button class="btn" type="button" @click="emit('clear')">放弃</button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.extract {
  margin-top: 12px;
  padding: 12px;
  border: 1px solid var(--c-line);
  border-radius: 8px;
  background: var(--c-bg);
}

.extract__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}

.extract__head .linkbtn {
  margin-left: auto;
}

.extract__note {
  margin: 6px 0;
  color: var(--c-warning);
  font-size: 13px;
}

.extract__lines {
  margin: 8px 0;
  font-size: 13px;
}

.extract__pre {
  max-height: 220px;
  overflow: auto;
  margin: 6px 0 0;
  padding: 8px;
  border: 1px solid var(--c-line);
  border-radius: 6px;
  background: var(--c-surface);
  font-family: var(--font-mono, ui-monospace, Menlo, Consolas, monospace);
  font-size: 12px;
  white-space: pre-wrap;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.hint {
  margin: 8px 0 0;
  color: var(--c-ink-3);
  font-size: 13px;
}

.asset-error {
  margin: 8px 0 0;
  color: var(--c-danger);
  font-size: 13px;
}

.linkbtn {
  padding: 0;
  border: 0;
  background: none;
  color: var(--c-primary);
  font: inherit;
  font-size: 13px;
  text-decoration: underline;
  cursor: pointer;
}
</style>
