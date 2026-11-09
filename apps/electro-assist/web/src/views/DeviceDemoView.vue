<script setup lang="ts">
/** 设备三维作业指导 · 演示页（多场景）。
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
 *  形体与尺寸取公开的通用形式（门洞 1.4m、单扇 0.7m；受电弓工作高度 1.5–2.8m），
 *  不代表任何车型图纸。这条线不能含糊：演示可以虚构，但不能让人误以为是实测。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import DeviceScene from '../figures/DeviceScene.vue'

type SceneKey = 'door' | 'pantograph' | 'cabinet'

interface Readout {
  label: string
  value: string
  unit?: string
  dot?: 'ok' | 'idle' | 'warn'
}

interface SceneDef {
  title: string
  eyebrow: string
  subject: string
  label: string
  step: string
  action: string
  tools: string
  criteria: string[]
  hint: string
  parts: { key: string; label: string }[]
  note: string
}

const SCENES: Record<SceneKey, SceneDef> = {
  door: {
    title: '车门开闭功能检查',
    eyebrow: 'A2 可视化作业指导 · 三维演示',
    subject: 'door',
    label: '地铁塞拉门三维示意：双扇对开，当前为开启过程中的某一时刻',
    step: '3 / 8',
    action: '按下开门按钮，观察双扇门动作',
    tools: '秒表、万用表',
    criteria: ['门扇开启时间 2.5 ± 0.5 s', '全部开启后锁定信号为「有」', '全程无卡滞、无异响'],
    hint: '三维动作、参数读数、验收判据共用同一条时间轴——这是电气调试与装配工艺的区别：装配看形状，调试看动作与量的时序耦合。',
    parts: [
      { key: 'leaf_l', label: '左门扇' },
      { key: 'leaf_r', label: '右门扇' },
      { key: 'frame', label: '门框' },
      { key: 'lamp', label: '指示灯' },
    ],
    note: '形体与尺寸取自公开的城轨塞拉门通用形式；<strong>全部参数为演示虚构值</strong>，不代表任何车型图纸或实测结果。',
  },
  pantograph: {
    title: '受电弓升降功能检查',
    eyebrow: 'A2 可视化作业指导 · 三维演示',
    subject: 'pantograph',
    label: '单臂受电弓三维示意：双杆机构展开，弓头上升，当前为升弓过程中的某一时刻',
    step: '5 / 9',
    action: '发出升弓指令，观察弓头上升与到位信号',
    tools: '秒表、压力表',
    criteria: ['升弓时间 8.5 ± 1.0 s', '到位后接触压力 70–120 N', '气路压力稳定在 0.5 MPa 以上'],
    hint: '受电弓是纯转动机构：两根臂各绕一个铰点转，杆长不变。所以三维里看到的不是「拉长」，而是「转起来」——这一条错了，整台设备就假了。',
    parts: [
      { key: 'arms', label: '臂杆' },
      { key: 'head', label: '弓头' },
      { key: 'frame', label: '底架' },
      { key: 'lamp', label: '到位灯' },
    ],
    note: '形体取公开的单臂受电弓通用结构（底架 + 四绝缘子 + 双下臂 + 双平衡臂 + 弓头）；<strong>全部参数为演示虚构值</strong>，不代表任何车型图纸或实测结果。',
  },
  cabinet: {
    title: '配电回路上电自检',
    eyebrow: 'A2 可视化作业指导 · 三维演示',
    subject: 'cabinet',
    label: '配电回路元件特写：三极断路器手柄向上扳至合闸、状态窗转红，接触器衔铁吸合，三只继电器依次动作',
    step: '2 / 6',
    action: '将主断路器手柄向上扳至合闸位，观察状态窗与指示灯',
    tools: '万用表',
    criteria: [
      '手柄在合闸位、状态窗为红（带电）',
      '三极断路器同时动作，无缺相',
      '主回路 380 ± 19 V、控制回路 220 ± 11 V',
      '继电器全部吸合、运行指示为绿',
      '过载脱扣后：手柄停在中间位，须先扳到底复位再合闸',
    ],
    hint: '断路器的方向不能说反：手柄向上是合闸、向下是断开，状态窗红色表示带电。后半段演示过载热脱扣——双金属片受热弯曲顶开脱扣杆，触点弹开、主回路失压，手柄落到既非合闸也非断开的中间位。现场见到中间位不要直接往上扳，必须先扳到底再合，否则合不上。',
    parts: [
      { key: 'breakers', label: '断路器' },
      { key: 'contactor', label: '接触器' },
      { key: 'relays', label: '继电器' },
      { key: 'lamps', label: '指示灯' },
    ],
    note: '视角是<b>元件特写</b>：柜体退成一块安装背板，重点在断路器手柄、接触器衔铁、继电器触点与指示灯的动作。断路器外壳做成六片薄壁，点「剖开看内部」去掉前盖，能看到灭弧室钢片、动静触点、双金属片与手柄轴——内部按真实电流路径排布。元件按真实比例放大，<strong>全部参数为演示虚构值</strong>，不代表任何图纸或实测结果。',
  },
}

const SCENE_KEYS: SceneKey[] = ['door', 'pantograph', 'cabinet']

const scene = ref<SceneKey>('door')
const def = computed(() => SCENES[scene.value])

const t = ref(0)
const playing = ref(false)
const focus = ref('')

/* 剖切：只有设备自己声明了 `cut` 才有这个能力，界面据此显示/隐藏开关。
   不做「按场景名硬编码」——那样一改模型就会和 UI 对不上。 */
