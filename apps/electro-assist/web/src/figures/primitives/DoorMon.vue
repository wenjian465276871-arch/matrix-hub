<script setup lang="ts">
/** mon_panel（开关门场景）：MON 的「车门」页。
 *
 *  ## 三页各回答一个问题
 *  - 状态：全列车门关了没有、有没有隔离与故障（第 3 步在这里逐项确认）；
 *  - 集控：本侧释放了没有、按钮灯亮不亮、防夹反开几次（第 4–5 步看这里）；
 *  - 记录：故障文案与隔离情况（第 6 步给结论用）。
 *
 *  ## 为什么"确认"只放在状态页
 *  集控页的数字是**操作过程的副产物**（释放了才有、反开了才有），
 *  让人去"确认"这些等于让他确认自己刚才按了什么。核对的对象只能是状态。
 */
import { computed, onBeforeUnmount, ref } from 'vue'

import type { ParamValue } from '../../types'
import {
  DOOR_ITEMS,
  ZERO_SPEED_LIMIT,
  closeTime,
  confirmDone,
  confirmDoor,
  door,
  doorState,
  openTime,
  poweredNow,
  type DoorKey,
} from '../../lib/door-session'

const props = defineProps<{
  params: Record<string, ParamValue>
  label?: string
}>()

type Tab = 'status' | 'control' | 'fault'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'status', label: '车门状态' },
  { id: 'control', label: '集控操作' },
  { id: 'fault', label: '故障与隔离' },
]

const initialTab = computed<Tab>(() => {
  const raw = props.params.tab
  return raw === 'control' || raw === 'fault' ? raw : 'status'
})
const tab = ref<Tab>(initialTab.value)

const mode = computed(() => (props.params.mode === 'status' ? 'status' : 'check'))
/** 本步允许确认的只有"车门状态"这一步；其余步骤打开屏只能看。 */
const phase = computed(() => String(props.params.phase ?? 'all'))
const canConfirm = computed(() => phase.value === 'check' || phase.value === 'all')
const rowClickable = computed(() => mode.value === 'check' && canConfirm.value)
const powered = computed(() => poweredNow() || mode.value === 'status')

const flash = ref('')
let flashTimer = 0
/* 卸载时收掉回执定时器（评审 R23-5）：翻页会真的卸载组件，定时器却会跑完
   ——写一个已死的 ref 不会报错，但与 `OpsBoard` / `PantoOps` 的写法不一致，
   而"同一件事两种写法"正是下一轮踩坑的地方。 */
onBeforeUnmount(() => window.clearTimeout(flashTimer))

/* 成功也回执（与空调屏同一条约定）：三行确认点完要能看到"已确认一项"。 */
function run(result: { ok: boolean; hint: string }): void {
  flash.value = result.hint
  window.clearTimeout(flashTimer)
  if (flash.value) {
    flashTimer = window.setTimeout(() => {
      flash.value = ''
    }, 5000)
  }
}

interface Row {
  key?: DoorKey
  label: string
  required: string
  value: string
}

const rows = computed<Row[]>(() => {
  if (tab.value === 'control') {
    return [
      { label: '集控侧', required: '站台侧', value: door.side === 'L' ? '左侧' : '右侧' },
      { label: '集控开关', required: '扳到投入', value: door.released ? '已投入 · 该侧接受集控' : '已切除 · 不受集控' },
      { label: '开门时间', required: '2.5–4.0 s', value: `${openTime().toFixed(1)} s` },
      { label: '关门时间', required: '3.0–5.0 s', value: `${closeTime().toFixed(1)} s` },
      { label: '防夹动作', required: '碰块即停并全开（1 次）', value: `${door.bumps} 次` },
    ]
  }
  if (tab.value === 'fault') {
    return [
      { label: '故障记录', required: '无故障', value: door.fault || '无故障' },
      { label: '隔离车门', required: '无隔离', value: '无隔离' },
      { label: '紧急解锁铅封', required: '完好', value: '完好' },
      { label: '零速保护', required: `<${ZERO_SPEED_LIMIT} km/h 才可开门`, value: '0 km/h · 有效' },
    ]
  }
  return [
    {
      key: 'closed',
      label: '全列车门',
      required: '关闭锁闭',
      value: door.openT > 0.001 ? '有门未关闭' : '8/8 关闭锁闭',
    },
    { key: 'isolated', label: '车门隔离', required: '无隔离', value: '无隔离' },
    { key: 'nofault', label: '车门故障', required: '无故障', value: door.fault || '无故障' },
    { label: '关门灯', required: '全关闭时点亮', value: door.closedLed ? '亮' : '灭' },
  ]
})

const done = computed(() => confirmDone())
const total = DOOR_ITEMS.length

const stat = computed(() => {
  if (poweredNow()) return '司机室占用'
  return mode.value === 'status' ? '结果示意' : '未上电'
})

