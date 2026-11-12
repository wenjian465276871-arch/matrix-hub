/** 几何自检：**没有零件悬在空中**。
 *
 *  ## 这条门禁补的是哪一类漏洞
 *
 *  我们的设备是程序化几何拼出来的，件与件之间的位置全靠手写坐标。写错一个数
 *  （少加一个 group 偏移、板宽算反、把螺母高度当成中心高度）时，页面照样渲染出
 *  一张很好看的三维图，只是某个零件**浮在空气里**——1× 看不出来，4× 特写里
 *  一眼就露馅，而它恰恰是客户/本人放大看时最先注意到的那类缺陷。
 *
 *  实测（2026-11-12，写这条门禁之前）8 台设备共 21 处脱开，其中 6 处是真缺陷：
 *  - 配电柜 10 个端子块整体悬空 6mm（下面是空的，没有导轨）；
 *  - 空调控制盒里 3 只指示灯悬空 26mm（没有 PCB）；
 *  - 空调冷凝器挡风板离盘管 10.6mm；
 *  - 受电弓红色安全阀离板面 15mm（它比别的元件窄，中心却用了同一个 x）；
 *  - 受电弓三根接地编织带起点比螺母低 8.3mm（挂在空气里）；
 *  - 扭矩扳手旁边那颗"已复紧的螺栓"浮在安装座前面 17mm。
 *
 *  ## 判据为什么是可靠的
 *
 *  用**世界包围盒间距**：`boxGap(A,B)` 是真实最小距离的**下界**
 *  （包围盒一定不小于实体）。所以"盒间距 > 8mm"可以断言"真的脱开了"，
 *  不会误报。反过来它会漏报（细长件斜放时包围盒很大，两个真挨着的件也满足
 *  盒间距 0），但漏报只是少抓，不会冤枉代码——门禁要的是可信，不是完备。
 *
 *  ## 阈值 8mm 的来历
 *
 *  我们的装配里确实存在 5–6.5mm 的设计间隙（端子面、卡箍内侧）。8mm 高于这些
 *  正常间隙，又远低于实测缺陷的 15–26mm，两头都留得住。
 */
import type { Box3, Mesh, Object3D } from 'three'
import { Box3 as Box3Ctor } from 'three'

import type { DeviceRig } from './rig'

/** 允许的最大脱开距离（米）。超过它就算悬空。 */
export const DETACH_TOL = 0.008

export interface MeshBox {
  part: string
  name: string
  box: Box3
}

/** 两个轴对齐盒之间的最短距离；相交返回 0。 */
export function boxGap(a: Box3, b: Box3): number {
  const dx = Math.max(0, a.min.x - b.max.x, b.min.x - a.max.x)
  const dy = Math.max(0, a.min.y - b.max.y, b.min.y - a.max.y)
  const dz = Math.max(0, a.min.z - b.max.z, b.min.z - a.max.z)
  return Math.hypot(dx, dy, dz)
}

/** 收集一个部件下所有**可见**网格的世界包围盒。
 *  隐藏件（拆下的盖板、没通电的指示灯）不参与判断——它们本来就不在场景里。 */
export function collectBoxes(part: Object3D, partKey: string): MeshBox[] {
  const out: MeshBox[] = []
  part.updateWorldMatrix(true, true)
  part.traverse((o) => {
    const mesh = o as Mesh
    if (!mesh.isMesh) return
    let cur: Object3D | null = o
    while (cur) {
      if (!cur.visible) return
      cur = cur.parent
    }
    const box = new Box3Ctor().setFromObject(mesh)
    if (box.isEmpty()) return
    out.push({ part: partKey, name: mesh.name || mesh.geometry.type, box })
  })
  return out
}

export interface Detached {
  part: string
  name: string
  gap: number
  /** 最近的那个件，报错时一眼能看出该接到哪儿 */
  nearest: string
}

/** 找出所有"离任何其它网格都超过 tol"的网格。 */
export function findDetached(boxes: MeshBox[], tol = DETACH_TOL): Detached[] {
  const out: Detached[] = []
  for (let i = 0; i < boxes.length; i += 1) {
    let best = Infinity
    let nearest = ''
    for (let j = 0; j < boxes.length; j += 1) {
      if (i === j) continue
      const gap = boxGap(boxes[i].box, boxes[j].box)
      if (gap < best) {
        best = gap
        nearest = `${boxes[j].part}/${boxes[j].name}`
      }
      if (best === 0) break
    }
    if (best > tol) {
      out.push({ part: boxes[i].part, name: boxes[i].name, gap: best, nearest })
    }
  }
  return out.sort((a, b) => b.gap - a.gap)
}

/** 对一台已构建的 rig 跑一遍自检。 */
export function auditRig(rig: DeviceRig, tol = DETACH_TOL): { total: number; detached: Detached[] } {
  rig.root.updateMatrixWorld(true)
  const boxes = Object.keys(rig.parts).flatMap((key) => collectBoxes(rig.parts[key], key))
  return { total: boxes.length, detached: findDetached(boxes, tol) }
}
