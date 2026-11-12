/** 工具类场景的「印刷面」：用 CanvasTexture 画表盘、液晶、牌面与刻度。
 *
 *  ## 为什么是画出来的，不是拍来的
 *
 *  用户的要求是"用互联网上的实拍图做 3D"。这条要求拆开只有两半能实现：
 *  **形体与配色参考实拍图**（尺寸、比例、黄护套、白底红字的牌面），
 *  以及**表面印刷内容参照实物**（表盘档位、液晶单位、警示语、扭矩刻度）。
 *  「把照片贴到模型上」不能做，三个原因：
 *
 *  1. **授权**：产品图与图库照片有版权，公开仓不能收录；实拍现场照片还涉及
 *     第三方场所与设备，与本项目「零内部资料」的合规铁律冲突。
 *  2. **CSP**：`img-src 'self' data:`，外部图片地址会被拦；写进仓库又回到第 1 条。
 *  3. **效果**：贴照片要 UV 展开与去光影，否则一圈环境光糊在照片上，
 *     比纯色材质更假。而这四台设备的辨识度几乎全在**印刷内容**上
 *     （LCD 读数、警示语、刻度），把印刷画对，比贴一张照片像得多。
 *
 *  所以：**几何按实拍比例建，表面按实物印刷画**。参考来源写在每台设备文件的头部，
 *  参数仍是演示虚构值。
 *
 *  ## happy-dom 下必须不炸
 *
 *  `builders.spec.ts` 在 happy-dom 里直接调 build 函数（没有 WebGL、也没有 canvas 2D）。
 *  所以每个 `getContext('2d')` 都要允许返回 null，纹理照建（内容是空白），
 *  否则整个几何契约测试会因为环境缺能力而红。
 */
import {
  CanvasTexture,
  DoubleSide,
  FrontSide,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
} from 'three'

type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void

/** 画一张纹理。取不到 2D 上下文时返回一张空白纹理，调用方不需要分支。 */
export function canvasTexture(w: number, h: number, draw: Draw): Texture {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.clearRect(0, 0, w, h)
    draw(ctx, w, h)
  }
  const tex = new CanvasTexture(canvas)
  // 颜色贴图必须是 sRGB：不设的话 CanvasTexture 默认 NoColorSpace，
  // 在 ACES 色调映射下整块颜色会发灰，白牌面变米黄。
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 4
  tex.needsUpdate = true
  return tex
}

/** 一张贴在设备表面的印刷面。`offset` 用来压住 z-fighting（面片离本体 1–2mm）。 */
export function facePlate(
  w: number,
  h: number,
  map: Texture,
  options: {
    /** 自发光强度。液晶、指示灯这类"自己有光"的面板才需要。 */
    glow?: number
    roughness?: number
    metalness?: number
    /** 双向可见：牌面翻过来要看背面时用（背面是白塑料，不是透明）。 */
    doubleSide?: boolean
  } = {},
): Mesh {
  const material = new MeshStandardMaterial({
    map,
    roughness: options.roughness ?? 0.42,
    metalness: options.metalness ?? 0,
    transparent: false,
    side: options.doubleSide ? DoubleSide : FrontSide,
  })
  if (options.glow) {
    // 自发光用同一张图作 emissiveMap：白色自发光 × 贴图 = 只有字画在发光，
    // 底色仍然是"暗的"。整面发光会把液晶糊成一块白板。
    material.emissiveMap = map
    material.emissive.setHex(0xffffff)
    material.emissiveIntensity = options.glow
  }
  const mesh = new Mesh(new PlaneGeometry(w, h), material)
  mesh.receiveShadow = false
  return mesh
}

/** 关掉自发光。液晶在断电/无读数时必须暗下去，否则"表一直在发光"就不像仪表。 */
export function setGlow(mesh: Mesh, intensity: number): void {
  const material = mesh.material as MeshStandardMaterial
  material.emissiveIntensity = intensity
}

/* ------------------------------------------------------------------ 液晶 */

const LCD_BG = '#c8d3bd'
const LCD_INK = '#1d2a1c'

/**
 * 万用表液晶。七段数字用等宽粗体近似：真机是七段管，但在这个尺寸下
 * 粗等宽数字的观感与七段几乎一致，而七段要手画 7 段 × 4 位 = 28 个多边形。
 */
