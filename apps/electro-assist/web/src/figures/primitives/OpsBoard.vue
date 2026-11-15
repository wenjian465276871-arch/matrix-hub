<script setup lang="ts">
/** operation_scene（空调制冷 / 开关门）：司机台与设备双画布。
 *
 *  ## 2026-11-14 本人定下的三条交互铁律（这一版就是按它重写的）
 *  1. **底部只放状态，不放动作**。一排状态灯回答"这一步做了没有"，它不接受点击
 *     ——动作只能来自三维里的件或 MON 屏上的按钮。
 *     （上一版把"起动通风/起动制冷/放试块/跑到位"做成了按钮，全错。）
 *  2. **一页只做本页主工步的事**。`act` 参数声明本步允许哪一组操作，
 *     越界的件点了会被拒绝并说明"本步只做…"。
 *  3. **本步做完就给下一步的出口**：HUD 出现「本步完成，进入下一步」，
 *     点了直接翻页（`guide-next` 钩子由阅读器/探索台提供）。
 *
 *  ## 动作都在哪
 *  | 动作 | 入口 |
 *  |---|---|
 *  | 插钥匙 / 右旋 / 手柄快速位 | 三维里的钥匙与制动手柄 |
 *  | 空调模式与温度、下发（= 起机） | MON 弹窗（点三维 MON 屏打开） |
 *  | 释放 / 开门 / 关门 | 三维台面上的六个门控按钮 |
 *  | 放试块 / 撤试块 | 三维里的试块本身（门外侧地面 ↔ 门洞地板） |
 *
 *  ## 动画为什么由外部驱动
 *  `stepCooling(dt)` / `stepDoor(dt)` 都是"给时间增量、返回还动不动"的纯推进。
 *  CI 的软件渲染只有 1–2 fps，单帧 dt 上限 1 秒——**动作时长是物理量，
 *  不该由渲染帧率决定**（升弓那次 4.6s 被拉成 46s 的坑）。
 */
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { splitLabel } from '../tooltip'

import type { ParamValue } from '../../types'
import DeviceScene from '../DeviceScene.vue'
import MonPanel from './MonPanel.vue'
import {
  deskT as powerDeskT,
  insertKey,
  moveBrakeFast,
  nextPowerAction,
  power,
  resetPower,
  turnKey,
} from '../../lib/desk-power'
import {
  confirmMissing,
  hvac,
  reset as resetHvac,
  compressorCurrent,
  supplyTemp,
  stageText as hvacStage,
  stepCooling,
  unitT,
} from '../../lib/hvac-session'
import {
  close as doorClose,
  door,
  open as doorOpen,
  release as doorRelease,
  reset as resetDoor,
  selectSide,
  stageText as doorStage,
  stepDoor,
  toggleBlock,
} from '../../lib/door-session'
import { OPS_ALLOWED, allowList, warnOnce } from '../../lib/ops-allowed'
import { opsChips, opsNext, opsStepDone } from '../../lib/ops-derive'

const props = defineProps<{
  params: Record<string, ParamValue>
  label?: string
}>()

/* 本步允许哪一组操作。样例不带 `act` 时按 `all`（旧样例兼容口径）；
   带了但**认不得**则一律拒绝——见 `allowed()` 与 `lib/ops-allowed.ts`。 */
const phase = computed(() => String(props.params.act ?? 'all'))
const scene = computed(() => (props.params.scene === 'door_switch' ? 'door' : 'hvac'))
/**
 * 舞台布局：`desk` 只看操纵台 · `both` 操纵台 + 设备 · `mon` **MON 屏** + 设备。
 *
 * `mon` 是 2026-11-14 本人要求的：以 MON 操作为主的步骤（通风确认、切制冷、结论），
 * 操纵台在画面上没有任何用——占一栏反而把屏挤小。屏才是那几步的作业面。
 */
