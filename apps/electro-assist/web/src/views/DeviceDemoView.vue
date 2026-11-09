<script setup lang="ts">
/** 设备三维作业指导 · 演示页。
 *
 *  演示什么：上面是设备三维动作，下面左边是工艺文本、右边是随动参数。
 *  要证明的是「AI 能把工艺文本变成可看的作业指导」，不是「我们会做 3D 模型」。
 *
 *  ## 为什么单列
 *  全站内容宽度是 860px（`--w-content`），三栏会把三维场景压到 236px，
 *  等于白做。三维要占满整行才看得清结构，文字与参数退到第二行。
 *
 *  ## 数据口径
 *  所有参数都是**演示虚构值**，页面顶部与读数区都标注了这件事。
 *  形体与尺寸取公开的城轨塞拉门通用形式（门洞 1.4m、单扇 0.7m、墙厚 90mm），
 *  不代表任何车型图纸。这条线不能含糊：演示可以虚构，但不能让人误以为是实测。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import DeviceScene from '../figures/DeviceScene.vue'

const t = ref(0)
const playing = ref(false)
const focus = ref('')
let raf = 0

const ease = (v: number): number => {
  const x = v < 0 ? 0 : v > 1 ? 1 : v
  return x * x * (3 - 2 * x)
}
const span = (a: number, b: number): number => ease((t.value - a) / (b - a))

/** 单扇行程上限 660mm：与 door.ts 的 DIM.slide 同源，改一处要改两处。 */
const STROKE_MAX = 660

const stroke = computed(() => Math.round(span(0.16, 0.86) * STROKE_MAX))
const popped = computed(() => Math.round(span(0, 0.16) * 55))
const locked = computed(() => t.value >= 0.88)
const percent = computed(() => Math.round(t.value * 100))

/** 电机电流是**虚构曲线**：启动冲击后回落，只用来演示参数随动作变化这件事。 */
const current = computed(() => {
  if (t.value < 0.16) return 0.18
  if (t.value >= 0.86) return 0.12
  const p = span(0.16, 0.86)
  return 1.05 + 2.3 * Math.exp(-3.4 * p)
})

const phase = computed(() => {
  if (t.value < 0.03) return '关闭锁定'
  if (t.value < 0.16) return '解锁外移'
  if (t.value < 0.86) return '门扇开启'
  if (t.value < 0.88) return '到位检测'
  return '完全开启'
})

function play(): void {
  if (playing.value) {
    stop()
    return
  }
  if (t.value >= 0.999) t.value = 0
  playing.value = true
  const from = t.value
  const start = performance.now()
  const duration = Math.max((1 - from) * 4600, 120)
  const tick = (now: number): void => {
    const p = Math.min(1, (now - start) / duration)
    t.value = from + (1 - from) * p
    if (p < 1) {
      raf = requestAnimationFrame(tick)
    } else {
      playing.value = false
      raf = 0
    }
  }
  raf = requestAnimationFrame(tick)
}

function stop(): void {
  playing.value = false
  if (raf) cancelAnimationFrame(raf)
  raf = 0
}

function seek(event: Event): void {
  stop()
  t.value = Number((event.target as HTMLInputElement).value) / 1000
}

function reset(): void {
  stop()
  t.value = 0
}

const PARTS = [
  { key: 'leaf_l', label: '左门扇' },
  { key: 'leaf_r', label: '右门扇' },
  { key: 'frame', label: '门框' },
  { key: 'lamp', label: '指示灯' },
]

function toggleFocus(key: string): void {
  focus.value = focus.value === key ? '' : key
}

onBeforeUnmount(stop)
</script>

