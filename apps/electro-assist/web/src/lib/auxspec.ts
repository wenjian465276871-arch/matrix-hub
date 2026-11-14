/** `DeviceScene` 的 `aux` 串：`scene|k=v;k=v`。
 *
 *  ## 为什么单独一个文件
 *  这段解析原来写在 `driver_desk.ts` 的 `setAux()` 里，只有真浏览器才跑得到。
 *  结果第一条分号就写错了：`split('|')` 之后只剩一个 token，
 *  于是 `mode` 读成 `cool;temp=24;fresh=closed;on=1`——**页面上看着"有内容"**，
 *  实际每一项都落回默认值（模式显示"停止"、状态显示"未上电"）。
 *  这种错靠肉眼截图极难发现，抽成纯函数加三条用例就钉死了。
 *
 *  ## 格式
 *  - 第一段是场景名：`panto` / `hvac` / `door`；
 *  - 后面可以有**多段**，每段内用 `;` 分隔 `k=v`；`|` 与 `;` 可混用。
 *  非法片段直接忽略（不抛错）：屏画不出来比整台设备打不开好。
 */

export interface AuxSpec {
  scene: string
  kv: Record<string, string>
}

export function parseAux(spec: string): AuxSpec {
  const [scene = '', ...rest] = spec.split('|')
  const kv: Record<string, string> = {}
  for (const group of rest) {
    for (const token of group.split(';')) {
      const at = token.indexOf('=')
      if (at > 0) kv[token.slice(0, at)] = token.slice(at + 1)
    }
  }
  return { scene, kv }
}
