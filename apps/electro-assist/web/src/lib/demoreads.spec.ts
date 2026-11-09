/** 演示页读数（`lib/demoreads.ts`）。
 *
 * 这些数字是页面右栏显示的内容，也是现场唯一会当作"仪表"读的东西。它们的时序
 * 与 `figures/devices/*.ts` 是两份副本（注释里写着"改一处要改两处"），所以这里
 * 至少钉住三件事：
 *
 * 1. **物理上说得通**：行程不会超过 660mm、压力不会是负的、电压只有 0/380/220；
 * 2. **关键时刻对得上**：升弓到位时压力必须建起来，脱扣后控制回路必须还有电；
 * 3. **与三维不脱节**：主回路失压不得晚于脱扣动画结束——这条挡的是"三维脱扣了、
 *    读数还亮着 380V"这类错位。
 *
 * 不断言精确小数：那是把测试写成实现的复印件，改一个系数就要改十条用例。
 */
import { describe, expect, it } from 'vitest'

import type { Readout, SceneKey } from './demoreads'
import {
  CAB_RESET,
  CAB_TRIP,
  DOOR_POP,
  DOOR_STROKE,
  PT_COMP,
  PT_LOWER_S,
  PT_RAISE_S,
  cabinetReads,
  doorReads,
  pantoP,
  pantoArmY,
  pantoReads,
  readoutsFor,
} from './demoreads'

const SAMPLES: number[] = Array.from({ length: 1001 }, (_, i) => i / 1000)

const byLabel = (reads: Readout[], label: string): Readout => {
  const hit = reads.find((r) => r.label === label)
  if (!hit) throw new Error(`缺少读数 ${label}；现有 ${reads.map((r) => r.label).join('、')}`)
  return hit
}

const num = (reads: Readout[], label: string): number => {
  const raw = Number(byLabel(reads, label).value)
  if (Number.isNaN(raw)) throw new Error(`${label} 不是数值：${byLabel(reads, label).value}`)
  return raw
}

const CASES: Array<{ name: SceneKey; build: (t: number) => Readout[]; count: number }> = [
  { name: 'door', build: doorReads, count: 6 },
  { name: 'pantograph', build: pantoReads, count: 6 },
  { name: 'cabinet', build: cabinetReads, count: 7 },
]

describe.each(CASES)('$name 读数', ({ build, count }) => {
  it('整条时间轴上不产生 NaN / Infinity / 空标签', () => {
    // three 里 NaN 不抛异常，读数里 NaN 会安静地显示成 "NaN mm"——两种都只有测试能抓。
    for (const t of SAMPLES) {
      const reads = build(t)
      expect(reads).toHaveLength(count)
      for (const item of reads) {
        expect(item.label.length, `t=${t} 有空标签`).toBeGreaterThan(0)
        expect(item.value.length, `t=${t} ${item.label} 值为空`).toBeGreaterThan(0)
        // 只检查纯数值项：`继电器` 的值是 "0 / 3"，`断路器手柄` 是文字，
        // 拿它们做 Number() 只会得到 NaN，测的就不是"读数有没有坏"了。
        if (item.unit && /^-?\d+(\.\d+)?$/.test(item.value)) {
          expect(Number.isFinite(Number(item.value)), `t=${t} ${item.label}=${item.value}`).toBe(
            true,
          )
        }
      }
    }
  })
})