<template>
  <main class="demo">
    <header class="demo__head">
      <p class="demo__eyebrow">A2 可视化作业指导 · 三维演示</p>
      <h1 class="demo__title">车门开闭功能检查</h1>
      <p class="demo__note">
        形体与尺寸取自公开的城轨塞拉门通用形式；<strong>全部参数为演示虚构值</strong>，
        不代表任何车型图纸或实测结果。
      </p>
    </header>

    <section class="demo__stage" aria-labelledby="scene-h">
      <h2 id="scene-h" class="demo__pane-title">三维作业引导（呈现）</h2>
      <DeviceScene
        subject="door"
        :t="t"
        :focus="focus"
        label="地铁塞拉门三维示意：双扇对开，当前为开启过程中的某一时刻"
      />

      <div class="demo__controls">
        <button class="demo__play" type="button" @click="play">
          {{ playing ? '暂停' : '播放动作' }}
        </button>
        <button class="demo__ghost" type="button" @click="reset">复位</button>
        <label class="demo__slider">
          <span class="demo__slider-label">时间轴 {{ percent }}%</span>
          <input
            type="range"
            min="0"
            max="1000"
            step="1"
            :value="Math.round(t * 1000)"
            @input="seek"
          />
        </label>
      </div>

      <div class="demo__parts" role="group" aria-label="部件高亮">
        <span class="demo__parts-label">部件</span>
        <button
          v-for="part in PARTS"
          :key="part.key"
          class="demo__chip"
          :class="{ 'demo__chip--on': focus === part.key }"
          type="button"
          :aria-pressed="focus === part.key"
          @click="toggleFocus(part.key)"
        >
          {{ part.label }}
        </button>
      </div>
    </section>

    <div class="demo__lower">
      <section class="demo__pane" aria-labelledby="text-h">
        <h2 id="text-h" class="demo__pane-title">工艺文本（输入）</h2>
        <div class="demo__doc">
          <p class="demo__doc-line"><span class="demo__k">步骤</span>3 / 8</p>
          <p class="demo__doc-line"><span class="demo__k">动作</span>按下开门按钮，观察双扇门动作</p>
          <p class="demo__doc-line"><span class="demo__k">工具</span>秒表、万用表</p>
          <p class="demo__doc-line demo__doc-line--head">验收判据</p>
          <ul class="demo__criteria">
            <li>门扇开启时间 2.5 ± 0.5 s</li>
            <li>全部开启后锁定信号为「有」</li>
            <li>全程无卡滞、无异响</li>
          </ul>
        </div>
        <p class="demo__hint">
          文本里没有一句描述设备长什么样。三维形体的来源是设备型号本身，
          与文本无关——这正是「模型只做表达、不做事实发明」的边界。
        </p>
      </section>

      <section class="demo__pane" aria-labelledby="read-h">
        <h2 id="read-h" class="demo__pane-title">随动参数（虚构）</h2>
        <dl class="demo__reads">
          <div class="demo__read">
            <dt>动作阶段</dt>
            <dd>{{ phase }}</dd>
          </div>
          <div class="demo__read">
            <dt>单扇行程</dt>
            <dd><span class="demo__num">{{ stroke }}</span> mm</dd>
          </div>
          <div class="demo__read">
            <dt>塞拉外移</dt>
            <dd><span class="demo__num">{{ popped }}</span> mm</dd>
          </div>
          <div class="demo__read">
            <dt>电机电流</dt>
            <dd><span class="demo__num">{{ current.toFixed(2) }}</span> A</dd>
          </div>
          <div class="demo__read">
            <dt>锁定信号</dt>
            <dd>
              <span class="demo__dot" :class="locked ? 'demo__dot--ok' : 'demo__dot--idle'" />
              {{ locked ? '有' : '无' }}
            </dd>
          </div>
        </dl>
        <p class="demo__hint">
          判据「2.5 ± 0.5 s」与「锁定信号为有」对应这几行读数。三维动作、参数读数、
          验收判据共用同一条时间轴——这是电气调试与装配工艺的区别：装配看形状，
          调试看动作与量的时序耦合。
        </p>
      </section>
    </div>
  </main>
</template>

<style scoped>
.demo {
  width: 100%;
}

