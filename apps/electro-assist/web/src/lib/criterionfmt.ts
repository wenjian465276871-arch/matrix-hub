/** 判据的显示口径（**唯一来源**）。
 *
 *  阅读器（StepPage）与探索台（GuideExplorer）都要把同一条判据渲染成人能读的一行字。
 *  这类"两处各写一遍"在本项目已经栽过三次（跨端枚举、气路时序、运动学常量），
 *  差别只在一个显示成 `0.5 ~ 1.5 mm`、另一个显示成 `0.5-1.5mm`，用户会以为数据不一致。
 */
import type { Criterion, Provenance } from '../types'

/** 判据的"目标值"文字。range 给区间，enum 给可选项，manual 明确写"人工确认"。 */
export function criterionValue(c: Criterion): string {
  if (c.type === 'range') return `${c.min ?? '—'} ~ ${c.max ?? '—'}`
  if (c.type === 'enum') return (c.options ?? []).join(' / ')
  if (c.type === 'manual') return '人工确认'
  return '记录'
}

/** 判据来源标签。行号内部 0 基、显示 1 基，与识别确认页同一口径。 */
export function provenanceText(p: Provenance): string {
  const tag = p.flag === 'ok' ? '有据' : '待核'
  if (p.line === null || p.line === undefined) return `${tag} · 见原图`
  return `${tag} · 第 ${p.line + 1} 行`
}
