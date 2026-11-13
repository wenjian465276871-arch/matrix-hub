<script setup lang="ts">
/** operation_scene：升弓操作台。左边司机操纵台、右边车顶受电弓，点一下、动一下。
 *
 *  ## 为什么是两块画布而不是一块
 *  司机台在车内、受电弓在车顶，物理上不同框。合成一个场景只能做成"博物馆展台"，
 *  看着假。两块画布各用各的机位，中间靠会话状态联动——这才像"我在这头按，
 *  那头真的动了"。
 *
 *  ## 交互入口有三套，走同一套判断
 *  1. 直接在三维里点件（`pick` + `part-click`）；
 *  2. 下面一排大按钮（触摸屏与键盘用，最小 44px）；
 *  3. 三维画布对读屏不可用，所以状态与下一步提示必须有文字。
 *  三者都调用 `panto-session`，不存在"按钮能升、点模型不能升"这种分歧。
 *
 *  ## 升弓动画
  `stepRaise(dt)` 由 rAF 喂时间增量；组件只负责"什么时候继续跑"。
 *  离开页面时动画随卸载停止，但 `raiseT` 留在会话里，翻回来接着走——
 *  否则第 5 步升起的弓，第 6 步又躺回去了。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type { ParamValue } from '../../types'
import DeviceScene from '../DeviceScene.vue'
import {
  RAISE_T,
  closeVcb,
  deskT,
  holdRaise,
  insertKey,
  moveBrakeFast,
  nextAction,
  releaseRaise,
  reset,
  selectUnit,
  session,
  stageText,
  stepRaise,
  turnKey,
} from '../../lib/panto-session'

const props = defineProps<{
  params: Record<string, ParamValue>
  label?: string
}>()

/** `desk` 只看操纵台（第 3、4 步）；`both` 加车顶受电弓（第 5、6 步）。 */
const view = computed(() => (props.params.view === 'desk' ? 'desk' : 'both'))

const notice = ref('')
/** 全屏操作：探索台/阅读器给的舞台高度有限（1090×614 下操作区只剩 65px），
 *  靠 CSS 挤不出能点中钥匙的高度——给一个铺满视口的模式。 */
const expanded = ref(false)

/* ---------------- rAF：只在"还在动"时跑 ----------------
   常驻循环会让平板白耗电；停下来就彻底停。 */
let raf = 0
let last = 0

function tick(now: number): void {
  if (!last) last = now
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  const moving = stepRaise(dt)
  raf = moving ? requestAnimationFrame(tick) : 0
}

function ensureMoving(): void {
  if (!raf) {
    last = 0
    raf = requestAnimationFrame(tick)
  }
}

/* 回执 6 秒后自动收起：它盖在图注上方，常驻会把"这张图是什么"压住。 */
let noticeTimer = 0
watch(notice, (value) => {
  window.clearTimeout(noticeTimer)
  if (!value) return
  noticeTimer = window.setTimeout(() => {
    notice.value = ''
  }, 6000)
})

function toggleExpand(): void {
  expanded.value = !expanded.value
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && expanded.value) expanded.value = false
}

onMounted(() => {
  // 翻页回来时可能正停在"升弓中"：接着跑，不要从头再来
  if (Math.abs(session.raiseT - (session.raiseHeld || session.raised ? RAISE_T : 0)) > 1e-6) {
    ensureMoving()
  }
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  window.clearTimeout(noticeTimer)
  window.removeEventListener('keydown', onKey)
})

/* ---------------- 动作入口 ---------------- */

type Act = 'key' | 'brake' | 'switch' | 'knob' | 'vcb'

function run(result: { ok: boolean; hint: string }): void {
  notice.value = result.hint
}

function act(kind: Act): void {
  if (kind === 'key') {
    if (!session.keyInserted) run(insertKey())
    else if (!session.keyTurned) run(turnKey())
    else notice.value = '钥匙已在运行位'
    return
  }
  if (kind === 'brake') {
    run(moveBrakeFast())
    return
  }
  if (kind === 'switch') {
    // 再点一次换单元；已升起时状态机会拒绝
    run(selectUnit(session.unit === '2U' ? '3U' : '2U'))
    return
  }
  if (kind === 'knob') {
    if (session.raiseHeld) run(releaseRaise())
    else {
      run(holdRaise())
      if (session.raiseHeld) ensureMoving()
    }
    return
  }
  run(closeVcb())
}

