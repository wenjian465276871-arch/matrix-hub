import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from './http'
import { postStream } from './sse'

/** 拼 SSE 文本：真实帧就是这两行 + 空行。 */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** 一个按块吐数据的流；`failAfter` 为 true 时"吐完这些块"再抛错（模拟断网）。
 *
 *  必须用 `pull` 而不是在 `start` 里写完：`controller.error()` 会丢弃队列里
 *  还没读走的块——那样断点会变成"一帧都没收到"，测的就不是重连逻辑了。
 */
function streamOf(chunks: string[], failAfter = false): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]))
        index += 1
        return
      }
      if (failAfter) controller.error(new Error('network down'))
      else controller.close()
    },
  })
}

interface FakeResponse {
  ok: boolean
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array> | null
  json: () => Promise<unknown>
  text: () => Promise<string>
}

function ok(body: ReadableStream<Uint8Array> | null): FakeResponse {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body,
    json: async () => ({}),
    text: async () => '',
  }
}

function fail(status: number, detail: unknown): FakeResponse {
  return {
    ok: false,
    status,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    body: null,
    json: async () => ({ detail }),
    text: async () => JSON.stringify({ detail }),
  }
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('postStream', () => {
  it('按顺序派发三帧，不触发重连', async () => {
    const seen: string[] = []
    const fetchMock = vi.fn(async () =>
      ok(streamOf([frame('recall', { stage: 'recall' }), frame('done', { stage: 'done' })])),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await postStream('/api/x', { q: 1 }, {
      onEvent: (event) => seen.push(event),
    })

    expect(seen).toEqual(['recall', 'done'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('断流后重连一次，并带上最后收到的事件名', async () => {
    const seen: string[] = []
    const headers: (Record<string, string> | undefined)[] = []
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      headers.push(init?.headers as Record<string, string>)
      if (fetchMock.mock.calls.length === 1) {
        // 只发出 recall 就断：重连的触发条件正是"收到过帧、没收到终止帧"
        return ok(streamOf([frame('recall', { stage: 'recall' })], true))
      }
      return ok(streamOf([frame('rerank', { stage: 'rerank' }), frame('done', { stage: 'done' })]))
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await postStream('/api/x', { q: 1 }, {
      onEvent: (event) => seen.push(event),
    })

    expect(seen).toEqual(['recall', 'rerank', 'done'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(headers[0]?.['Last-Event-ID']).toBeUndefined()
    expect(headers[1]?.['Last-Event-ID']).toBe('recall')
  })

  it('一帧都没收到就失败时不重连：那等于偷偷重跑整个请求', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(postStream('/api/x', { q: 1 }, { onEvent: () => undefined })).rejects.toThrow(
      ApiError,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('429 这类配额错误不重连', async () => {
    const fetchMock = vi.fn(async () =>
      fail(429, { code: 'rate_limited', message: '太频繁', retry_after: 30 }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(postStream('/api/x', { q: 1 }, { onEvent: () => undefined })).rejects.toMatchObject(
      { kind: 'ratelimit', status: 429, retryAfter: 30 },
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('流正常关闭但没有终止帧时也重连（静默截断比报错更坏）', async () => {
    const seen: string[] = []
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return ok(streamOf([frame('recall', { stage: 'recall' })]))
      }
      return ok(streamOf([frame('rerank', { stage: 'rerank' }), frame('done', { stage: 'done' })]))
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await postStream('/api/x', { q: 1 }, {
      onEvent: (event) => seen.push(event),
    })

    expect(seen).toEqual(['recall', 'rerank', 'done'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('重连后仍然截断就抛错，不再多试', async () => {
    const fetchMock = vi.fn(async () => ok(streamOf([frame('recall', { stage: 'recall' })])))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(postStream('/api/x', { q: 1 }, { onEvent: () => undefined })).rejects.toMatchObject({
      code: 'stream_truncated',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('resume=false 时完全不重连（一次性调用用得上）', async () => {
    const fetchMock = vi.fn(async () => ok(streamOf([frame('recall', {})], true)))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      postStream('/api/x', { q: 1 }, { onEvent: () => undefined, resume: false }),
    ).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
