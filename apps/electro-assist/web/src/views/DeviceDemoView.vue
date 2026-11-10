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
import type { Readout, SceneKey } from '../lib/demoreads'
import { readoutsFor } from '../lib/demoreads'

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
    criteria: [
      '锁闭信号丢失后才允许动门（锁舌缩回是前置条件）',
      '门扇开启时间 2.5 ± 0.5 s，全程无卡滞、无异响',
      '塞拉外移 55 ± 3 mm，单扇行程 660 ± 5 mm',
      '中缝间隙 ≤ 2 mm，锁钩跨缝咬合到位',
    ],
    hint: '前 2% 是解锁段：锁舌没缩回、锁闭信号还在，门一点都不能动——这是门控回路的硬联锁，不是流程建议。此后先退出密封面再滑移，中途锁闭信号必须一直是「无」，否则按锁闭回路故障排查。三维动作、参数读数、验收判据共用同一条时间轴：装配看形状，调试看动作与量的时序耦合。',
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
    label:
      '单臂受电弓三维示意：气路建压、气囊顶起下臂、弓头升到接触线并压出接触压力，随后排气降弓、阻尼器限速；切到「ADD 自动降弓」可见滑板破裂后快排阀直排大气、弓头明显更快落下',
    step: '5 / 9',
    action: '发出升弓指令，观察弓头上升、接触压力建立与到位信号；随后排气降弓，检查下降是否匀速',
    tools: '秒表、压力表',
    criteria: [
      '升弓时间 8.5 ± 1.0 s',
      '到位后接触压力 110 ± 15 N',
      '气路压力稳定在 0.5 MPa 以上',
      '降弓时间 3.5 ± 0.5 s，全程匀速、无冲击（阻尼器失效会自由落体）',
      '升弓到位与落弓到位是两个独立信号，降弓途中两者均应丢失',
      'ADD 试验：滑板漏气后压力开关先断开，快排阀排气，弓头比正常降弓明显更快落下',
    ],
    hint: '受电弓是纯转动机构：两根臂各绕一个铰点转，杆长不变。所以三维里看到的不是「拉长」，而是「转起来」——这一条错了，整台设备就假了。另一条容易漏的是力的来源：气缸顶起下臂、阻尼器限制下降速度，两者是并联的两支不同的缸，不是同一个件。',
    parts: [
      { key: 'arms', label: '臂杆' },
      { key: 'head', label: '弓头' },
      { key: 'frame', label: '底架' },
      { key: 'drive', label: '气路控制箱' },
      { key: 'drive2', label: '气囊/阻尼' },
      { key: 'lamp', label: '接近开关' },
    ],
    note: '形体取公开的单臂受电弓通用结构（底架 + 四绝缘子 + 双下臂 + 双上臂 + 弓头 + 气囊 + 阻尼器 + 气路控制箱 + 快排阀/压力开关）；<strong>全部参数为演示虚构值</strong>，不代表任何车型图纸或实测结果。图中红丹漆底架、棕红瓷绝缘子、碳滑板均为实拍配色；气囊、快排阀、压力开关做了<b>剖切</b>以露出内腔与触点——这三件的内部变化本来在实物外面看不见。',
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
  multimeter: {
    title: '万用表测门控器输入电压',
    eyebrow: 'A2 可视化作业指导 · 工具动作',
    subject: 'multimeter',
    label:
      '手持式数字万用表三维示意：档位旋到直流电压档，红表笔搭正极端子、黑表笔搭公共端，液晶由 OL 跳成 110.3 V，撤笔后读数保持',
    step: '3 / 6',
    action: '将万用表置直流电压档，红表笔接门控器电源正极、黑表笔接公共端，读稳定值并记录',
    tools: '万用表（DC 档）、端子起子',
    criteria: [
      '档位在 V⎓ 直流电压，不是电阻档或电流档',
      '红笔接正极、黑笔接公共端；接反读数带负号',
      '两根笔都搭稳后读数才成立，之前显示 OL',
      '输入电压 110 ± 5.5 V（演示值，与样例判据同源）',
    ],
    hint: '三维里能看见三件 2D 画不出来的事：旋钮停在哪个档、两根笔各自落在第几号端子、读数是在哪一刻从 OL 变成数字的。第三件最要紧——只有一根笔搭上时表是开路的，这时抄下来的"读数"没有意义。撤笔后读数保持，是"抄完再撤"的习惯，不是表坏了。',
    parts: [
      { key: 'body', label: '表体' },
      { key: 'dial', label: '档位' },
      { key: 'screen', label: '读数' },
      { key: 'probes', label: '表笔' },
      { key: 'terminals', label: '端子排' },
    ],
    note: '形体按公开的工业手持表通用形式（约 183 × 90 × 49 mm、可拆黄护套、四个插孔）建模，<b>表面印刷按实物画</b>（档位刻度、液晶单位、端子编号），不贴照片。端子排放大到 4 倍才看得清表笔落点；<strong>全部参数为演示虚构值</strong>。',
  },
  warning_sign: {
    title: '隔离点挂警示牌',
    eyebrow: 'A2 可视化作业指导 · 工具动作',
    subject: 'warning_sign',
    label:
      '警示牌三维示意：牌挂在门边操作把手上，挂绳滑入把手内侧、牌面离手后摆动收住，最后牌面正对作业面',
    step: '1 / 8',
    action: '在门边操作把手上挂「禁止合闸，有人工作」标示牌，牌面朝向作业面，确认不会自行脱落',
    tools: '警示牌',
    criteria: [
      '牌挂在门边操作把手上，不是挂在门扇或别的支架上',
      '牌面朝向作业面，站在作业位置能直接看到',
      '挂绳绕过把手并回到穿线孔，不是单边搭着',
      '挂牌后设备不可被误操作（钥匙/按钮有遮挡）',
    ],
    hint: '这一段只演"挂上之后怎么摆正"，不演从地上把牌拿起来——演示里没有操作者，凭空飘起来的牌子比静止更假。摆动的衰减是解析式算的：同一个进度永远得到同一帧，截图和打印才对得上。',
    parts: [
      { key: 'plate', label: '牌面' },
      { key: 'cord', label: '挂绳' },
      { key: 'handle', label: '把手' },
      { key: 'door', label: '门体' },
    ],
    note: '牌面按公开的电力安全标示牌式样：<b>白底红字、200 × 160 mm</b>，悬挂在"一经合闸即可送电到工作地点的断路器/隔离开关操作把手上"。<strong>全部参数为演示虚构值</strong>，不代表任何现场布置。',
  },
  feeler_gauge: {
    title: '塞尺测门扇关闭间隙',
    eyebrow: 'A2 可视化作业指导 · 工具动作',
    subject: 'feeler_gauge',
    label:
      '塞尺三维示意：从叠片中翻出一片、竖直对准门缝、插入后沿缝滑动找最紧处，再抽出读数',
    step: '7 / 8',
    action: '用塞尺沿门缝插入并滑动，取能入的最厚一片；换厚一档复测应插不进',
    tools: '塞尺（0.02–1.00 mm）',
    criteria: [
      '塞尺垂直门面插入，不许斜插（斜插会把缝"撑"大）',
      '沿缝上下滑动，以最紧处为准，不取最松处',
      '最厚能入的一片记为下限，厚一档不入记为上限',
      '门缝全长均匀，局部超差要记录位置',
    ],
    hint: '门的关闭间隙不是一个"点"，是一条缝上的最小值——所以必须沿线滑动，取最紧处。三维里片的厚度方向与缝宽对齐，是这一步唯一的判据来源：片歪一点，量出来就是另一个数。真实缝宽 1–2mm、片厚 0.5mm，按真实比例在屏幕上只有一条线，这里把可视尺度放大了约 2.4 倍，<b>厚度刻字仍是实物值</b>。',
    parts: [
      { key: 'blades', label: '塞尺片' },
      { key: 'case', label: '尺壳' },
      { key: 'gap', label: '门缝' },
      { key: 'seal', label: '密封面' },
    ],
    note: '形体按公开的塞尺通用形式（十几片薄钢片铆在同一根轴上、扇形展开、每片冲压厚度数字）建模。<b>门缝与片厚为便于观察做了放大</b>，厚度刻字与片数按实物；<strong>全部参数为演示虚构值</strong>。',
  },
  torque_wrench: {
    title: '力矩扳手复紧门机螺栓',
    eyebrow: 'A2 可视化作业指导 · 工具动作',
    subject: 'torque_wrench',
    label:
      '预置式力矩扳手三维示意：套筒落到螺栓六角头上、手柄绕螺栓轴转约 50°，到 25 N·m 时手柄回弹、刻度窗短促亮起',
    step: '4 / 8',
    action: '套筒完全坐到底后施力，听到咔嗒即停，不得继续加力；复检后做防松标记',
    tools: '力矩扳手（预置 25 N·m）、套筒',
    criteria: [
      '套筒六角口完全套住螺栓头，不歪、不悬空',
      '施力方向与扳手平面一致，不侧向掰',
      '到 25 N·m 咔嗒即停；脱扣后继续拧，扭矩不再增加',
      '复检扭矩 25 ± 2 N·m，做防松标记',
    ],
    hint: '"咔嗒"是声音，画不出来，所以用三个可见信号替代：手柄回弹约 4°、指针停在设定值、刻度窗短促亮一下。三者同时出现才是"到值脱扣"。另一处容易忽略的是套筒：悬空施力会把六角头咬圆，三维里能看见它是不是坐到底了。',
    parts: [
      { key: 'wrench', label: '扳手' },
      { key: 'socket', label: '套筒' },
      { key: 'bolt', label: '螺栓' },
      { key: 'bracket', label: '安装座' },
      { key: 'window', label: '刻度窗' },
    ],
    note: '形体按公开的预置式（click-type）力矩扳手通用形式建模：镀铬方杆 + 黑色滚花握把 + 握把刻度窗 + 棘轮头 + 六角套筒。<b>刻度窗文字按实物排布</b>（每 4 N·m 一格），<strong>全部参数为演示虚构值</strong>。',
  },
}

