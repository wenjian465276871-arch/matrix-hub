/** 交互状态的作用域：**一份指导书一套状态**。
 *
 * ## 为什么需要它
 * 2026-11-14 本人实测：先从空调试验切到车门试验，还没插钥匙，司机室操纵台就是"已上电"的
 * ——因为 `desk-power` / `panto-session` 都是模块级单例，跨指导书共享。
 *
 * 单例本身是对的：阅读器一步一屏、只挂当前页 ±1，状态放进组件会在翻页时清零。
 * 缺的是**边界**——状态该活在"这次试验"里，而不是"整个应用会话"里。
 * 所以进出指导书时清一次：换一份指导书 = 重新开始一次试验。
 *
 * ## 为什么放在视图里调
 * 只有路由层知道"当前是哪一份指导书"。图形组件拿到的只有 `params`，
 * 让它们去读路由会把"能单独渲染"的单元测试路径弄断（`mount` 里没有 router）。
 */
import { reset as resetDoor } from './door-session'
import { resetPower } from './desk-power'
import { reset as resetHvac } from './hvac-session'
import { reset as resetPanto } from './panto-session'

/** 把四项试验状态一起清回初始值。换指导书时调用。 */
export function resetAllOps(): void {
  resetPanto()
  resetPower()
  resetHvac()
  resetDoor()
}
