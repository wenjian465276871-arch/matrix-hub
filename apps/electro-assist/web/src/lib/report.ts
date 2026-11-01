/** 前端错误上报（FRONTEND §9 的 `_fe-error`）。
 *
 *  目的只有一个：线上白屏时能拿到**位置**。所以只带路由、消息、堆栈首行，
 *  不带任何用户输入——工艺文本、判据值、设备型号都不进请求体。
 *  这与隐私页的承诺一致：不收集可识别个人的内容。
 *
 *  四条硬约束：
 *  1. **每会话最多 20 条**：渲染函数里抛错会每帧报一次，不封顶就是自造 DDoS；
 *  2. **同一条 60 秒内只报一次**：滚动重渲染会让同一个错误刷屏；
 *  3. **上报失败静默**：上报本身抛错再触发上报，等于死循环；
 *  4. **优先 sendBeacon**：页面正在卸载时 fetch 会被取消，beacon 不会。
 */

const MAX_PER_SESSION = 20
const DEDUPE_MS = 60_000
const MAX_MESSAGE = 300
const MAX_STACK = 1200

let sent = 0
const seen = new Map<string, number>()

interface ReportBody {
  message: string
  kind: string
  source: string
  route: string
  ref: string
  stack: string
}

function route(): string {
  // 只保留路由模板，不带 id：`/guide/g_abc123` 里的 id 属于内容标识。
  const path = window.location.pathname.replace(/\/apps\/electro-assist/, '')
  return path.replace(/\/(g|s|d)_[a-z0-9_]+/g, '/:id').slice(0, 120) || '/'
}

function firstStackLine(stack?: string): string {
  if (!stack) return ''
  // 只留第一帧：完整堆栈对定位够用了，但 1200 字符足够放 8 行，
  // 多出来的部分是打包后的压缩代码，读不出信息量。
  return stack.split('\n').slice(0, 8).join(' | ').slice(0, MAX_STACK)
}

function dedupeKey(message: string, kind: string): string {
  return `${kind}:${message}`
}

/** 发一条。所有参数都当不可信内容处理：截断 + 单行化在服务端还会再做一次。 */
export function reportError(
  message: string,
  options: { kind?: string; source?: string; stack?: string } = {},
): void {
  if (typeof window === 'undefined') return
  if (!message.trim()) return
  if (sent >= MAX_PER_SESSION) return

  const kind = (options.kind ?? 'error').slice(0, 24)
  const key = dedupeKey(message, kind)
  const now = Date.now()
  const previous = seen.get(key)
  if (previous !== undefined && now - previous < DEDUPE_MS) return
  seen.set(key, now)
  sent += 1

  const body: ReportBody = {
    message: message.slice(0, MAX_MESSAGE),
    kind,
    source: (options.source ?? '').slice(0, 120),
    route: route(),
    ref: '',
    stack: firstStackLine(options.stack),
  }

  try {
    const payload = JSON.stringify(body)
    if (typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([payload], { type: 'application/json' })
      // sendBeacon 的返回值只表示"是否排队成功"，失败也没有更多信息可做，
      // 所以不检查它——检查了也只能 console，反而多一次噪音。
      navigator.sendBeacon('/api/electro/fe-error', blob)
      return
    }
    void fetch('/api/electro/fe-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      // keepalive 让请求在页面卸载后继续；不设 timeout：
      // 这是尽力而为的上报，卡住也不会影响页面。
      keepalive: true,
    }).catch(() => undefined)
  } catch {
    // 上报链路的任何异常都不再外抛。
  }
}

/** 仅供测试：重置配额与去重表。 */
export function resetReporter(): void {
  sent = 0
  seen.clear()
}