const foot = computed(() => {
  if (flash.value) return flash.value
  if (mode.value === 'status') {
    return `8/8 关闭锁闭 · 关门灯${door.closedLed ? '亮' : '灭'} · 无故障`
  }
  if (!poweredNow()) return 'MON 未上电：先插钥匙右旋，并把制动手柄推到「快速」位'
  if (done.value >= total) return '三项已确认 · 可开始集控开关门'
  return `已确认 ${done.value}/${total} · 全列状态确认后才能集控开门`
})

const provisional = computed(() => mode.value === 'status' && !door.confirmed.closed)
</script>

<template>
  <div class="dmon" :class="{ 'dmon--off': !powered }">
    <div class="dmon__frame">
      <header class="dmon__bar">
        <span class="dmon__brand">MON</span>
        <span class="dmon__title">车辆信息显示器 · 车门</span>
        <span class="dmon__stat">{{ stat }}</span>
      </header>

      <div class="dmon__ribbon" aria-hidden="true">
        <span>CRH380A · 04 车</span>
        <span>端号 1</span>
        <span class="dmon__clock">14:26:08</span>
      </div>

      <div class="dmon__tabs" role="tablist" aria-label="MON 车门页">
        <button
          v-for="t in TABS"
          :key="t.id"
          class="dmon__tab"
          type="button"
          role="tab"
          :aria-selected="tab === t.id"
          :class="{ 'is-on': tab === t.id }"
          @click="tab = t.id"
        >
          {{ t.label }}
        </button>
      </div>

      <div class="dmon__body">
        <div class="dmon__main">
          <div class="dmon__thead" aria-hidden="true">
            <span>项目</span>
            <span>要求</span>
            <span>显示值</span>
            <span>确认</span>
          </div>

          <ul class="dmon__rows">
            <li
              v-for="row in rows"
              :key="row.label"
              class="dmon__row"
              :class="{ 'is-done': row.key ? door.confirmed[row.key] : false, 'is-bad': row.label === '故障记录' && door.fault }"
            >
              <button
                v-if="rowClickable && row.key"
                class="dmon__hit"
                type="button"
                :aria-pressed="door.confirmed[row.key]"
                :aria-label="`${row.label}，要求 ${row.required}，显示 ${row.value}。点击确认`"
                @click="run(confirmDoor(row.key))"
              >
                <span class="dmon__name">{{ row.label }}</span>
                <span class="dmon__req">{{ row.required }}</span>
                <span class="dmon__val">{{ row.value }}</span>
                <span class="dmon__tick" aria-hidden="true">{{ door.confirmed[row.key] ? '✓' : '○' }}</span>
              </button>
              <div v-else class="dmon__hit dmon__hit--static">
                <span class="dmon__name">{{ row.label }}</span>
                <span class="dmon__req">{{ row.required }}</span>
                <span class="dmon__val">{{ row.value }}</span>
                <span class="dmon__tick" aria-hidden="true">{{ row.key ? (door.confirmed[row.key] ? '✓' : '—') : '—' }}</span>
              </div>
            </li>
          </ul>
        </div>

        <aside class="dmon__side" aria-hidden="true">
          <div class="dmon__stat-card">
            <span>本侧车门</span>
            <strong>{{ doorState() }}</strong>
          </div>
          <div class="dmon__stat-card">
            <span>集控</span>
            <strong>{{ door.released ? '已释放' : '未释放' }}</strong>
          </div>
          <div class="dmon__stat-card">
            <span>关门灯</span>
            <strong>{{ door.closedLed ? '亮' : '灭' }}</strong>
          </div>
        </aside>
      </div>

      <footer class="dmon__foot">
        <span class="dmon__foot-text">{{ foot }}</span>
        <span class="dmon__meter" aria-hidden="true">
          <i v-for="i in total" :key="i" :class="{ 'is-on': i <= done }" />
        </span>
      </footer>

      <p v-if="provisional" class="dmon__provisional" role="note">本屏为结果示意：本次会话尚未确认全列门状态</p>

      <div class="dmon__softkeys" aria-hidden="true">
        <span v-for="k in 8" :key="k">F{{ k }}</span>
      </div>
    </div>

    <p class="dmon__hint">
      开关门时间 3.2 s / 3.6 s（公开区间 2.5–4.0 / 3.0–5.0）；中缝试块约 40 mm，连续 3 次受阻报故障。
    </p>
  </div>
</template>

<style scoped>
.dmon {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  height: 100%;
  min-height: 0;
  gap: 6px;
}

