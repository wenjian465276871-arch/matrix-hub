<script setup lang="ts">
/** device_scene 的渲染适配器。
 *
 *  `registry.ts` 里所有原语都吃同一组 props（`params` / `label` / `motion`），
 *  而 `DeviceScene` 要的是 `subject` / `t` / `focus`。这一层只做翻译，不加逻辑。
 *
 *  ## 为什么有「播放 / 复位」+
 *  三维图的价值在「看动作」，静态一帧只剩一张透视渲染图。指导书里的 3D 默认停在
 *  `t` 指定的那一帧（通常是动作中段）——第一次看到的人不知道"动起来是什么样"。
 *  所以给三个入口：**播放动作**（从当前跑到终态）、**复位**（回到这一步的那一帧）、
 *  时间轴拖动（停在任意瞬间反复看）。三者共用同一个 `progress`。
 *
 *  与「三维演示」页同一套交互（用户 2026-11-10 反馈：指导书里只能拖、不能播放）。
 *  播放时长按剩余进度算，总时长 4.6s——和演示页一致，翻到那一步不看也知道大概多久。
 *
 *  ## 打印
 *  按钮、滑块与提示在打印版里必须消失，只留下三维图的那一帧。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import DeviceScene from '../DeviceScene.vue'
import type { ParamValue } from '../../types'

const props = defineProps<{
  params: Record<string, ParamValue>
  label?: string
  /**
   * 打印兜底文案。WebGL 不可用 / 显卡回收上下文时静态帧根本拍不出来，
   * 纸上会只剩一个空框——指导书的图可以画不出来，但不能什么都没有。
   */
  fallback?: string
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

/** 本步对应的那一帧（服务端 `params.t`，必填）。默认**不再停在这里**：
 *  2026-11-12 本人指出"部分三维的默认时间轴不是 0%"，要求打开就从 0 开始。
 *  这条值现在只做两件事：一是「跳到本步」按钮的目标，二是播放时的语义参照。 */
const initial = computed(() => {
  const raw = props.params.t
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.6
})

/** 打印用：DeviceScene 在停下后给的当前帧 PNG。canvas 打印出来是空白。 */
const shot = ref('')

/* 默认从 0 开始：打开就是动作的起点，按「播放动作」能看完整的全过程。
   以前默认停在本步那一帧，于是按播放只演最后一段（0.78 → 1 只有 22%），
   而且时间轴一进来就是"78%"，看着像没归位。 */
const progress = ref(0)
watch(initial, () => {
  progress.value = 0
})

const percent = computed(() => Math.round(progress.value * 100))

function seek(event: Event): void {
  stop()
  progress.value = Number((event.target as HTMLInputElement).value) / 1000
}

/* ---------------- 播放 / 复位 ---------------- */

/** 总时长与演示页一致（`DeviceDemoView` 的 4600ms）：同一台设备在两页上手感相同。 */
const DURATION_MS = 4600
const playing = ref(false)
let raf = 0

function stop(): void {
  playing.value = false
  if (raf) cancelAnimationFrame(raf)
  raf = 0
}

function play(): void {
  if (playing.value) {
    stop()
    return
  }
  // 已经到终态时从头播：不这么做，第二次点"播放"什么都不会发生
  if (progress.value >= 0.999) progress.value = 0
  playing.value = true
  const from = progress.value
  const start = performance.now()
  const duration = Math.max((1 - from) * DURATION_MS, 120)
  const tick = (now: number): void => {
    const p = Math.min(1, (now - start) / duration)
    progress.value = from + (1 - from) * p
    if (p < 1) {
      raf = requestAnimationFrame(tick)
    } else {
      playing.value = false
      raf = 0
    }
  }
  raf = requestAnimationFrame(tick)
}

/** 「跳到本步」= 回到这一步在指导书里被指定的那一帧。
 *  不叫「复位」：默认已经是 0（动作起点），这个按钮的作用是"跳到该看的那个瞬间"，
 *  叫复位会让人以为回到开头。 */
function reset(): void {
  stop()
  progress.value = initial.value
}

onBeforeUnmount(stop)
</script>

<template>
  <div class="device">
    <DeviceScene
      :subject="subject"
      :t="progress"
      :focus="part"
      :label="label"
      @snapshot="shot = $event"
    />
    <!-- 打印时替掉 canvas：canvas 在纸上什么都不打，指导书不能出现空白框 -->
    <img
      v-if="shot"
      class="device__print"
      :src="shot"
      :alt="label || '设备三维示意'"
    />
    <!-- 拍不出静态帧时的打印兜底：宁可给一句话，也不要留白框 -->
    <p v-else class="device__print-text">{{ fallback || '三维图未生成，请参见本步骤的文字说明。' }}</p>
    <div class="device__controls no-print">
      <button class="device__btn device__btn--play" type="button" @click="play">
        {{ playing ? '暂停' : '播放动作' }}
      </button>
      <button
        class="device__btn"
        type="button"
        :disabled="progress === initial"
        :title="`跳到本步骤对应的那一帧（${Math.round(initial * 100)}%）`"
        @click="reset"
      >
        跳到本步
      </button>
      <label class="device__scrub">
        <span class="device__scrub-label">时间轴 {{ percent }}%</span>
        <input
          type="range"
          min="0"
          max="1000"
          step="1"
          :value="Math.round(progress * 1000)"
          @input="seek"
        />
      </label>
    </div>
    <p class="device__note no-print">结构示意，参数为演示虚构值；拖动可停在任意瞬间。</p>
  </div>
</template>

<style scoped>
.device {
  margin: 0;
}

.device__controls {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.device__btn {
  flex: 0 0 auto;
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.device__btn--play {
  border-color: var(--c-primary-line);
  background: var(--c-primary-soft);
  color: var(--c-primary-ink);
  font-weight: 600;
}

.device__btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.device__scrub {
  flex: 1 1 160px;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
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

.device__print,
.device__print-text {
  display: none;
}

.device__note {
  margin: 6px 0 0;
  color: var(--c-ink-2);
  font-size: 12px;
  line-height: 1.6;
}
@media print {
  /* canvas 换成静态帧；进度条与提示已经在全局 .no-print 里隐藏 */
  .device :deep(.scene) {
    display: none;
  }

  .device__print-text {
    display: block;
    padding: 6mm 8mm;
    border: 1px dashed var(--c-line);
    border-radius: 6px;
    color: var(--c-ink-2);
    font-size: 12px;
    line-height: 1.7;
  }

  .device__print {
    display: block;
    /* 固定高度 + object-fit: contain 才能保比例。
       只写 max-height 时，img 的固有宽度（1402px）会先被 max-width 压到 100%，
       再被 max-height 压高度，两个约束互相打架，图就被横向拉扁。 */
    width: 100%;
    height: 95mm;
    object-fit: contain;
    border: 1px solid var(--c-line);
    border-radius: 6px;
  }
}
</style>
