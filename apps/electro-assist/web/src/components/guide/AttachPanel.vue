<script setup lang="ts">
/**
 * 素材归位面板：选图放哪一步、写说明、保存。仅草稿可见。
 *
 * 从 GuideView 拆出来的第一块（2026-11-06）。选它的理由：
 * - 它只碰"图放哪"，不碰步骤文字与判据——原文注释写着「判据能被改一个字，
 *   超差就能变合格」，所以这块本来就被刻意隔离在写路径之外；
 * - 状态自成一套（placement / captions / 三个提示位），父组件别处不读。
 *
 * 状态归属：placement / captions 的初值来自服务端的 guide 结构，
 * 通过 rows 传进来；本组件在 rows 变化时重建初值（watch），保存成功后
 * emit('saved') 让父组件重新 load，形成单向环。
 */
import { ref, watch } from 'vue'
import { ApiError, putJson } from '../../lib/http'
import type { AssetRef, AttachResult, Step } from '../../types'

const props = defineProps<{
  guideId: string
  /** 扁平化的素材列表：步骤里的 + 文末素材区的 */
  rows: { asset: AssetRef; stepId: string | null }[]
  /** 素材编号（图 1、图 2…），由父组件按同一顺序算好传进来 */
  numbers: Record<string, number>
  steps: Step[]
  /**
   * 成功/失败提示必须由父组件持有。
   * 保存成功会 emit('saved') → 父组件 load() 把 phase 切回 loading，
   * 整棵子树销毁重建；提示如果留在本组件内，会被重建顺手抹掉——
   * 用户永远看不到「已保存」。这是 2026-11-06 拆分时真实踩到的回归，
   * 由「保存后应显示已保存」这条测试抓出来。
   */
  message: string
}>()

const emit = defineEmits<{ saved: []; 'update:message': [value: string] }>()

const placement = ref<Record<string, string>>({})
const captions = ref<Record<string, string>>({})
const busy = ref(false)
const error = ref('')

function assetUrl(asset: AssetRef): string {
  return `/api/electro/uploads/${asset.asset_id}/${asset.asset_id}.png`
}

/** 初值来自服务端，本地只存"用户改了什么"。 */
function resetFromRows(): void {
  const place: Record<string, string> = {}
  const labels: Record<string, string> = {}
  for (const row of props.rows) {
    place[row.asset.asset_id] = row.stepId ?? ''
    labels[row.asset.asset_id] = row.asset.caption
  }
  placement.value = place
  captions.value = labels
}

watch(() => props.rows, resetFromRows, { immediate: true })

async function save(): Promise<void> {
  if (busy.value) return
  busy.value = true
  emit('update:message', '')
  error.value = ''
  try {
    const assets = props.rows.map(({ asset }) => ({
      asset_id: asset.asset_id,
      caption: (captions.value[asset.asset_id] ?? asset.caption).trim() || asset.caption,
      step_id: placement.value[asset.asset_id] || null,
    }))
    const res = await putJson<AttachResult>(`/api/electro/guides/${props.guideId}/assets`, {
      assets,
    })
    emit('update:message', `已保存：${res.attached} 张挂到步骤，${res.loose} 张留在素材区`)
    emit('saved')
  } catch (err) {
    error.value =
      err instanceof ApiError
        ? err.code === 'published_locked'
          ? '已发布的指导书不能调整素材。'
          : err.message || '保存失败，请稍后重试'
        : '保存失败，请稍后重试'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="attach no-print">
    <h2 class="attach__title">素材归位</h2>
    <p class="attach__hint">
      系统不会识别图片内容，所以位置由你决定：选好步骤后保存。已发布的指导书不能再改。
    </p>
    <ul class="attach__list">
      <li v-for="row in props.rows" :key="row.asset.asset_id" class="attach__row">
        <img
          class="attach__thumb"
          :src="assetUrl(row.asset)"
          :alt="`图 ${props.numbers[row.asset.asset_id]} 预览`"
          loading="lazy"
          decoding="async"
        />
        <div class="attach__fields">
          <label class="attach__label" :for="`cap-${row.asset.asset_id}`">
            图 {{ props.numbers[row.asset.asset_id] }} 说明
          </label>
          <input
            :id="`cap-${row.asset.asset_id}`"
            v-model="captions[row.asset.asset_id]"
            class="attach__input"
            type="text"
            maxlength="60"
            :disabled="busy"
          />
          <label class="attach__label" :for="`pos-${row.asset.asset_id}`">放在</label>
          <select
            :id="`pos-${row.asset.asset_id}`"
            v-model="placement[row.asset.asset_id]"
            class="attach__select"
            :disabled="busy"
          >
            <option value="">素材区（文末）</option>
            <option v-for="step in props.steps" :key="step.id" :value="step.id">
              第 {{ step.seq }} 步 · {{ step.title }}
            </option>
          </select>
        </div>
      </li>
    </ul>
    <div class="attach__actions">
      <button class="btn" type="button" :disabled="busy" @click="save">
        {{ busy ? '保存中…' : '保存归位' }}
      </button>
      <span v-if="props.message" class="attach__ok">{{ props.message }}</span>
      <span v-if="error" class="attach__error">{{ error }}</span>
    </div>
  </section>
</template>

<style scoped>
.attach {
  margin: 0 0 20px;
  padding: 14px;
  border: 1px solid var(--c-primary-line);
  border-radius: 8px;
  background: var(--c-primary-soft);
}

.attach__title {
  margin: 0 0 6px;
  font-size: 15px;
}

.attach__hint {
  margin: 0 0 10px;
  color: var(--c-ink-2);
  font-size: 13px;
}

.attach__list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.attach__row {
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: 12px;
  align-items: start;
  padding: 10px;
  border-radius: 6px;
  background: var(--c-surface);
}

.attach__thumb {
  width: 64px;
  height: 64px;
  border-radius: 4px;
  background: var(--c-line-soft);
  object-fit: cover;
}

.attach__fields {
  display: grid;
  gap: 6px;
}

.attach__label {
  color: var(--c-ink-3);
  font-size: 12px;
}

.attach__input,
.attach__select {
  width: 100%;
  min-height: 44px;
  padding: 0 10px;
  border: 1px solid var(--c-line);
  border-radius: 6px;
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
  font-size: 14px;
}

.attach__input:focus,
.attach__select:focus {
  outline: 2px solid var(--c-primary);
  outline-offset: 1px;
}

.attach__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.attach__ok {
  color: var(--c-success);
  font-size: 13px;
}

.attach__error {
  color: var(--c-danger);
  font-size: 13px;
}
</style>
