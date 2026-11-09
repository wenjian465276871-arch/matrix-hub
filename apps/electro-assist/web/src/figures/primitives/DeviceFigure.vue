<script setup lang="ts">
/** device_scene 的渲染适配器。
 *
 *  `registry.ts` 里所有原语都吃同一组 props（`params` / `label` / `motion`），
 *  而 `DeviceScene` 要的是 `subject` / `t` / `focus`。这一层只做翻译，不加逻辑。
 *
 *  ## 为什么要给滑块
 *  三维图的价值在「看动作」，静态一帧只剩一张透视渲染图。
 *  指导书里的 3D 默认停在 `t` 指定的那一帧（通常是动作中段），
 *  想看全过程就拖这条时间轴——拖动比自动播放好：
 *  现场的人要停在某一瞬间反复看，自动播完反而要等它重来。
 *
 *  ## 打印
 *  滑块与提示在打印版里必须消失，只留下三维图的那一帧。
 */
import { computed, ref, watch } from 'vue'
import DeviceScene from '../DeviceScene.vue'
import type { ParamValue } from '../../types'

const props = defineProps<{
  params: Record<string, ParamValue>
  label?: string
}>()

/** subject 已由服务端按白名单校验过，这里只做类型收敛，不再判断合法性。 */
const subject = computed(() => {
  const raw = props.params.subject
  return typeof raw === 'string' ? raw : ''
})

const part = computed(() => {
  const raw = props.params.part
  return typeof raw === 'string' ? raw : ''
})

/** 默认 0.6：停在动作中段，比 0（初始）或 1（终态）更能表达「这设备会动」。 */
const initial = computed(() => {
  const raw = props.params.t
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.6
})

const progress = ref(initial.value)
watch(initial, (value) => {
  progress.value = value
})

const percent = computed(() => Math.round(progress.value * 100))

function seek(event: Event): void {
  progress.value = Number((event.target as HTMLInputElement).value) / 1000
}
</script>

<template>
  <div class="device">
    <DeviceScene :subject="subject" :t="progress" :focus="part" :label="label" />
    <label class="device__scrub no-print">
      <span class="device__scrub-label">动作进度 {{ percent }}%</span>
      <input
        type="range"
        min="0"
        max="1000"
        step="1"
        :value="Math.round(progress * 1000)"
        @input="seek"
      />
    </label>
    <p class="device__note no-print">拖动可查看动作全过程；结构示意，参数为演示虚构值。</p>
  </div>
</template>

<style scoped>
.device {
  margin: 0;
}

.device__scrub {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}

.device__scrub-label {
  flex: 0 0 auto;
  color: var(--c-ink-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.device__scrub input {
  flex: 1;
  min-width: 0;
}

.device__note {
  margin: 6px 0 0;
  color: var(--c-ink-2);
  font-size: 12px;
  line-height: 1.6;
}
</style>