const SCENE_KEYS: SceneKey[] = [
  'door',
  'pantograph',
  'cabinet',
  'multimeter',
  'warning_sign',
  'feeler_gauge',
  'torque_wrench',
]

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
/* 标注默认开：全屏演示页的存在意义就是"看清一台设备"。
   指导书里的图不开——那张只有 340px 高，五个标注会盖住整台设备。 */
const labels = ref(true)
/* 受电弓的第三种调试工况：ADD 自动降弓。其余设备只有一条时间轴，用不到。 */
const pantoMode = ref<'normal' | 'add'>('normal')
let raf = 0

const percent = computed(() => Math.round(t.value * 100))

/* 读数计算在 `lib/demoreads.ts`（纯函数，可单测）。这里只把时间轴接进去。
   抽出去的理由：它与 `figures/devices/*.ts` 共享同一套时序常量，是"改一处要改两处"
   的副本——只有能被测试钉住，它才不会悄悄错位。 */

const reads = computed<Readout[]>(() =>
  readoutsFor(scene.value, t.value, scene.value === 'pantograph' ? pantoMode.value : 'normal'),
)

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
  pantoMode.value = 'normal'
}

function toggleCut(): void {
  cut.value = !cut.value
}

/* 切工况必须回到时间轴起点：ADD 的分叉在 0.80 之后，
   停在 0.95 再切过来会看到"已经落弓但压力还是满的"这种不存在的状态。 */
