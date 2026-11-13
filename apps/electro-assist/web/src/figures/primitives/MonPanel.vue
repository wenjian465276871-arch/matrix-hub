<script setup lang="ts">
/** mon_panel：可点确认的 MON 屏。
 *
 *  ## 这一屏解决什么
 *  升弓前有九项条件，其中五项必须"在 MON 上看一眼"。文字清单只能证明"读过"，
 *  点一遍才能证明"核对过"——所以做成屏：点一行，记一行，没点完不许升弓。
 *
 *  ## 为什么页签是固定的三个
 *  现场就是三页：电源电压、车辆信息、远程控制切除。页签不做成参数，
 *  是因为参数一放开，模型就会编出"牵引变流"这种不存在的页——而页面上看着挺像。
 *
 *  ## 与状态机的关系
 *  本组件只负责"显示 + 把点击交给 `panto-session`"；能不能升弓由状态机判。
 *  这样第 3 步点三维、第 5 步点按钮、第 2 步点屏，走的是同一套联锁。
 */
import { computed, ref } from 'vue'

import type { ParamValue } from '../../types'
import { MON_ITEMS, confirmMon, monDone, session, type MonKey } from '../../lib/panto-session'

const props = defineProps<{
  params: Record<string, ParamValue>
  label?: string
}>()

type Tab = 'power' | 'vehicle' | 'remote'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'power', label: '电源电压' },
  { id: 'vehicle', label: '车辆信息' },
  { id: 'remote', label: '远程控制切除' },
]

const initialTab = computed<Tab>(() => {
  const raw = props.params.tab
  return raw === 'vehicle' || raw === 'remote' ? raw : 'power'
})
const tab = ref<Tab>(initialTab.value)

/** status：只看结果（第 6 步）；check：可点确认（第 2 步）。 */
const mode = computed(() => (props.params.mode === 'status' ? 'status' : 'check'))

interface Row {
  key?: MonKey
  label: string
  required: string
  value: string
}

/* 第 6 步（status）是"成功后应该看到的样子"：即使没走过前面步骤，也按成功态显示受电弓。
   否则直接翻到第 6 步会看到一块暗屏 + "未升起"，与"读到升起即可进入下一步"自相矛盾。 */
const shownRaised = computed(() => (mode.value === 'status' ? true : session.raised))

/* VCB **不能**跟着 status 一起"示意"。
   2026-11-13 本人实测：第 5 步合了 VCB，第 6 步屏上仍写"断开"——因为这里写死了 false。
   VCB 是人操作的直接结果，屏必须如实反映；"升起了但还没合闸"本身也是合法中间态，
   显示"断开"不算矛盾。 */
const shownVcb = computed(() => session.vcbClosed)

/** VCB 在两种场景下的含义不同：
 *  - 升弓前（check）：必须断开，否则升弓回路被联锁切断；
 *  - 升弓后（status）：按需要，合闸是下一步的事，不是判据。 */
const vcbRequired = computed(() => (mode.value === 'status' ? '视需要' : '必须断开'))

/** 当前选中的受电弓单元。2U = 04 车，3U = 06 车。 */
const unit = computed(() => session.unit ?? '2U')

const rows = computed<Row[]>(() => {
  if (tab.value === 'power') {
    return [
      { key: 'voltage', ...pick('voltage') },
      { key: 'mr', ...pick('mr') },
      { label: '蓄电池电压', required: '≥87 V', value: '110.0 V' },
    ]
  }
  if (tab.value === 'vehicle') {
    return [
      { key: 'egs', ...pick('egs') },
      { key: 'vcb', ...pick('vcb', '视需要') },
      // 这一行的"要求"与"显示"不能都写"未切除"：两列同字，看着像重复渲染。
      { key: 'panto_cut', label: '受电弓远程切除', required: '应未切除', value: '均未切除' },
    ]
  }
  // 远程控制切除页：先看"切没切"，再看"升没升"。
  // 原来把"升起"塞进切除行，出现"未切除 升起"这种两种语义挤在一行的读法。
  const other = unit.value === '2U' ? '3U' : '2U'
  return [
    { label: `${unit.value} 受电弓切除`, required: '应未切除', value: '未切除' },
    { label: `${other} 受电弓切除`, required: '应未切除', value: '未切除' },
    { label: '受电弓状态', required: mode.value === 'status' ? '已确认' : '应升起', value: shownRaised.value ? '升起' : '未升起' },
    { label: 'VCB', required: vcbRequired.value, value: shownVcb.value ? '闭合' : '断开' },
  ]
})