const view = computed<'desk' | 'both' | 'mon'>(() => {
  const raw = props.params.view
  if (raw === 'mon') return 'mon'
  if (raw === 'both') return 'both'
  if (raw === 'desk') return 'desk'
  // 未知值同样不静默（评审 R23-1）：退回 desk 但告警一次，别让"本步该显示 MON"
  // 变成一句看着正常、实则丢了一整栏的话。
  warnOnce(
    `view:${String(raw)}`,
    `[OpsBoard] 未知的 view「${String(raw)}」：按 desk 渲染。口径见契约 scenes[].ops_views。`,
  )
  return 'desk'
})

/** 下一步的出口：由阅读器 / 探索台 provide；单测里没有就退化成提示。 */
const gotoNext = inject<(() => boolean) | null>('guide-next', null)
/** 重新开始 = 状态复位 + 回到第一工步（2026-11-14 本人要求）。 */
const gotoFirst = inject<(() => boolean) | null>('guide-first', null)
/** 还有没有下一工步。最后一页要藏掉出口——点了没反应的按钮比没有更差。 */
const canNext = inject<{ value: boolean } | null>('guide-can-next', null)

const monZoom = ref(false)
/** 空调场景：在 `both` 布局里点 MON 屏后，**左侧那一栏**换成 MON 屏（不弹窗）。 */
const monPane = ref(false)
const expanded = ref(false)
const notice = ref('')
const shotDesk = ref('')
const shotUnit = ref('')

/* ---------------- rAF ---------------- */

let raf = 0
let last = 0
/** 单帧最多吃 1 秒：低帧率下仍按真实时间走，避免"切走标签页回来一帧跳完"。 */
const MAX_DT = 1.0

function tick(now: number): void {
  if (!last) last = now
  const dt = Math.min(MAX_DT, (now - last) / 1000)
  last = now
  const moving = scene.value === 'door' ? stepDoor(dt) : stepCooling(dt)
  raf = moving ? requestAnimationFrame(tick) : 0
}

function ensureMoving(): void {
  if (!raf) {
    last = 0
    raf = requestAnimationFrame(tick)
  }
}

function toggleExpand(): void {
  expanded.value = !expanded.value
}

function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (monZoom.value) {
    monZoom.value = false
    return
  }
  if (expanded.value) expanded.value = false
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  // E2E 读的探针：等状态，不等时间（CI 只有 1–2 fps）
  ;(window as unknown as { __ops?: () => Record<string, unknown> }).__ops = () => ({
    scene: scene.value,
    phase: phase.value,
    power: power.keyTurned && power.brakeFast,
    hvac: { mode: hvac.mode, temp: hvac.setTemp, cooling: hvac.cooling, coolT: hvac.coolT },
    door: {
      openT: door.openT,
      released: door.released,
      bumps: door.bumps,
      fault: door.fault,
      closedLed: door.closedLed,
      pinching: door.pinching,
      target: door.target,
    },
    block: door.blocked,
  })
})

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  delete (window as unknown as { __ops?: () => Record<string, unknown> }).__ops
  window.clearTimeout(noticeTimer)
  window.removeEventListener('keydown', onKey)
})

/* 制冷一旦起来就自己跑起来：起机是在 MON 弹窗里点的，弹窗关掉之后
   这个组件不会收到任何"点击"，不主动拉 rAF 的话读数永远停在 0（E2E 里就是 0）。 */
watch(
  () => hvac.cooling,
  (on) => {
    if (on) ensureMoving()
  },
)

/* 换一步（view / act 变了）就回到本步的初始布局：上一步点开的 MON 不该跟过来 */
watch(
  () => [props.params.view, props.params.act],
  () => {
    monPane.value = false
  },
)

/* 回执 6 秒后自动收起 */
let noticeTimer = 0
watch(notice, (value) => {
  window.clearTimeout(noticeTimer)
  if (!value) return
  noticeTimer = window.setTimeout(() => {
    notice.value = ''
  }, 6000)
})

/* ---------------- 本步允许做什么 ---------------- */

/* 表在 `lib/ops-allowed.ts`：它是**唯一口径**，并与后端契约里的 `ops_acts` 机检对齐。
   这里只负责"按当前场景取表、取不到就拒绝"。 */
