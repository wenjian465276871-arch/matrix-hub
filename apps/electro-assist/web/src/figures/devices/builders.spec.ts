/** 三台设备的几何构建契约：不碰 WebGL，只验「造得出来、键对得上、时间轴推得动」。
 *
 *  ## 为什么值得测
 *
 *  `buildDoor()` / `buildPantograph()` / `buildCabinet()` 两千多行，几乎全是
 *  `mesh.position.set(...)` 的堆叠。这类代码的失败方式是**静默**的：
 *  少 add 一个件、键名拼错、某个 t 分支出 NaN——页面照样渲染出一张好看的图，
 *  只是那一步的图不对。E2E 只能断言「三维图存在」，看不出少了哪个件、哪个件在漂。
 *
 *  这里钉三件事：
 *  1. **键名**：`parts` 的键必须与后端 `models/visual.py` 的 `DEVICE_SUBJECTS` 一致。
 *     拼错一个字母，模型选中的 part 就永远不高亮，而两边都不会报错。
 *  2. **时间轴**：后端 `DEVICE_MOMENTS` 里每个 `t` 都要能推，且不产生 NaN。
 *     NaN 在 three 里不会抛异常，它会让整台设备消失或飞走。
 *  3. **剖切**：声明了 `cut` 的设备必须真的能开关与定位，否则演示页那个开关是死的。
 *
 *  ## 为什么不需要 WebGL
 *
 *  构建函数只创建 BufferGeometry / Mesh / Material，这些是纯 CPU 对象；
 *  只有 `WebGLRenderer` 需要 GPU。所以 `DeviceScene.vue` 不进这份测试（它造渲染器），
 *  由 E2E 在真实浏览器里覆盖。
 */
import { describe, expect, it } from 'vitest'

import type { DeviceRig } from './rig'
import { buildCabinet } from './cabinet'
import { buildDoor } from './door'
import { buildPantograph } from './pantograph'
import { createSection } from './section'
// 契约文件由后端生成（`api/scripts/export_contract.py`），**不要手改**。
// 这份 import 就是这条用例的全部意义：部件清单来自后端，而不是在这里再抄一遍。
// 2026-11-10 评审 P2-1：上一版是硬编码数组，给后端加一个部件键它照样全绿。
import CONTRACT from '../../contract/devices.json'

const BUILDERS: Record<string, () => DeviceRig> = {
  door: buildDoor,
  pantograph: buildPantograph,
  cabinet: buildCabinet,
}

type ContractDevice = {
  parts: string[]
  part_labels: Record<string, string>
  moments: Array<{ t: number; key: string; label: string }>
  systems: string[]
}

const CONTRACT_DEVICES = CONTRACT.devices as unknown as Record<string, ContractDevice>

const DEVICES = Object.entries(CONTRACT_DEVICES).map(([name, info]) => ({
  name,
  build: BUILDERS[name],
  parts: info.parts,
  // `t` 用后端表里的值：那正是模型能选的瞬间，也是最该保证推得动的几个点。
  moments: info.moments.map((m) => m.t),
}))

/** 遍历整棵树找 NaN。three 里 NaN 不抛错，只会让几何体凭空消失。 */
function assertNoNaN(rig: DeviceRig, label: string): void {
  rig.root.updateMatrixWorld(true)
  let checked = 0
  rig.root.traverse((node) => {
    checked += 1
    const { x, y, z } = node.position
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error(`${label}：节点 ${node.name || node.type} 的位置是 NaN`)
    }
    if (!Number.isFinite(node.scale.x) || !Number.isFinite(node.scale.y)) {
      throw new Error(`${label}：节点 ${node.name || node.type} 的缩放是 NaN`)
    }
  })
  expect(checked).toBeGreaterThan(10)
}

