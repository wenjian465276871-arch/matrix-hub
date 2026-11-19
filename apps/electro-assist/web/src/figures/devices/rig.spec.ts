/** 材质工厂的共享语义：`paintedMaterial()` **不做按色缓存**。
 *
 *  ## 为什么钉这条（2026-11-19 复盘发现的"结论对、理由错"）
 *
 *  2026-11-16 的 `69ac2f9` 提交信息写着：根因是「`paintedMaterial()` **按色缓存**，
 *  给过渡筒写 `duct.material.side = 2` 把一大批共享面变成双面，软件渲染下成倍变慢」。
 *
 *  核实结果：**这个机制不存在**。从初始提交 `07ca4f7` 到现在，它每次调用都是
 *  `new MeshStandardMaterial(...)`；`git log -S paintedMaterial -- rig.ts` 只命中创建那一次。
 *  真正被缓存的只有纹理（`grain()` 的 `sharedGrain`），那是 Texture，不是 Material。
 *
 *  那次修复的**结论**（换成独立材质的写法）恰好是对的，但**理由**是错的，
 *  而且错理由被抄进了 `hvac.ts` 的注释，一直留到复盘才改。错理由比没理由更危险：
 *  它会让下一个人据此推断出别处也不安全（或反过来，觉得别处安全）。
 *
 *  这条用例把「不缓存」从口头约定变成可执行断言。将来谁真加了按色缓存，
 *  这里会红——而那个红的含义很具体：**`hvac.ts` 里每一处就地改 `.material.*`
 *  的地方，从此都有跨件副作用了**，先去把它们改成显式构造。
 */

import { describe, expect, it } from 'vitest'

import { paintedMaterial } from './rig'

describe('paintedMaterial 的共享契约', () => {
  it('同色两次调用返回不同实例（不做按色缓存）', () => {
    const a = paintedMaterial(0x8b9196)
    const b = paintedMaterial(0x8b9196)
    expect(a).not.toBe(b)
  })

  it('改一份的 side 不会影响另一份', () => {
    const a = paintedMaterial(0x8b9196)
    const b = paintedMaterial(0x8b9196)
    a.side = 2
    expect(b.side).not.toBe(2)
    // 恢复，避免同一个测试文件里后续用例拿到被改过的实例
    a.side = 0
  })

  it('纹理是共享的（那是 Texture 层的缓存，不是 Material 层）', () => {
    const a = paintedMaterial(0x8b9196)
    const b = paintedMaterial(0x9aa0a6)
    // 不同颜色的材质共用同一张 grain 纹理——这是有意为之的省显存做法，
    // 但它的含义是：**改纹理属性**会跨件生效，改材质属性不会。两者别混。
    expect(a.roughnessMap).toBe(b.roughnessMap)
  })
})
