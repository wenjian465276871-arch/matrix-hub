<script setup lang="ts">
/** B 模块：故障排查。
 *
 *  只做一件事：把现场的话变成"按顺序查什么"。
 *  刻意不做对话框——排查结论必须能一次看完、能打印、能对照着做。
 */
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ApiError, getJson, postJson } from '../lib/http'
import type { DiagnoseResponse, KbOverview } from '../types'

const route = useRoute()

const symptom = ref('')
const system = ref<'' | 'door' | 'hvac' | 'pantograph'>('')
const phase = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const result = ref<DiagnoseResponse | null>(null)
const kb = ref<KbOverview | null>(null)
const errorText = ref('')
const context = ref<{ guide_id?: string; step_seq?: number }>({})

const SYSTEM_LABEL: Record<string, string> = {
  door: '客室侧门',
  hvac: '空调',
  pantograph: '受电弓',
}

async function submit(): Promise<void> {
  const text = symptom.value.trim()
  if (text.length < 4) {
    errorText.value = '请多描述一点现象，至少 4 个字'
    phase.value = 'error'
    return
  }
  phase.value = 'loading'
  errorText.value = ''
  try {
    result.value = await postJson<DiagnoseResponse>('/api/electro/diagnose', {
      symptom: text,
      system: system.value || null,
      top_k: 3,
      context: context.value.guide_id ? context.value : null,
    })
    phase.value = 'ready'
  } catch (err) {
    errorText.value =
      err instanceof ApiError
        ? err.message || '排查失败，请稍后再试'
        : '网络异常，排查失败，请稍后再试'
    phase.value = 'error'
  }
}

function reset(): void {
  result.value = null
  phase.value = 'idle'
  errorText.value = ''
}

onMounted(async () => {
  try {
    kb.value = await getJson<KbOverview>('/api/electro/diagnose/kb')
  } catch {
    // 知识库概览只是提示，取不到不影响主流程
  }

  const query = route.query
  if (typeof query.symptom === 'string' && query.symptom.trim()) {
    symptom.value = query.symptom.slice(0, 200)
    if (typeof query.guide === 'string') context.value.guide_id = query.guide
    if (typeof query.step === 'string' && Number(query.step) > 0) {
      context.value.step_seq = Number(query.step)
    }
    await submit()
  }
})
</script>

<template>
  <div class="page-head">
    <h1 class="page-title">故障排查</h1>
    <p class="page-sub">
      用现场的话描述现象，给出按顺序可执行的检查项。只做知识检索，不调用模型、不编造部件。
    </p>
  </div>

  <section class="card ask">
    <label class="field">
      <span class="field__label">现场现象</span>
      <textarea
        id="symptom"
        v-model="symptom"
        class="textarea"
        rows="3"
        maxlength="200"
        placeholder="例如：门关到一半又自己弹开了"
      />
      <span class="field__hint">{{ symptom.length }}/200</span>
    </label>

    <div class="ask__row">
      <select v-model="system" class="select" aria-label="子系统">
        <option value="">自动识别子系统</option>
        <option value="door">客室侧门</option>
        <option value="hvac">空调</option>
        <option value="pantograph">受电弓</option>
      </select>
      <button
        class="btn btn--primary"
        type="button"
        :disabled="phase === 'loading' || symptom.trim().length < 4"
        @click="submit"
      >
        {{ phase === 'loading' ? '检索中…' : '开始排查' }}
      </button>
    </div>

    <p v-if="kb" class="kb-note">
      知识库 {{ kb.count }} 条 · 覆盖
      {{ kb.systems.map((s) => SYSTEM_LABEL[s] ?? s).join('、') }} · 关键词检索 ·
      {{ kb.provider }}
    </p>
  </section>

  <p v-if="context.guide_id" class="ctx-note">
    来自作业记录：第 {{ context.step_seq }} 步异常 · 指导书 {{ context.guide_id }}
  </p>

  <section v-if="phase === 'error'" class="card state">
    <p>{{ errorText }}</p>
    <button class="btn" type="button" @click="phase = 'idle'">返回修改</button>
  </section>

  <section v-else-if="result && !result.matched" class="card uncovered">
    <p class="uncovered__title">未覆盖</p>
    <p class="uncovered__body">{{ result.message }}</p>
    <p class="uncovered__hint">{{ result.suggestion }}</p>
    <button class="btn" type="button" @click="reset">换个说法</button>
  </section>

  <section v-else-if="result" class="results">
    <p class="results__meta">
      匹配 {{ result.count }} 条 · 用时 {{ result.took_ms }}ms · 知识库 v{{ result.kb_version }}
    </p>

    <article v-for="(item, index) in result.results" :key="item.id" class="card hit">
      <header class="hit__head">
        <span class="hit__rank">{{ index + 1 }}</span>
        <h2 class="hit__title">{{ item.title }}</h2>
      </header>

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
            <span class="check__action">{{ check.action }}</span>
            <span class="check__expect">判据：{{ check.expect }}</span>
          </li>
        </ol>
      </div>

      <p class="hit__note"><strong>仍不解决：</strong>{{ item.escalation }}</p>
      <p class="hit__note hit__note--safe"><strong>安全提示：</strong>{{ item.safety }}</p>
    </article>

    <p class="disclaimer">{{ result.disclaimer }} · 排查建议需专业人员确认后执行</p>
  </section>