function allowed(key: string): boolean {
  const list = allowList(OPS_ALLOWED[scene.value], phase.value)
  if (!list) {
    // fail-closed（评审 R23-1）：未知 act 一律拒绝，并告警一次。
    // 原来这里写 `?? table.all`，等于"配置错了就全放开"。
    warnOnce(
      `ops:${scene.value}:${phase.value}`,
      `[OpsBoard] 未知的 act「${phase.value}」（场景 ${scene.value}）：本步所有件一律拒绝。` +
        '按步裁剪表见 src/lib/ops-allowed.ts，口径以契约 scenes[].ops_acts 为准。',
    )
    return false
  }
  return list.includes(key)
}

/** 越界点击时告诉人"本步做什么"，而不是静默无视。 */
function outOfScope(name: string): void {
  const what =
    scene.value === 'door'
      ? ({
          power: '插钥匙 / 钥匙右旋 / 手柄快速位',
          check: '在 MON 上确认门状态',
          operate: '释放与开门',
          pinch: '放试块与关门',
          close: '关门与释放复位',
        }[phase.value] ?? '本步操作')
      : ({
          power: '插钥匙 / 钥匙右旋 / 手柄快速位',
          set: '在 MON 上设定并下发',
          vent: '看读数（本步不动控制）',
          cool: '在 MON 上切制冷并确认',
          done: '看结论',
        }[phase.value] ?? '本步操作')
  notice.value = `本步只做「${what}」：${name} 不在本步范围内，请按提示进入对应步骤`
}

/* ---------------- 动作入口（全部来自三维 / MON） ---------------- */

const PART_NAME: Record<string, string> = {
  key: '主控钥匙',
  brake: '制动手柄',
  mon: 'MON 屏',
  desk: '台面',
  block: '防夹试块',
  door_l_release: '左侧释放按钮',
  door_l_open: '左侧开门按钮',
  door_l_close: '左侧关门按钮',
  door_r_release: '右侧释放按钮',
  door_r_open: '右侧开门按钮',
  door_r_close: '右侧关门按钮',
}

function onDeskPart(key: string, label = ''): void {
  const name = (label ? splitLabel(label).name : '') || PART_NAME[key] || key
  if (key === 'desk') {
    notice.value = '点在台体上了：可点的件是主控钥匙 / 制动手柄 / 门控按钮 / MON 屏'
    return
  }
  if (!allowed(key)) {
    outOfScope(name)
    return
  }
  if (key === 'mon') {
    openMon()
    return
  }
  let result: { ok: boolean; hint: string } | null = null
  if (key === 'key') result = power.keyInserted ? turnKey() : insertKey()
  else if (key === 'brake') result = moveBrakeFast()
  else if (key.startsWith('door_')) {
    const side = key.startsWith('door_l') ? 'L' : 'R'
    if (door.side !== side) {
      const picked = selectSide(side)
      if (!picked.ok) {
        notice.value = picked.hint
        return
      }
    }
    if (key.endsWith('_release')) result = doorRelease()
    else if (key.endsWith('_open')) {
      result = doorOpen()
      if (door.target === 1) ensureMoving()
    } else {
      result = doorClose()
      ensureMoving()
    }
  }
  if (result) notice.value = result.hint ? `已点「${name}」：${result.hint}` : `已点「${name}」`
}

/** 点右侧三维里的件（目前只有试块）。 */
function onUnitPart(key: string, label = ''): void {
  if (key !== 'block') return
  const name = (label ? splitLabel(label).name : '') || PART_NAME[key] || key
  if (!allowed('block')) {
    outOfScope(name)
    return
  }
  notice.value = toggleBlock().hint
}

/**
 * 点 MON 屏 → 弹窗。MON 任何时候都能看；**能改什么由本步决定**
 * （`phase` 传给面板，面板据此只放开本步的那几个按钮）。
 */
