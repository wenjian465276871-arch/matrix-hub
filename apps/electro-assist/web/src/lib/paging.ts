/** 翻页阅读器的纯逻辑：页数、边界、滚动位置与"上次读到第几页"。
 *
 *  抽出来的理由与 `demoreads.ts` 同：这些判断错一次，现场看到的就是**错的那一步**，
 *  而页面本身完全正常——没有测试根本发现不了。DOM 与滚动留给组件，
 *  这里只做可以拿数字断言的部分。
 */

/** 页数 = 封面 1 + 步骤 N + 尾页（有未归位素材时才有）。 */
export function pageCount(stepCount: number, hasTail: boolean): number {
  const steps = Math.max(0, Math.floor(stepCount))
  return 1 + steps + (hasTail ? 1 : 0)
}

/** 夹到 [0, count-1]。空数据时不返回负数——`Math.min(0, -1)` 是 -1，会让下标取到 undefined。 */
export function clampPage(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) return 0
  const last = count - 1
  const value = Math.round(index)
  if (value < 0) return 0
  return value > last ? last : value
}

/**
 * 从滚动位置反推当前页。`scroll-snap` 会在停稳后对齐，但滚动过程中
 * `scrollLeft` 是连续值，必须在半页处四舍五入——否则滑到 49% 就翻页，
 * 手指还没松，画面已经跳到下一页。
 */
export function pageIndexFromScroll(scrollLeft: number, pageWidth: number, count: number): number {
  if (!Number.isFinite(scrollLeft) || !Number.isFinite(pageWidth) || pageWidth <= 0) return 0
  return clampPage(scrollLeft / pageWidth, count)
}

/** 每页的读屏名称：封面 / 第 N 步：标题 / 现场素材。
 *
 *  两处都要用（圆点的 aria-label 与翻页播报），所以放在这里而不是某个组件里——
 *  放两处就一定会有一处忘了跟着步骤改名。 */
export function pageLabels(
  steps: ReadonlyArray<{ seq: number; title: string }>,
  hasTail: boolean,
): string[] {
  const list = ['封面']
  for (const step of steps) list.push(`第 ${step.seq} 步：${step.title}`)
  if (hasTail) list.push('现场素材')
  return list
}

/** 每份指导书单独记位置：从 A 指导书读到第 5 步，不该影响 B 的进度。 */
export function pageStorageKey(guideId: string): string {
  return `electro:guide-page:${guideId}`
}

type Readable = Pick<Storage, 'getItem'>
type Writable = Pick<Storage, 'setItem'>

/** 读回上次位置。任何异常（隐私模式禁用 storage、值被改坏）都退回封面。 */
export function loadPage(key: string, count: number, store?: Readable): number {
  try {
    const target = store ?? globalThis.sessionStorage
    const raw = target?.getItem(key)
    if (raw === null || raw === undefined || raw === '') return 0
    const value = Number(raw)
    if (!Number.isInteger(value)) return 0
    return clampPage(value, count)
  } catch {
    return 0
  }
}

/** 记住当前位置。写失败不影响阅读，所以静默吞掉。 */
export function savePage(key: string, index: number, store?: Writable): void {
  try {
    const target = store ?? globalThis.sessionStorage
    target?.setItem(key, String(Math.max(0, Math.round(index))))
  } catch {
    /* 隐私模式 / 配额满：位置记不住而已，不是错误 */
  }
}