const cutable = ref(false)
const cut = ref(false)
const cutAt = ref(0.52)
let raf = 0

const ease = (v: number): number => {
  const x = v < 0 ? 0 : v > 1 ? 1 : v
  return x * x * (3 - 2 * x)
}
const span = (a: number, b: number): number => ease((t.value - a) / (b - a))

const percent = computed(() => Math.round(t.value * 100))

/* ------------------------------------------------------------------ 车门读数 */

/** 单扇行程上限 660mm：与 door.ts 的 DIM.slide 同源，改一处要改两处。 */
const DOOR_STROKE = 660

const doorReads = computed<Readout[]>(() => {
  const stroke = Math.round(span(0.16, 0.86) * DOOR_STROKE)
  const popped = Math.round(span(0, 0.16) * 55)
  const locked = t.value >= 0.88
  let current = 0.18
  if (t.value >= 0.16 && t.value < 0.86) {
    current = 1.05 + 2.3 * Math.exp(-3.4 * span(0.16, 0.86))
  } else if (t.value >= 0.86) {
    current = 0.12
  }
  const phase =
    t.value < 0.03
      ? '关闭锁定'
      : t.value < 0.16
        ? '解锁外移'
        : t.value < 0.86
          ? '门扇开启'
          : t.value < 0.88
            ? '到位检测'
            : '完全开启'
  return [
    { label: '动作阶段', value: phase },
    { label: '单扇行程', value: String(stroke), unit: 'mm' },
    { label: '塞拉外移', value: String(popped), unit: 'mm' },
    { label: '电机电流', value: current.toFixed(2), unit: 'A' },
    { label: '锁定信号', value: locked ? '有' : '无', dot: locked ? 'ok' : 'idle' },
  ]
})

/* -------------------------------------------------------------- 受电弓读数 */

/** 弓头高度：与 pantograph.ts 的连杆解算同源（收弓 8°/16°、到位 56°/62°），
 *  收弓约 930mm、到位约 2820mm。改角度就要同步改这两个数，否则读数和三维会对不上。 */
const PANTO_LOW = 930
const PANTO_RISE = 1890