.demo__head {
  margin-bottom: 16px;
}

.demo__eyebrow {
  margin: 0 0 6px;
  color: var(--c-primary);
  font-size: 12px;
  letter-spacing: 0.08em;
}

.demo__title {
  margin: 0 0 8px;
  font-size: 24px;
  font-weight: 500;
  color: var(--c-ink);
}

.demo__note {
  margin: 0;
  max-width: 74ch;
  color: var(--c-ink-2);
  font-size: 13px;
  line-height: 1.7;
}

.demo__note strong {
  color: var(--c-ink);
  font-weight: 500;
}

.demo__stage {
  padding: 14px;
  border: 1px solid var(--c-line);
  border-radius: 12px;
  background: var(--c-surface);
}

.demo__pane-title {
  margin: 0 0 10px;
  color: var(--c-ink-2);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.04em;
}

.demo__controls {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.demo__play {
  min-height: 40px;
  padding: 0 18px;
  border: 1px solid var(--c-primary-line, var(--c-line));
  border-radius: 8px;
  background: var(--c-primary-soft, var(--c-surface));
  color: var(--c-primary-ink, var(--c-primary));
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.demo__ghost {
  min-height: 40px;
  padding: 0 14px;
  border: 1px solid var(--c-line);
  border-radius: 8px;
  background: transparent;
  color: var(--c-ink-2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.demo__slider {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 10px;
}

.demo__slider-label {
  flex: 0 0 auto;
  color: var(--c-ink-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.demo__slider input {
  flex: 1;
  min-width: 0;
}

.demo__parts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}

.demo__parts-label {
  margin-right: 2px;
  color: var(--c-ink-2);
  font-size: 12px;
}

.demo__chip {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--c-line);
  border-radius: 999px;
  background: transparent;
  color: var(--c-ink-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.demo__chip--on {
  border-color: var(--c-primary);
  background: var(--c-primary-soft, transparent);
  color: var(--c-primary-ink, var(--c-primary));
}

.demo__lower {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
  margin-top: 16px;
  align-items: start;
}

.demo__pane {
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--c-line);
  border-radius: 12px;
  background: var(--c-surface);
}

.demo__doc {
  padding: 12px;
  border: 1px solid var(--c-line);
  border-radius: 8px;
  background: var(--c-bg);
}

.demo__doc-line {
  margin: 0 0 8px;
  color: var(--c-ink);
  font-size: 13px;
  line-height: 1.6;
}

.demo__doc-line--head {
  margin-top: 12px;
  color: var(--c-ink-2);
  font-size: 12px;
}

.demo__k {
  display: inline-block;
  min-width: 32px;
  margin-right: 6px;
  color: var(--c-ink-3, var(--c-ink-2));
  font-size: 12px;
}

.demo__criteria {
  margin: 0;
  padding-left: 16px;
  color: var(--c-ink);
  font-size: 13px;
  line-height: 1.8;
}

.demo__hint {
  margin: 12px 0 0;
  color: var(--c-ink-2);
  font-size: 12px;
  line-height: 1.7;
}

.demo__reads {
  margin: 0;
}

.demo__read {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--c-line);
}

.demo__read:last-child {
  border-bottom: none;
}

.demo__read dt {
  color: var(--c-ink-2);
  font-size: 12px;
}

.demo__read dd {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--c-ink);
  font-size: 13px;
}

.demo__num {
  font-variant-numeric: tabular-nums;
  font-size: 16px;
  font-weight: 500;
}

.demo__dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.demo__dot--ok {
  background: #2f9e6a;
}

.demo__dot--idle {
  background: var(--c-ink-3, var(--c-ink-2));
}

@media (max-width: 720px) {
  .demo__lower {
    grid-template-columns: minmax(0, 1fr);
  }

  .demo__controls {
    flex-wrap: wrap;
  }

  .demo__slider {
    flex-basis: 100%;
  }
}
</style>
