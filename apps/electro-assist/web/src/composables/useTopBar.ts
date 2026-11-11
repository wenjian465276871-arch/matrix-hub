/** 顶栏投稿口：页面把自己的「正在查看 / 标题 / 进度」交给全站唯一那条顶栏。
 *
 *  为什么要有这一层：参考站是**一条** 88px 顶栏承载品牌 + 正在看什么 + 模块切换 +
 *  进度。本项目原来是「48px 深色导航 + 页内白条」两层，等于每条信息都付两次
 *  垂直空间。合成一条之后，页内就不该再有自己的 bar——页面只能"投稿"，
 *  不能自己画一条。这样任何新页面都不会再长出第二种头部。
 *
 *  约定：
 *  - 页面挂载时 setTopBar({...})，卸载时 resetTopBar()；
 *  - 没投稿的页面由 App 用路由标题兜底（作业库/生成/排查/演示各自一句）；
 *  - progress 为 null 时右端不渲染进度块，而不是显示 0/0 骗人。
 */
import { reactive } from 'vue'

export interface TopBarAction {
  label: string
  onClick: () => void
  disabled?: boolean
  /** 主色实心。只有"开始作业"这种真正的主线动作用它——
   *  按位置取第一个会把"返回探索台"这种导航动作刷成主按钮。 */
  primary?: boolean
}

export interface TopBarState {
  /** 小字（"正在查看 02 / 05"这类） */
  kicker: string
  /** 主标题（指导书名 / 页面名） */
  title: string
  /** 右侧进度：label + 当前值 + 总数 */
  progress: { label: string; value: number; total: number } | null
  /** 标题右侧的动作（开始作业 / 打印 / 草稿） */
  actions: TopBarAction[]
}

const state = reactive<TopBarState>({
  kicker: '',
  title: '',
  progress: null,
  actions: [],
})

/** 页面投稿。只给要改的字段，其余保持上一次的值会让上一个页面串味，
 *  所以每次调用都整体替换（调用方通常一次给全）。 */
export function setTopBar(patch: Partial<TopBarState>): void {
  state.kicker = patch.kicker ?? state.kicker
  state.title = patch.title ?? ''
  state.progress = patch.progress ?? null
  state.actions = patch.actions ?? []
}

export function resetTopBar(): void {
  state.kicker = ''
  state.title = ''
  state.progress = null
  state.actions = []
}

export function useTopBar(): TopBarState {
  return state
}
