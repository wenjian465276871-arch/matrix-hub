/** 皮肤状态：全站唯一 key、唯一写入点（视觉规范 §6「状态单源」）。
 *
 *  三条约定：
 *  1. **不跟随系统** `prefers-color-scheme`——现场平板可能被系统设成暗色，
 *     但作业页需要亮色；跟随系统等于把开关交给别人。
 *  2. **挂 `html` 上的 class**，不是 `:root` 的属性覆盖：`html.theme-dark`
 *     比 `:root` 多一个类，才能压过亮色令牌（打印见 print.css 同一坑）。
 *  3. **模块导入即上色**：等到 `onMounted` 再打 class，首屏会先白一下再变黑。
 */
import { readonly, ref } from 'vue'

export type ThemeName = 'light' | 'dark'

const KEY = 'electro-theme'
const root = document.documentElement

function read(): ThemeName {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    // 隐私模式下 localStorage 会抛：按亮色处理，不阻断渲染
    return 'light'
  }
}

const current = ref<ThemeName>(read())

function paint(name: ThemeName): void {
  root.classList.toggle('theme-dark', name === 'dark')
}

export function applyTheme(name: ThemeName): void {
  if (current.value === name) return
  current.value = name
  paint(name)
  try {
    localStorage.setItem(KEY, name)
  } catch {
    // 存不下就只影响"下次打开"，不影响本次切换
  }
}

export function toggleTheme(): void {
  applyTheme(current.value === 'dark' ? 'light' : 'dark')
}

export const theme = readonly(current)

paint(current.value)