const PART_NAME: Record<string, string> = {
  key: '主控钥匙',
  brake: '制动手柄',
  switch: '受电弓切换开关',
  knob: '升弓旋钮',
  vcb: 'VCB 按钮',
  mon: 'MON 屏',
  gauge: '网压表',
  desk: '台面',
}

/** 三维里点中某个件：按当前状态派发到同一个动作，并把"点到了什么"说出来。
 *  没有这句回执，点在背景上与被忽略无法区分——用户会直接判"功能没做"。 */
function onPart(key: string): void {
  const name = PART_NAME[key] ?? key
  if (key === 'key') act('key')
  else if (key === 'brake') act('brake')
  else if (key === 'switch') act('switch')
  else if (key === 'knob') act('knob')
  else if (key === 'vcb') act('vcb')
  else if (key === 'mon') notice.value = 'MON 屏的逐项确认在第 2 步；这里只显示结果'
  else if (key === 'gauge') {
    notice.value = session.raised ? '网压表：25.1 kV（正常 19–31 kV）' : '网压表：0 kV（受电弓未升起）'
  } else {
    notice.value = '点在台体上了：可点的件是钥匙 / 制动手柄 / 切换开关 / 升弓旋钮 / VCB'
  }
  if (key !== 'desk') {
    notice.value = `已点「${name}」${notice.value ? '：' + notice.value : ''}`
  }
}

/* ---------------- 显示 ---------------- */

const stage = computed(() => stageText())
const next = computed(() => nextAction())
const unitText = computed(() => session.unit ?? '未选择')
const volts = computed(() => (session.raised ? '25.1 kV' : '0 kV'))

/** 按钮文案跟着状态走：同一个键在不同阶段做的是不同动作，标签必须说出来。 */
const acts = computed<Array<{ id: Act; label: string }>>(() => [
  {
    id: 'key',
    label: session.keyTurned ? '钥匙已右旋' : session.keyInserted ? '钥匙 右旋' : '钥匙 插入',
  },
  { id: 'brake', label: session.brakeFast ? '手柄已在快速位' : '手柄 推快速位' },
  {
    id: 'switch',
    label: session.unit ? `已选 ${session.unit}（点击切换）` : '选弓 2U / 3U',
  },
  {
    id: 'knob',
    label: session.raiseHeld ? '松开旋钮' : session.raised ? '已升起、保压' : '按住升弓旋钮',
  },
  { id: 'vcb', label: session.vcbClosed ? 'VCB 已闭合' : 'VCB 合' },
])

function restart(): void {
  reset()
  notice.value = '已复位到落弓状态'
}

</script>

<template>
  <div class="ops" :class="{ 'ops--expanded': expanded }">
    <!-- 浮在画布左上：不占高度，又能第一眼看见。短屏下这是"看清"的唯一入口。 -->
    <button class="ops__float" type="button" @click="toggleExpand">
      {{ expanded ? '退出全屏' : '放大操作' }}
    </button>

    <div class="ops__stage" :class="{ 'ops__stage--solo': view === 'desk' }">
      <figure class="ops__pane">
        <DeviceScene
          subject="driver_desk"
          :t="deskT()"
          :unit="session.unit ?? '2U'"
          :label="'司机操纵台三维示意，可拖动旋转；点钥匙、制动手柄、切换开关、升弓旋钮、VCB 按钮进行操作'"
          pick
          @part-click="onPart"
        />
        <figcaption class="ops__cap">
          司机操纵台<span class="ops__cap-tip">移到件上高亮，点一下就操作</span>
        </figcaption>
      </figure>

      <figure v-if="view !== 'desk'" class="ops__pane">
        <DeviceScene
          subject="pantograph"
          :t="session.raiseT"
          :label="`车顶受电弓三维示意，当前${session.raised ? '已升起并保压' : session.raiseHeld ? '正在升起' : '落弓锁定'}`"
        />
        <figcaption class="ops__cap">
          车顶受电弓<span class="ops__cap-tip">{{ session.raised ? '升起保压' : session.raiseHeld ? '升弓中' : '落弓' }}</span>
        </figcaption>
      </figure>

      <p v-if="notice" class="ops__toast" role="status">{{ notice }}</p>
    </div>

    <div class="ops__hud">
      <p class="ops__next">{{ next }}</p>
      <p class="ops__line">
        <span class="ops__chip">{{ stage }}</span>
        <span class="ops__kv">单元 {{ unitText }}</span>
        <span class="ops__kv">网压 {{ volts }}</span>
      </p>
    </div>

    <div class="ops__acts">
      <button
        v-for="a in acts"
        :key="a.id"
        class="ops__btn"
        :class="{ 'is-on': a.id === 'knob' && session.raiseHeld }"
        type="button"
        @click="act(a.id)"
      >
        {{ a.label }}
      </button>
      <button class="ops__btn ops__btn--reset" type="button" @click="restart">重新开始</button>
    </div>

    <p class="ops__note">
      结构示意，参数为演示虚构值；点三维里的件与点下面的按钮等价。
    </p>
  </div>