describe('车门读数', () => {
  it('未解锁前门锁与锁闭信号都必须为「有」，一动就消失', () => {
    // 这是门控回路的硬联锁：信号没丢就动车，等于绕过安全回路。
    expect(byLabel(doorReads(0), '锁闭信号').value).toBe('有')
    expect(byLabel(doorReads(0), '门锁').value).toBe('锁闭')
    expect(byLabel(doorReads(0.03), '锁闭信号').value).toBe('无')
    expect(byLabel(doorReads(0.03), '锁闭信号').dot).toBe('warn')
  })

  it('行程与外移在量程内且单调不减', () => {
    let prevStroke = -1
    let prevPop = -1
    for (const t of SAMPLES) {
      const stroke = num(doorReads(t), '单扇行程')
      const pop = num(doorReads(t), '塞拉外移')
      expect(stroke).toBeGreaterThanOrEqual(0)
      expect(stroke).toBeLessThanOrEqual(DOOR_STROKE)
      expect(pop).toBeGreaterThanOrEqual(0)
      expect(pop).toBeLessThanOrEqual(DOOR_POP)
      expect(stroke).toBeGreaterThanOrEqual(prevStroke)
      expect(pop).toBeGreaterThanOrEqual(prevPop)
      prevStroke = stroke
      prevPop = pop
    }
  })

  it('走完全程停在上限，且电机电流回到空载', () => {
    // 到位后电流不降，读数上就是"电机还在堵转"，现场会去查门机——不能靠人眼判断。
    expect(num(doorReads(0.95), '单扇行程')).toBe(DOOR_STROKE)
    expect(num(doorReads(0.95), '塞拉外移')).toBe(DOOR_POP)
    expect(num(doorReads(0.95), '电机电流')).toBeLessThan(0.2)
    expect(byLabel(doorReads(0.95), '动作阶段').value).toBe('完全开启')
  })

  it('动作阶段覆盖解锁 → 外移 → 滑移 → 到位四段', () => {
    const phases = new Set(SAMPLES.map((t) => byLabel(doorReads(t), '动作阶段').value))
    expect(phases).toEqual(
      new Set(['关闭锁定', '门锁解锁', '退出密封面', '门扇开启', '到位检测', '完全开启']),
    )
  })
})

describe('受电弓读数', () => {
  it('未接触前压力为 0，接触后建立压力', () => {
    // 不许"编一个近似值"：没碰到就是 0，否则现场按 0 压差判断是否接触会失效。
    expect(num(pantoReads(0), '接触压力')).toBe(0)
    expect(num(pantoReads(0.72), '接触压力')).toBeGreaterThan(80)
    expect(byLabel(pantoReads(0.72), '到位信号').value).toBe('升弓到位')
  })

  it('升弓与降弓计时峰值与验收判据一致（8.5 / 3.5 s）', () => {
    // 标签本身随阶段变（升弓计时 / 降弓计时 / 计时），所以按阶段筛，不按标签取。
    const peak = (label: string): number =>
      Math.max(
        ...SAMPLES.map((t) => {
          const item = pantoReads(t).find((r) => r.label === label)
          return item ? Number(item.value) : 0
        }),
      )
    const raiseMax = peak('升弓计时')
    const lowerMax = peak('降弓计时')
    // 判据写"8.5 ± 1.0"与"3.5 ± 0.5"，读数峰值必须落在里面，否则演示与判据自相矛盾。
    expect(raiseMax).toBeGreaterThan(PT_RAISE_S - 0.1)
    expect(raiseMax).toBeLessThanOrEqual(PT_RAISE_S)
    expect(lowerMax).toBeGreaterThan(PT_LOWER_S - 0.1)
    expect(lowerMax).toBeLessThanOrEqual(PT_LOWER_S)
  })

  it('降弓途中两个到位信号都丢失', () => {
    const mid = pantoReads(0.9)
    expect(byLabel(mid, '到位信号').value).toBe('均无')
    expect(byLabel(mid, '到位信号').dot).toBe('warn')
    expect(byLabel(mid, '动作阶段').value).toBe('降弓中（阻尼）')
  })

  it('落弓到位后高度回到底位、压力归零、气路泄压', () => {
    const end = pantoReads(1)
    expect(byLabel(end, '动作阶段').value).toBe('落弓到位')
    expect(num(end, '接触压力')).toBe(0)
    expect(num(end, '气路压力')).toBe(0)
    expect(num(end, '弓头高度')).toBeLessThan(900)
    expect(byLabel(end, '到位信号').value).toBe('落弓到位')
  })

  it('铰接机构：行程与臂尖高度同向，且高度不越界', () => {
    let prev = -1
    for (const t of SAMPLES) {
      const p = pantoP(t)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(1)
      const head = num(pantoReads(t), '弓头高度')
      // 弓头被接触线挡住后会停住（弹簧压缩），所以只断言不越界、不出现负值。
      expect(head).toBeGreaterThanOrEqual(0)
      expect(head).toBeLessThanOrEqual(3200)
      // **只在升弓段**要求单调不减：降弓段它本来就该往下走。
      // 容差按弹簧压缩量给（顶到接触线后滑板顶面会下沉最多 PT_COMP）。
      if (t < 0.68) {
        expect(head).toBeGreaterThan(prev - PT_COMP * 1000 - 5)
        prev = head
      }
    }
    // 摆角单调：升弓过程中臂只往上转，不会来回摆。
    expect(pantoArmY(1)).toBeGreaterThan(pantoArmY(0))
  })
})

