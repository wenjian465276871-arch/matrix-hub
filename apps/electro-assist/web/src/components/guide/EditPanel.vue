<script setup lang="ts">
import { ref } from 'vue'
import { ApiError, patchJson } from '../../lib/http'
import { buildPatch, toEditDraft, type EditDraft } from '../../lib/guidepatch'
import type { Guide, GuidePatchResult } from '../../types'

/**
 * 草稿修正面板。
 *
 * 只改文字与判据**值**：不能加步骤、不能换判据类型、不能新增判据。
 * 那不是"修正"，那是重新生成——重新生成有它自己的入口，也更便宜。
 *
 * 两个必须知道的设计点：
 * 1. 草稿是**挂载时的快照**（setup 里只取一次）。故意不 watch `guide`：
 *    保存成功后父组件会把新 guide 传回来，若跟着重置，用户刚改的内容会闪一下再变回去。
 * 2. 成功提示**不在本组件里**，靠 emit 交给父组件。因为保存成功后父组件会
 *    `editing = false` 卸载本组件，提示留在内部就等于用户永远看不见。
 *    （AttachPanel 那次踩过同样的坑，这里不再踩第二遍。）
 */

const props = defineProps<{
  guideId: string
  /** 进入编辑态那一刻的服务端快照，用于对比"改了什么" */
  guide: Guide
  /** 口令令牌；为 null 时保存必然 401，由父组件负责重新验证 */
  token: string | null
}>()

const emit = defineEmits<{
  /** 保存成功：把新 guide 与最新 blockers 交回父组件 */
  saved: [guide: Guide, blockers: string[]]
  /** 一个字都没改：父组件提示"没有改动"并退出编辑态 */
  unchanged: []
  cancel: []
  /** 401：令牌过期，父组件要清 token 并重新弹口令面板 */
  authExpired: []
}>()

const draft = ref<EditDraft>(toEditDraft(props.guide))
const busy = ref(false)
const error = ref('')

function describeError(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return err instanceof Error ? err.message : '保存失败，请稍后重试'
  }
  if (err.code === 'passcode_required' || err.status === 401) return '口令已过期，请重新验证口令。'
  if (err.code === 'passcode_disabled') return '服务端未启用修正通道（未配置口令）。'
  if (err.code === 'published_locked') return '这份指导书已被发布，不能再修改。'
  if (err.code === 'rate_limited') return `操作过于频繁，请 ${err.retryAfter ?? 60} 秒后再试。`
  return err.message || '保存失败，请稍后重试'
}

