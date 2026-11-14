<script setup lang="ts">
/** mon_panel（空调制冷场景）：MON 的「空调」页。
 *
 *  ## 与升弓那块屏的区别
 *  升弓屏是**核对**（点一行记一行）；空调屏是**设定**（选模式、调温度、下发）。
 *  所以这一屏多了一组控件：模式、温度 ±0.5 ℃、新风门、下发。
 *  控件不做成自由输入——现场就是按软键加/减，输入框反而给了编参数的机会。
 *
 *  ## 联锁从哪来
 *  全部走 `lib/hvac-session`：未上电不许设、压缩机运行时不许改模式、
 *  设定温度不低于回风温度时压缩机不启动。组件只负责显示与派发。
 */
import { computed, ref, watch } from 'vue'

import type { ParamValue } from '../../types'
import {
  HVAC_ITEMS,
  MODE_LABEL,
  applySettings,
  bumpTemp,
  confirmDone,
  confirmHvac,
  hvac,
  highPressure,
  lowPressure,
  nextAction,
  returnTemp,
  selectMode,
  supplySpeed,
  supplyTemp,
  tempDiff,
  toggleFreshAir,
  ventConfirmDone,
  applicable,
  poweredNow,
  type HvacKey,
  type HvacMode,
} from '../../lib/hvac-session'

const props = defineProps<{
  params: Record<string, ParamValue>
  label?: string
}>()

/** 回执除了本屏页脚，也抛给作业台——紧凑版把页脚藏了（那一栏只有 300px），
 *  没有这条通道，点了「下发设定」就没有任何文字回执（2026-11-14 实测）。 */
const emit = defineEmits<{ (e: 'receipt', text: string): void }>()

type Tab = 'set' | 'unit' | 'cabin'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'set', label: '空调设定' },
  { id: 'unit', label: '机组状态' },
  { id: 'cabin', label: '客室温度' },
]

const initialTab = computed<Tab>(() => {
  const raw = props.params.tab
  return raw === 'unit' || raw === 'cabin' ? raw : 'set'
})
const tab = ref<Tab>(initialTab.value)

/* 同一块屏会被连着几步复用（03 设定 → 04 确认 → 05 切制冷），**页签必须跟着步走**：
   只在初始化时读一次 params.tab，第 4 步会停在"空调设定"页，用户就找不到确认行
   （2026-11-14 实测）。人手动翻页不被覆盖——只有 params.tab 变了才同步。 */
watch(
  () => props.params.tab,
  (value) => {
    if (value === 'unit' || value === 'cabin' || value === 'set') tab.value = value
  },
)

/** status：只读结果（第 6 步）；check：可操作（第 3 步）。 */
const mode = computed(() => (props.params.mode === 'status' ? 'status' : 'check'))

const powered = computed(() => poweredNow() || mode.value === 'status')

/** 紧凑版：嵌在作业台左栏时用（那一栏高度只有 300px 上下）。
 *  弹窗版仍是完整版——屏里该有的边框、副屏、软键一个不少。 */
const compact = computed(() => props.params.compact === '1')

/** 本步允许选哪些模式（由作业台按步传入）。
 *  `set` 步只能选通风、`cool` 步只能切制冷——一页只做本页主工步的事。 */
const phase = computed(() => String(props.params.phase ?? 'all'))
const MODES = computed<HvacMode[]>(() => {
  if (phase.value === 'set') return ['vent']
  if (phase.value === 'cool') return ['cool']
  return ['vent', 'cool', 'heat']
})
/** 只有"设定"与"切制冷"两步允许改参数与下发。 */
const canSet = computed(() => phase.value === 'set' || phase.value === 'cool' || phase.value === 'all')

const flash = ref('')
let flashTimer = 0
function say(text: string): void {
  flash.value = text
  if (text) emit('receipt', text)
  window.clearTimeout(flashTimer)
  if (text) {
    flashTimer = window.setTimeout(() => {
      flash.value = ''
    }, 5000)
  }
}

