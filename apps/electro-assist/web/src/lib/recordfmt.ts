/**
 * 作业记录的展示口径。
 *
 * 抽出来的理由：这三条都是**"看起来显然、实际踩过坑"**的格式化规则。
 * 尤其 `formatTime` —— 用 `hour12: false` 在部分内核（荣耀 / 旧 WebView 的 ICU）
 * 会输出 "24:42:45"，看起来像"第二天零点"，现场对时间会直接对错。
 */

/** 秒数转人话。0 与负数都当"没有数据"，返回破折号——不要显示"0 秒"这种假精度。 */
export function formatDuration(seconds: number): string {
  if (!seconds) return '—'
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`
}

/**
 * 单步耗时：未执行为 null；不足 1 秒单独说，不要显示 "0 秒"。
 * 现场看到 "0 秒" 会以为计时坏了。
 */
export function formatStepDuration(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 1) return '不足 1 秒'
  return formatDuration(seconds)
}

/**
 * 时间戳转本地时间。
 *
 * 显式 `hourCycle: 'h23'`：不用 `hour12: false`，因为后者在部分 ICU 实现里
 * 会给出 h24（00 点显示成 24）。
 */
export function formatTime(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
}