</template>

<style scoped>
.field {
  display: block;
}

.field__label {
  display: block;
  margin-bottom: 8px;
  font-weight: 600;
  color: var(--c-ink);
}

.field__hint {
  display: block;
  margin-top: 6px;
  color: var(--c-ink-3);
  font-size: 12px;
  text-align: right;
}

.textarea {
  width: 100%;
  min-height: 88px;
  padding: 12px 14px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
  line-height: 1.6;
  resize: vertical;
}

.textarea:focus {
  outline: 2px solid var(--c-primary);
  outline-offset: 1px;
}

.select {
  height: var(--tap);
  padding: 0 12px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
}

.ask {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ask__row {
  display: flex;
  gap: 12px;
  align-items: center;
}

.ask__row .select {
  flex: 0 0 160px;
}

.ask__row .btn {
  flex: 1;
}

.kb-note {
  margin: 0;
  color: var(--c-ink-3);
  font-size: 12px;
}

.ctx-note {
  margin: 12px 2px 0;
  color: var(--c-ink-3);
  font-size: 12px;
}

.uncovered {
  margin-top: 16px;
  border-left: 4px solid var(--c-warning);
  background: var(--c-warning-soft);
}

.uncovered__title {
  margin: 0 0 8px;
  font-weight: 600;
  color: var(--c-warning);
}

.uncovered__body {
  margin: 0 0 6px;
}

.uncovered__hint {
  margin: 0 0 12px;
  color: var(--c-ink-2);
  font-size: 14px;
}

.results {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.results__meta {
  margin: 0;
  color: var(--c-ink-3);
  font-size: 12px;
}

.hit__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 12px;
}

.hit__rank {
  flex: 0 0 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--c-primary);
  color: #fff;
  font-size: 13px;
  line-height: 24px;
  text-align: center;
}

.hit__title {
  margin: 0;
  font-size: 17px;
}

.hit__block {
  margin-bottom: 12px;
}

.hit__label {
  margin: 0 0 6px;
  color: var(--c-ink-3);
  font-size: 12px;
  letter-spacing: 0.04em;
}

.hit__list {
  margin: 0;
  padding-left: 20px;
}

.hit__list li {
  margin-bottom: 4px;
}

.check-list {
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: check;
}

.check {
  counter-increment: check;
  position: relative;
  padding: 10px 12px 10px 38px;
  margin-bottom: 8px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius-sm);
  background: var(--c-bg);
}

.check::before {
  content: counter(check);
  position: absolute;
  left: 12px;
  top: 10px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--c-primary-soft);
  color: var(--c-primary-ink);
  font-size: 12px;
  line-height: 18px;
  text-align: center;
}

.check__action {
  display: block;
}

.check__expect {
  display: block;
  margin-top: 4px;
  color: var(--c-ink-3);
  font-size: 13px;
}

.hit__note {
  margin: 0 0 6px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--c-primary-soft);
  font-size: 14px;
}

.hit__note--safe {
  background: var(--c-warning-soft);
}

.disclaimer {
  margin: 4px 0 0;
  color: var(--c-ink-3);
  font-size: 12px;
  text-align: center;
}

@media (max-width: 640px) {
  .ask__row {
    flex-direction: column;
    align-items: stretch;
  }

  .ask__row .select {
    flex: none;
  }
}
</style>
