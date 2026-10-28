<script setup lang="ts">
/**
 * 确认弹层：只做三件事——焦点进得来、出不去、关得掉。
 *
 * 为什么不用原生 `<dialog>` + `showModal()`：老 WebView（现场 Honor 那批）对
 * `showModal` 的焦点陷阱实现不一致，且 `::backdrop` 在部分内核里不响应
 * `prefers-reduced-motion`。自己写 30 行，行为可测。
 *
 * 约定（对应开发计划 §12.5「弹层 trap + Esc 回流」）：
 * 1. 打开时焦点落到**取消**按钮——破坏性操作不能默认停在确认上；
 * 2. Tab / Shift+Tab 在层内循环，不逃到背后的页面；
 * 3. Esc 关闭，取消而不是确认；
 * 4. 关闭后焦点回到打开它的那个元素。
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    title: string
    hint?: string
    confirmText?: string
    cancelText?: string
    busy?: boolean
  }>(),
  { hint: '', confirmText: '确认', cancelText: '取消', busy: false },
)

const emit = defineEmits<{ confirm: []; cancel: [] }>()

const panel = ref<HTMLElement | null>(null)
const cancelBtn = ref<HTMLButtonElement | null>(null)
const confirmBtn = ref<HTMLButtonElement | null>(null)
let previous: HTMLElement | null = null

function focusables(): HTMLElement[] {
  const root = panel.value
  if (!root) return []
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  )
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (!props.busy) emit('cancel')
    return
  }
  if (event.key !== 'Tab') return
  const list = focusables()
  if (!list.length) return
  const first = list[0]
  const last = list[list.length - 1]
  const active = document.activeElement
  if (event.shiftKey && (active === first || !rootContains(active))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (active === last || !rootContains(active))) {
    event.preventDefault()
    first.focus()
  }
}

function rootContains(node: Element | null): boolean {
  return !!panel.value && !!node && panel.value.contains(node)
}

onMounted(() => {
  previous = document.activeElement as HTMLElement | null
  document.addEventListener('keydown', onKeydown, true)
  // 破坏性操作的默认焦点在取消。
  void nextTick(() => cancelBtn.value?.focus())
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true)
  // 触发元素可能已被卸载（例如会话结束后按钮消失），兜底不抛错。
  if (previous && document.contains(previous)) previous.focus()
})

function onOverlayClick(event: MouseEvent): void {
  if (props.busy) return
  if (event.target === event.currentTarget) emit('cancel')
}
</script>

<template>
  <Teleport to="body">
    <div class="dialog-overlay no-print" @click="onOverlayClick">
      <div
        ref="panel"
        class="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        :aria-describedby="props.hint ? 'confirm-dialog-hint' : undefined"
      >
        <h2 id="confirm-dialog-title" class="dialog-title">{{ props.title }}</h2>
        <p v-if="props.hint" id="confirm-dialog-hint" class="dialog-hint">{{ props.hint }}</p>
        <div class="dialog-actions">
          <button ref="cancelBtn" class="btn" type="button" :disabled="props.busy" @click="emit('cancel')">
            {{ props.cancelText }}
          </button>
          <button
            ref="confirmBtn"
            class="btn btn--danger"
            type="button"
            :disabled="props.busy"
            @click="emit('confirm')"
          >
            {{ props.busy ? '处理中…' : props.confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(16, 24, 40, 0.44);
}

.dialog-panel {
  width: 100%;
  max-width: 420px;
  padding: 20px;
  border-radius: var(--radius);
  background: var(--c-surface);
  box-shadow: var(--shadow-2);
}

.dialog-title {
  margin: 0;
  font-size: 16px;
}

.dialog-hint {
  margin: 8px 0 0;
  color: var(--c-ink-2);
  font-size: 13px;
  line-height: 22px;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>
