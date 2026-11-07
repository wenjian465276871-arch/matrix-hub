/** SSE 客户端：`fetch` + `ReadableStream`（计划 §12.7 裁决 3）。
 *
 *  为什么不用 `EventSource`：它只能 GET、不能带请求体、也拿不到状态码。
 *  排查接口是 POST + JSON 入参，且 429/422 必须能被读到并显示 `Retry-After`——
 *  EventSource 遇到非 200 只会静默重连，用户看到的是"一直转圈"。
 *
 *  `Last-Event-ID` 重连（2026-11-08，决策 #45）：断流且**已收到帧、未收到终止帧**时
 *  自动重连一次，带上最后收到的事件名，服务端据此跳过已发帧。
 *  不做跨请求续生成——重连会把被打断的那一步重跑（重排多花一次模型调用，约 ¥0.002），
 *  所以**只重连一次**；再失败就如实报错，让用户点重试。一帧都没收到的失败不重连：
 *  那等于把整个请求重跑，与用户手点重试没有区别，只是偷偷多花一次钱。
 */

import { ApiError, parseErrorResponse } from './http'

export type SseHandler = (event: string, data: unknown) => void

interface StreamOptions {
  signal?: AbortSignal
  onEvent: SseHandler
  /** 关掉自动重连（默认开启）。一次性诊断调用与测试用得上。 */
  resume?: boolean
}

/** 收到这些事件说明本轮已经结束，不该再重连。 */
const TERMINAL_EVENTS = new Set(['done', 'error'])

interface StreamState {
  lastEventId: string | null
  terminal: boolean
}

/** 一次 SSE 请求。正常结束 resolve；HTTP 错误抛 `ApiError`；网络中断抛原异常。 */
export async function postStream(
  path: string,
  body: unknown,
  { signal, onEvent, resume = true }: StreamOptions,
): Promise<void> {
  const state: StreamState = { lastEventId: null, terminal: false }
  const track: SseHandler = (event, data) => {
    // 先交给调用方再记账：调用方抛异常时不能把"没显示出来的帧"记成已收到。
    onEvent(event, data)
    state.lastEventId = event
    if (TERMINAL_EVENTS.has(event)) state.terminal = true
  }

  try {
    await runOnce(path, body, signal, track, null)
  } catch (err) {
    if (!canResume(resume, signal, state)) throw err
    await runOnce(path, body, signal, track, state.lastEventId)
    assertTerminal(state)
    return
  }

  // 流正常关闭却没有终止帧：服务端崩了、反代超时、或中间层截断。
  // 这种"静默截断"比抛异常更坏——前端会以为结果就是这几个候选。
  if (state.lastEventId !== null && !state.terminal) {
    if (!canResume(resume, signal, state)) {
      throw new ApiError('server', 200, 'stream_truncated')
    }
    await runOnce(path, body, signal, track, state.lastEventId)
    assertTerminal(state)
  }
}

/** 重连之后仍然没有终止帧：这次必须抛，不能再静默返回。 */
function assertTerminal(state: StreamState): void {
  if (!state.terminal && state.lastEventId !== null) {
    throw new ApiError('server', 200, 'stream_truncated')
  }
}

/** 该不该再试一次。
 *
 *  HTTP 层错误（429 / 422 / 503 / `stream_unsupported`）都发生在读到第一帧之前，
 *  那时 `lastEventId` 仍是 null，所以不需要再按错误类型判断一遍——
 *  配额问题重试不会好，而"一帧都没收到"的重连等于把整个请求重跑。
 */
function canResume(resume: boolean, signal: AbortSignal | undefined, state: StreamState): boolean {
  if (!resume) return false
  if (signal?.aborted) return false
  if (state.terminal) return false
  return state.lastEventId !== null
}

async function runOnce(
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
  onEvent: SseHandler,
  resumeFrom: string | null,
): Promise<void> {
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
  }
  if (resumeFrom) headers['Last-Event-ID'] = resumeFrom

  let res: Response
  try {
    res = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) throw err
    throw new ApiError('network')
  }

  if (!res.ok) throw await parseErrorResponse(res)
  if (!res.body) {
    // 老内核（或某些代理）不给 body：让调用方回落到一次性 JSON。
    throw new ApiError('server', res.status, 'stream_unsupported')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // `stream: true` 让多字节字符被截断在两块之间时也能正确解码。
      buffer += decoder.decode(value, { stream: true })

      let sep = buffer.indexOf('\n\n')
      while (sep !== -1) {
        const block = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        emit(block, onEvent)
        sep = buffer.indexOf('\n\n')
      }
    }
    // 有些服务端最后一帧不带空行结尾：丢掉它等于丢掉最终结果。
    if (buffer.trim()) emit(buffer, onEvent)
  } finally {
    // 主动取消时要释放连接，否则浏览器会一直占着这条流。
    void reader.cancel().catch(() => undefined)
  }
}

function emit(block: string, onEvent: SseHandler): void {
  let event = 'message'
  const dataLines: string[] = []

  for (const raw of block.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!line || line.startsWith(':')) continue // 注释/心跳
    if (line.startsWith('event:')) {
      event = line.slice(6).trim() || 'message'
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  if (!dataLines.length) return

  const text = dataLines.join('\n')
  try {
    onEvent(event, JSON.parse(text) as unknown)
  } catch {
    // 单帧不是合法 JSON 不该让整条流炸掉：后面的帧还有用。
    onEvent('invalid', text)
  }
}