function openMon(): void {
  if (!power.keyTurned || !power.brakeFast) {
    notice.value = nextPowerAction() || 'MON 未上电'
    return
  }
  if (scene.value === 'hvac') {
    // 空调：点屏 = 把左侧换成屏（不遮住右侧机组——本步要一边设一边看风机）
    monPane.value = true
    return
  }
  monZoom.value = true
}

/** 左侧这一栏现在显示什么：MON 屏还是司机台。 */
const leftIsMon = computed(() => view.value === 'mon' || (view.value === 'both' && monPane.value))

/**
 * 重新开始 = **回到第一工步 + 状态复位**。
 *
 * 只复位状态不够：人还在第 5 步，看到的是"门开着、块还在门洞"，却已经什么都没做——
 * 分不清"复位了"还是"页面坏了"（2026-11-14 本人要求从任何页回到第一工步）。
 */
function restart(): void {
  resetPower()
  if (scene.value === 'door') resetDoor()
  else resetHvac()
  const jumped = gotoFirst?.() ?? false
  notice.value = jumped ? '已回到第一工步，状态复位' : '已在第一工步：状态已复位'
}

/* ---------------- 显示 ---------------- */

/* 三段派生（状态灯 / 本步提示 / 完成判据）搬到 `lib/ops-derive.ts`（评审 R23-7）。
   它们只读会话状态、不碰 DOM，搬出去之后可以单测，组件也回到"画界面"这一件事。 */
const chips = computed(() => opsChips(scene.value, phase.value))

const stage = computed(() => (scene.value === 'door' ? doorStage() : hvacStage()))

const next = computed(() => opsNext(scene.value, phase.value))

const stepDone = computed(() => opsStepDone(scene.value, phase.value))

/** 本步做完**且后面还有工步**时才给出口。 */
const showGo = computed(() => stepDone.value && (canNext ? canNext.value : true))

/** 已经是最后一工步（没有下一步可走）。末步只写"本步已完成"，人会以为还有下一页。 */
const isLastStep = computed(() => !(canNext ? canNext.value : true))

function goNext(): void {
  const jumped = gotoNext?.() ?? false
  notice.value = jumped ? '已进入下一步' : '请点右上角「下一步」进入下一工序'
}

/* ---------------- MON 弹窗 ---------------- */

/** 弹窗默认停在哪一页：按"此刻最该做的那件事"挑。 */
const monTab = computed(() => {
  if (scene.value === 'door') {
    if (door.fault) return 'fault'
    if (phase.value === 'check') return 'status'
    if (door.openT > 0.001) return 'control'
    return 'status'
  }
  // 设定步一直停在设定页：下发完也不跳走——用户要在这一页看着"已下发：通风"，
  // 同时从右侧看到风机由静止转为运转（2026-11-14 本人要的正是这个对照）。
  if (phase.value === 'set') return 'set'
  // 还没下发，或本步就是"切制冷"而当前还是通风 → 都停在设定页
  if (!hvac.applied || (phase.value === 'cool' && hvac.mode !== 'cool')) return 'set'
  // 通风 / 切制冷这两步都要在「机组状态」页逐项确认
  if (phase.value === 'vent' || phase.value === 'cool') return 'unit'
  if (confirmMissing().length) return 'unit'
  return 'cabin'
})

/** 嵌在左栏时带 `compact`：那一栏只有 ~300px 高，完整版会挤成一团。 */
const monPaneParams = computed<Record<string, ParamValue>>(() => ({ ...monParams.value, compact: '1' }))

const monParams = computed<Record<string, ParamValue>>(() =>
  scene.value === 'door'
    ? { scene: 'door_switch', tab: monTab.value, mode: 'check', phase: phase.value }
    : { scene: 'hvac_cooling', tab: monTab.value, mode: 'check', phase: phase.value },
)

/** 右侧设备帧：空调按制冷进程，车门按开度。 */
const unitFrame = computed(() => (scene.value === 'door' ? door.openT : unitT()))

const doorAux = computed(() => `door|block=${door.blocked ? 1 : 0}`)

