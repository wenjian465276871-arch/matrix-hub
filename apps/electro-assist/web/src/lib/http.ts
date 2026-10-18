/** 极简网络层：只做三件事——超时、错误归一、JSON 解析。
 *
 * 不做自动重试：生成接口有配额，"重试"必须由用户显式触发。
 * 错误类型区分 `notfound` / `ratelimit` / `server`，
 * 因为三者对用户的意义完全不同：链接失效 / 额度用完 / 稍后再试。
 */

export type ApiErrorKind = 'notfound' | 'ratelimit' | 'server' | 'network' | 'timeout'

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly status?: number,
    readonly code?: string,
    message?: string,
  ) {
    super(message ?? code ?? kind)
    this.name = 'ApiError'
  }
}

const TIMEOUT_MS = 15_000

/** 现场 WebView 版本不可控，`AbortSignal.any` 不是所有内核都有。 */
function combine(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b])
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  a.addEventListener('abort', onAbort, { once: true })
  b.addEventListener('abort', onAbort, { once: true })
  return ctrl.signal
}

interface ErrorBody {
  detail?: { code?: string; message?: string; retry_after?: number }
}

async function request<T>(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const merged = signal ? combine(signal, timeout) : timeout

  let res: Response
  try {
    res = await fetch(path, { ...init, signal: merged })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new ApiError('timeout')
    }
    throw new ApiError('network')
  }

  if (res.status === 404) throw new ApiError('notfound', 404)
  if (!res.ok) {
    let code: string | undefined
    let message: string | undefined
    try {
      const body = (await res.json()) as ErrorBody
      code = body.detail?.code
      message = body.detail?.message
    } catch {
      /* 非 JSON 错误体：保留状态码即可 */
    }
    const kind: ApiErrorKind = res.status === 429 ? 'ratelimit' : 'server'
    throw new ApiError(kind, res.status, code, message)
  }

  return (await res.json()) as T
}

export function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { headers: { Accept: 'application/json' } }, signal)
}

export function postJson<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return request<T>(
    path,
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    signal,
  )
}
