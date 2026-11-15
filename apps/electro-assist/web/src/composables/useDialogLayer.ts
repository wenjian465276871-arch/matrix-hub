/** 弹层焦点纪律（2026-11-15，R24-3）。
 *
 * ## 为什么要有这个东西
 *
 * 全站有 7 个 `role="dialog" aria-modal="true"`，改造前只有 3 个做全了「焦点移入 → Tab 不外逃
 * → Esc 关闭 → 关闭还原」：`ConfirmDialog`（手写 30 行）、`SiteDrawer`（同一套抄了一遍）、
 * `GuideFigure`（手写 Tab 分支）。剩下 4 个只处理了 Esc：
 * `OpsBoard` / `PantoOps` 的 MON 放大层、`GuideView` 的口令层、`NewGuideView` 的切图层
 * ——打开后按 Tab，焦点会跑到**被遮住的页面**上；读屏用户听到的还是整页。
 *
 * 这一类问题 `axe` 抓不到（它不是静态规则，要交互才暴露），只能靠断言 Tab 行为。
 *
 * ## 为什么不做 `inert` 背景
 *
 * `inert` 要加在"层之外的祖先"上，而这四个层都是**就地渲染**（不是 Teleport 到 body），
 * 它们的祖先里就包含层自己——给祖先加 `inert` 会把层一起冻住。
 * 要正确用 `inert` 得把层 Teleport 出去，那会改动定位与层叠关系，风险大于收益。
 * 所以这里用**焦点循环**（Tab 走不出去）达成同一个效果；
 * `ConfirmDialog` 与 `SiteDrawer` 现在也是这么做的，行为一致。
 *
 * ## 约定
 *
 * 1. 打开时焦点落到 `initialFocus()`（没给就落到层内第一个可聚焦元素）；
 * 2. Tab / Shift+Tab 在层内循环；焦点意外跑到层外（鼠标点了别处）时，下一次 Tab 会被拽回来；
 * 3. Esc 交给调用方的 `onEscape`——"能关"与"关了做什么"是两件事，不在这里猜；
 * 4. 关闭后焦点还原到打开它的那个元素（它可能已被卸载，故判 `document.contains`）；
 * 5. 打开期间锁 `body` 滚动，关闭解锁（计数式，允许层套层）；
 * 6. 层套层时让位：焦点在**别的** `role="dialog"` 里时，这一层不抢 Tab / Esc。
 */
import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** 锁滚动的计数：两个层同时开着时，先关的那个不能把滚动解锁了。 */
let locks = 0
let savedOverflow = ''

function lockScroll(): void {
  if (typeof document === 'undefined') return
  if (locks === 0) {
    savedOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  locks += 1
}

function unlockScroll(): void {
  if (typeof document === 'undefined') return
  locks = Math.max(0, locks - 1)
  if (locks === 0) document.body.style.overflow = savedOverflow
}

export interface DialogLayerOptions {
  /** Esc 时做什么。不给则 Esc 不拦（层不接受 Esc 关闭）。 */
  onEscape?: () => void
  /** 打开时优先聚焦谁。默认层内第一个可聚焦元素。 */
  initialFocus?: () => HTMLElement | null
}

export function useDialogLayer(
  open: Ref<boolean>,
  panel: Ref<HTMLElement | null>,
  options: DialogLayerOptions = {},
): void {
  let previous: HTMLElement | null = null
  let active = false

  function focusables(): HTMLElement[] {
    const root = panel.value
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
  }

  function inside(node: Element | null): boolean {
    return !!panel.value && !!node && panel.value.contains(node)
  }

  /** 焦点是否落在**别的**弹层里。层套层时（例如口令层之上又弹了确认框），
   *  键盘该由上面那层管，这一层必须让位——否则上面那层的 Tab 会被下面拽回去。 */
  function insideOtherLayer(node: Element | null): boolean {
    if (!node) return false
    const host = node.closest('[role="dialog"]')
    return !!host && host !== panel.value
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!active) return
    if (event.key === 'Escape') {
      if (!options.onEscape) return
      // 上面还压着别的层就不管：`ConfirmDialog` 是捕获阶段监听并 `stopPropagation`，
      // 正常情况下这里根本收不到；这一句是给"非捕获实现"兜底。
      if (insideOtherLayer(document.activeElement)) return
      event.preventDefault()
      event.stopPropagation()
      options.onEscape()
      return
    }
    if (event.key !== 'Tab') return
    if (insideOtherLayer(document.activeElement)) return
    const list = focusables()
    if (!list.length) return
    const first = list[0]
    const last = list[list.length - 1]
    const current = document.activeElement
    if (event.shiftKey && (current === first || !inside(current))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (current === last || !inside(current))) {
      event.preventDefault()
      first.focus()
    }
  }

  function activate(): void {
    if (active) return
    active = true
    previous = (document.activeElement as HTMLElement | null) ?? null
    // **冒泡阶段**而不是捕获：`ConfirmDialog` 在捕获阶段处理 Esc 并 `stopPropagation`，
    // 监听冒泡就等于"上面的确认框优先"；反过来（两层都捕获）会变成
    // "后注册的先响应"，谁是上层取决于挂载顺序，不可靠。
    document.addEventListener('keydown', onKeydown)
    lockScroll()
    void nextTick(() => {
      const target = options.initialFocus?.() ?? focusables()[0] ?? panel.value
      target?.focus?.()
    })
  }

  function deactivate(): void {
    if (!active) return
    active = false
    document.removeEventListener('keydown', onKeydown, true)
    unlockScroll()
    // 触发元素可能已经随状态变化卸载了（例如会话结束），兜底不抛错。
    if (previous && document.contains(previous)) previous.focus()
    previous = null
  }

  watch(open, (value) => (value ? activate() : deactivate()), { immediate: true })
  onBeforeUnmount(deactivate)
}