const deskAux = computed(() => {
  const on = power.keyTurned && power.brakeFast ? 1 : 0
  return scene.value === 'door'
    ? `door|side=${door.side}|released=${door.released ? 1 : 0}|open=${door.openT > 0.001 ? 1 : 0}|on=${on}`
    : `hvac|mode=${hvac.mode};temp=${hvac.setTemp};fresh=${hvac.freshAir};on=${on}`
})

const unitCaption = computed(() =>
  scene.value === 'door' ? `客室侧门 · ${doorStage()}` : `客室空调机组 · ${hvacStage()}`,
)

/** 机组徽标：通风 / 制冷 / 停机的差别要一眼看出来（本人 2026-11-14：「切换模式后看不出变化」）。 */
const unitBadge = computed(() => {
  if (hvac.cooling) {
    return `制冷运行 · 送风 ${supplyTemp().toFixed(1)} ℃ · 压缩机 ${compressorCurrent().toFixed(1)} A`
  }
  if (hvac.ventRunning) return '通风运行 · 压缩机未起动'
  return hvac.applied ? `已下发 ${hvac.mode === 'cool' ? '制冷' : '通风'} · 未起动` : '机组未起动'
})
</script>

<template>
  <div class="ops" :class="{ 'ops--expanded': expanded }">
    <button class="ops__float no-print" type="button" @click="toggleExpand">
      {{ expanded ? '退出全屏' : '放大操作' }}
    </button>

    <div class="ops__stage" :class="{ 'ops__stage--solo': view === 'desk' }">
      <!-- 2026-11-14 本人裁决（决策 #62）：本演示**只保证鼠标路径**。
           限制写在这里（读屏可读、不上屏）——键盘用户 Tab 进来先听到这句，
           就不会以为是页面坏了。MON 屏那条路仍是 DOM，键盘可用。 -->
      <p class="sr-only">
        本演示的三维操作仅支持鼠标点击：主控钥匙、制动手柄、门控按钮与防夹试块都要用鼠标点选，键盘无法操作；
        MON 屏的设定与逐项确认用键盘可以完成。
      </p>
      <!-- 左栏：以 MON 为主的步骤（`view=mon`）或点了屏之后（`both` + 点屏）换成屏；
           操纵台在这些步骤里没有可点的东西，占一栏只会把屏挤小。 -->
      <figure v-if="leftIsMon" class="ops__pane ops__pane--mon">
        <header class="ops__mon-head">
          <span>MON 车辆信息显示屏</span>
          <button
            v-if="view === 'both'"
            class="ops__mon-back no-print"
            type="button"
            @click="monPane = false"
          >
            返回司机台
          </button>
        </header>
        <MonPanel :params="monPaneParams" label="MON 车辆信息显示屏" @receipt="notice = $event" />
        <figcaption class="ops__cap">
          MON 车辆信息显示屏<span class="ops__cap-tip no-print">点行确认；点页签切换</span>
        </figcaption>
      </figure>

      <figure v-else class="ops__pane">
        <DeviceScene
          subject="driver_desk"
          :t="powerDeskT()"
          :aux="deskAux"
          :label="scene === 'door'
            ? '司机操纵台三维示意：点主控钥匙、制动手柄、六个门控按钮或 MON 屏进行操作'
            : '司机操纵台三维示意：点主控钥匙、制动手柄或 MON 屏进行操作'"
          pick
          @part-click="onDeskPart"
          @snapshot="shotDesk = $event"
        />
        <img v-if="shotDesk" class="ops__print" :src="shotDesk" alt="司机操纵台三维示意" />
        <p v-else class="ops__print-text">司机操纵台三维示意（本次未生成静态帧，内容见本步文字说明）</p>
        <figcaption class="ops__cap">
          司机操纵台<span class="ops__cap-tip no-print">点件操作；鼠标移上去会高亮</span>
        </figcaption>
      </figure>

      <figure v-if="view !== 'desk'" class="ops__pane">
        <!-- 机组此刻在做什么：小画布里冷气看得见但不够显眼，
             这一枚徽标把"通风 / 制冷"的差别直接写在画面上（数据来自会话，不是装饰） -->
        <p v-if="scene === 'hvac'" class="ops__badge no-print" :class="{ 'is-cool': hvac.cooling }">
          {{ unitBadge }}
        </p>
        <DeviceScene
          :subject="scene === 'door' ? 'door' : 'hvac'"
          :t="unitFrame"
          :aux="scene === 'door' ? doorAux : ''"
          :label="scene === 'door'
            ? `客室侧门三维示意，当前${doorStage()}；门外侧地上的浅色卷状物是防夹试块，点它可移到门洞`
            : `客室空调机组三维示意，当前${hvacStage()}`"
          :pick="scene === 'door'"
          @part-click="onUnitPart"
          @snapshot="shotUnit = $event"
        />
        <img v-if="shotUnit" class="ops__print" :src="shotUnit" :alt="unitCaption" />
        <p v-else class="ops__print-text">{{ unitCaption }}（本次未生成静态帧，内容见本步文字说明）</p>
        <figcaption class="ops__cap">
          {{ scene === 'door' ? '客室侧门' : '客室空调机组' }}
          <span class="ops__cap-tip">{{ scene === 'door' ? doorStage() : hvacStage() }}</span>
        </figcaption>
      </figure>

    </div>

    <div class="ops__hud no-print">
      <!-- 末步补一句"到此结束"（评审 R23-6）：原来只有"本步已完成"，而出口按钮
           按设计不出现，读完不知道还能不能往下走。 -->
      <p class="ops__next">
        {{ stepDone ? (isLastStep ? '本步已完成，本试验到此结束' : '本步已完成') : next }}
      </p>
      <!-- 回执与"当前阶段"共用一行：**不用浮层**——浮层会盖住 MON 屏下发的按钮
           （2026-11-14 实测：一条"已进入下一步"正好压在控件条上）。 -->
      <p class="ops__line">
        <!-- 回执与阶段并存：只留一个会让"当前工况"在 6 秒里消失，
             而这一行本来就是读状态的地方 -->
        <span v-if="notice" class="ops__notice no-print" role="status">{{ notice }}</span>
        <span class="ops__chip">{{ stage }}</span>
      </p>
    </div>

    <!-- 底部：**只读状态**，不接受点击（2026-11-14 本人明确）。
         动作在三维里、在 MON 屏上；这里只回答"这一步做了没有"。 -->
    <div class="ops__status no-print" role="status" aria-label="本步状态">
      <span v-for="c in chips" :key="c.label" class="ops__st" :class="{ 'is-on': c.done }">
        <i class="ops__st-dot" aria-hidden="true" />{{ c.label }}
      </span>
      <button v-if="showGo" class="ops__go" type="button" @click="goNext">
        本步完成，进入下一步 ›
      </button>
      <button class="ops__reset" type="button" @click="restart">重新开始</button>
    </div>

    <p class="ops__note">结构示意，参数为演示虚构值；动作只能来自三维里的件与 MON 屏，下方状态条只显示状态。</p>

    <div v-if="monZoom" class="ops__mon" role="dialog" aria-modal="true" aria-label="MON 车辆信息显示屏放大">
      <div class="ops__mon-box">
        <header class="ops__mon-bar">
          <span>MON 车辆信息显示屏</span>
          <button class="ops__mon-close" type="button" @click="monZoom = false">关闭</button>
        </header>
        <p class="ops__mon-tip">
          本屏只做本步允许的操作（模式 / 温度 / 下发 / 逐项确认）；开关门等动作在三维台面的按钮上。
        </p>
        <MonPanel :params="monParams" label="MON 屏放大" @receipt="notice = $event" />
      </div>
    </div>
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
  grid-template-columns: 1.25fr 0.75fr;
  gap: 8px;
}