.dmon__frame {
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

.dmon__bar {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 14px 8px;
  background: linear-gradient(#1d6150, #154a3d);
  color: #e7f7ef;
}

.dmon__brand {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.1em;
}

.dmon__title {
  font-size: 12.5px;
  opacity: 0.82;
}

.dmon__stat {
  margin-left: auto;
  padding: 2px 9px;
  border: 1px solid rgb(231 247 239 / 45%);
  border-radius: 999px;
  font-size: 12px;
  white-space: nowrap;
}

.dmon__ribbon {
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

.dmon__ribbon span:nth-child(2) {
  margin-left: auto;
}

.dmon__clock {
  color: #a9c9bd;
  font-family: var(--font-mono, ui-monospace, monospace);
}

.dmon__tabs {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 8px 10px 0;
  border-bottom: 1px solid #1e3a31;
  background: #0d211b;
}

.dmon__tab {
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

.dmon__tab.is-on {
  border-color: #2b5a49;
  background: #17402f;
  color: #eafaf3;
  font-weight: 600;
}

.dmon__body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: stretch;
  gap: 10px;
}

.dmon__main {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.dmon__thead {
  flex: none;
  display: grid;
  grid-template-columns: 1fr 120px 132px 26px;
  column-gap: 12px;
  padding: 6px 6px;
  border-bottom: 1px solid #1a352c;
  background: #0b1d17;
  color: #86a89a;
  font-size: 11px;
  letter-spacing: 0.06em;
}

.dmon__thead span:nth-child(2),
.dmon__thead span:nth-child(3) {
  text-align: right;
}

.dmon__thead span:nth-child(4) {
  text-align: center;
}

.dmon__rows {
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

.dmon__row {
  flex: 1 1 0;
  min-height: 50px;
  max-height: 84px;
  display: flex;
  border-bottom: 1px solid #14261f;
}

.dmon__row:last-child {
  border-bottom: none;
}

.dmon__hit {
  width: 100%;
  height: 100%;
  min-height: 50px;
  display: grid;
  grid-template-columns: 1fr 120px 132px 26px;
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

.dmon__hit:not(.dmon__hit--static):hover {
  background: #153026;
}

.dmon__hit--static {
  cursor: default;
}

.dmon__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dmon__req {
  color: #9dbfb2;
  font-size: 12.5px;
  text-align: right;
  white-space: nowrap;
}

.dmon__val {
  color: #f2fdf8;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-weight: 700;
  font-size: 16px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}

.dmon__tick {
  color: #86a89a;
  font-size: 15px;
  text-align: center;
}

.dmon__row.is-done {
  background: linear-gradient(90deg, rgb(47 143 91 / 18%), transparent 70%);
}

.dmon__row.is-done .dmon__tick {
  color: #7fd6b4;
}

/* 故障行：红底窄带。它不是"没完成"，是"有东西坏了"，颜色必须区分开 */
.dmon__row.is-bad {
  background: linear-gradient(90deg, rgb(176 58 52 / 30%), transparent 72%);
}

.dmon__row.is-bad .dmon__val {
  color: #ffb4ae;
}

.dmon__side {
  flex: 0 0 208px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px 6px 0;
}

.dmon__stat-card {
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

.dmon__stat-card span {
  color: #86a89a;
  font-size: 12px;
}

.dmon__stat-card strong {
  color: #eafaf3;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 19px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.dmon__foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-top: 1px solid #1e3a31;
  background: #0a1a16;
}

.dmon__foot-text {
  flex: 1 1 auto;
  color: #7fd6b4;
  font-size: 12.5px;
}

.dmon__meter {
  display: flex;
  gap: 3px;
}

.dmon__meter i {
  width: 16px;
  height: 5px;
  border-radius: 2px;
  background: #22403a;
}

.dmon__meter i.is-on {
  background: #7fd6b4;
}

.dmon__provisional {
  margin: 0;
  padding: 5px 12px;
  border-top: 1px solid #3d2f14;
  background: #2a2109;
  color: #ffd89a;
  font-size: 12px;
  text-align: center;
}

.dmon__softkeys {
  flex: none;
  display: flex;
  gap: 6px;
  padding: 6px 12px 9px;
  border-top: 1px solid #16291f;
  background: #070f0c;
}

.dmon__softkeys span {
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

.dmon__hint {
  flex: none;
  width: 100%;
  max-width: 1180px;
  margin: 0;
  color: var(--c-ink-2);
  font-size: 12px;
  line-height: 1.55;
}

.dmon--off .dmon__frame {
  filter: saturate(0.45) brightness(0.72);
}

@media (max-height: 620px) {
  .dmon__ribbon,
  .dmon__softkeys,
  .dmon__hint {
    display: none;
  }

  .dmon__side {
    flex: 0 0 164px;
    gap: 5px;
  }

  .dmon__row {
    max-height: none;
  }
}

@media (max-width: 900px) {
  .dmon__side {
    display: none;
  }
}

@media print {
  .dmon__frame,
  .dmon__bar,
  .dmon__ribbon,
  .dmon__thead,
  .dmon__row,
  .dmon__hit,
  .dmon__body,
  .dmon__main,
  .dmon__side,
  .dmon__stat-card,
  .dmon__foot {
    background: #fff !important;
    color: #111 !important;
    box-shadow: none !important;
    border-color: #bbb !important;
  }

  .dmon__tabs,
  .dmon__softkeys,
  .dmon__hint,
  .dmon__provisional,
  .dmon__meter,
  .dmon__stat {
    display: none !important;
  }

  .dmon__name,
  .dmon__req,
  .dmon__val,
  .dmon__tick,
  .dmon__foot-text,
  .dmon__stat-card span,
  .dmon__stat-card strong {
    color: #111 !important;
  }
}
</style>
