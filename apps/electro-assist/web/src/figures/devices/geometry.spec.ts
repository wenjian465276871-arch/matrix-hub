/** 8 台设备的「无悬空件」门禁 + 审计器自身的负例。
 *
 *  判据与阈值来历见 `geometry-audit.ts` 的文件头。一句话：包围盒间距是真实
 *  距离的下界，所以"盒间距 > 8mm"不会冤枉代码，只会少抓。
 *
 *  2026-11-12 首次跑出 21 处脱开、修掉 6 处真缺陷（端子排没导轨、指示灯没 PCB、
 *  挡风板离盘管、红色安全阀离板面、接地编织带起点、第二颗螺栓）之后归零。
 */
import { describe, expect, it } from 'vitest'
import { Box3, BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Vector3 } from 'three'

import { buildCabinet } from './cabinet'
import { buildDoor } from './door'
import { buildFeelerGauge } from './feeler_gauge'
import { DETACH_TOL, auditRig, boxGap, findDetached, type MeshBox } from './geometry-audit'
import { buildHvac } from './hvac'
import { buildMultimeter } from './multimeter'
import { buildPantograph } from './pantograph'
import { buildTorqueWrench } from './torque_wrench'
import { buildWarningSign } from './warning_sign'

const BUILDERS: Record<string, () => ReturnType<typeof buildDoor>> = {
  door: buildDoor,
  pantograph: buildPantograph,
  cabinet: buildCabinet,
  hvac: buildHvac,
  multimeter: buildMultimeter,
  warning_sign: buildWarningSign,
  feeler_gauge: buildFeelerGauge,
  torque_wrench: buildTorqueWrench,
}

describe.each(Object.keys(BUILDERS))('%s 的几何自检', (name) => {
  it('没有零件脱开超过 8mm', () => {
    const rig = BUILDERS[name]()
    // 取动作结束态：检修盖板已拆下、门已开到位——被隐藏的件不参与判断
    rig.setT(1)
    const { total, detached } = auditRig(rig)
    // 防止遍历写坏导致"0 个网格 = 全部通过"
    expect(total, `${name} 没有收集到任何网格`).toBeGreaterThan(10)
    expect(
      detached.map((d) => `${d.part}/${d.name} 脱开 ${(d.gap * 1000).toFixed(1)}mm，最近的是 ${d.nearest}`),
    ).toEqual([])
    rig.dispose()
  })
})

describe('审计器本身', () => {
  it('间距能算对：两盒相距 20mm 时 gap=0.02，相交时 0', () => {
    const size = new Vector3(0.1, 0.1, 0.1)
    const a = new Box3().setFromCenterAndSize(new Vector3(0, 0, 0), size)
    // 中心距 0.12、各半宽 0.05 → 净距 0.02
    const b = new Box3().setFromCenterAndSize(new Vector3(0.12, 0, 0), size)
    expect(boxGap(a, b)).toBeCloseTo(0.02, 6)
    const c = new Box3().setFromCenterAndSize(new Vector3(0.05, 0, 0), size)
    expect(boxGap(a, c)).toBe(0)
  })

  it('**负例**：真放一个悬空的盒子进去，必须被抓出来', () => {
    // 三个盒子：两个贴在一起（间距 2mm），第三个飞到 30mm 外
    const size = new Vector3(0.1, 0.1, 0.1)
    const mk = (x: number, part: string): MeshBox => ({
      part,
      name: 'box',
      box: new Box3().setFromCenterAndSize(new Vector3(x, 0, 0), size),
    })
    const boxes = [mk(0, 'a'), mk(0.102, 'a'), mk(0.35, 'b')]
    const found = findDetached(boxes)
    expect(found).toHaveLength(1)
    expect(found[0].part).toBe('b')
    // b 在 0.30..0.40，最近的邻居是 0.052..0.152 → 净距 0.148
expect(found[0].gap).toBeCloseTo(0.148, 6)
  })

  it('**负例**：隐藏的件不算悬空（拆下来的盖板本来就不在场景里）', () => {
    const rig = BUILDERS.hvac()
    // 把压缩机整个藏起来：它不应再被当成"悬空"
    const hidden: Object3D = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial())
    hidden.visible = false
    hidden.position.set(5, 5, 5)
    rig.parts.compressor.add(hidden)
    const { detached } = auditRig(rig)
    expect(detached.map((d) => d.name)).not.toContain('BoxGeometry')
    rig.dispose()
  })

  it('阈值是 8mm（改动它必须同步改这条与文件头）', () => {
    expect(DETACH_TOL).toBe(0.008)
  })
})
