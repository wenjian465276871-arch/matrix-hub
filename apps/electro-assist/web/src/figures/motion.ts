/** 动效轨道 → CSS 类。
 *
 *  为什么不是 `style="animation-duration: 900ms"`：CSP 是 `style-src 'self'`，
 *  内联 style 属性会被浏览器直接丢弃，动画写了也等于没写（见 `svg.ts` 同一约束）。
 *  所以时长只能落进固定档位，档位由 CSS 类承载。
 *
 *  槽位找不到时**不画**，也不抛错：动效是可选强调，缺一条不该让整张图降级。
 *  真正的错误在服务端就被拒了（models/visual.py `_check_motion`）。
 */
import type { MotionTrack } from '../types'

/** 三档：短（≤600）、常规（≤1200）、长（>1200）。
 *  视觉规范没有规定具体毫秒，取这三档是因为 CSS 只能写到类里，
 *  再多档位就是在用类名模拟连续变量。 */
function durationClass(ms: number): string {
  if (ms <= 600) return 'fig-anim--fast'
  if (ms <= 1200) return 'fig-anim--mid'
  return 'fig-anim--slow'
}

export function motionClass(motion: MotionTrack[] | undefined, slot: string): string {
  const track = motion?.find((item) => item.target === slot)
  if (!track) return ''
  return `fig-anim fig-anim--${track.anim} ${durationClass(track.duration)}`
}

/** 拆成数组给模板用（`<g>` 上同时挂多个类时比字符串拼接好读）。 */
export function motionClasses(motion: MotionTrack[] | undefined, slot: string): string[] {
  const cls = motionClass(motion, slot)
  return cls ? cls.split(' ') : []
}