describe('配电柜读数', () => {
  it('脱扣后控制回路仍有电、主回路失压——这条本身就是判据', () => {
    const tripped = cabinetReads(0.84)
    expect(byLabel(tripped, '断路器手柄').value).toBe('中间位（已脱扣）')
    expect(num(tripped, '主回路电压')).toBe(0)
    expect(num(tripped, '控制回路电压')).toBe(220)
    expect(byLabel(tripped, '接触器').value).toBe('断开')
  })

  it('主回路失压不得晚于脱扣动作结束（0.86）', () => {
    // 三维里脱扣动画是 0.78→0.86（`cabinet.ts` 的 seg(t, 0.78, 0.86)）。
    // 读数若比它晚，画面上已经脱扣、右栏还亮着 380V，现场会以为仪表坏了。
    for (const t of SAMPLES) {
      if (t >= 0.86 && t < 0.99) {
        expect(num(cabinetReads(t), '主回路电压'), `t=${t} 仍显示带电`).toBe(0)
      }
    }
  })

  it('手柄位置序列：断开 → 合闸 → 中间位 → 复位 → 合闸', () => {
    const at = (t: number): string => byLabel(cabinetReads(t), '断路器手柄').value
    expect(at(0.05)).toBe('断开位')
    expect(at(0.5)).toBe('合闸位')
    expect(at(CAB_TRIP + 0.02)).toBe('中间位（已脱扣）')
    expect(at(CAB_RESET + 0.02)).toBe('断开位（已复位）')
    expect(at(1)).toBe('合闸位')
  })

  it('继电器按顺序逐个吸合，脱扣时同时释放', () => {
    const count = (t: number): string => byLabel(cabinetReads(t), '继电器').value
    expect(count(0.4)).toBe('0 / 3')
    expect(count(0.5)).toBe('1 / 3')
    expect(count(0.62)).toBe('3 / 3')
    // 脱扣后必须一起落：只落一半等于缺相，读数不能含糊。
    expect(count(0.84)).toBe('0 / 3')
    expect(count(1)).toBe('3 / 3')
  })

  it('主回路电压只会是 0 / 380，控制回路只会是 0 / 220', () => {
    for (const t of SAMPLES) {
      const reads = cabinetReads(t)
      expect(['0', '380']).toContain(byLabel(reads, '主回路电压').value)
      expect(['0', '220']).toContain(byLabel(reads, '控制回路电压').value)
    }
  })
})

describe('readoutsFor', () => {
  it('按场景分发，且与直接调用一致', () => {
    for (const t of [0, 0.3, 0.7, 1]) {
      expect(readoutsFor('door', t)).toEqual(doorReads(t))
      expect(readoutsFor('pantograph', t)).toEqual(pantoReads(t))
      expect(readoutsFor('cabinet', t)).toEqual(cabinetReads(t))
    }
  })
})
