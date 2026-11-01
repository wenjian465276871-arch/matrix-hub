/** 全站播报：polite / assertive 双区（计划 §12.5）。
 *
 *  为什么必须是「双区」而不是一个区：`aria-live` 的礼貌级别是**容器属性**，
 *  改不了。同一个容器里既播"已保存"又播"判据超差"只有一个结果——
 *  要么所有消息都打断当前朗读（assertive），要么每条都排到后面（polite）。
 *  现场两种都要：判据失败必须立刻打断，保存成功不该打断。
 *
 *  三条纪律（都是从读屏实际行为倒推的）：
 *  1. **同一句话 2 秒内不重复播**：轮询每 1.5 秒刷新一次状态，不去重就是复读机；
 *  2. **先清空再写**：往同一个 live 区写相同内容，部分读屏不会重新朗读；
 *  3. **assertive 只给错误与危险操作**：它会把用户正在听的内容打断，
 *     用来播"已复制"属于滥用。
 */

export type Politeness = 'polite' | 'assertive'

type Listener = (politeness: Politeness, text: string) => void

const listeners = new Set<Listener>()
const lastSpoken = new Map<string, number>()

/** 同一句话的最小间隔：小于它视为同一次事件的重复渲染。 */
const DEDUPE_MS = 2000

/** 播报一句话。空串忽略——调用方常把可选字段直接传进来。 */
export function announce(text: string, politeness: Politeness = 'polite'): void {
  const message = text.trim()
  if (!message) return

  const key = `${politeness}:${message}`
  const now = Date.now()
  const previous = lastSpoken.get(key)
  if (previous !== undefined && now - previous < DEDUPE_MS) return
  lastSpoken.set(key, now)

  // 映射只增不减会随会话变长；超过 50 条就清一次，代价可忽略。
  if (lastSpoken.size > 50) lastSpoken.clear()

  for (const listener of listeners) listener(politeness, message)
}

export function onAnnounce(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 仅供测试：清空去重表，避免用例之间互相吞掉同一句话。 */
export function resetAnnounce(): void {
  lastSpoken.clear()
}
