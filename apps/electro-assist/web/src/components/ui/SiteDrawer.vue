<script setup lang="ts">
/** 全屏抽屉：窄屏的唯一导航入口，也是全站唯一的外观开关位置。
 *
 *  单独成组件并**异步加载**：抽屉的模板与样式不该进首屏包。
 *  首屏只需要那个 ⋯ 按钮，菜单等点开再下载。
 *
 *  焦点管理（与 ConfirmDialog 同一套）：进来落在关闭键、Tab 在层内循环、
 *  Esc 关、卸载时解锁滚动。焦点回填由父级负责——父级才知道是谁打开的。
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { theme, toggleTheme } from '../../lib/theme'

const emit = defineEmits<{ close: [] }>()

const panel = ref<HTMLElement | null>(null)
const closeBtn = ref<HTMLButtonElement | null>(null)

function focusables(): HTMLElement[] {
  if (!panel.value) return []
  return Array.from(
    panel.value.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  )
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  if (event.key !== 'Tab') return
  const list = focusables()
  if (!list.length) return
  const first = list[0]
  const last = list[list.length - 1]
  const active = document.activeElement
  const inside = !!panel.value && !!active && panel.value.contains(active)
  if (event.shiftKey && (active === first || !inside)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (active === last || !inside)) {
    event.preventDefault()
    first.focus()
  }
}

onMounted(() => {
  document.documentElement.classList.add('drawer-open')
  document.addEventListener('keydown', onKeydown, true)
  void nextTick(() => closeBtn.value?.focus())
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true)
  document.documentElement.classList.remove('drawer-open')
})
</script>

<template>
  <Teleport to="body">
    <div class="drawer-overlay no-print" @click.self="emit('close')">
      <div
        id="site-drawer"
        ref="panel"
        class="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="site-drawer-title"
      >
        <div class="drawer__head">
          <h2 id="site-drawer-title" class="drawer__title">菜单</h2>
          <button ref="closeBtn" class="drawer__close" type="button" @click="emit('close')">
            关闭
          </button>
        </div>

        <nav class="drawer__nav" aria-label="站点导航">
          <RouterLink class="drawer__link" to="/">作业指导书库</RouterLink>
          <RouterLink class="drawer__link" to="/new">生成指导书</RouterLink>
          <RouterLink class="drawer__link" to="/diagnose">故障排查</RouterLink>
          <a class="drawer__link" href="/">返回门户</a>
        </nav>

        <div class="drawer__foot">
          <div class="drawer__row">
            <span id="appearance-label">外观</span>
            <button
              class="drawer__switch"
              type="button"
              role="switch"
              aria-labelledby="appearance-label"
              :aria-checked="theme === 'dark'"
              @click="toggleTheme"
            >
              <span class="drawer__switch-track" aria-hidden="true">
                <span class="drawer__switch-dot" />
              </span>
              <span class="drawer__switch-text">{{ theme === 'dark' ? '暗色' : '亮色' }}</span>
            </button>
          </div>
          <p class="drawer__hint">
            现场作业建议用亮色：强光下暗色屏的可读性更差。演示皮肤，不跟随系统。
          </p>
          <p class="drawer__ver">v1.0 · 演示版 · 数据均为虚构示例</p>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 45;
  background: var(--c-bg);
  overflow-y: auto;
}

.drawer {
  max-width: 480px;
  margin: 0 auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 100%;
}

.drawer__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.drawer__title {
  margin: 0;
  font-size: 17px;
}

/* 关闭固定在右上：左上留给"返回"，同位置双语义在戴手套时最容易误触。 */
.drawer__close {
  min-width: 64px;
  height: var(--tap);
  padding: 0 12px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-ink);
  font-size: 14px;
  cursor: pointer;
}

.drawer__nav {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--c-line);
}

.drawer__link {
  display: flex;
  align-items: center;
  min-height: 52px;
  padding: 0 4px;
  border-bottom: 1px solid var(--c-line-soft);
  color: var(--c-ink);
  font-size: 16px;
}

.drawer__link:hover {
  color: var(--c-primary);
  text-decoration: none;
}

.drawer__foot {
  margin-top: auto;
  padding-top: 16px;
  border-top: 1px solid var(--c-line);
}

.drawer__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 14px;
  color: var(--c-ink);
}

.drawer__switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: var(--tap);
  padding: 0 4px;
  border: none;
  background: transparent;
  color: var(--c-ink-2);
  font-size: 13px;
  cursor: pointer;
}

.drawer__switch-track {
  position: relative;
  width: 44px;
  height: 24px;
  border-radius: 12px;
  background: var(--c-line);
  transition: background 120ms ease;
}

.drawer__switch[aria-checked='true'] .drawer__switch-track {
  background: var(--c-primary);
}

.drawer__switch-dot {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--c-surface);
  transition: transform 120ms ease;
}

.drawer__switch[aria-checked='true'] .drawer__switch-dot {
  transform: translateX(20px);
}

.drawer__hint {
  margin: 8px 0 0;
  color: var(--c-ink-3);
  font-size: 12px;
  line-height: 20px;
}

.drawer__ver {
  margin: 8px 0 0;
  color: var(--c-ink-3);
  font-size: 12px;
  font-family: var(--font-mono);
}

@media (min-width: 720px) {
  .drawer {
    padding: 24px;
  }
}
</style>