/** 有些项的"显示值"是活的，不能写死在 `MON_ITEMS` 里默认值中：
 *  VCB 是人操作的结果，写死"断开"会在用户合闸后自相矛盾。 */
function liveValue(key: MonKey, fallback: string): string {
  if (key === 'vcb') return shownVcb.value ? '闭合' : '断开'
  return fallback
}

function pick(
  key: MonKey,
  requiredInStatus?: string,
): { label: string; required: string; value: string } {
  const item = MON_ITEMS.find((i) => i.key === key)!
  return {
    label: item.label,
    required: mode.value === 'status' && requiredInStatus ? requiredInStatus : item.required,
    value: liveValue(key, item.value),
  }
}

function isDone(key?: MonKey): boolean {
  return key ? session.mon[key] : false
}

/** 点击没被接受时的说明。放在屏内页脚——短屏下 `.mon__hint` 是隐藏的，
 *  提示挂在那里等于没提示。 */
const flash = ref('')
let flashTimer = 0

function toggle(key?: MonKey): void {
  if (mode.value !== 'check' || !key) return
  const result = confirmMon(key)
  flash.value = result.ok ? '' : result.hint
  window.clearTimeout(flashTimer)
  if (flash.value) {
    flashTimer = window.setTimeout(() => {
      flash.value = ''
    }, 5000)
  }
}

const done = computed(() => monDone())
const total = MON_ITEMS.length

const foot = computed(() => {
  if (flash.value) return flash.value
  if (mode.value === 'status') {
    return shownVcb.value
      ? '受电弓升起 · 网压 25.1 kV · VCB 已闭合'
      : '受电弓升起 · 网压 25.1 kV（VCB 未合）'
  }
  if (!session.keyTurned) return 'MON 未上电：先插主控钥匙并右旋到运行位'
  if (done.value >= total) return '五项已确认 · 允许发出升弓指令'
  return `已确认 ${done.value}/${total} · 五项全部确认后才允许升弓`
})

/** 屏幕是否"有电"：钥匙右旋后点亮。第 2 步是上电后画面，所以恒亮，但要说明。 */
/* MON 由主控钥匙右旋点亮。check 模式不再恒亮——那是上一版为了让"先确认后上电"
   这个错误顺序看起来自洽而加的补丁，现在顺序已经改对，屏就该如实反映有没有电。 */
const powered = computed(() => session.keyTurned || mode.value === 'status')

const stat = computed(() => {
  if (session.keyTurned) return '司机室占用'
  return mode.value === 'status' ? '结果示意' : '未上电'
})
</script>

