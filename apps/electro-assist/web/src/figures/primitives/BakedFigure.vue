<script setup lang="ts">
/** baked_figure：离线烘焙的静态图（Blender / Cycles 渲出来的指导书主图）。
 *
 *  为什么要有这个原语：指导书里那张图只有三百多像素高，实时三维在这个尺寸上
 *  看不出好处，反而丢了"这一步设备长什么样"的清晰度。烘焙图在这里纯赚——
 *  它是照片级的光照，代价是不可交互；而"拖时间轴、转视角"的需求留在演示页。
 *
 *  三条纪律：
 *  1. `src` 只接受站内绝对路径（后端已用正则卡死），这里再拼 `BASE_URL`——
 *     站点挂在 `/apps/electro-assist/` 下，写死 `/figures/...` 会 404。
 *  2. `alt` 必填。图是内容不是装饰，读屏用户靠它知道画面里是什么。
 *  3. 加载失败不静默：`@error` 抛出，交给 `GuideFigure` 的 onErrorCaptured
 *     降级成 `fallback_text`——一张图加载不出来，不该让整份指导书空白。
 */
import { computed, ref } from 'vue'
import type { ParamValue } from '../../types'

const props = defineProps<{
  params: Record<string, ParamValue>
  label?: string
  motion?: unknown
}>()

const failed = ref(false)

const src = computed(() => {
  const raw = String(props.params.src ?? '')
  if (!raw.startsWith('/')) throw new Error('baked_figure：src 必须是站内绝对路径')
  const base = import.meta.env.BASE_URL.replace(/\/$/, '')
  return base + raw
})

const alt = computed(() => String(props.params.alt ?? ''))

function onError(): void {
  failed.value = true
  throw new Error('baked_figure：图片加载失败')
}
</script>

<template>
  <img
    v-if="!failed"
    class="baked"
    :src="src"
    :alt="alt"
    loading="lazy"
    decoding="async"
    @error="onError"
  />
</template>

<style scoped>
/* 图本身是 3:2 的深底渲染，圆角与其它图元一致即可。
   背景色兜底：图还没下载完时不该闪一块白。 */
.baked {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 6px;
  background: #16181a;
}
</style>
