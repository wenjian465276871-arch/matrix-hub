<script setup lang="ts">
/**
 * 现场素材区：选图 → 校验 → 上传 → 列表（说明 / 移除 / 选区域）。
 *
 * 从 NewGuideView 拆出来的第一块。选它当起点，是因为边界最清楚、测试最全
 * （4 条单测盯着：类型白名单、5MB 上限、张数上限、无素材时禁用识别）。
 *
 * 状态归属（拆的时候最容易搞错的地方）：
 * - 素材数组 `assets` 仍归父组件，本组件只 `emit('uploaded')`，父组件 push。
 *   状态源只有一个，切图/提交都能读到同一份。
 * - `uploading` 用 `v-model:uploading` 同步回父组件——父组件的 `busy` 要算上它，
 *   否则"上传中"还能点提交，会生成一份缺图的草稿。
 * - 错误提示 `error` 是纯展示态，留在本组件。
 */
import { ref } from 'vue'
import { ApiError, postForm } from '../../lib/http'
import type { StagedAsset, UploadedAsset } from '../../types'

const MAX_ASSETS = 4
const MAX_ASSET_BYTES = 5 * 1024 * 1024
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp']

const props = defineProps<{
  assets: StagedAsset[]
  busy: boolean
  uploading: boolean
  extractBusy: boolean
}>()

const emit = defineEmits<{
  'update:uploading': [value: boolean]
  uploaded: [asset: StagedAsset]
  remove: [index: number]
  slice: [asset: StagedAsset]
  extract: []
}>()

const error = ref('')

function uploadErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return '上传失败，请检查网络后重试。'
  switch (err.code) {
    case 'too_large':
      return '单张不能超过 5 MB。'
    case 'too_small':
      return '图片分辨率太低，请换一张更清晰的截图。'
    case 'bad_format':
      return '只支持 PNG / JPEG / WebP。'
    case 'unreadable':
      return '这张图可能已损坏或被截断，无法解析。'
    case 'rate_limited':
      return err.message || '上传过于频繁，请稍后再试。'
    default:
      return err.message || '上传失败，请稍后再试。'
  }
}

async function onPickFiles(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  // 立刻清空：不清的话，同一张图删掉后再选一次不会触发 change
  input.value = ''
  if (!files.length) return

  error.value = ''
  const room = MAX_ASSETS - props.assets.length
  if (room <= 0) {
    error.value = `最多 ${MAX_ASSETS} 张素材。`
    return
  }
  const picked = files.slice(0, room)
  if (files.length > room) {
    error.value = `最多 ${MAX_ASSETS} 张素材，已忽略多余的 ${files.length - room} 张。`
  }

  emit('update:uploading', true)
  try {
    for (const file of picked) {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        error.value = '只支持 PNG / JPEG / WebP。'
        continue
      }
      if (file.size > MAX_ASSET_BYTES) {
        error.value = '单张不能超过 5 MB。'
        continue
      }
      const form = new FormData()
      form.append('file', file)
      try {
        const res = await postForm<UploadedAsset>('/api/electro/uploads', form)
        emit('uploaded', {
          asset_id: res.asset_id,
          caption: '',
          url: `/api/electro/uploads/${res.asset_id}/${res.asset_id}.png`,
        })
      } catch (err) {
        error.value = uploadErrorText(err)
      }
    }
  } finally {
    emit('update:uploading', false)
  }
}
</script>

<template>
  <section class="assets">
    <div class="assets__head">
      <span class="field-label field-label--inline">
        现场素材
        <span class="field-label__opt">（可选，最多 {{ MAX_ASSETS }} 张）</span>
      </span>
      <label class="btn btn--ghost" :aria-disabled="busy || assets.length >= MAX_ASSETS">
        {{ uploading ? '上传中…' : '添加图片' }}
        <input
          class="sr-only"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          :disabled="busy || assets.length >= MAX_ASSETS"
          @change="onPickFiles"
        />
      </label>
      <button
        class="btn btn--ghost"
        type="button"
        :disabled="busy || extractBusy || !assets.length"
        @click="emit('extract')"
      >
        {{ extractBusy ? '识别中…' : '识别图中内容' }}
      </button>
    </div>
    <p class="hint">
      图片可用于排版（挂到哪一步由你在草稿页决定），也可以点「识别图中内容」转成文本草稿；
      识别会把图片发送到模型服务，结果必须对着原图核对。请勿上传含企业名称、工号、图纸编号等敏感信息的截图。
    </p>
    <!-- 识别要跑两次模型调用，密集中文表格实测约 30 秒。没有这条提示，
         用户会以为页面卡死然后刷新——白等一次还照扣成本。 -->
    <p v-if="extractBusy" class="hint hint--busy" role="status">
      正在识别：先逐行转录、再整理结构，共两次模型调用。内容多的图约 20–40 秒，请勿关闭页面。
    </p>
    <p v-if="error" class="asset-error" role="alert">{{ error }}</p>

    <ul v-if="assets.length" class="asset-list">
      <li v-for="(item, index) in assets" :key="item.asset_id" class="asset-item">
        <img
          class="asset-item__img"
          :src="item.url"
          :alt="`素材 ${index + 1} 预览`"
          loading="lazy"
          decoding="async"
        />
        <div class="asset-item__body">
          <label class="sr-only" :for="`cap-${item.asset_id}`">素材 {{ index + 1 }} 说明</label>
          <input
            :id="`cap-${item.asset_id}`"
            v-model="item.caption"
            class="asset-item__input"
            type="text"
            maxlength="60"
            :disabled="busy"
            placeholder="说明：这张图拍的是什么（如 门锁间隙测量位置）"
          />
          <button class="linkbtn" type="button" :disabled="busy" @click="emit('remove', index)">
            移除
          </button>
          <button class="linkbtn" type="button" :disabled="busy" @click="emit('slice', item)">
            选择区域
          </button>
        </div>
      </li>
    </ul>

    <!-- 识别结果块由父组件塞进来：它的样式与状态都在父作用域 -->
    <slot />
  </section>
</template>

<style scoped>
.assets {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px dashed var(--c-line);
}

.assets__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.field-label {
  display: block;
  margin-bottom: 8px;
  font-weight: 600;
  color: var(--c-ink);
}

.field-label--inline {
  margin-bottom: 0;
}

.field-label__opt {
  color: var(--c-ink-3);
  font-weight: 400;
}

.hint {
  margin: 8px 0 0;
  color: var(--c-ink-3);
  font-size: 13px;
}

/* 等待提示要比普通提示显眼：它是这一屏唯一在动的信息 */
.hint--busy {
  color: var(--c-primary-ink);
  font-weight: 600;
}

.asset-error {
  margin: 8px 0 0;
  color: var(--c-danger);
  font-size: 13px;
}

.asset-list {
  display: grid;
  gap: 10px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}

.asset-item {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: 12px;
  align-items: center;
  padding: 8px;
  border: 1px solid var(--c-line);
  border-radius: 6px;
  background: var(--c-surface);
}

.asset-item__img {
  width: 72px;
  height: 72px;
  border-radius: 4px;
  background: var(--c-line-soft);
  object-fit: cover;
}

.asset-item__body {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.asset-item__input {
  flex: 1;
  min-width: 0;
  min-height: 44px;
  padding: 0 10px;
  border: 1px solid var(--c-line);
  border-radius: 6px;
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
  font-size: 14px;
}

.asset-item__input:focus {
  outline: 2px solid var(--c-primary);
  outline-offset: 1px;
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