<template>
  <div class="mon" :class="{ 'mon--off': !powered }">
    <div class="mon__frame">
      <header class="mon__bar">
        <span class="mon__brand">MON</span>
        <span class="mon__title">车辆信息显示器</span>
        <span class="mon__stat">{{ stat }}</span>
      </header>

      <!-- 端号 / 车号 / 时钟：真车屏顶部固定的一条。演示值，读屏不读 -->
      <div class="mon__ribbon" aria-hidden="true">
        <span>CRH380A · {{ unit === '3U' ? '06 车' : '04 车' }}</span>
        <span>端号 1</span>
        <span class="mon__clock">14:26:08</span>
      </div>

      <div class="mon__tabs" role="tablist" aria-label="MON 页面">
        <button
          v-for="t in TABS"
          :key="t.id"
          class="mon__tab"
          type="button"
          role="tab"
          :aria-selected="tab === t.id"
          :class="{ 'is-on': tab === t.id }"
          @click="tab = t.id"
        >
          {{ t.label }}
        </button>
      </div>

      <div class="mon__body">
      <div class="mon__main">
      <div class="mon__thead" aria-hidden="true">
        <span>项目</span>
        <span>要求</span>
        <span>显示值</span>
        <span>确认</span>
      </div>

      <ul class="mon__rows">
        <li v-for="row in rows" :key="row.label" class="mon__row" :class="{ 'is-done': isDone(row.key) }">
          <button
            v-if="mode === 'check' && row.key"
            class="mon__hit"
            type="button"
            :aria-pressed="isDone(row.key)"
            :aria-label="`${row.label}，要求 ${row.required}，显示 ${row.value}。点击确认`"
            @click="toggle(row.key)"
          >
            <span class="mon__name">{{ row.label }}</span>
            <span class="mon__req">{{ row.required }}</span>
            <span class="mon__val">{{ row.value }}</span>
            <span class="mon__tick" aria-hidden="true">{{ isDone(row.key) ? '✓' : '○' }}</span>
          </button>
          <div v-else class="mon__hit mon__hit--static">
            <span class="mon__name">{{ row.label }}</span>
            <span class="mon__req">{{ row.required }}</span>
            <span class="mon__val">{{ row.value }}</span>
            <span class="mon__tick" aria-hidden="true">{{ isDone(row.key) ? '✓' : '—' }}</span>
          </div>
        </li>
      </ul>
      </div>

      <!-- 右侧三块状态牌：真车 MON 的右上角常驻"受电弓 / 网压 / VCB"。
           它同时把宽屏下表格右侧那一大片空白填上。 -->
      <aside class="mon__side" aria-hidden="true">
        <div class="mon__stat-card">
          <span>受电弓 {{ unit }}</span>
          <strong>{{ shownRaised ? '升起' : '未升起' }}</strong>
        </div>
        <div class="mon__stat-card">
          <span>网压</span>
          <strong>{{ shownRaised ? '25.1' : '0.0' }}<em>kV</em></strong>
        </div>
        <div class="mon__stat-card">
          <span>VCB</span>
          <strong>{{ shownVcb ? '闭合' : '断开' }}</strong>
        </div>
      </aside>
      </div>

      <!-- 列车编组：把 2U / 3U 对应哪辆车画出来。
           它补的是第 4 步"选哪个单元"的上下文，也让大屏在宽窗口下不空。 -->
      <div class="mon__form" aria-hidden="true">
        <div class="mon__form-head">
          <span>列车编组</span>
          <span>2U = 04 车 · 3U = 06 车</span>
        </div>
        <div class="mon__cars">
          <span v-for="c in 8" :key="c" :class="{ 'is-unit': c === 4 || c === 6 }">
            <b>{{ String(c).padStart(2, '0') }}</b>
            <em v-if="c === 4">2U</em>
            <em v-else-if="c === 6">3U</em>
          </span>
        </div>
      </div>

      <footer class="mon__foot">
        <span class="mon__foot-text">{{ foot }}</span>
        <span class="mon__meter" aria-hidden="true">
          <i v-for="i in total" :key="i" :class="{ 'is-on': i <= done }" />
        </span>
      </footer>

      <!-- 屏下软键：真车每块屏下面一排 8 个，按页面功能分配。这里只作形制 -->
      <div class="mon__softkeys" aria-hidden="true">
        <span v-for="k in 8" :key="k">F{{ k }}</span>
      </div>
    </div>

    <p class="mon__hint">
      {{
        mode === 'status'
          ? '读到"升起"与 25 kV 即可进入下一步；数值为演示值。'
          : session.keyTurned
            ? '点一行确认一行。实际作业以司机室 MON 实屏为准。'
            : 'MON 未上电：回到上一步插钥匙并右旋到运行位，屏点亮后才能逐项确认。'
      }}
    </p>
  </div>
</template>

