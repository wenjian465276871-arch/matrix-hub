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
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

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

onMounted(() => {
  // 翻页回来时可能正停在"升弓中"：接着跑，不要从头再来
  if (Math.abs(session.raiseT - (session.raiseHeld || session.raised ? RAISE_T : 0)) > 1e-6) {
    ensureMoving()
  }
})

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
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

/** 三维里点中某个件：按当前状态派发到同一个动作。 */
function onPart(key: string): void {
  if (key === 'key') act('key')
  else if (key === 'brake') act('brake')
  else if (key === 'switch') act('switch')
  else if (key === 'knob') act('knob')
  else if (key === 'vcb') act('vcb')
  else if (key === 'mon') notice.value = 'MON 屏的逐项确认在第 2 步；这里只显示结果'
  else if (key === 'gauge') {
    notice.value = session.raised ? '网压表：25.1 kV（正常 19–31 kV）' : '网压表：0 kV（受电弓未升起）'
  } else notice.value = '台面/仪表盘：本步不需要操作'
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
  <div class="ops">
    <div class="ops__stage" :class="{ 'ops__stage--solo': view === 'desk' }">
      <figure class="ops__pane">
        <DeviceScene
          subject="driver_desk"
          :t="deskT()"
          :label="'司机操纵台三维示意，可拖动旋转；点钥匙、制动手柄、切换开关、升弓旋钮、VCB 按钮进行操作'"
          pick
          @part-click="onPart"
        />
        <figcaption class="ops__cap">
          司机操纵台<span class="ops__cap-tip">点台面上的件即可操作</span>
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
    </div>

    <div class="ops__hud">
      <p class="ops__next">{{ next }}</p>
      <p class="ops__line">
        <span class="ops__chip">{{ stage }}</span>
        <span class="ops__kv">单元 {{ unitText }}</span>
        <span class="ops__kv">网压 {{ volts }}</span>
      </p>
      <p v-if="notice" class="ops__notice" role="status">{{ notice }}</p>
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
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: 8px;
}

.ops__stage {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: 1.15fr 0.85fr;
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

.ops__notice {
  margin: 0;
  color: var(--c-ink);
  font-size: 12px;
  line-height: 1.5;
  padding: 4px 8px;
  border-left: 2px solid var(--c-primary-line);
  background: var(--c-primary-soft);
}

.ops__acts {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ops__btn {
  flex: 1 1 auto;
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
  flex: 0 0 auto;
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

@media (max-height: 560px) {
  .ops__note {
    display: none;
  }

  .ops__btn {
    min-height: 32px;
  }
}
</style>