const pantoReads = computed<Readout[]>(() => {
  const p = span(0.08, 0.9)
  const height = Math.round(PANTO_LOW + PANTO_RISE * p)
  const seconds = (p * 8.5).toFixed(1)
  // 接触压力只有在弓头真正贴上接触线之后才有意义，未到位显示 0 而不是编一个数
  const pressure = t.value >= 0.9 ? String(Math.round(70 + 22 * p)) : '0'
  const air = (0.32 + 0.2 * p).toFixed(2)
  const ready = t.value >= 0.92
  const phase =
    t.value < 0.08 ? '落弓锁定' : t.value < 0.9 ? '升弓中' : t.value < 0.92 ? '到位检测' : '升弓到位'
  return [
    { label: '动作阶段', value: phase },
    { label: '弓头高度', value: String(height), unit: 'mm' },
    { label: '已用时', value: seconds, unit: 's' },
    { label: '接触压力', value: pressure, unit: 'N' },
    { label: '气路压力', value: air, unit: 'MPa' },
    { label: '到位信号', value: ready ? '有' : '无', dot: ready ? 'ok' : 'idle' },
  ]
})


/* -------------------------------------------------------------- 电气柜读数 */

const cabinetReads = computed<Readout[]>(() => {
  // 第三只断路器在 0.12 合完，主回路才算真正带电
  const closed = t.value >= 0.12
  // 0.90 起热脱扣：双金属片弯曲 → 触点弹开 → 主回路失电
  const tripped = t.value >= 0.97
  const tripping = t.value >= 0.9
  const mainV = closed && !tripped ? '380' : '0'
  // 控制回路取自断路器上游，脱扣后仍有电——这也是现场判据：主回路没了、控制回路还在
  const ctrlV = t.value >= 0.3 ? '220' : '0'
  const pulled = t.value >= 0.5 && !tripped
  const relayCount = tripped ? 0 : [0, 1, 2].filter((i) => t.value >= 0.56 + i * 0.08).length
  const running = t.value >= 0.86 && !tripping
  const phase =
    t.value < 0.15
      ? '主断路器合闸'
      : t.value < 0.3
        ? '分路断路器合闸'
        : t.value < 0.34
          ? '控制回路得电'
          : t.value < 0.52
            ? '接触器吸合'
            : t.value < 0.82
              ? '继电器自检'
              : t.value < 0.9
                ? '系统就绪'
                : t.value < 0.97
                  ? '过载脱扣'
                  : '已脱扣'
  return [
    { label: '动作阶段', value: phase },
    { label: '主回路电压', value: mainV, unit: 'V' },
    { label: '控制回路电压', value: ctrlV, unit: 'V' },
    { label: '接触器', value: pulled ? '吸合' : '断开', dot: pulled ? 'ok' : 'idle' },
    { label: '继电器', value: `${relayCount} / 3`, unit: '个' },
    { label: '运行指示', value: running ? '亮' : '灭', dot: running ? 'ok' : 'idle' },
    // 脱扣是这一页最要紧的一条：手柄停在中间位，不是断开位
    { label: '断路器手柄', value: tripped ? '中间位（已脱扣）' : closed ? '合闸位' : '断开位', dot: tripped ? 'warn' : 'idle' },
  ]
})

const reads = computed(() => {
  if (scene.value === 'door') return doorReads.value
  if (scene.value === 'pantograph') return pantoReads.value
  return cabinetReads.value
})

/* -------------------------------------------------------------------- 操作 */

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

function toggleFocus(key: string): void {
  focus.value = focus.value === key ? '' : key
}

function switchScene(key: SceneKey): void {
  if (key === scene.value) return
  stop()
  scene.value = key
  t.value = 0
  focus.value = ''
  cut.value = false
}

function toggleCut(): void {
  cut.value = !cut.value
}

function seekCut(event: Event): void {
  cutAt.value = Number((event.target as HTMLInputElement).value) / 1000
}

onBeforeUnmount(stop)
</script>