/* 成功也要回执：这一屏没有别的"结果提示"，点完「下发设定」若什么都不说，
   用户只能靠右侧状态牌自己比对。失败给原因、成功给结果，两者都占同一行。 */
function run(result: { ok: boolean; hint: string }): void {
  say(result.hint)
}

/** status 模式是"成功后应该看到的样子"：即使没真跑过也按稳态显示，
 *  但页脚必须说清"这是示意"——与升弓屏同一条纪律。 */
const stable = computed(() => hvac.coolT >= 0.999 || mode.value === 'status')

const rows = computed<
  Array<{ key?: HvacKey; label: string; required: string; value: string; usable?: boolean }>
>(() => {
  if (tab.value === 'cabin') {
    const supply = stable.value ? supplyTemp() : supplyTemp()
    const ret = stable.value ? returnTemp() : returnTemp()
    return [
      { label: '送风温度', required: '—', value: `${supply.toFixed(1)} ℃` },
      { label: '回风温度', required: '—', value: `${ret.toFixed(1)} ℃` },
      { label: '送回风温差', required: '6–12 ℃', value: `${tempDiff().toFixed(1)} ℃` },
      { label: '设定温度', required: '—', value: `${hvac.setTemp} ℃` },
    ]
  }
  if (tab.value === 'unit') {
    return HVAC_ITEMS.map((item) => ({
      key: item.key,
      label: item.label,
      required: item.required,
      value: item.value(),
      // 通风模式下压缩机不转：这两行没有可确认的东西，行本身也要长得"点不动"
      usable: applicable(item.key),
    }))
  }
  // set 页：四行"当前机组状态"，控件在下面一条
  return [
    { label: '机组模式', required: '通风/制冷/制热', value: MODE_LABEL[hvac.mode] },
    { label: '设定温度', required: '16–30 ℃', value: `${hvac.setTemp} ℃` },
    { label: '新风门', required: '制冷试验关闭', value: hvac.freshAir === 'closed' ? '关闭' : '打开' },
    { label: '压缩机', required: '运行/停止', value: hvac.cooling ? '运行' : '停止' },
  ]
})

/** 通风阶段只有三项可判（压缩机与高压侧压力不适用）；制冷阶段才是五项。 */
const ventMode = computed(() => hvac.ventRunning && !hvac.cooling)
const done = computed(() => (ventMode.value ? ventConfirmDone() : confirmDone()))
const total = computed(() => (ventMode.value ? 3 : HVAC_ITEMS.length))
const stat = computed(() => {
  if (poweredNow()) return '司机室占用'
  return mode.value === 'status' ? '结果示意' : '未上电'
})

const foot = computed(() => {
  if (flash.value) return flash.value
  if (mode.value === 'status') {
    return `制冷稳定 · 温差 ${tempDiff().toFixed(1)} ℃ · 高压 ${highPressure().toFixed(2)} MPa`
  }
  if (!poweredNow()) return 'MON 未上电：先插钥匙右旋，并把制动手柄推到「快速」位'
  if (done.value >= total.value) {
    return ventMode.value
      ? `通风三项已确认 3/3 · 压缩机与高压侧压力切制冷后再判`
      : `五项已确认 ${done.value}/${total.value} · 可进入结论`
  }
  if (!hvac.applied) {
    return phase.value === 'cool'
      ? '选「制冷」并「下发设定」：压缩机随即起动'
      : '选「通风」并「下发设定」：风机随即运行'
  }
  return nextAction()
})

const provisional = computed(() => mode.value === 'status' && hvac.coolT < 0.999)
</script>