.ops__stage--solo {
  grid-template-columns: 1fr;
}

.ops__badge {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 2;
  margin: 0;
  padding: 3px 9px;
  border: 1px solid var(--c-line);
  border-radius: 999px;
  background: color-mix(in srgb, var(--c-surface) 88%, transparent);
  color: var(--c-ink-2);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

.ops__badge.is-cool {
  border-color: #7fb2d8;
  background: #e3f1fb;
  color: #14506f;
  font-weight: 600;
}

.ops__pane--mon {
  /* 屏要占满这一栏：它现在是作业面，不是插图 */
  padding: 6px 8px 4px;
  border: 1px solid var(--c-line);
  border-radius: 10px;
  background: var(--c-surface);
  overflow: hidden;
}

.ops__mon-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--c-ink);
  font-size: 12px;
  font-weight: 600;
}

.ops__mon-back {
  min-height: 26px;
  padding: 0 10px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.ops__pane--mon :deep(.hmon) {
  flex: 1 1 auto;
  min-height: 0;
}

.ops__pane {
  /* 徽标要贴在这一栏的角上，不是整个舞台的角上 */
  position: relative;
  margin: 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

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

.ops__notice {
  padding: 2px 10px;
  border-left: 3px solid var(--c-primary-line);
  border-radius: var(--radius-sm);
  background: var(--c-primary-soft);
  color: var(--c-primary-ink);
  font-size: 12px;
  line-height: 1.6;
}

/* ---------------- 状态条（只读） ---------------- */
.ops__status {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

/* 状态灯不是按钮：没有 hover、没有手型、没有 focus 环——一眼就该看出"点不动"。 */
.ops__st {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 0 10px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-ink-2);
  font-size: 12px;
  white-space: nowrap;
}

.ops__st-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--c-line);
}

