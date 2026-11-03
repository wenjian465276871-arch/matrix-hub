/**
 * 生成任务的跨页交接。
 *
 * 只有两件事要传：`job_id` 与它的开始时刻。开始时刻**不能因为换页而重置**——
 * 它是硬超时预算的唯一基准，每跳一次页面就重新计时，等于把"超时"变成"无限等"。
 *
 * 放 sessionStorage 而不是 URL：URL 会被分享、会留在历史记录里，
 * 而 job 是"我这一次的等待"，没有理由出现在别人的浏览器里。
 */
export const JOB_KEY = 'electro:job'

export interface StoredJob {
  jobId: string
  startedAt: number
}

export function readStoredJob(): StoredJob | null {
  try {
    const raw = sessionStorage.getItem(JOB_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredJob>
    if (typeof parsed.jobId !== 'string' || typeof parsed.startedAt !== 'number') return null
    if (!/^j_[0-9a-f]{16}$/.test(parsed.jobId)) return null
    return { jobId: parsed.jobId, startedAt: parsed.startedAt }
  } catch {
    return null
  }
}

export function writeStoredJob(id: string, startedAt: number): void {
  try {
    sessionStorage.setItem(JOB_KEY, JSON.stringify({ jobId: id, startedAt }))
  } catch {
    // 隐私模式写不进：只影响"刷新续接"，不影响本次生成
  }
}

export function clearStoredJob(): void {
  try {
    sessionStorage.removeItem(JOB_KEY)
  } catch {
    /* 同上 */
  }
}
