/** 剖切（section / cutaway）：把设备沿一个平面切开，切口里填深色断面。
 *
 *  ## 为什么不是「只加 clippingPlanes」
 *  裁剪是「丢弃片元」，不是「切开实体」。给一块钣金加裁剪平面后，被切掉那半消失，
 *  剩下的半截是**单层壳**：从切口看进去全是背面，而 PBR 材质默认只画正面，
 *  于是切口变成一个能看穿的空洞——比不切还假。
 *
 *  ## 为什么不用 stencil 封盖
 *  标准做法（three 官方 `webgl_clipping_stencil`）是给每个实体件加正/反两套
 *  「计数器」网格，用模板缓冲统计「这一点是否落在实体内部」，再用一块躺在切面上的
 *  平面按计数着色。实现在厚实体上是对的，但在**薄钣金**上不成立：门扇 42mm、
 *  墙体 90mm，正反两面的屏幕投影几乎完全重合，计数恒为 0，封盖面一个像素都画不出来
 *  （实测绿色封盖 0 像素，而把计数换成「画到就置 1」时边缘才出线）。
 *
 *  ## 实际做法：背面封盖
 *  给每个实体件加一个**同几何体的背面副本**，材质固定为断面深色。
 *  - 没被切到时，副本藏在正面之后，看不见；
 *  - 被切到时，正面那半消失，副本的背面就成了切口里的「实心填充」。
 *
 *  代价是断面不是严格平面（它是零件内壁的形状），但钣金件本来就是一层面，
 *  视觉上反而更真：切口里看到的是深色板料内表面，而不是一块凭空贴上去的色板。
 *  收益是它不依赖模板缓冲、不依赖渲染顺序，任何浏览器/显卡都不会静默失效。
 */
import {
  BackSide,
  Box3,
  CanvasTexture,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Plane,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
} from 'three'

/** 一个设备能怎么被剖开。坐标是**世界坐标**，单位米。 */
export interface CutSpec {
  /** 沿哪个轴切。 */
  axis: 'x' | 'y' | 'z'
  /** 滑块 0% 对应的坐标（切得最深）。 */
  from: number
  /** 滑块 100% 对应的坐标（完全不切）。 */
  to: number
  /** 断面颜色。默认深暖灰——断面要和漆面拉开明度，才读得出「切开了」。 */
  cap?: number
}

export interface SectionCutter {
  /** 开/关剖切。切换会改材质的 clippingPlanes，必须 needsUpdate 重编译。 */
  setEnabled: (on: boolean) => void
  /** 切面位置，0..1 归一化。只改 plane.constant，不重编译。 */
  setAt: (v: number) => void
  dispose: () => void
}

const AXIS: Record<CutSpec['axis'], Vector3> = {
  x: new Vector3(1, 0, 0),
  y: new Vector3(0, 1, 0),
  z: new Vector3(0, 0, 1),
}

/**
 * 45° 剖面线。一格四条，靠 repeat 控制间距。
 * 技术制图里断面一律打斜线，这是「这是切开的材料，不是又一个表面」的视觉契约，
 * 比单纯换颜色有效得多。
 */
function hatchTexture(): CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size, size)
    ctx.strokeStyle = 'rgba(255,255,255,0.34)'
    ctx.lineWidth = 5
    ctx.beginPath()
    // 两端溢出，保证平铺后接缝连续
    for (let i = -2; i < 5; i += 1) {
      const x = i * (size / 4)
      ctx.moveTo(x, 0)
      ctx.lineTo(x + size, size)
    }
    ctx.stroke()
  }
  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.anisotropy = 4
  return tex
}

/**
 * 给一棵设备树装上剖切能力。
 *
 * @param root 设备根节点
 * @param spec 剖切轴与范围
 */
