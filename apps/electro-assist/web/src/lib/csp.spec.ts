import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installCspReporter } from './csp'
import { resetReporter } from './report'

/** 造一个 CSP 违规事件：`SecurityPolicyViolationEvent` 在 happy-dom 里可能不存在，
 *  而真实浏览器里它是 `Event` 子类、字段都是只读的——所以用 defineProperty 挂字段。 */
function violation(props: Record<string, unknown>): Event {
  const event = new Event('securitypolicyviolation')
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { value, enumerable: true })
  }
  return event
}

let beacon: ReturnType<typeof vi.fn>
/** 监听器挂在共享的 `document` 上，跨用例会串——每个用例装一次、`afterEach` 卸一次。 */
let off: (() => void) | null = null

function install(): void {
  off = installCspReporter(document)
}

beforeEach(() => {
  resetReporter()
  beacon = vi.fn(() => true)
  Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true, writable: true })
})

afterEach(() => {
  off?.()
  off = null
})

async function sent(): Promise<string> {
  const blob = beacon.mock.calls[0][1] as Blob
  return blob.text()
}

describe('CSP 违规上报', () => {
  it('把指令与资源地址发到 fe-error，source 只留文件名与行号', async () => {
    install()
    document.dispatchEvent(
      violation({
        violatedDirective: 'script-src-elem',
        blockedURI: 'inline',
        sourceFile: '/apps/electro-assist/assets/index-abc123.js',
        lineNumber: 12,
      }),
    )

    expect(beacon).toHaveBeenCalledTimes(1)
    expect(beacon.mock.calls[0][0]).toBe('/api/electro/fe-error')
    const body = JSON.parse(await sent()) as { message: string; kind: string; source: string }
    expect(body.message).toBe('script-src-elem 拦截 inline')
    expect(body.kind).toBe('csp')
    // 只留文件名：完整 URL 可能带查询串，没必要外传
    expect(body.source).toBe('index-abc123.js:12')
  })

  it('缺字段时退化成 unknown 拦截 inline，不抛错', async () => {
    install()
    document.dispatchEvent(violation({}))
    const body = JSON.parse(await sent()) as { message: string }
    expect(body.message).toBe('unknown 拦截 inline')
  })

  it('同一条 60 秒内只报一次（复用 reportError 的去重）', () => {
    install()
    const event = violation({ violatedDirective: 'style-src', blockedURI: 'inline' })
    document.dispatchEvent(event)
    document.dispatchEvent(event)
    expect(beacon).toHaveBeenCalledTimes(1)
  })

  it('卸载后不再上报', () => {
    install()
    off?.()
    off = null
    document.dispatchEvent(violation({ violatedDirective: 'img-src', blockedURI: 'https://x.test/a.png' }))
    expect(beacon).not.toHaveBeenCalled()
  })

  it('没有 sendBeacon 时退回 fetch（keepalive）', async () => {
    Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: true, writable: true })
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    install()
    document.dispatchEvent(violation({ violatedDirective: 'connect-src', blockedURI: 'https://api.test/x' }))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/electro/fe-error')
    expect(init.keepalive).toBe(true)
  })
})
