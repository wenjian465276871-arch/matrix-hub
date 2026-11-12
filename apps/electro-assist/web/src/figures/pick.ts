/** 三维拾取：从命中的 mesh 反查它属于哪个部件键。
 *
 *  ## 为什么单独一个文件
 *  `DeviceScene` 里那段代码要 WebGL 才能跑，单测覆盖不到；而"点到了哪个件"
 *  恰恰是最容易错的一步：`raycaster` 返回的是**叶子 mesh**（弓头的一根碳滑板、
 *  手柄上的一颗球头），而 DSL 里的部件键挂在**组**上（`head` / `brake`）。
 *  少往上爬一层，点击就永远匹配不到键，页面上表现为"点了没反应"——
 *  没有报错、没有日志，最难查。
 *
 *  所以把"往上找键"抽成纯函数，用假对象树测；`DeviceScene` 只负责坐标与射线。
 */
import type { Object3D } from 'three'

/**
 * 沿父链向上找，返回第一个属于 `parts` 的键。
 *
 * 找不到返回 `null`（点到了地面、背景墙这类没注册的件）。不做"就近猜一个"：
 * 猜错会把点击派发到别的动作上，比不响应更糟。
 */
export function partKeyOf(parts: Record<string, Object3D>, object: Object3D | null): string | null {
  let node: Object3D | null = object
  while (node) {
    for (const [key, root] of Object.entries(parts)) {
      if (root === node) return key
    }
    node = node.parent
  }
  return null
}