<template>
  <div class="hmon" :class="{ 'hmon--off': !powered, 'hmon--compact': compact }">
    <div class="hmon__frame">
      <header class="hmon__bar">
        <span class="hmon__brand">MON</span>
        <span class="hmon__title">车辆信息显示器 · 空调</span>
        <span class="hmon__stat">{{ stat }}</span>
      </header>

      <div class="hmon__ribbon" aria-hidden="true">
        <span>CRH380A · 04 车</span>
        <span>端号 1</span>
        <span class="hmon__clock">14:26:08</span>
      </div>

      <div class="hmon__tabs" role="tablist" aria-label="MON 空调页">
        <button
          v-for="t in TABS"
          :key="t.id"
          class="hmon__tab"
          type="button"
          role="tab"
          :aria-selected="tab === t.id"
          :class="{ 'is-on': tab === t.id }"
          @click="tab = t.id"
        >
          {{ t.label }}
        </button>
      </div>

      <div class="hmon__body">
        <div class="hmon__main">
          <div class="hmon__thead" aria-hidden="true">
            <span>项目</span>
            <span>要求</span>
            <span>显示值</span>
            <span>确认</span>
          </div>

          <ul class="hmon__rows">
            <li
              v-for="row in rows"
              :key="row.label"
              class="hmon__row"
              :class="{
                'is-done': row.key ? hvac.confirmed[row.key] : false,
                'is-na': row.usable === false,
              }"
            >
              <button
                v-if="mode === 'check' && row.key && row.usable !== false"
                class="hmon__hit"
                type="button"
                :aria-pressed="hvac.confirmed[row.key]"
                :aria-label="`${row.label}，要求 ${row.required}，显示 ${row.value}。点击确认`"
                @click="run(confirmHvac(row.key))"
              >
                <span class="hmon__name">{{ row.label }}</span>
                <span class="hmon__req">{{ row.required }}</span>
                <span class="hmon__val">{{ row.value }}</span>
                <span class="hmon__tick" aria-hidden="true">{{ hvac.confirmed[row.key] ? '✓' : '○' }}</span>
              </button>
              <div v-else class="hmon__hit hmon__hit--static">
                <span class="hmon__name">{{ row.label }}</span>
                <span class="hmon__req">{{ row.required }}</span>
                <span class="hmon__val">{{ row.value }}</span>
                <span class="hmon__tick" aria-hidden="true">{{ row.key ? (hvac.confirmed[row.key] ? '✓' : '—') : '—' }}</span>
              </div>
            </li>
          </ul>

          <!-- 通风阶段的两项"不适用"要说出来，否则用户会一直找为什么点不动 -->
          <p v-if="tab === 'unit' && ventMode" class="hmon__na-note" role="note">
            通风模式下压缩机不运行：<b>压缩机</b>与<b>高压侧压力</b>这两项本步不判，
            切到「制冷」并下发后再确认。
          </p>

          <!-- 控件条：只在 check 模式出现。status 是"看结果"，不该有可操作件。 -->
          <div v-if="mode === 'check' && tab === 'set' && canSet" class="hmon__ctrl">
            <div class="hmon__group" role="group" aria-label="机组模式">
              <button
                v-for="m in MODES"
                :key="m"
                class="hmon__key"
                type="button"
                :class="{ 'is-on': hvac.pending === m }"
                :aria-pressed="hvac.pending === m"
                @click="run(selectMode(m))"
              >
                {{ MODE_LABEL[m] }}
              </button>
            </div>
            <div class="hmon__group" role="group" aria-label="设定温度">
              <button class="hmon__key hmon__key--step" type="button" @click="run(bumpTemp(-0.5))">− 0.5</button>
              <span class="hmon__set">{{ hvac.pendingTemp.toFixed(1) }} ℃</span>
              <button class="hmon__key hmon__key--step" type="button" @click="run(bumpTemp(0.5))">+ 0.5</button>
            </div>
            <div class="hmon__group" role="group" aria-label="新风门">
              <button
                class="hmon__key"
                type="button"
                :aria-pressed="hvac.freshAir === 'closed'"
                @click="run(toggleFreshAir())"
              >
                新风门 {{ hvac.freshAir === 'closed' ? '关闭' : '打开' }}
              </button>
            </div>
            <button class="hmon__apply" type="button" @click="run(applySettings())">下发设定（起动）</button>
          </div>
        </div>

        <aside class="hmon__side" aria-hidden="true">
          <div class="hmon__stat-card">
            <span>机组模式</span>
            <strong>{{ MODE_LABEL[hvac.mode] }}</strong>
          </div>
          <div class="hmon__stat-card">
            <span>设定</span>
            <strong>{{ hvac.setTemp }}<em>℃</em></strong>
          </div>
          <div class="hmon__stat-card">
            <span>送风 / 回风</span>
            <strong>{{ supplyTemp().toFixed(1) }}<em>/ {{ returnTemp().toFixed(1) }} ℃</em></strong>
          </div>
          <div class="hmon__stat-card">
            <span>高压侧</span>
            <!-- 压缩机没起就没有高压读数：写 1.40 会被当成"系统已建压" -->
            <strong>
              {{ hvac.cooling ? highPressure().toFixed(2) : '—' }}<em v-if="hvac.cooling">MPa</em>
            </strong>
          </div>
        </aside>
      </div>

      <footer class="hmon__foot">
        <span class="hmon__foot-text">{{ foot }}</span>
        <span class="hmon__meter" aria-hidden="true">
          <i v-for="i in total" :key="i" :class="{ 'is-on': i <= done }" />
        </span>
      </footer>

      <p v-if="provisional" class="hmon__provisional" role="note">本屏为结果示意：本次会话尚未真正起制冷</p>

      <div class="hmon__softkeys" aria-hidden="true">
        <span v-for="k in 8" :key="k">F{{ k }}</span>
      </div>
    </div>

    <p class="hmon__hint">
      送风 {{ supplyTemp().toFixed(1) }} ℃ · 回风 {{ returnTemp().toFixed(1) }} ℃ · 风速
      {{ supplySpeed().toFixed(1) }} m/s · 低压
      {{ hvac.cooling ? lowPressure().toFixed(2) : '—' }} MPa（演示虚构值）
    </p>
  </div>