<style scoped>
/* MON 屏：按真车 TCMS 屏的形制做——深色玻璃、绿色状态条、表格行、屏下软键。
   尺寸不再"能放几行放几行"：行长 52–96px、字号 14.5/16，离屏两米也读得清。 */
.mon {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  height: 100%;
  min-height: 0;
  gap: 6px;
}

.mon__frame {
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

/* 玻璃反光：很淡的一道，斜着压在整块屏上。没有它，屏像贴纸。 */
.mon__frame::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(122deg, rgb(255 255 255 / 7%) 0%, rgb(255 255 255 / 0%) 44%);
  pointer-events: none;
}

.mon__bar {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 14px 8px;
  background: linear-gradient(#1d6150, #154a3d);
  color: #e7f7ef;
}

.mon__brand {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.1em;
}

.mon__title {
  font-size: 12.5px;
  opacity: 0.82;
}

.mon__stat {
  margin-left: auto;
  padding: 2px 9px;
  border: 1px solid rgb(231 247 239 / 45%);
  border-radius: 999px;
  font-size: 12px;
  white-space: nowrap;
}

/* ---------------- 顶部端号条 ---------------- */
.mon__ribbon {
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

.mon__ribbon span:nth-child(2) {
  margin-left: auto;
}

.mon__clock {
  color: #a9c9bd;
  font-family: var(--font-mono, ui-monospace, monospace);
}

/* ---------------- 页签 ---------------- */
.mon__tabs {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 8px 10px 0;
  border-bottom: 1px solid #1e3a31;
  background: #0d211b;
}

.mon__tab {
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

.mon__tab:hover {
  color: #d8f2e8;
}

.mon__tab.is-on {
  border-color: #2b5a49;
  background: #17402f;
  color: #eafaf3;
  font-weight: 600;
}

/* ---------------- 表头 ---------------- */
.mon__thead {
  flex: none;
  display: grid;
  grid-template-columns: 1fr 96px 124px 26px;
  column-gap: 12px;
  /* 与 `.mon__hit` 同 padding-left/right，列才真正对齐 */
  padding: 6px 6px;
  border-bottom: 1px solid #1a352c;
  background: #0b1d17;
  color: #86a89a;
  font-size: 11px;
  letter-spacing: 0.06em;
}

.mon__thead span:nth-child(2),
.mon__thead span:nth-child(3) {
  text-align: right;
}

.mon__thead span:nth-child(4) {
  text-align: center;
}

/* ---------------- 表体 ---------------- */
.mon__body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: stretch;
  gap: 10px;
}

/* 表头与数据行必须同宽：原来表头横跨整个面板（含右侧状态牌的位置），
   数据行只占左侧，两者的固定列相差 170px 以上，看上去像"表头东倒西歪"。 */
.mon__main {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.mon__rows {
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

/* 行按可用高度均分，但不超过 96px：3 行撑满一屏比"下面空一大块"更像仪表 */
.mon__row {
  flex: 1 1 0;
  min-height: 52px;
  max-height: 96px;
  display: flex;
  border-bottom: 1px solid #14261f;
}

.mon__row:last-child {
  border-bottom: none;
}

.mon__hit {
  width: 100%;
  height: 100%;
  min-height: 52px;
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

.mon__hit:not(.mon__hit--static):hover {
  background: #153026;
}

.mon__hit:not(.mon__hit--static):focus-visible {
  outline: 2px solid #7fd6b4;
  outline-offset: -2px;
}

.mon__hit--static {
  cursor: default;
}

.mon__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mon__req {
  color: #9dbfb2;
  font-size: 12.5px;
  text-align: right;
  white-space: nowrap;
}

.mon__val {
  color: #f2fdf8;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-weight: 700;
  font-size: 16px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}

.mon__tick {
  color: #86a89a;
  font-size: 15px;
  text-align: center;
}

.mon__row.is-done {
  background: linear-gradient(90deg, rgb(47 143 91 / 18%), transparent 70%);
}

.mon__row.is-done .mon__tick {
  color: #7fd6b4;
}

.mon__row.is-done .mon__name {
  color: #eafaf3;
}

/* ---------------- 右侧状态牌 ---------------- */
.mon__side {
  flex: 0 0 216px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px 6px 0;
}

.mon__stat-card {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  padding: 8px 12px;
  border: 1px solid #1e3a31;
  border-radius: 6px;
  background: #0c211a;
}

.mon__stat-card span {
  color: #86a89a;
  font-size: 12px;
}

.mon__stat-card strong {
  color: #eafaf3;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 23px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.mon__stat-card em {
  margin-left: 4px;
  color: #86a89a;
  font-size: 12px;
  font-style: normal;
}

/* ---------------- 列车编组 ---------------- */
.mon__form {
  flex: 1 1 auto;
  min-height: 84px;
  display: flex;
  flex-direction: column;
  padding: 8px 16px 10px;
  border-top: 1px solid #1e3a31;
  background: #0a1a15;
}

.mon__form-head {
  flex: none;
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
  color: #7fa79a;
  font-size: 11.5px;
}

.mon__cars {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.mon__cars span {
  flex: 1 1 0;
  height: 100%;
  max-height: 58px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  border: 1px solid #24503f;
  border-radius: 4px;
  background: #0e2a21;
  color: #8fb3a6;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 13px;
}

.mon__cars span b {
  font-size: 13px;
  font-weight: 600;
}

.mon__cars span em {
  color: #7fd6b4;
  font-size: 10px;
  font-style: normal;
}

.mon__cars span.is-active {
  background: #267a55;
  box-shadow: inset 0 0 0 2px #bff3dc;
}

.mon__cars span.is-unit {
  border-color: #3f8f6d;
  background: #1d5b46;
  box-shadow: inset 0 0 0 1px #7fd6b4;
  color: #eafaf3;
  font-weight: 700;
}

/* ---------------- 页脚 ---------------- */
.mon__foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-top: 1px solid #1e3a31;
  background: #0a1a16;
}

.mon__foot-text {
  flex: 1 1 auto;
  color: #7fd6b4;
  font-size: 12.5px;
}

.mon__meter {
  display: flex;
  gap: 3px;
}

.mon__meter i {
  width: 16px;
  height: 5px;
  border-radius: 2px;
  background: #22403a;
}

.mon__meter i.is-on {
  background: #7fd6b4;
}

/* ---------------- 屏下软键 ---------------- */
.mon__softkeys {
  flex: none;
  display: flex;
  gap: 6px;
  padding: 6px 12px 9px;
  border-top: 1px solid #16291f;
  background: #070f0c;
}

.mon__softkeys span {
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

.mon__hint {
  flex: none;
  width: 100%;
  max-width: 1180px;
  margin: 0;
  color: var(--c-ink-2);
  font-size: 12px;
  line-height: 1.55;
}

.mon--off .mon__frame {
  filter: saturate(0.45) brightness(0.72);
}

/* 短屏：先保行，端号条 / 状态牌 / 编组 / 软键依次让位 */
@media (max-height: 620px) {
  .mon__ribbon,
  .mon__softkeys,
  .mon__form {
    display: none;
  }

  /* 右侧状态牌**不跟着隐藏**：受电弓 / 网压 / VCB 是这一屏的结论。
     1090×614（本人常用窗口）下把它藏掉，等于让人只看表格去猜结果——
     2026-11-13 实测就是这么发现"VCB 明明合了却看不到"的。矮屏只压缩它。 */
  .mon__side {
    flex: 0 0 176px;
    gap: 5px;
    padding: 6px 8px 4px 0;
  }

  .mon__stat-card {
    padding: 5px 9px;
  }

  .mon__stat-card strong {
    font-size: 19px;
  }

  .mon__row {
    max-height: none;
  }

  .mon__hint {
    display: none;
  }
}

/* 窄容器：状态牌挤掉表格，宁可不显示。
   判据用视口宽度——容器宽度随三栏布局变，CSS 读不到；900px 以下视口里
   MON 面板确实撑不住 176px 的侧栏。 */
@media (max-width: 900px) {
  .mon__side {
    display: none;
  }
}
</style>