export function createSection(root: Object3D, spec: CutSpec): SectionCutter {
  root.updateMatrixWorld(true)

  /* 平面法线指向**保留侧**：three 裁掉 `dot(n, p) + constant < 0` 的部分。
     n 取轴的反向、constant 取切点坐标，等价于「裁掉坐标大于切点的部分」，
     也就是从相机这一侧往里切。 */
  const axis = AXIS[spec.axis]
  const plane = new Plane(axis.clone().negate(), spec.to)

  const box = new Box3().setFromObject(root)
  const size = box.getSize(new Vector3())

  /* 断面材质：深色底 + 浅色斜线。整棵树共用一份，材质数量不随零件数增长。 */
  const pitch = 0.02
  const span = Math.max(size.x, size.y, size.z) * 1.2
  const hatch = hatchTexture()
  hatch.repeat.set(span / pitch, span / pitch)

  const capMat = new MeshStandardMaterial({
    color: spec.cap ?? 0x4a433a,
    map: hatch,
    roughness: 0.92,
    metalness: 0,
    side: BackSide,
    // 切口里几乎没有环境光，压低环境反射免得断面发灰发亮
    envMapIntensity: 0.15,
    clippingPlanes: [plane],
  })

  /** 需要被裁的**全部**材质。墨线与玻璃不做封盖，但必须跟着一起裁——
   *  否则门扇被切掉后，它的黑色轮廓线还留在原地，像一层漂浮的线框。 */
  const allMats = new Set<Material>()
  const solids: Mesh[] = []

  root.traverse((obj) => {
    const holder = obj as Mesh
    const raw = holder.material as Material | Material[] | undefined
    if (!raw) return
    for (const material of Array.isArray(raw) ? raw : [raw]) {
      // 接影面是纯阴影材质，裁它没有意义，还会让影子消失得莫名其妙
      if (material.type === 'ShadowMaterial') continue
      allMats.add(material)
    }
    // `isMesh` 已经排除 LineSegments（墨线包边）与 Group
    if (!holder.isMesh) return
    const single = Array.isArray(holder.material) ? null : (holder.material as MeshStandardMaterial)
    if (!single) return
    // 玻璃不做封盖：给它封盖会在切口里长出一块不透明的深色片
    if (single.transparent) return
    if (typeof single.roughness !== 'number') return
    /* 零厚度几何（车内背板那种单面平面）不做封盖：它只有一个朝向，
       背面副本等于不存在，加进去只是白跑一次 draw call。 */
    holder.geometry.computeBoundingBox()
    const bb = holder.geometry.boundingBox
    if (!bb) return
    const thin = Math.min(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z)
    if (thin < 1e-4) return
    solids.push(holder)
  })

  /* 背面副本必须跟着零件一起动（门扇会平移），所以挂成零件的子节点。
     关掉剖切时直接 visible=false，连 draw call 都不产生。 */
  for (const mesh of solids) {
    const shell = new Mesh(mesh.geometry, capMat)
    shell.name = 'sectionShell'
    shell.renderOrder = 1
    shell.castShadow = false
    shell.receiveShadow = false
    shell.visible = false
    mesh.add(shell)
  }

  let enabled = false

  const setAt = (v: number): void => {
    const k = v < 0 ? 0 : v > 1 ? 1 : v
    plane.constant = spec.from + (spec.to - spec.from) * k
  }

  const setEnabled = (on: boolean): void => {
    if (on === enabled) return
    enabled = on
    for (const material of allMats) {
      material.clippingPlanes = on ? [plane] : null
      // 不设它，切开一半的墙照样投出完整的影子
      material.clipShadows = on
      material.needsUpdate = true
    }
    for (const mesh of solids) {
      for (const child of mesh.children) {
        if (child.name === 'sectionShell') child.visible = on
      }
    }
  }

  setAt(0.5)

  return {
    setEnabled,
    setAt,
    dispose: () => {
      for (const material of allMats) {
        material.clippingPlanes = null
        material.clipShadows = false
        material.needsUpdate = true
      }
      hatch.dispose()
      capMat.dispose()
    },
  }
}