export function lcdTexture(main: string, unit: string, note = ''): Texture {
  return canvasTexture(512, 256, (ctx, w, h) => {
    ctx.fillStyle = LCD_BG
    ctx.fillRect(0, 0, w, h)

    // 分段底色要有一点点不均匀：真液晶的分段电极之间有细缝
    ctx.strokeStyle = 'rgba(40,52,38,0.10)'
    ctx.lineWidth = 2
    for (let i = 1; i < 5; i += 1) {
      const x = (w / 5) * i
      ctx.beginPath()
      ctx.moveTo(x, 8)
      ctx.lineTo(x, h - 8)
      ctx.stroke()
    }

    ctx.fillStyle = LCD_INK
    ctx.font = 'bold 150px ui-monospace, "Consolas", "Courier New", monospace'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(main, w - 96, h - 96)

    ctx.font = 'bold 54px ui-monospace, "Consolas", "Courier New", monospace'
    ctx.textAlign = 'left'
    ctx.fillText(unit, w - 84, h - 108)

    if (note) {
      ctx.font = '28px "Microsoft YaHei", sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(note, 20, 44)
    }

    // 电量与自动量程的小标记：真机左上角常有，缺了像贴纸
    ctx.strokeStyle = LCD_INK
    ctx.lineWidth = 4
    ctx.strokeRect(18, 60, 46, 22)
    ctx.fillStyle = LCD_INK
    ctx.fillRect(22, 64, 26, 14)
  })
}

/* ------------------------------------------------------------------ 牌面 */

/**
 * 电力安全标示牌「禁止合闸，有人工作」。
 *
 * 依据公开的《电业安全工作规程》标示牌式样：**白底、红字**，尺寸 200×160mm，
 * 悬挂在"一经合闸即可送电到工作地点的断路器/隔离开关操作把手上"。
 * （同款另有 200×100 的白底红字版；这里取 200×160，因为它在门边把手上更常见。）
 * 牌面比例按 200:160 = 5:4 画，不要拉成 3:2——比例错了，牌就不像牌。
 */
export function signFaceTexture(): Texture {
  return canvasTexture(500, 400, (ctx, w, h) => {
    ctx.fillStyle = '#f4f2ec'
    ctx.fillRect(0, 0, w, h)

    // 红色边框：内缩 16px，线宽 10px，与实物丝印的边距接近
    ctx.strokeStyle = '#c0262a'
    ctx.lineWidth = 10
    ctx.strokeRect(16, 16, w - 32, h - 32)

    ctx.fillStyle = '#c0262a'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    /* 字号与行距必须一起算：字高 116、行距 108 时两行是**叠在一起**的。
       小画布上看不清，一放大就是一团红块（2026-11-10 放大态验收发现）。
       现在 96px、行距 110，行高比 1.15；四字宽 384px，画布可用宽 468px，留了余量。 */
    ctx.font = 'bold 96px "Microsoft YaHei", "PingFang SC", sans-serif'
    ctx.fillText('禁止合闸', w / 2, 112)
    ctx.fillText('有人工作', w / 2, 222)

    ctx.font = 'bold 72px "Microsoft YaHei", "PingFang SC", sans-serif'
    ctx.fillText('！', w / 2, 320)

    // 顶部穿绳孔：牌上真有这个孔，画出来绳子才有落点
    ctx.fillStyle = '#2b2d31'
    ctx.beginPath()
    ctx.arc(w / 2, 26, 7, 0, Math.PI * 2)
    ctx.fill()
  })
}

/* ------------------------------------------------------------ 表盘 / 刻度 */

/**
 * 万用表前脸的印刷层：档位刻度与文字围绕旋钮排一圈。
 *
 * 画在整块面板贴图上，旋钮再叠在上面——这比在 3D 里排一圈文字便宜得多，
 * 也是真机的做法（丝印在面板上，旋钮只是转）。
 */
export function meterPanelTexture(): Texture {
  // 画布比例必须与面板一致（88 × 180mm）：比例错了，画在像素里的圆
  // 贴到模型上就变成椭圆，整块表立刻失真。
  return canvasTexture(256, 512, (ctx, w, h) => {
    ctx.fillStyle = '#2c2f33'
    ctx.fillRect(0, 0, w, h)

    const cx = w / 2
    const cy = 296

    // 刻度弧
    ctx.strokeStyle = '#e8e6df'
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.arc(cx, cy, 108, Math.PI * 1.12, Math.PI * 1.88)
    ctx.stroke()

    for (let i = 0; i <= 12; i += 1) {
      const a = Math.PI * 1.12 + (Math.PI * 0.76 * i) / 12
      const r0 = i % 3 === 0 ? 96 : 103
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0)
      ctx.lineTo(cx + Math.cos(a) * 108, cy + Math.sin(a) * 108)
      ctx.stroke()
    }

    ctx.fillStyle = '#e8e6df'
    ctx.font = 'bold 19px "Microsoft YaHei", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const marks: [number, string][] = [
      [0.04, 'OFF'],
      [0.2, 'V⎓'],
      [0.38, 'mV'],
      [0.56, 'Ω'],
      [0.74, '通断'],
      [0.9, 'A'],
    ]
    for (const [p, label] of marks) {
      const a = Math.PI * 1.12 + Math.PI * 0.76 * p
      ctx.fillText(label, cx + Math.cos(a) * 80, cy + Math.sin(a) * 80)
    }

    // 底部型号丝印
    ctx.fillStyle = 'rgba(232,230,223,0.5)'
    ctx.font = '15px ui-monospace, monospace'
    ctx.fillText('TRUE RMS', cx, h - 26)
  })
}

