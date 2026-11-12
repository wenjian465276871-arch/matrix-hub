/** 拾取反查的单元测试：用假对象树，不碰 WebGL。 */
import { describe, expect, it } from 'vitest'
import { Group, Mesh } from 'three'

import { partKeyOf } from './pick'

function tree(): { parts: Record<string, Group>; leaf: Mesh; orphan: Mesh } {
  const brake = new Group()
  const lever = new Group()
  const knob = new Mesh()
  lever.add(knob)
  brake.add(lever)

  const desk = new Group()
  const plate = new Mesh()
  desk.add(plate)

  const orphan = new Mesh() // 没注册到 parts 的件（地面、背景）
  return { parts: { brake, desk }, leaf: knob, orphan }
}

describe('partKeyOf', () => {
  it('命中叶子 mesh 时能往上找到所属部件键', () => {
    const { parts, leaf } = tree()
    expect(partKeyOf(parts, leaf)).toBe('brake')
  })

  it('命中组本身也能找到', () => {
    const { parts } = tree()
    expect(partKeyOf(parts, parts.desk)).toBe('desk')
  })

  it('点到未注册的件返回 null，不猜', () => {
    const { parts, orphan } = tree()
    expect(partKeyOf(parts, orphan)).toBeNull()
    expect(partKeyOf(parts, null)).toBeNull()
  })

  it('先命中近的键：嵌套部件以最近的那个为准', () => {
    // 同一棵树下再注册一个内层组，点到内层必须返回内层键
    const outer = new Group()
    const inner = new Group()
    const mesh = new Mesh()
    inner.add(mesh)
    outer.add(inner)
    const parts = { outer, inner } as unknown as Record<string, Group>
    expect(partKeyOf(parts, mesh)).toBe('inner')
  })
})
