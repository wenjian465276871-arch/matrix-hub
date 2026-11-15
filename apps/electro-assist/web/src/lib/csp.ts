/** CSP 违规上报（2026-11-15，R24-2）。
 *
 *  为什么需要单独接这一个事件：
 *  `main.ts` 已经挂了 `error` / `unhandledrejection` / `vue:errorHandler` / `vite:preloadError`
 *  四条钩子，但 **CSP 拦截不会触发其中任何一条**——被拦的资源不产生 `error` 事件，
 *  内联脚本被拒也不抛异常，只在控制台留一行红字。表现是"线上白屏 / 某个功能静默失效，
 *  而服务端一条记录都没有"，与 2026-11-02 那次旧 bundle 事故是同一类故障：
 *  前端自己知道出了事，但没人收到通知。
 *
 *  口径（三条，与 `lib/report.ts` 保持一致）：
 *  1. **只报指令与资源地址**，不报页面内容——CSP 的 `blockedURI` 本身就是资源路径，
 *     不含用户输入；`sourceFile` 只保留文件名部分，避免把完整 URL（可能带查询串）带出去。
 *  2. 复用 `reportError`：它自带每会话 20 条上限与 60 秒去重，CSP 刷屏不会打爆后端。
 *  3. **不做兜底重试**：上报失败就失败，观测链路自己不能成为新的故障源。
 *
 *  为什么不只用 Caddy 的 `report-to`：标准上报要求浏览器支持 Reporting API，
 *  而现场是"老 WebView"（见 `ConfirmDialog.vue` 的说明）；前端事件在能跑 JS 的地方都能跑，
 *  覆盖面更稳。两者都上最好，但这一条零成本，先上这一条。
 */
import { reportError } from './report'

/** `SecurityPolicyViolationEvent` 在 happy-dom / 老内核里可能不存在，按结构取值。 */
interface ViolationLike extends Event {
  violatedDirective?: string
  effectiveDirective?: string
  blockedURI?: string
  sourceFile?: string
  lineNumber?: number
}

/** 只保留 `sourceFile` 的最后一段：整条 URL 可能带查询串，没必要外传。 */
function tail(path: string): string {
  if (!path) return ''
  const cut = path.lastIndexOf('/')
  return cut >= 0 ? path.slice(cut + 1) : path
}

/**
 * 挂上监听，返回卸载函数（单测用；生产只调一次，不需要卸载）。
 *
 * `target` 默认 `document`：CSP 违规事件在 document 上派发，且不冒泡到 window 的
 * `error` 通道——这正是原来四条钩子接不到它的原因。
 */
export function installCspReporter(target: EventTarget = document): () => void {
  const onViolation = (event: Event): void => {
    const e = event as ViolationLike
    // `violatedDirective` 是原始指令，`effectiveDirective` 是回落后的实际指令；
    // 两者常常相同，不同时（例如 default-src 兜住 script-src）原始值更有诊断价值。
    const directive = e.violatedDirective || e.effectiveDirective || 'unknown'
    const blocked = e.blockedURI || 'inline'
    const where = e.lineNumber ? `${tail(e.sourceFile || '')}:${e.lineNumber}` : tail(e.sourceFile || '')
    reportError(`${directive} 拦截 ${blocked}`.slice(0, 300), {
      kind: 'csp',
      source: where,
    })
  }

  target.addEventListener('securitypolicyviolation', onViolation)
  return () => target.removeEventListener('securitypolicyviolation', onViolation)
}