</template>

<style scoped>
.hmon {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  height: 100%;
  min-height: 0;
  gap: 6px;
}

.hmon__frame {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  max-width: 1180px;
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  background: #08100d;
  box-shadow:
    inset 0 0 0 2px #2b3336,
    inset 0 0 0 7px #0d1513,
    0 6px 18px rgb(0 0 0 / 28%);
  overflow: hidden;
}

.hmon__bar {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 14px 8px;
  background: linear-gradient(#1d6150, #154a3d);
  color: #e7f7ef;
}

.hmon__brand {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.1em;
}

.hmon__title {
  font-size: 12.5px;
  opacity: 0.82;
}

.hmon__stat {
  margin-left: auto;
  padding: 2px 9px;
  border: 1px solid rgb(231 247 239 / 45%);
  border-radius: 999px;
  font-size: 12px;
  white-space: nowrap;
}

.hmon__ribbon {
  flex: none;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 5px 14px;
  border-bottom: 1px solid #17332b;
  background: #0a1a15;
  color: #7fa79a;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.hmon__ribbon span:nth-child(2) {
  margin-left: auto;
}

.hmon__clock {
  color: #a9c9bd;
  font-family: var(--font-mono, ui-monospace, monospace);
}

.hmon__tabs {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 8px 10px 0;
  border-bottom: 1px solid #1e3a31;
  background: #0d211b;
}

.hmon__tab {
  flex: 1 1 0;
  min-height: 34px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  background: transparent;
  color: #8fb3a6;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.hmon__tab.is-on {
  border-color: #2b5a49;
  background: #17402f;
  color: #eafaf3;
  font-weight: 600;
}

.hmon__body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: stretch;
  gap: 10px;
}

