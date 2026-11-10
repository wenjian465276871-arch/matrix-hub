<script setup lang="ts">
/** 翻页控件：‹ 3/9 › 加一排圆点。只负责显示与发事件，不持有状态。
 *
 *  ## 为什么从 StepPager 里拆出来
 *  上一版把翻页条做成阅读器下面的**第二级工具栏**：标题一行、翻页一行，
 *  两级一共吃掉 114px 垂直空间。在 600px 高的窗口里这是 19% 的可视高度，
 *  而三维画面恰恰是这页最需要空间的东西（用户 2026-11-10 反馈「画面不协调」）。
 *  拆出来之后，控件和标题共用一行，只留一级工具栏。
 *
 *  ## 窄屏换成下拉框
 *  1080px 以下「标题 + 标签 + 箭头 + 计数 + 圆点 + 打印」放不下。圆点是**快捷方式**，
 *  不是唯一入口——但 390px 的手机上如果只剩箭头，从第 1 步跳到第 8 步要点七次。
 *  所以窄屏把圆点换成原生 `<select>`：一个控件、可键盘、读屏友好，宽度只要 90px。
 */
const props = defineProps<{
  current: number
  /** 每页的读屏名称，来自 `lib/paging.pageLabels()` */
  labels: string[]
}>()

const emit = defineEmits<{ go: [index: number] }>()

const count = (): number => props.labels.length

function pick(event: Event): void {
  emit('go', Number((event.target as HTMLSelectElement).value))
}
</script>

<template>
  <div class="pager-nav">
    <button
      class="pager__arrow"
      type="button"
      :disabled="current === 0"
      aria-label="上一页"
      @click="emit('go', current - 1)"
    >
      <span aria-hidden="true">‹</span>
    </button>

    <p class="pager__count">
      <b>{{ current + 1 }}</b>
      <span class="pager__count-sep">/</span>
      {{ count() }}
    </p>

    <ol class="pager__dots" aria-label="页面导航">
      <li v-for="(label, i) in labels" :key="i">
        <button
          class="pager__dot"
          :class="{ 'pager__dot--on': i === current }"
          type="button"
          :aria-label="label"
          :aria-current="i === current ? 'page' : undefined"
          @click="emit('go', i)"
        >
          <span class="pager__dot-mark" aria-hidden="true" />
        </button>
      </li>
    </ol>

    <button
      class="pager__arrow"
      type="button"
      :disabled="current >= count() - 1"
      aria-label="下一页"
      @click="emit('go', current + 1)"
    >
      <span aria-hidden="true">›</span>
    </button>

    <select class="pager__select" aria-label="跳转到页" :value="String(current)" @change="pick">
      <option v-for="(label, i) in labels" :key="i" :value="String(i)">
        {{ i + 1 }}. {{ label }}
      </option>
    </select>
  </div>
</template>

<style scoped>
.pager-nav {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.pager__arrow {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-ink);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}

.pager__arrow:disabled {
  opacity: 0.35;
  cursor: default;
}

.pager__count {
  flex: 0 0 auto;
  margin: 0;
  padding: 0 2px;
  color: var(--c-ink-3);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.pager__count b {
  color: var(--c-ink);
  font-size: 15px;
}

.pager__count-sep {
  padding: 0 2px;
}

.pager__dots {
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  gap: 2px;
  margin: 0 0 0 4px;
  padding: 0;
  list-style: none;
  overflow-x: auto;
  scrollbar-width: none;
}

.pager__dots::-webkit-scrollbar {
  display: none;
}

.pager__dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 36px;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
}

.pager__dot-mark {
  display: block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--c-line);
  transition: background-color 120ms linear;
}

.pager__dot--on .pager__dot-mark {
  background: var(--c-primary);
}

.pager__dot:hover .pager__dot-mark {
  background: var(--c-ink-3);
}

.pager__dot--on:hover .pager__dot-mark {
  background: var(--c-primary);
}

/* 宽屏：圆点；窄屏：下拉。两者互斥，不重复占位 */
.pager__select {
  display: none;
  flex: 0 0 auto;
  max-width: 128px;
  height: 34px;
  padding: 0 6px;
  border: 1px solid var(--c-line);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-ink);
  font: inherit;
  font-size: 13px;
}

@media (max-width: 1080px) {
  .pager__dots {
    display: none;
  }

  .pager__select {
    display: block;
  }
}

/* 手机：箭头缩到 32、计数让位给下拉（下拉里已有页码），否则顶栏装不下 */
@media (max-width: 720px) {
  .pager__arrow {
    width: 32px;
    height: 32px;
    font-size: 18px;
  }

  .pager__count {
    display: none;
  }

  .pager__select {
    max-width: 108px;
    height: 32px;
  }
}
</style>
