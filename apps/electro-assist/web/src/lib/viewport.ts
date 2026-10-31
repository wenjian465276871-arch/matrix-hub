/** 软键盘遮挡高度（计划 §12.5「软键盘用 visualViewport 上推底栏」）。
 *
 *  为什么不能用 `window.innerHeight`：iOS/Android 弹出软键盘时 `innerHeight` 与 `dvh`
 *  都不变，只有 `visualViewport.height` 变小、`offsetTop` 变大。底栏是 `position: fixed;
 *  bottom: 0`，于是正好被键盘盖住——现场输入判据时看不到「提交本步」。
 *
 *  为什么要有阈值：浏览器地址栏收起/展开也会让 visualViewport 抖动几十像素，
 *  低于 120px 一律当作工具栏，不顶底栏。否则页面会在滚动时上下跳。
 */

export interface ViewportLike {
  height: number
  offsetTop: number
}

export const KEYBOARD_THRESHOLD = 120

export function keyboardInset(
  innerHeight: number,
  vv: ViewportLike | null,
  threshold: number = KEYBOARD_THRESHOLD,
): number {
  if (!vv) return 0
  const inset = Math.round(innerHeight - vv.height - vv.offsetTop)
  return inset >= threshold ? inset : 0
}

/** 订阅视口变化，返回取消订阅函数。不支持 visualViewport 的旧内核直接退化为 0。 */
export function watchKeyboardInset(apply: (inset: number) => void): () => void {
  const vv = typeof window === 'undefined' ? null : window.visualViewport
  if (!vv) {
    apply(0)
    return () => {}
  }

  const sync = (): void => apply(keyboardInset(window.innerHeight, vv))
  vv.addEventListener('resize', sync)
  // scroll 也要听：iOS 键盘弹出时常只触发 scroll 不触发 resize
  vv.addEventListener('scroll', sync)
  window.addEventListener('orientationchange', sync)
  sync()

  return () => {
    vv.removeEventListener('resize', sync)
    vv.removeEventListener('scroll', sync)
    window.removeEventListener('orientationchange', sync)
  }
}
