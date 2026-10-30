<script setup lang="ts">
/** GuideFigure：图示容器。
 *
 *  三条降级路径，任一触发都显示 `fallback_text`，绝不静默失败：
 *  1. primitive 不在注册表里（后端加了新原语、前端还没跟上）；
 *  2. 组件渲染抛错（参数不合法、数值越界、除零）；
 *  3. 组件内部主动抛错（例如 status_light 收到未知状态）。
 *
 *  为什么用 onErrorCaptured 而不是 if/else 预校验：校验逻辑只能覆盖已知错误，
 *  渲染期才暴露的问题（NaN 参与坐标计算、数组越界）必须靠兜底接住。
 */
import { computed, onErrorCaptured, ref, watch } from 'vue'
import type { VisualSpec } from '../types'
import { FIGURES } from './registry'

const props = defineProps<{ spec: VisualSpec }>()

const failed = ref(false)
const reason = ref('')
const component = computed(() => FIGURES[props.spec.primitive] ?? null)

watch(
  () => props.spec,
  () => {
    failed.value = false
    reason.value = ''
  },
)

onErrorCaptured((err) => {
  failed.value = true
  reason.value = err instanceof Error ? err.message : '图示渲染异常'
  // 返回 false 阻断冒泡：一张图渲不出来，不该炸掉整份指导书
  return false
})
</script>

<template>
  <figure class="figure">
    <figcaption v-if="spec.caption" class="figure__caption">{{ spec.caption }}</figcaption>
    <component
      :is="component"
      v-if="component && !failed"
      :params="spec.params"
      :label="spec.caption || spec.fallback_text"
      :motion="spec.motion"
    />
    <p v-else class="figure__fallback">{{ spec.fallback_text }}</p>
    <p v-if="failed" class="figure__pending">{{ reason }} · 已降级为文字</p>
  </figure>
</template>
