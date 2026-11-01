/** SSE 客户端：`fetch` + `ReadableStream`（计划 §12.7 裁决 3）。
 *
 *  为什么不用 `EventSource`：它只能 GET、不能带请求体、也拿不到状态码。
 *  排查接口是 POST + JSON 入参，且 429/422 必须能被读到并显示 `Retry-After`——
 *  EventSource 遇到非 200 只会静默重连，用户看到的是"一直转圈"。
 *
 *  不实现 `Last-Event-ID` 重连：`POST /diagnose` 不承诺跨请求续生成
 *  （§12.8 明确写了），重连等于把同一次检索重跑一遍，多花钱还不一定更快。
 *  断流就如实报错，让用户点重试。
 */

import { ApiError, parseErrorResponse } from './http'

export type SseHandler = (event: string, data: unknown) => void

interface StreamOptions {
  signal?: AbortSignal
  onEvent: SseHandler
}

/** 一次 SSE 请求。正常结束 resolve；HTTP 错误抛 `ApiError`；网络中断抛原异常。 */
export async function postStream(
  path: string,
  body: unknown,
  { signal, onEvent }: StreamOptions,
): Promise<void> {
  let res: Response
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
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
