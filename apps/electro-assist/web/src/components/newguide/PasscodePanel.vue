<script setup lang="ts">
/**
 * 访问口令面板：折叠 → 输入 → 验证 → 生效状态。
 *
 * 从 NewGuideView 拆出来的第二块（2026-11-06）。选它的理由和素材区一样：
 * 一块 UI、一套状态、边界清楚。
 *
 * 状态归属：token 与 message 由父组件持有（提交时要带 X-Passcode-Token header，
 * 而且 passcode_invalid 时父组件要能清掉），本组件只做输入与验证调用，
 * 通过 v-model:token / v-model:message 双向同步。
 * 展开态、输入框、忙碌态是纯 UI 状态，留在这里。
 */
import { ref } from 'vue'
import { ApiError, postJson } from '../../lib/http'
import { storeToken } from '../../lib/passcode'

const props = defineProps<{
  token: string
  message: string
  /** 生成请求进行中时禁用验证，避免和主流程抢状态 */
  busy?: boolean
}>()

const emit = defineEmits<{
  'update:token': [value: string]
  'update:message': [value: string]
}>()

const open = ref(false)
const input = ref('')
const verifying = ref(false)

async function verify(): Promise<void> {
  const code = input.value.trim()
  if (!code || verifying.value) return
  verifying.value = true
  emit('update:message', '')
  try {
    const res = await postJson<{ token: string; expires_in: number }>(
      '/api/electro/passcode/verify',
      { code },
    )
    emit('update:token', res.token)
    storeToken(res.token)
    input.value = ''
    open.value = false
    emit(
      'update:message',
      `口令已生效：${Math.round(res.expires_in / 3600)} 小时内不受每 IP 次数限制（全站预算仍生效）`,
    )
  } catch (err) {
    if (err instanceof ApiError && err.kind === 'ratelimit') {
      emit('update:message', err.message || '验证过于频繁，请稍后再试。')
    } else if (err instanceof ApiError && err.code === 'passcode_disabled') {
      emit('update:message', '本站未启用口令通道。')
    } else if (err instanceof ApiError && err.message) {
      emit('update:message', err.message)
    } else {
      emit('update:message', '验证失败，请稍后再试。')
    }
  } finally {
    verifying.value = false
  }
}
</script>

<template>
  <div class="passcode">
    <template v-if="!props.token">
      <button
        class="linkbtn"
        type="button"
        :aria-expanded="open"
        @click="open = !open"
      >
        {{ open ? '收起口令输入' : '有访问口令？' }}
      </button>
      <div v-if="open" class="passcode__row">
        <input
          v-model="input"
          class="passcode__input"
          type="password"
          autocomplete="off"
          placeholder="输入访问口令"
          :disabled="verifying || props.busy"
          @keyup.enter="verify"
        />
        <button
          class="btn"
          type="button"
          :disabled="verifying || props.busy || !input.trim()"
          @click="verify"
        >
          {{ verifying ? '验证中…' : '验证' }}
        </button>
      </div>
    </template>
    <template v-else>
      <span class="passcode__ok">口令已生效</span>
      <span class="passcode__hint">本机不受每 IP 次数限制，全站预算仍生效</span>
    </template>
    <p v-if="props.message" class="hint">{{ props.message }}</p>
  </div>
</template>

<style scoped>
.passcode {
  margin-top: 12px;
}

.hint {
  margin: 8px 0 0;
  color: var(--c-ink-3);
  font-size: 13px;
}

.linkbtn {
  padding: 0;
  border: 0;
  background: none;
  color: var(--c-primary);
  font: inherit;
  font-size: 13px;
  text-decoration: underline;
  cursor: pointer;
}

.passcode__row {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.passcode__input {
  flex: 1;
  min-height: 44px;
  padding: 0 12px;
  border: 1px solid var(--c-line);
  border-radius: 6px;
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
}

.passcode__input:focus {
  outline: 2px solid var(--c-primary);
  outline-offset: 1px;
}

.passcode__ok {
  color: var(--c-primary-ink);
  font-size: 13px;
  font-weight: 600;
}

.passcode__hint {
  margin-left: 8px;
  color: var(--c-ink-3);
  font-size: 13px;
}
</style>