.hmon__main {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.hmon__thead {
  flex: none;
  display: grid;
  grid-template-columns: 1fr 96px 124px 26px;
  column-gap: 12px;
  padding: 6px 6px;
  border-bottom: 1px solid #1a352c;
  background: #0b1d17;
  color: #86a89a;
  font-size: 11px;
  letter-spacing: 0.06em;
}

.hmon__thead span:nth-child(2),
.hmon__thead span:nth-child(3) {
  text-align: right;
}

.hmon__thead span:nth-child(4) {
  text-align: center;
}

.hmon__rows {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 2px 6px 4px;
  list-style: none;
  overflow-y: auto;
}

.hmon__row {
  flex: 1 1 0;
  min-height: 50px;
  max-height: 84px;
  display: flex;
  border-bottom: 1px solid #14261f;
}

.hmon__row:last-child {
  border-bottom: none;
}

.hmon__hit {
  width: 100%;
  height: 100%;
  min-height: 50px;
  display: grid;
  grid-template-columns: 1fr 96px 124px 26px;
  column-gap: 12px;
  align-items: center;
  padding: 8px 6px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #c3ddd2;
  font: inherit;
  font-size: 14.5px;
  text-align: left;
  cursor: pointer;
}

.hmon__hit:not(.hmon__hit--static):hover {
  background: #153026;
}

.hmon__hit--static {
  cursor: default;
}

.hmon__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hmon__req {
  color: #9dbfb2;
  font-size: 12.5px;
  text-align: right;
  white-space: nowrap;
}

.hmon__val {
  color: #f2fdf8;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-weight: 700;
  font-size: 16px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}

.hmon__tick {
  color: #86a89a;
  font-size: 15px;
  text-align: center;
}

.hmon__row.is-done {
  background: linear-gradient(90deg, rgb(47 143 91 / 18%), transparent 70%);
}

/* 本工况下不可确认的行：不抢注意力，但也不显得"坏了" */
.hmon__row.is-na .hmon__name,
.hmon__row.is-na .hmon__req,
.hmon__row.is-na .hmon__val {
  color: #5f7c72;
}

.hmon__na-note {
  margin: 0;
  padding: 6px 10px 8px;
  border-top: 1px dashed #1e3a31;
  color: #ffd89a;
  font-size: 12px;
  line-height: 1.5;
}

.hmon__row.is-done .hmon__tick {
  color: #7fd6b4;
}

/* 控件条：一排软键。高度固定 44px，不抢表格的份额 */
.hmon__ctrl {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 8px;
  border-top: 1px solid #1e3a31;
  background: #0a1a15;
}

.hmon__group {
  display: flex;
  align-items: center;
  gap: 4px;
}

.hmon__key {
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid #2b5a49;
  border-radius: 5px;
  background: #12332a;
  color: #cfe9de;
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}

.hmon__key.is-on {
  border-color: #7fd6b4;
  background: #1f6a4d;
  color: #f2fdf8;
  font-weight: 600;
}

.hmon__key--step {
  min-width: 52px;
  font-family: var(--font-mono, ui-monospace, monospace);
}

.hmon__set {
  min-width: 62px;
  color: #f2fdf8;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 15px;
  font-weight: 700;
  text-align: center;
}

.hmon__apply {
  margin-left: auto;
  min-height: 32px;
  padding: 0 14px;
  border: 1px solid #4f9c7c;
  border-radius: 5px;
  background: #267a55;
  color: #f2fdf8;
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}

.hmon__side {
  flex: 0 0 216px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px 6px 0;
}

.hmon__stat-card {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  padding: 6px 12px;
  border: 1px solid #1e3a31;
  border-radius: 6px;
  background: #0c211a;
}

.hmon__stat-card span {
  color: #86a89a;
  font-size: 12px;
}

.hmon__stat-card strong {
  color: #eafaf3;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 20px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.hmon__stat-card em {
  margin-left: 4px;
  color: #86a89a;
  font-size: 11px;
  font-style: normal;
}

.hmon__foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-top: 1px solid #1e3a31;
  background: #0a1a16;
}

.hmon__foot-text {
  flex: 1 1 auto;
  color: #7fd6b4;
  font-size: 12.5px;
}

.hmon__meter {
  display: flex;
  gap: 3px;
}

.hmon__meter i {
  width: 16px;
  height: 5px;
  border-radius: 2px;
  background: #22403a;
}

