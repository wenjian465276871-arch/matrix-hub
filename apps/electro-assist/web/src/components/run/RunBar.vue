<script setup lang="ts">
/**
 * 底部固定操作栏。
 *
 * 现场是"戴手套、单手、可能站着"的场景，所以这栏有三个硬约束：
 * 1. 主按钮 48px 高、字号 16px（手套点得中）
 * 2. 超差时**只改文案不阻断**（`仍要提交 · N 项超差`）——服务端判 fail 才是结论
 * 3. `bottom` 绑 `--kb-inset`：软键盘弹起时整栏上移，否则会盖住正在输入的判据框
 *
 * 第 3 条的变量由父组件的 `watchKeyboardInset` 写到 documentElement 上，
 * 本组件只读不写——所以拆出来不影响软键盘行为。
 */

defineProps<{
  /** 超差项数，>0 时上方出现提示行、主按钮换成"仍要提交" */
  warningCount: number
  submitLabel: string
  /** 提交中：两个按钮都禁用，防重复提交 */
  submitting: boolean
  /** 正在结束作业：中止按钮要禁用，避免连点 */
  starting: boolean
}>()

const emit = defineEmits<{
  abort: []
  submit: []
}>()
</script>

<template>
  <div class="run-bar no-print">
    <!-- 超差提示放在底栏上方而不是弹窗：现场要的是"我知道这项超了"，不是再点一次确认框 -->
    <p v-if="warningCount" class="run-bar__warn" role="status" aria-live="polite">
      {{ warningCount }} 项超差，提交后本步记为异常
    </p>
    <div class="run-bar__inner">
      <button
        class="bar-secondary"
        type="button"
        :disabled="submitting || starting"
        @click="emit('abort')"
      >
        中止
      </button>
      <button
        class="btn btn--primary bar-primary"
        type="button"
        :disabled="submitting"
        @click="emit('submit')"
      >
        {{ submitLabel }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.run-bar {
  position: fixed;
  right: 0;
  /* 软键盘顶升：--kb-inset 由 visualViewport 写入（§12.5）。没有键盘时恒为 0。 */
  bottom: var(--kb-inset, 0px);
  left: 0;
  z-index: 20;
  border-top: 1px solid var(--c-line);
  background: var(--c-surface);
  padding: 8px 16px calc(8px + env(safe-area-inset-bottom));
}

.run-bar__inner {
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 760px;
  margin: 0 auto;
}

/* 超差提示：一条 12px 的 waring 行，不抢按钮的位置 */
.run-bar__warn {
  max-width: 760px;
  margin: 0 auto 6px;
  color: var(--c-danger);
  font-size: 12px;
  line-height: 16px;
}

.bar-secondary {
  min-width: 64px;
  min-height: 48px;
  border: none;
  background: transparent;
  color: var(--c-ink-2);
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}

.bar-secondary:disabled {
  color: var(--c-ink-3);
  cursor: default;
}

.bar-primary {
  flex: 1;
  min-height: 48px;
  font-size: 16px;
}

/* 极窄屏（<360px）：间距收紧、主按钮字号降一档，避免文案换行顶高底栏 */
@media (max-width: 359px) {
  .run-bar__inner {
    gap: 8px;
  }

  .bar-primary {
    font-size: 15px;
  }
}

/* 横屏短高：整行 800px 的主按钮要右手拇指跨半屏，反而破坏拇指区纪律，
   所以改成固定 240px 靠右。这两条**必须跟着组件走**——
   拆 RunBar 时漏掉它们，底栏会从 240px 变成撑满整行（E2E landscape 用例抓到的）。 */
@media (orientation: landscape) and (max-height: 560px) {
  .run-bar__inner {
    max-width: none;
    justify-content: flex-end;
  }

  .bar-primary {
    flex: 0 0 240px;
    width: 240px;
  }
}
</style>