function setPantoMode(next: 'normal' | 'add'): void {
  if (pantoMode.value === next) return
  pantoMode.value = next
  stop()
  t.value = 0
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
        :labels="labels"
        :mode="scene === 'pantograph' ? pantoMode : 'normal'"
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

      <div v-if="cutable" class="demo__controls demo__controls--cut">        <button
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

      <div class="demo__controls demo__controls--mode">
        <div v-if="scene === 'pantograph'" class="demo__modes" role="group" aria-label="试验工况">
          <span class="demo__parts-label">工况</span>
          <button
            class="demo__chip"
            :class="{ 'demo__chip--on': pantoMode === 'normal' }"
            type="button"
            :aria-pressed="pantoMode === 'normal'"
            @click="setPantoMode('normal')"
          >
            正常升降弓
          </button>
          <button
            class="demo__chip"
            :class="{ 'demo__chip--on': pantoMode === 'add' }"
            type="button"
            :aria-pressed="pantoMode === 'add'"
            @click="setPantoMode('add')"
          >
            ADD 自动降弓
          </button>
        </div>
        <button
          class="demo__ghost"
          :class="{ 'demo__ghost--on': labels }"
          type="button"
          :aria-pressed="labels"
          @click="labels = !labels"
        >
          {{ labels ? '隐藏标注' : '显示标注' }}
        </button>
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
  /* 七台设备之后一行放不下：换行而不是横向滚动——横向滚动会把"还有别的设备"
     藏到屏幕外，而演示恰恰要让人一眼看到全集 */
  flex-wrap: wrap;
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

/* 工况切换与标注开关同一行：都是"看什么/怎么看"，不属于部件高亮 */
.demo__modes {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-right: auto;
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