<template>
  <main class="demo">
    <header class="demo__head">
      <p class="demo__eyebrow">{{ def.eyebrow }}</p>
      <h1 class="demo__title">{{ def.title }}</h1>
      <p class="demo__note" v-html="def.note" />
    </header>

    <div class="demo__tabs" role="tablist" aria-label="设备场景">
      <button
        v-for="key in SCENE_KEYS"
        :key="key"
        class="demo__tab"
        :class="{ 'demo__tab--on': scene === key }"
        type="button"
        role="tab"
        :aria-selected="scene === key"
        @click="switchScene(key)"
      >
        {{ SCENES[key].title }}
      </button>
    </div>

    <section class="demo__stage" aria-labelledby="scene-h">
      <h2 id="scene-h" class="demo__pane-title">三维作业引导（呈现）</h2>
      <DeviceScene
        :key="scene"
        :subject="def.subject"
        :t="t"
        :focus="focus"
        :label="def.label"
        :cut="cut"
        :cut-at="cutAt"
        @cutable="cutable = $event"
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

      <div v-if="cutable" class="demo__controls demo__controls--cut">
        <button
          class="demo__ghost"
          :class="{ 'demo__ghost--on': cut }"
          type="button"
          :aria-pressed="cut"
          @click="toggleCut"
        >
          {{ cut ? '关闭剖切' : '剖开看内部' }}
        </button>
        <label v-if="cut" class="demo__slider">
          <span class="demo__slider-label">切面位置 {{ Math.round(cutAt * 100) }}%</span>
          <input
            type="range"
            min="0"
            max="1000"
            step="1"
            :value="Math.round(cutAt * 1000)"
            @input="seekCut"
          />
        </label>
      </div>

      <div class="demo__parts" role="group" aria-label="部件高亮">
        <span class="demo__parts-label">部件</span>
        <button
          v-for="part in def.parts"
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
          <p class="demo__doc-line"><span class="demo__k">步骤</span>{{ def.step }}</p>
          <p class="demo__doc-line"><span class="demo__k">动作</span>{{ def.action }}</p>
          <p class="demo__doc-line"><span class="demo__k">工具</span>{{ def.tools }}</p>
          <p class="demo__doc-line demo__doc-line--head">验收判据</p>
          <ul class="demo__criteria">
            <li v-for="item in def.criteria" :key="item">{{ item }}</li>
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
          <div v-for="item in reads" :key="item.label" class="demo__read">
            <dt>{{ item.label }}</dt>
            <dd>
              <span v-if="item.dot" class="demo__dot" :class="`demo__dot--${item.dot}`" />
              <span v-else class="demo__num">{{ item.value }}</span>
              <template v-if="!item.dot">
                <span v-if="item.unit" class="demo__unit">{{ item.unit }}</span>
              </template>
              <template v-else>{{ item.value }}</template>
            </dd>
          </div>
        </dl>
        <p class="demo__hint">{{ def.hint }}</p>
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

.demo__note :deep(strong) {
  color: var(--c-ink);
  font-weight: 500;
}

.demo__tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.demo__tab {
  min-height: 36px;
  padding: 0 16px;
  border: 1px solid var(--c-line);
  border-radius: 999px;
  background: transparent;
  color: var(--c-ink-2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.demo__tab--on {
  border-color: var(--c-primary);
  background: var(--c-primary-soft, transparent);
  color: var(--c-primary-ink, var(--c-primary));
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

.demo__controls--cut {
  margin-top: 10px;
}

/* 剖切开关的「开」态：用实心描边表示已生效，和部件高亮片区分开 */
.demo__ghost--on {
  border-color: var(--c-primary, #2f6fd0);
  color: var(--c-primary, #2f6fd0);
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

.demo__unit {
  color: var(--c-ink-2);
  font-size: 12px;
}

.demo__dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.demo__dot--warn {
  /* 脱扣位用琥珀色：既不是正常（绿）也不是未动作（灰） */
  background: #c28a2a;
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

  .demo__controls--cut {
  margin-top: 10px;
}

/* 剖切开关的「开」态：用实心描边表示已生效，和部件高亮片区分开 */
.demo__ghost--on {
  border-color: var(--c-primary, #2f6fd0);
  color: var(--c-primary, #2f6fd0);
}

.demo__controls {
    flex-wrap: wrap;
  }

  .demo__slider {
    flex-basis: 100%;
  }
}
</style>