.ops__st.is-on {
  border-color: var(--c-primary);
  background: var(--c-primary);
  color: #fff;
  font-weight: 600;
}

.ops__st.is-on .ops__st-dot {
  background: #fff;
}

.ops__go {
  min-height: 30px;
  margin-left: auto;
  padding: 0 12px;
  border: 1px solid var(--c-primary);
  border-radius: var(--radius-sm);
  background: var(--c-primary);
  color: #fff;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.ops__reset {
  min-height: 30px;
  padding: 0 10px;
  border: none;
  background: transparent;
  color: var(--c-ink-2);
  font: inherit;
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}

.ops__mon {
  position: fixed;
  inset: 0;
  z-index: 95;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgb(10 12 14 / 74%);
}

.ops__mon-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(1120px, 94vw);
  height: min(760px, 90vh);
  padding: 12px 14px 14px;
  border: 1px solid var(--c-line);
  border-radius: 12px;
  background: var(--c-surface);
  box-shadow: 0 12px 40px rgb(0 0 0 / 42%);
}

.ops__mon-box :deep(.hmon),
.ops__mon-box :deep(.dmon) {
  flex: 1 1 auto;
  min-height: 0;
}

.ops__mon-bar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--c-ink);
  font-size: 13px;
  font-weight: 600;
}

.ops__mon-close {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.ops__mon-tip {
  flex: none;
  margin: 0;
  padding: 5px 10px;
  border-left: 3px solid var(--c-primary-line);
  border-radius: var(--radius-sm);
  background: var(--c-primary-soft);
  color: var(--c-primary-ink);
  font-size: 12px;
  line-height: 1.5;
}

.ops__note {
  margin: 0;
  color: var(--c-ink-2);
  font-size: 11px;
  line-height: 1.5;
}

@media (max-width: 900px) {
  .ops__stage {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr;
  }
}

/* 打印：交互内容一律换静态帧（与 PantoOps 同一套处理） */
.ops__print,
.ops__print-text {
  display: none;
}

@media print {
  .ops__pane :deep(.scene) {
    display: none !important;
  }

  .ops__print {
    display: block !important;
    width: 100%;
    max-height: 110mm;
    object-fit: contain;
  }

  .ops__print-text {
    display: block !important;
    color: #444;
    font-size: 12px;
    line-height: 1.6;
  }
}
</style>
