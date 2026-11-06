/**
 * 访问口令令牌的本地保存。
 *
 * 只放 sessionStorage：关掉标签页即失效，不写 localStorage——口令是"这一次的授权"，
 * 不该在共用机器的下次开机里还留着。
 *
 * 隐私模式 / 旧 WebView 里 sessionStorage 可能直接抛异常：令牌退化为"仅本页有效"，
 * 不影响生成，只是刷新后要重新输入。所以每个函数都吞异常。
 *
 * 2026-11-06 从 NewGuideView 抽出：口令弹层拆成组件后，父子两侧都要读写它。
 */
export const PASSCODE_KEY = 'electro_passcode'

export function readStoredToken(): string {
  try {
    return sessionStorage.getItem(PASSCODE_KEY) || ''
  } catch {
    return ''
  }
}

export function storeToken(token: string): void {
  try {
    sessionStorage.setItem(PASSCODE_KEY, token)
  } catch {
    /* 忽略：内存里仍有 token */
  }
}

export function dropStoredToken(): void {
  try {
    sessionStorage.removeItem(PASSCODE_KEY)
  } catch {
    /* 忽略 */
  }
}
