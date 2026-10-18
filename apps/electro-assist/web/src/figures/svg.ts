/** 图元渲染的共享工具。
 *
 * 两个硬约束（都来自 CSP `style-src 'self'`）：
 * 1. **不能用 `style` 属性**——内联样式会被 CSP 直接拦掉，所以颜色走 CSS 类、
 *    尺寸走 SVG 表现属性（`fill`/`stroke`/`font-size` 属于属性，不受 style-src 管）。
 * 2. **不能用 `<foreignObject>`**——HTML 嵌进 SVG 会被白名单渲染器拒绝。
 *
 * 文本换行只能手算：SVG 没有自动折行。按「CJK 记 1 个字宽、ASCII 记 0.55」估算，
 * 宁可估宽一点（多折一行）也不要溢出画布。
 */
import type { ParamValue } from '../types'

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/

/** 等宽字体栈：数值必须对齐，比例字体读表会错行。 */
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

export function num(value: ParamValue | undefined, name: string, fallback?: number): number {
  if (Array.isArray(value)) throw new Error(`参数 ${name} 应为标量，收到列表`)
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback
    throw new Error(`缺少参数 ${name}`)
  }
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n)) {
    if (fallback !== undefined) return fallback
    throw new Error(`参数 ${name} 不是有效数值`)
  }
  return n
}

export function str(value: ParamValue | undefined, fallback = ''): string {
  if (value === undefined || value === null) return fallback
  if (Array.isArray(value)) return value.join('、')
  return String(value)
}

/** 估算一段文本的显示宽度（px）。 */
export function textWidth(text: string, fontSize: number): number {
  let w = 0
  for (const ch of text) w += CJK.test(ch) ? fontSize : fontSize * 0.55
  return w
}

/** 按可用宽度折行，超出行数用省略号收尾。 */
export function wrapText(
  text: string,
  maxWidth: number,
  fontSize: number,
  maxLines = 3,
): string[] {
  const lines: string[] = []
  let current = ''
  let width = 0

  for (const ch of text) {
    const w = CJK.test(ch) ? fontSize : fontSize * 0.55
    if (width + w > maxWidth && current) {
      lines.push(current)
      current = ch
      width = w
      if (lines.length === maxLines) break
    } else {
      current += ch
      width += w
    }
  }

  if (lines.length < maxLines && current) lines.push(current)

  if (lines.length === maxLines) {
    const consumed = lines.join('').length
    if (consumed < text.length) {
      const last = lines[maxLines - 1]
      lines[maxLines - 1] = last.slice(0, Math.max(1, last.length - 1)) + '…'
    }
  }
  return lines
}

/** 把 "1-2-3" / "1,2,3" / "1 2 3" 这类串解析成数组。 */
export function splitList(value: ParamValue | undefined, pattern = /[-–—,、\s]+/): string[] {
  // 列表直接用；字符串才需要按分隔符拆。两种写法都要支持：
  // 老数据是 "1-2-3"，模型现在更爱输出 ["1","2","3"]。
  if (Array.isArray(value)) return value.map((s) => s.trim()).filter(Boolean)
  return str(value)
    .split(pattern)
    .map((s) => s.trim())
    .filter(Boolean)
}
