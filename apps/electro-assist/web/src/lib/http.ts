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
    readonly ref?: string,
  ) {
    super(message ?? code ?? kind)
    this.name = 'ApiError'
  }
}

const TIMEOUT_MS = 15_000
/** 上传要走完整读文件 + 转码 + 落盘，15 秒在移动网络下不够；页面只等这一件事。 */
const UPLOAD_TIMEOUT_MS = 60_000

/** 现场 WebView 版本不可控：`AbortSignal.timeout` / `AbortSignal.any`
 * 不是所有内核都有（Chrome < 103、Safari < 16.4 会直接抛 TypeError，
 * 页面表现就是"未知错误"）。这里统一用 AbortController 兜底。
 */
function combine(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b])
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  // 已经 abort 的信号不会再触发事件，必须先判一次。
  if (a.aborted || b.aborted) ctrl.abort()
  a.addEventListener('abort', onAbort, { once: true })
  b.addEventListener('abort', onAbort, { once: true })
  return ctrl.signal
}

interface ErrorBody {
  detail?: { code?: string; message?: string; retry_after?: number; ref?: string }
}

async function request<T>(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
  timeoutMs: number = TIMEOUT_MS,
): Promise<T> {
  // 不用 AbortSignal.timeout：老内核没有这个静态方法，会在 fetch 之前就抛
  // TypeError，被上层当成"未知错误"。timedOut 标记同时解决了"超时"与
  // "页面卸载主动 abort"无法区分的问题。
  let timedOut = false
  const timeoutCtrl = new AbortController()
  const timer = setTimeout(() => {
    timedOut = true
    timeoutCtrl.abort()
  }, timeoutMs)
  const merged = signal ? combine(signal, timeoutCtrl.signal) : timeoutCtrl.signal

  let res: Response
  try {
    res = await fetch(path, { ...init, signal: merged })
  } catch {
    throw new ApiError(timedOut ? 'timeout' : 'network')
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 404) throw new ApiError('notfound', 404)
  if (!res.ok) {
    let code: string | undefined
    let message: string | undefined
    let ref: string | undefined
    try {
      const body = (await res.json()) as ErrorBody
      code = body.detail?.code
      message = body.detail?.message
      // 服务端 500 会带 ref：显示出来，用户报障时能对上日志。
      ref = body.detail?.ref || res.headers.get('X-Request-Id') || undefined
    } catch {
      ref = res.headers.get('X-Request-Id') || undefined
    }
    const kind: ApiErrorKind = res.status === 429 ? 'ratelimit' : 'server'
    const shown = message ? (ref ? `${message}（错误号 ${ref}）` : message) : undefined
    throw new ApiError(kind, res.status, code, shown, ref)
  }

  return (await res.json()) as T
}

export function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { headers: { Accept: 'application/json' } }, signal)
}

export interface PostOptions {
  signal?: AbortSignal
  headers?: Record<string, string>
  /** 覆盖默认 15s；上传走 60s */
  timeoutMs?: number
}

export function postJson<T>(
  path: string,
  body: unknown,
  options: PostOptions = {},
): Promise<T> {
  return request<T>(
    path,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...options.headers,
      },
      body: JSON.stringify(body),
    },
    options.signal,
    options.timeoutMs,
  )
}

export function putJson<T>(
  path: string,
  body: unknown,
  options: PostOptions = {},
): Promise<T> {
  return request<T>(
    path,
    {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...options.headers,
      },
      body: JSON.stringify(body),
    },
    options.signal,
    options.timeoutMs,
  )
}

/** multipart 上传。**不要手动设 Content-Type**：boundary 由浏览器生成。 */
export function postForm<T>(
  path: string,
  form: FormData,
  options: PostOptions = {},
): Promise<T> {
  return request<T>(
    path,
    { method: 'POST', headers: { Accept: 'application/json', ...options.headers }, body: form },
    options.signal,
    options.timeoutMs ?? UPLOAD_TIMEOUT_MS,
  )
}