.hmon__meter i.is-on {
  background: #7fd6b4;
}

.hmon__provisional {
  margin: 0;
  padding: 5px 12px;
  border-top: 1px solid #3d2f14;
  background: #2a2109;
  color: #ffd89a;
  font-size: 12px;
  text-align: center;
}

.hmon__softkeys {
  flex: none;
  display: flex;
  gap: 6px;
  padding: 6px 12px 9px;
  border-top: 1px solid #16291f;
  background: #070f0c;
}

.hmon__softkeys span {
  flex: 1 1 0;
  min-width: 0;
  padding: 3px 0;
  border-radius: 3px;
  background: #123c50;
  color: #a9d8f2;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10.5px;
  text-align: center;
}

.hmon__hint {
  flex: none;
  width: 100%;
  max-width: 1180px;
  margin: 0;
  color: var(--c-ink-2);
  font-size: 12px;
  line-height: 1.55;
}

.hmon--off .hmon__frame {
  filter: saturate(0.45) brightness(0.72);
}

/* ---- 嵌入式紧凑版：作业台左栏只有 ~300px 高 ---- */
.hmon--compact .hmon__ribbon,
.hmon--compact .hmon__softkeys,
.hmon--compact .hmon__hint,
.hmon--compact .hmon__side,
.hmon--compact .hmon__provisional {
  display: none;
}

.hmon--compact .hmon__bar {
  padding: 6px 10px 5px;
}

.hmon--compact .hmon__tab {
  min-height: 26px;
  font-size: 12px;
}

/* 表头在 250px 高的栏里是奢侈品：四列含义靠内容本身就能读（勾/圆点在最后一列） */
.hmon--compact .hmon__thead {
  display: none;
}

.hmon--compact .hmon__hit {
  grid-template-columns: 1fr 78px 92px 20px;
  column-gap: 8px;
  min-height: 26px;
  padding: 2px 6px;
  font-size: 12.5px;
}

.hmon--compact .hmon__ctrl {
  padding: 4px 6px;
  gap: 6px;
}

.hmon--compact .hmon__row {
  min-height: 26px;
  max-height: none;
}

.hmon--compact .hmon__key,
.hmon--compact .hmon__apply {
  min-height: 26px;
  padding: 0 8px;
  font-size: 11.5px;
}

.hmon--compact .hmon__foot {
  /* 页面下方的 HUD 已经写着同一句"下一步做什么"，这里再占一行只会挤掉表格 */
  display: none;
}

.hmon--compact .hmon__foot-text {
  font-size: 11.5px;
}

@media (max-height: 620px) {
  .hmon__ribbon,
  .hmon__softkeys,
  .hmon__hint {
    display: none;
  }

  .hmon__side {
    flex: 0 0 168px;
    gap: 5px;
  }

  .hmon__row {
    max-height: none;
  }
}

@media (max-width: 900px) {
  .hmon__side {
    display: none;
  }
}

/* 打印：深色玻璃翻白底（与升弓那块屏同一套处理） */
@media print {
  .hmon__frame,
  .hmon__bar,
  .hmon__ribbon,
  .hmon__thead,
  .hmon__row,
  .hmon__hit,
  .hmon__body,
  .hmon__main,
  .hmon__side,
  .hmon__stat-card,
  .hmon__foot,
  .hmon__ctrl,
  .hmon__key,
  .hmon__set {
    background: #fff !important;
    color: #111 !important;
    box-shadow: none !important;
    border-color: #bbb !important;
  }

  .hmon__tabs,
  .hmon__softkeys,
  .hmon__hint,
  .hmon__provisional,
  .hmon__meter,
  .hmon__stat,
  .hmon__ctrl {
    display: none !important;
  }

  .hmon__name,
  .hmon__req,
  .hmon__val,
  .hmon__tick,
  .hmon__foot-text,
  .hmon__stat-card span,
  .hmon__stat-card strong {
    color: #111 !important;
  }
}
</style>