describe('契约覆盖', () => {
  it('后端每台设备前端都有实现', () => {
    // 后端加了第四台设备而前端没写 build，这条会红——比在页面上发现"切过去是空白"早得多。
    for (const name of Object.keys(CONTRACT_DEVICES)) {
      expect(BUILDERS[name], `缺少 ${name} 的构建函数`).toBeTypeOf('function')
    }
  })

  it('后端每个部件键都有中文释义', () => {
    // 释义是给模型看的（`drive2` 这种键只给缩写等于让它猜），缺一条等于那个键失去语义。
    for (const [name, info] of Object.entries(CONTRACT_DEVICES)) {
      for (const part of info.parts) {
        expect(info.part_labels[part], `${name}.${part} 缺释义`).toBeTruthy()
      }
    }
  })
})

describe.each(DEVICES)('$name 设备' , ({ name, build, parts, moments }) => {
  it('能构建出非空场景', () => {
    const rig = build()
    expect(rig.root.children.length).toBeGreaterThan(0)
    expect(typeof rig.setT).toBe('function')
    expect(typeof rig.dispose).toBe('function')
    rig.dispose()
  })

  it('parts 键与后端白名单一致', () => {
    const rig = build()
    // 只比对"后端允许的键都在"：前端多挂几个内部件（如 motor / wires）不该报错，
    // 那些只是没开放给模型选。
    for (const key of parts) {
      expect(rig.parts[key], `缺少部件 ${key}`).toBeTruthy()
      expect(rig.parts[key].isObject3D, `${key} 不是 Object3D`).toBe(true)
    }
    rig.dispose()
  })

  it('时间轴每个可指名瞬间都能推且不产生 NaN', () => {
    const rig = build()
    for (const t of moments) {
      expect(() => rig.setT(t)).not.toThrow()
      assertNoNaN(rig, `${name}@${t}`)
      expect(rig.phase(t).length).toBeGreaterThan(0)
    }
    rig.dispose()
  })

  it('取景参数是有限数', () => {
    const rig = build()
    expect(rig.framing.target).toHaveLength(3)
    for (const v of rig.framing.target) expect(Number.isFinite(v)).toBe(true)
    expect(rig.framing.distance).toBeGreaterThan(0)
    expect(Number.isFinite(rig.framing.distance)).toBe(true)
    if (rig.fov !== undefined) {
      expect(rig.fov).toBeGreaterThan(5)
      expect(rig.fov).toBeLessThan(90)
    }
    if (rig.envIntensity !== undefined) {
      expect(rig.envIntensity).toBeGreaterThan(0)
      expect(rig.envIntensity).toBeLessThanOrEqual(3)
    }
    rig.dispose()
  })

  it('随动作取景在全程都是有限数', () => {
    const rig = build()
    if (!rig.framingAt) {
      // 只有行程大的设备才声明随动；没有就是没有，不该补一个假的。
      expect(rig.framingAt).toBeUndefined()
      rig.dispose()
      return
    }
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const at = rig.framingAt(t)
      expect(at.target).toHaveLength(3)
      for (const v of at.target) expect(Number.isFinite(v)).toBe(true)
      expect(at.distance).toBeGreaterThan(0)
    }
    rig.dispose()
  })

  it('声明了剖切就能真的开关与定位', () => {
    const rig = build()
    if (!rig.cut) {
      expect(rig.cut).toBeUndefined()
      rig.dispose()
      return
    }
    const cutter = createSection(rig.root, rig.cut)
    expect(() => cutter.setEnabled(true)).not.toThrow()
    expect(() => cutter.setAt(0)).not.toThrow()
    expect(() => cutter.setAt(0.5)).not.toThrow()
    expect(() => cutter.setAt(1)).not.toThrow()
    expect(() => cutter.setEnabled(false)).not.toThrow()
    cutter.dispose()
    rig.dispose()
  })
})

describe('两次构建互不共享可变状态', () => {
  it('分别 setT 之后互不影响', () => {
    // 踩过的坑：材质/纹理如果在模块作用域里建一次复用，切场景再回来会带着上一台的
    // emissive 色。这里用最直接的方式验：两次构建、各推不同进度，几何体不该相同。
    const a = buildDoor()
    const b = buildDoor()
    expect(a.root).not.toBe(b.root)
    a.setT(0.95)
    b.setT(0)
    expect(a.parts.leaf_l.position.x).not.toBeCloseTo(b.parts.leaf_l.position.x, 6)
    a.dispose()
    b.dispose()
  })
})
