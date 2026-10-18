/** 极简网络层：只做三件事——超时、错误归一、JSON 解析。
 *
 * 不做重试、不做缓存：W1 的页面是只读列表与详情，重试只会掩盖服务端问题。
 * 错误类型区分 `notfound` 与 `server`，因为二者对用户的意义完全不同：
 * 前者是"链接失效"，后者是"稍后再试"。
 */

export type ApiErrorKind = 'notfound' | 'server' | 'network' | 'timeout'

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(code ?? kind)
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

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const merged = signal ? combine(signal, timeout) : timeout

  let res: Response
  try {
    res = await fetch(path, { headers: { Accept: 'application/json' }, signal: merged })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new ApiError('timeout')
    }
    throw new ApiError('network')
  }

  if (res.status === 404) throw new ApiError('notfound', 404)
  if (!res.ok) {
    let code: string | undefined
    try {
      const body = (await res.json()) as { detail?: { code?: string } }
      code = body.detail?.code
    } catch {
      /* 非 JSON 错误体：保留状态码即可 */
    }
    throw new ApiError('server', res.status, code)
  }

  return (await res.json()) as T
}
