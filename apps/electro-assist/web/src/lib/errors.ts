/** 错误 → 用户能看懂、能行动的一句话。
 *
 * 为什么不让每个页面各写一套：同一个 `code` 在不同页面必须给同一种说法，
 * 否则用户会以为遇到了不同的问题。这里只做"翻译"，不做重试或跳转。
 */
import { ApiError } from './http'

const BY_CODE: Record<string, string> = {
  value_required: '这一项需要填实测值。',
  value_invalid: '实测值必须是有限数字，请检查后重填。',
  result_required: '请先选择「正常」或「异常」。',
  duplicate_check: '这一步已经提交过，刷新后可以看到最新状态。',
  run_finished: '该诊断已结束，请重新开始一次。',
  wrong_order: '当前不在这一步，已是最新检查项。',
  input_too_short: '现象描述太短，再补几句现场细节。',
  system_not_covered: '这个子系统还没收录，换车门/空调/受电弓的现象试试。',
  no_match: '没有匹配的条目，换个说法再试。',
  entry_not_found: '这条知识条目已不存在，请重新检索。',
  rate_limited: '请求太频繁，稍等片刻再试。',
  budget_exhausted: '今天全站额度已用完，请明天再试。',
  passcode_invalid: '口令已失效，请重新验证。',
  internal_error: '服务异常，请稍后重试。',
}

export function errorText(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback
  if (err.code && BY_CODE[err.code]) return BY_CODE[err.code]
  if (err.kind === 'timeout') return '请求超时，请检查网络后重试。'
  if (err.kind === 'network') return '网络不可用，请检查连接后重试。'
  if (err.kind === 'ratelimit') return err.message || '操作太频繁，请稍后再试。'
  // 500 的 message 里已经带「错误号」，原样透出，方便用户报障
  return err.message || fallback
}