/**
 * 力矩扳手手柄上的刻度窗：预置式扳手的读数就是从这里看的。
 * 窗口贴在握把侧面，指针随后盖在上面。
 */
export function torqueScaleTexture(): Texture {
  return canvasTexture(512, 128, (ctx, w, h) => {
    ctx.fillStyle = '#1c1e21'
    ctx.fillRect(0, 0, w, h)

    ctx.strokeStyle = '#d8d5cc'
    ctx.fillStyle = '#d8d5cc'
    ctx.font = '26px ui-monospace, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'

    for (let i = 0; i <= 10; i += 1) {
      const x = 28 + ((w - 56) * i) / 10
      const long = i % 2 === 0
      ctx.lineWidth = long ? 3 : 1.5
      ctx.beginPath()
      ctx.moveTo(x, 8)
      ctx.lineTo(x, long ? 40 : 26)
      ctx.stroke()
      if (long) ctx.fillText(String(10 + i * 4), x, 44)
    }

    ctx.font = '22px "Microsoft YaHei", sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText('N·m', 12, h - 30)
  })
}

/** 端子排上的编号条。
 *
 *  `marks` 把个别端子标成极性——真实端子排上只有电源进线端会另插一小片
 *  「+/−」标记条，其余全是编号。**不能整排都标**：全标"+"就没法表达电位差，
 *  表笔搭哪两个端子都成了"量同一极"。 */
export function terminalLabelTexture(count: number, marks: Record<number, string> = {}): Texture {
  return canvasTexture(64 * count, 64, (ctx, w, h) => {
    ctx.fillStyle = '#e9e6dc'
    ctx.fillRect(0, 0, w, h)
    for (let i = 0; i < count; i += 1) {
      const marked = marks[i] !== undefined
      const text = marked ? marks[i] : String(i + 1)
      ctx.fillStyle = marked ? '#14171b' : '#2b2d31'
      ctx.font = `bold ${marked ? 46 : 34}px ui-monospace, monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, 64 * i + 32, h / 2 + 2)
      if (marked) {
        // 极性标记是单独一片插进去的，压一圈深色边
        ctx.strokeStyle = '#6f757b'
        ctx.lineWidth = 3
        ctx.strokeRect(64 * i + 5, 5, 54, h - 10)
      }
    }
  })
}

/** 线号管：套在导线上的白色套管，环向热转印线号。
 *
 *  **为什么要重复 4 份**：Cylinder 的 u 沿整个圆周，只印一份的话转到背面就看不见了，
 *  而这一类图是静态机位渲出来的，字落在背面等于没有。印 4 份，任意角度都有一份正对。
 *  真实线号管是"白 PVC 管 + 黑色热转印"，字高约管径的 1.2 倍。 */
export function ferruleTexture(text: string): Texture {
  const W = 128
  return canvasTexture(W * 4, 64, (ctx, w, h) => {
    ctx.fillStyle = '#f4f2ec'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#1f2226'
    // 字宽按份宽自适应：`-110V` 比 `PE` 长得多，固定字号会把长的挤成两行
    const size = text.length > 3 ? 26 : 30
    ctx.font = `bold ${size}px ui-monospace, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let i = 0; i < 4; i += 1) ctx.fillText(text, W * i + W / 2, h / 2 + 1)
  })
}

/** 隔离锁的标识铭牌：真实锁盒上贴"隔离/解锁"字样，是现场辨认它最直接的东西。 */
export function isolationLabelTexture(): Texture {
  return canvasTexture(192, 64, (ctx, w, h) => {
    ctx.fillStyle = '#2f3338'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#e8e4d8'
    ctx.font = 'bold 38px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('隔离锁', w / 2, h / 2 + 2)
  })
}

/** 拉丝/磨砂的重复纹理占位：只用于给印刷面加一点点颗粒，不需要新材质。 */
export function repeat(tex: Texture, x: number, y: number): Texture {
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.repeat.set(x, y)
  return tex
}
