<script setup lang="ts">
/** 逐步诊断：故障树推进。
 *
 *  这个组件只做"把服务端给的当前检查项画出来、把输入收上去"。
 *  它不判断超差、不决定下一项、不生成结论——那些都在服务端。
 *  这条边界一旦被前端越过去，"判定在服务端"就成了空话。
 */
import { computed, ref, watch } from 'vue'

import type { DiagnoseRunResponse } from '../../types'

const props = defineProps<{
  runData: DiagnoseRunResponse | null
  busy: boolean
}>()

const emit = defineEmits<{
  start: [entryId?: string]
  submit: [payload: { verdict: 'pass' | 'fail'; value: number | null; note: string }]
  abort: []
  reset: []
}>()

const SYSTEM_LABEL: Record<string, string> = {
  door: '客室侧门',
  hvac: '空调',
  pantograph: '受电弓',
}

const CONCLUSION_LABEL: Record<string, string> = {
  fail: '已定位到异常点',
  exhausted: '全部检查完成，未定位单一原因',
  aborted: '诊断已中止',
}

// Vue 3 对 <input type="number"> 的 v-model 会自动转 number，
// 所以这里不能假设是字符串，统一按 string | number 处理。
const measured = ref<string | number>('')
const note = ref('')

const currentCheck = computed(() => props.runData?.current_check ?? null)
const isMeasure = computed(() => currentCheck.value?.kind === 'measure')
const measuredNumber = computed(() => {
  const raw = measured.value
  if (raw === '' || raw === null || raw === undefined) return null
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
  return Number.isFinite(value) ? value : null
})
const canSubmitMeasure = computed(() => measuredNumber.value !== null && !props.busy)

// 换到下一项（或换条目）时清空输入，避免把上一条的实测值带过去。
watch(
  () => [props.runData?.run.id, currentCheck.value?.order],
  () => {
    measured.value = ''
    note.value = ''
  },
)

function submit(verdict: 'pass' | 'fail'): void {
  emit('submit', {
    verdict,
    value: isMeasure.value ? measuredNumber.value : null,
    note: note.value,
  })
}
</script>

<template>
  <section v-if="runData" class="run">
    <header class="run__head">
      <div>
        <p class="run__label">排查条目</p>
        <h2 class="run__title">{{ runData.entry.title }}</h2>
        <p class="run__sub">
          {{ SYSTEM_LABEL[runData.entry.system] ?? runData.entry.system }} ·
          已完成 {{ runData.progress.done }} / {{ runData.progress.total }} 项 ·
          状态 {{ runData.run.status === 'active' ? '进行中' : '已结束' }}
        </p>
      </div>
      <button
        v-if="runData.candidates && runData.candidates.length > 1"
        class="btn btn--ghost"
        type="button"
        @click="emit('start')"
      >
        重新匹配
      </button>
    </header>

    <div v-if="runData.candidates && runData.candidates.length > 1" class="candidates">
      <span class="candidates__label">也可能是</span>
      <button
        v-for="item in runData.candidates"
        :key="item.id"
        class="chip"
        type="button"
        :class="{ 'chip--on': item.id === runData.entry.id }"
        @click="emit('start', item.id)"
      >
        {{ item.title }}
        <span class="chip__score">{{ item.signals.combined }}</span>
      </button>
    </div>

    <article v-if="currentCheck" class="card current">
      <p class="current__label">
        第 {{ runData.progress.done + 1 }} 项 ·
        {{ isMeasure ? '回填实测值' : '确认正常 / 异常' }}
      </p>
      <h3 class="current__action">{{ currentCheck.action }}</h3>
      <p class="current__expect">判据：{{ currentCheck.expect }}</p>

      <div v-if="isMeasure" class="measure">
        <label class="measure__field">
          <span class="visually-hidden">实测值</span>
          <input
            v-model="measured"
            class="input"
            type="number"
            inputmode="decimal"
            step="any"
            placeholder="填入实测值"
          />
          <span class="measure__unit">{{ currentCheck.unit }}</span>
        </label>
        <span class="measure__range">
          参考 {{ currentCheck.min }}–{{ currentCheck.max }} {{ currentCheck.unit }}
        </span>
        <p class="measure__tip">按实测值提交，是否超差由服务端判定。</p>
      </div>

      <input
        v-model="note"
        class="input note-input"
        type="text"
        maxlength="120"
        placeholder="备注（可选）：看到的现象、部位、声音"
      />

      <div class="current__actions">
        <template v-if="isMeasure">
          <button
            class="btn btn--primary"
            type="button"
            :disabled="!canSubmitMeasure"
            @click="submit('pass')"
          >
            提交实测值
          </button>
        </template>
        <template v-else>
          <button class="btn btn--ok" type="button" :disabled="busy" @click="submit('pass')">
            正常
          </button>
          <button class="btn btn--warn" type="button" :disabled="busy" @click="submit('fail')">
            异常
          </button>
        </template>
        <button class="btn btn--ghost" type="button" :disabled="busy" @click="emit('abort')">
          中止
        </button>
      </div>
    </article>

    <article
      v-if="runData.conclusion"
      class="card conclusion"
      :class="`conclusion--${runData.conclusion.kind}`"
    >
      <p class="conclusion__kind">{{ CONCLUSION_LABEL[runData.conclusion.kind] }}</p>
      <p class="conclusion__cause">{{ runData.conclusion.cause }}</p>
      <div class="conclusion__block">
        <p class="hit__label">处置与升级</p>
        <p class="conclusion__text">{{ runData.conclusion.action }}</p>
      </div>
      <div class="conclusion__block conclusion__block--safe">
        <p class="hit__label">安全提示</p>
        <p class="conclusion__text">{{ runData.conclusion.safety }}</p>
      </div>
      <p v-if="runData.conclusion.sources.length" class="conclusion__sources">
        来源：{{ runData.conclusion.sources.join('、') }}
      </p>
      <button class="btn btn--primary" type="button" @click="emit('reset')">重新排查</button>
    </article>

    <section v-if="runData.steps.length" class="steps">
      <p class="hit__label">已完成的检查</p>
      <ol class="steps__list">
        <li v-for="step in runData.steps" :key="step.check_order" class="step">
          <span class="step__order">{{ step.check_order }}</span>
          <span class="step__verdict" :class="`step__verdict--${step.verdict}`">
            {{ step.verdict === 'pass' ? '正常' : '异常' }}
          </span>
          <span v-if="step.value" class="step__value">{{ step.value }}</span>
          <span v-if="step.note" class="step__note">{{ step.note }}</span>
        </li>
      </ol>
    </section>

    <p class="disclaimer">{{ runData.disclaimer }} · 排查建议需专业人员确认后执行</p>
  </section>
</template>
