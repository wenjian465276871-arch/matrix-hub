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
import { MON_ITEMS, monDone, session, type MonKey } from '../../lib/panto-session'

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
      { key: 'vcb', ...pick('vcb') },
      // 这一行的"要求"与"显示"不能都写"未切除"：两列同字，看着像重复渲染。
      { key: 'panto_cut', label: '受电弓远程切除', required: '应未切除', value: '均未切除' },
    ]
  }
  // 远程控制切除页：先看"切没切"，再看"升没升"。
  // 原来把"升起"塞进切除行，出现"未切除 升起"这种两种语义挤在一行的读法。
  const unit = session.unit ?? '2U'
  const other = unit === '2U' ? '3U' : '2U'
  return [
    { label: `${unit} 受电弓切除`, required: '应未切除', value: '未切除' },
    { label: `${other} 受电弓切除`, required: '应未切除', value: '未切除' },
    { label: '受电弓状态', required: '应升起', value: session.raised ? '升起' : '未升起' },
    { label: 'VCB', required: '应断开', value: session.vcbClosed ? '闭合' : '断开' },
  ]
})

function pick(key: MonKey): { label: string; required: string; value: string } {
  const item = MON_ITEMS.find((i) => i.key === key)!
  return { label: item.label, required: item.required, value: item.value }
}

function isDone(key?: MonKey): boolean {
  return key ? session.mon[key] : false
}

function toggle(key?: MonKey): void {
  if (mode.value !== 'check' || !key) return
  session.mon[key] = true
  session.notice = 'MON 已确认一项'
}

const done = computed(() => monDone())
const total = MON_ITEMS.length

const foot = computed(() => {
  if (mode.value === 'status') {
    return session.raised ? `受电弓升起 · 网压 ${session.raised ? '25.1 kV' : '0 kV'}` : '受电弓未升起'
  }
  if (done.value >= total) return '五项已确认 · 允许发出升弓指令'
  return `已确认 ${done.value}/${total} · 五项全部确认后才允许升弓`
})

/** 屏幕是否"有电"：钥匙右旋后点亮。第 2 步是上电后画面，所以恒亮，但要说明。 */
const powered = computed(() => session.keyTurned || mode.value === 'check')

/** 第 2 步（check）还没插钥匙，写"未上电"会与"屏亮着、能点"自相矛盾。
 *  这里如实说明它是"上电后画面"，不是当前实时状态。 */
const stat = computed(() => {
  if (session.keyTurned) return '司机室占用'
  return mode.value === 'check' ? '画面示意' : '未上电'
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

      <footer class="mon__foot">
        <span class="mon__foot-text">{{ foot }}</span>
        <span class="mon__meter" aria-hidden="true">
          <i v-for="i in total" :key="i" :class="{ 'is-on': i <= done }" />
        </span>
      </footer>
    </div>

    <p class="mon__hint">
      {{
        mode === 'status'
          ? '读到"升起"与 25 kV 即可进入下一步；数值为演示值。'
          : '画面为上电后状态，用于逐项核对：点一行确认一行。实际作业以司机室 MON 实屏为准。'
      }}
    </p>
  </div>
</template>

<style scoped>
.mon {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: 8px;
}

.mon__frame {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid #0b1512;
  border-radius: 8px;
  /* 设备屏的底色不跟主题走：MON 本身就是深色液晶，浅色主题下也不该变成白底 */
  background: #0b1512;
  box-shadow: inset 0 0 0 3px #20272b;
  overflow: hidden;
}

.mon--off .mon__frame {
  filter: saturate(0.4) brightness(0.75);
}

.mon__bar {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 8px 12px;
  background: #1d5b4c;
  color: #e7f7ef;
}

.mon__brand {
  font-weight: 700;
  letter-spacing: 0.08em;
  font-size: 14px;
}

.mon__title {
  font-size: 12px;
  opacity: 0.85;
}

.mon__stat {
  margin-left: auto;
  font-size: 12px;
  padding: 1px 8px;
  border: 1px solid rgba(231, 247, 239, 0.45);
  border-radius: 999px;
}

.mon__tabs {
  display: flex;
  gap: 2px;
  padding: 6px 8px 0;
  background: #0f1f1a;
  border-bottom: 1px solid #1e3a31;
}

.mon__tab {
  flex: 1 1 0;
  min-height: 30px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  background: transparent;
  color: #7fa79a;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.mon__tab.is-on {
  background: #143027;
  border-color: #2b5a49;
  color: #d8f2e8;
  font-weight: 600;
}

.mon__rows {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: 4px 6px;
  list-style: none;
  overflow-y: auto;
}

.mon__row {
  border-bottom: 1px solid #14261f;
}

.mon__row:last-child {
  border-bottom: none;
}

.mon__hit {
  width: 100%;
  min-height: 42px;
  display: grid;
  /* 四列固定宽度：要求与显示右对齐，读起来是"应… / 实际…"两栏，
     不再是两串字挤在一起。 */
  grid-template-columns: 1fr 84px 104px 20px;
  column-gap: 10px;
  align-items: center;
  padding: 6px 6px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #b9d5c9;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.mon__hit:not(.mon__hit--static):hover {
  background: #12281f;
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
  color: #6f9184;
  font-size: 12px;
  text-align: right;
  white-space: nowrap;
}

.mon__val {
  color: #eafaf3;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-weight: 700;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}

.mon__tick {
  text-align: center;
  color: #6f9184;
  font-size: 14px;
}

.mon__row.is-done .mon__tick {
  color: #7fd6b4;
}

.mon__row.is-done .mon__name {
  color: #eafaf3;
}

.mon__foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: #0a1a16;
  border-top: 1px solid #1e3a31;
}

.mon__foot-text {
  flex: 1 1 auto;
  color: #7fd6b4;
  font-size: 12px;
}

.mon__meter {
  display: flex;
  gap: 3px;
}

.mon__meter i {
  width: 14px;
  height: 4px;
  border-radius: 2px;
  background: #22403a;
}

.mon__meter i.is-on {
  background: #7fd6b4;
}

.mon__hint {
  margin: 0;
  color: var(--c-ink-2);
  font-size: 12px;
  line-height: 1.6;
}

@media (max-height: 560px) {
  .mon__hit {
    min-height: 36px;
  }

  .mon__hint {
    display: none;
  }
}
</style>