</template>

<style scoped>
.ops {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  gap: 8px;
}

.ops__float {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 3;
  min-height: 30px;
  padding: 0 10px;
  border: 1px solid var(--c-primary-line);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-primary-ink);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 1px 4px rgb(0 0 0 / 18%);
}

/* 全屏操作：舞台高度不够时唯一靠谱的放大方式。
   走 fixed 而不是重挂载，状态（会话）在 store 里，画面不重建。 */
.ops--expanded {
  position: fixed;
  inset: 0;
  z-index: 90;
  padding: 12px 14px;
  background: var(--c-surface);
}

.ops__stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  /* 操纵台是"手在动"的那一侧，给它更多宽度；受电弓是结果，可略窄 */
  grid-template-columns: 1.25fr 0.75fr;
  gap: 8px;
}

.ops__stage--solo {
  grid-template-columns: 1fr;
}

.ops__pane {
  margin: 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 画布吃满格子：DeviceScene 自带的 3:2 在这里会把下方按钮顶出卡外 */
.ops__pane :deep(.scene) {
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
  aspect-ratio: auto;
}

.ops__cap {
  flex: 0 0 auto;
  display: flex;
  align-items: baseline;
  gap: 8px;
  color: var(--c-ink-2);
  font-size: 12px;
}

.ops__cap-tip {
  color: var(--c-primary-ink);
}

.ops__hud {
  flex: 0 0 auto;
  display: grid;
  gap: 4px;
  /* 固定高度：回执改成画布内浮层后，这里只留"下一步 + 状态"两行。
     2026-11-13 本人截图：点一次按钮 HUD 多一行，画布从 65px 缩到 20px。 */
  min-height: 44px;
  align-content: start;
}

.ops__next {
  margin: 0;
  color: var(--c-ink);
  font-size: 13px;
  font-weight: 600;
}

.ops__line {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--c-ink-2);
  font-size: 12px;
}

.ops__chip {
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--c-primary-line);
  background: var(--c-primary-soft);
  color: var(--c-primary-ink);
}

.ops__kv {
  font-variant-numeric: tabular-nums;
}

.ops__toast {
  position: absolute;
  left: 8px;
  right: 8px;
  /* 抬高 30px：下面还有一行图注（"司机操纵台 · 移上去高亮"），
     浮层压住它就等于把"这是什么"盖掉一半。 */
  bottom: 30px;
  z-index: 2;
  margin: 0;
  padding: 5px 10px;
  border-left: 3px solid var(--c-primary-line);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--c-surface) 92%, transparent);
  color: var(--c-ink);
  font-size: 12px;
  line-height: 1.45;
  box-shadow: 0 1px 6px rgb(0 0 0 / 18%);
}

.ops__acts {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: thin;
}

.ops__btn {
  flex: 0 0 auto;
  min-height: 36px;
  padding: 0 10px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.ops__btn.is-on {
  border-color: var(--c-primary-line);
  background: var(--c-primary-soft);
  color: var(--c-primary-ink);
  font-weight: 600;
}

.ops__btn--reset {
  color: var(--c-ink-2);
}



.ops__note {
  margin: 0;
  color: var(--c-ink-2);
  font-size: 11px;
  line-height: 1.5;
}

/* 触摸屏：按钮做大，最少 44px；窄窗口把说明收掉腾高度 */
@media (max-width: 900px) {
  .ops__stage {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr;
  }

  .ops__btn {
    min-height: 44px;
  }
}

@media (max-height: 820px) {
  .ops__note {
    display: none;
  }
}

@media (max-height: 560px) {

  .ops__btn {
    min-height: 32px;
  }
}
</style>