async function save(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const patch = buildPatch(props.guide, draft.value)
    if (!Object.keys(patch).length) {
      emit('unchanged')
      return
    }
    const res = await patchJson<GuidePatchResult>(`/api/electro/guides/${props.guideId}`, patch, {
      headers: { 'X-Passcode-Token': props.token ?? '' },
    })
    emit('saved', res.guide, res.blockers)
  } catch (err) {
    error.value = describeError(err)
    if (err instanceof ApiError && err.status === 401) emit('authExpired')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="edit no-print">
    <h2 class="edit__title">修正草稿</h2>
    <p class="edit__hint">
      只能改文字与判据数值。增删步骤、换判据类型请重新生成——那不是在改一份稿子，是在换一份内容。
    </p>

    <label class="edit__label" for="edit-title">标题</label>
    <input id="edit-title" v-model="draft.title" class="edit__input" maxlength="60" />

    <label class="edit__label" for="edit-summary">摘要</label>
    <textarea id="edit-summary" v-model="draft.summary" class="edit__text" rows="2" maxlength="300" />

    <div v-for="(step, index) in draft.steps" :key="step.id" class="edit__step">
      <h3 class="edit__step-title">第 {{ index + 1 }} 步 · {{ step.id }}</h3>

      <label class="edit__label" :for="`edit-t-${step.id}`">小标题</label>
      <input :id="`edit-t-${step.id}`" v-model="step.title" class="edit__input" maxlength="40" />

      <label class="edit__label" :for="`edit-a-${step.id}`">动作描述</label>
      <textarea
        :id="`edit-a-${step.id}`"
        v-model="step.action"
        class="edit__text"
        rows="3"
        maxlength="600"
      />

      <div v-for="c in step.criteria" :key="c.id" class="edit__crit">
        <label class="edit__label" :for="`edit-c-${step.id}-${c.id}`">
          判据 · {{ c.type === 'range' ? '数值区间' : c.type === 'enum' ? '枚举' : '文本/人工' }}
        </label>
        <input :id="`edit-c-${step.id}-${c.id}`" v-model="c.label" class="edit__input" maxlength="60" />

        <template v-if="c.type === 'range'">
          <div class="edit__range">
            <label :for="`edit-min-${step.id}-${c.id}`">下限</label>
            <input
              :id="`edit-min-${step.id}-${c.id}`"
              v-model="c.min"
              class="edit__input edit__input--num"
              inputmode="decimal"
            />
            <label :for="`edit-max-${step.id}-${c.id}`">上限</label>
            <input
              :id="`edit-max-${step.id}-${c.id}`"
              v-model="c.max"
              class="edit__input edit__input--num"
              inputmode="decimal"
            />
            <label :for="`edit-unit-${step.id}-${c.id}`">单位</label>
            <input
              :id="`edit-unit-${step.id}-${c.id}`"
              v-model="c.unit"
              class="edit__input edit__input--unit"
              maxlength="3"
            />
          </div>
        </template>

        <template v-else-if="c.type === 'enum'">
          <label class="edit__label" :for="`edit-opt-${step.id}-${c.id}`">选项（用 / 分隔）</label>
          <input
            :id="`edit-opt-${step.id}-${c.id}`"
            v-model="c.options"
            class="edit__input"
            maxlength="200"
          />
        </template>
      </div>
    </div>

    <p v-if="error" class="edit__error">{{ error }}</p>
    <div class="edit__actions">
      <button class="btn btn--primary" type="button" :disabled="busy" @click="save">
        {{ busy ? '保存中…' : '保存修正' }}
      </button>
      <button class="btn" type="button" :disabled="busy" @click="emit('cancel')">取消</button>
    </div>
  </section>
</template>

<style scoped>
.edit {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--c-line);
}

.edit__title {
  margin: 0 0 6px;
  font-size: 18px;
}

.edit__hint {
  margin: 0 0 12px;
  color: var(--c-ink-3);
  font-size: 13px;
  line-height: 1.6;
}

.edit__label {
  display: block;
  margin: 10px 0 4px;
  font-size: 13px;
  color: var(--c-ink-2);
}

.edit__input,
.edit__text {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-ink);
  font-size: 15px;
  font-family: inherit;
}

.edit__input {
  min-height: var(--tap);
}

.edit__text {
  line-height: 1.5;
  resize: vertical;
}

.edit__input:focus-visible,
.edit__text:focus-visible {
  outline: 2px solid var(--c-primary);
  outline-offset: 1px;
}

.edit__step {
  margin-top: 18px;
  padding-top: 12px;
  border-top: 1px dashed var(--c-line);
}

.edit__step-title {
  margin: 0;
  font-size: 15px;
  color: var(--c-ink-2);
}

.edit__crit {
  margin-top: 10px;
  padding-left: 10px;
  border-left: 2px solid var(--c-primary-line);
}

/* 上下限用 flex 而不是网格：窄屏两列网格会让「标签-输入」错位成两行半 */
.edit__range {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 10px;
  align-items: center;
  margin-top: 6px;
  font-size: 13px;
  color: var(--c-ink-2);
}

.edit__input--num {
  width: 96px;
}

.edit__input--unit {
  width: 72px;
}

.edit__error {
  margin: 12px 0 0;
  color: var(--c-danger);
  font-size: 14px;
}

.edit__actions {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}
</style>
