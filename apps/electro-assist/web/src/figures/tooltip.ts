/**
 * 三维悬停气泡的排版与定位。
 *
 * ## 为什么单独抽出来
 *
 * `DeviceScene.vue` 里那段代码要 WebGL 才能跑，单测覆盖不到；而"气泡该弹在哪、
 * 名称怎么拆成两行"是纯算术，却正好是最容易出错的地方——靠截图调一次只能证明
 * "这一次对了"，换个窗口宽度就溢出画布外。抽成纯函数后，边界条件由 `tooltip.spec.ts`
 * 直接断言。
 *
 * ## 两个约束
 *
 * 1. 后端 `models/visual.py` 的 `part_labels` 是**一句带解释的长文案**
 *    （"制动控制器 / 制动手柄（运行、B1–B7、快速、拔取位）"）。整句塞进气泡，
 *    用户得读两遍才能找到设备名；拆成"主名 + 备注"两行，第一行就是他要找的字。
 * 2. 气泡跟着鼠标走，靠近画布右/下边缘时必须翻到另一侧，否则一半在框外看不见。
 */

/** 拆成"主名 + 备注"。分隔符按出现位置取最靠前的那个括号。 */
export function splitLabel(label: string): { name: string; note: string } {
  const text = label.trim()
  if (!text) return { name: '', note: '' }
  // 全角（和半角 ( 都认：后端两种都写过
  const at = [text.indexOf('（'), text.indexOf('(')].filter((i) => i > 0)
  if (!at.length) return { name: text, note: '' }
  const cut = Math.min(...at)
  const tail = text.slice(cut + 1).replace(/[）)]\s*$/, '')
  return { name: text.slice(0, cut).trim(), note: tail.trim() }
}

export interface TipPlacement {
  /** 相对容器左上角的像素位置（气泡自身左上角）。 */
  left: number
  top: number
  /** 是否翻了边。调试与截图断言用。 */
  flipX: boolean
  flipY: boolean
}

/** 光标与气泡之间的间隙。太小会被手指/光标压住，太大又离得远。 */
export const TIP_GAP = 14
/** 容器每侧留的边距：贴边弹会看着像被裁掉。 */
export const TIP_PAD = 6

/**
 * 算气泡位置，保证整个气泡落在容器内。
 *
 * - 默认在光标右下方（`TIP_GAP` 处）；
 * - 右边放不下就翻到光标左侧，下边放不下就翻到上方；
 * - 无论怎么翻，最后都夹回容器内——画布小到装不下气泡时（气泡比容器还大），
 *   夹取会退化成贴左上角，这比让它溢出到页面外要好。
 *
 * `cursor` 与返回值都是**相对容器**的坐标，调用方负责把 clientX/Y 减掉
 * `getBoundingClientRect()`。
 */
export function placeTip(
  cursor: { x: number; y: number },
  box: { w: number; h: number },
  tip: { w: number; h: number },
): TipPlacement {
  let left = cursor.x + TIP_GAP
  let flipX = false
  if (left + tip.w > box.w - TIP_PAD) {
    left = cursor.x - TIP_GAP - tip.w
    flipX = true
  }

  let top = cursor.y + TIP_GAP
  let flipY = false
  if (top + tip.h > box.h - TIP_PAD) {
    top = cursor.y - TIP_GAP - tip.h
    flipY = true
  }

  const maxLeft = Math.max(TIP_PAD, box.w - tip.w - TIP_PAD)
  const maxTop = Math.max(TIP_PAD, box.h - tip.h - TIP_PAD)
  return {
    left: Math.min(Math.max(left, TIP_PAD), maxLeft),
    top: Math.min(Math.max(top, TIP_PAD), maxTop),
    flipX,
    flipY,
  }
}
