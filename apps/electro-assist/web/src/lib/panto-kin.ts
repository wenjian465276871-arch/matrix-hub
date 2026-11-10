/** 受电弓的运动学与外形常量（**唯一来源**）。
 *
 * ## 为什么单独成文件
 * 弓头高度、接触压力、接触线位置这三组数，原来在 `figures/devices/pantograph.ts`（建模）
 * 和 `lib/demoreads.ts`（读数）里各写一份，两边都注着"改一处要改两处"。
 * 2026-11-10 重做受电弓时又踩了一次：`demoreads` 里写死 `0.34 + 1.55·sin + 1.35·sin`，
 * 建模那边改成 0.42 / 1.50 / 1.25，读数立刻与画面差 5cm 以上——
 * 三维顶到接触线了，读数却说还差 42mm。这类"两份同源"在本项目已经栽过三次
 * （跨端枚举、气路时序、这里），所以按 `panto-air.ts` 的做法收敛成一份。
 *
 * ## 数值口径
 * 蓝本 TSG19A（CRH380A 用）：弓头 1950mm、滑板 1576mm。
 * 其余杆长、铰点位置是**按实拍目测的比例反推的示意值**，不代表任何图纸。
 * 标定方式：让「落弓 ≈ 0.6m、升到位 ≈ 2.9m」这两个端位同时成立——
 * 这是公开资料里能确认的仅有两条高度信息。
 */

/** 杆长与铰点（米）。 */
export const PDIM = {
  /** 下臂长度（铰点到肘接） */
  lower: 1.52,
  /** 上臂长度（肘接到弓头托架） */
  upper: 1.3,
  /** 左右两臂的间距半径：两根下臂相距 0.92m，与实拍的窄底架一致 */
  armX: 0.46,
  /** 下臂铰点高度（相对车顶面）：必须**高于底架梁顶面**（0.475），
   *  否则销轴埋进梁里，画面上两根臂像是从红梁里"长"出来的，没有铰。 */
  pivotY: 0.5,
  /** 下臂铰点前后位置（+Z 为车行方向的前方，也是弓头所在侧） */
  pivotZ: 0.6,
  /** 弓头半长：1950mm 的一半 */
  headHalf: 0.975,
  /** 碳滑板长度：1576mm */
  stripLen: 1.576,
} as const

/**
 * 摆角（度）。`lo` = 落弓位，`hi` = 升到位。
 *
 * ## 上臂落弓时为什么是**负角**
 * 单臂受电弓收起来时肘部是最高点，弓头反而落到肘点下方、靠近底架；
 * 上臂必须往**下**折一点点。第一版写成 +10°，收弓后弓头吊在 0.84m 高，
 * 整台设备看起来像一张升降台——这正是用户 2026-11-10 说的"两块大 V 形平板"的来源：
 * 两根臂都接近水平、还都在同一高度，屏幕上就只剩两块平板。
 */
export const PANGLES = {
  a1lo: 8,
  a1hi: 48,
  a2lo: -8,
  a2hi: 54,
} as const

/** 弓头悬挂（米）。三个数彼此锁定，改一个要重算 `WIRE_Y`。 */
export const PGAP = {
  /** 臂尖到弓头托架的自由间隙 */
  free: 0.055,
  /** 弹簧最大压缩量 */
  maxComp: 0.045,
  /** 弓头托架原点到滑板顶面的高度（含滑板厚度） */
  headTop: 0.135,
} as const

const RAD = Math.PI / 180

/** 摆角随行程 p（0–1）线性插值。 */
export const armAngles = (p: number): { a1: number; a2: number } => ({
  a1: (PANGLES.a1lo + (PANGLES.a1hi - PANGLES.a1lo) * p) * RAD,
  a2: (PANGLES.a2lo + (PANGLES.a2hi - PANGLES.a2lo) * p) * RAD,
})

/** 臂尖（上臂顶端）的绝对高度。纯三角函数，两边共用。 */
export function armY(p: number): number {
  const { a1, a2 } = armAngles(p)
  return PDIM.pivotY + PDIM.lower * Math.sin(a1) + PDIM.upper * Math.sin(a2)
}

/** 臂尖的前后位置。单臂机构的固有特性：升弓过程中弓头几乎不平移（本例 26mm）。 */
export function armZ(p: number): number {
  const { a1, a2 } = armAngles(p)
  return PDIM.pivotZ - PDIM.lower * Math.cos(a1) + PDIM.upper * Math.cos(a2)
}

/** 未受接触线约束时的滑板顶面高度。 */
export const freeTop = (p: number): number => armY(p) + PGAP.free + PGAP.headTop

/** 满行程的自由顶面，接触线就装在它下方一个压缩量处。 */
const TOP_RAISED = freeTop(1)
/**
 * 接触线高度（相对车顶面）。
 *
 * 取 `TOP_RAISED − 0.042` 而不是写死：满行程时弹簧压掉 42mm，
 * 于是"升到位"这个瞬间同时满足「臂还在上行」「弓头被挡住」「压力达到额定值」三条。
 * 写死数字的话，任何人改一次杆长，这三条就一起失效，而且不报错。
 */
export const WIRE_Y = TOP_RAISED - 0.042

/** 弓头当前被压下去多少（0–maxComp）。 */
export function compression(p: number): number {
  const over = freeTop(p) - WIRE_Y
  return over <= 0 ? 0 : Math.min(over, PGAP.maxComp)
}
