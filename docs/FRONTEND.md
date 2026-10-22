# 前端实现方案（as-built）

> 版本 v1.0 · 最后更新：2026-10-23 · 代码位置 `apps/electro-assist/web`
> Vue 3.5 + Vite 6 + TypeScript，静态产物由 Caddy 直服，base `/apps/electro-assist/`。
> 本文是**代码结构说明**，不是设计稿：写"实际有什么"，以及"为什么比方案简单"。
> 视觉值见 `UI.md`，交互状态见 `UX.md`。

## 0. 四个前置决策

| 决策 | 结论 | 理由 |
|---|---|---|
| TypeScript | **采用** | 契约仍在演进，`Job`/判据都是联合类型，靠类型提前暴露漂移；esbuild 只剥类型，**产物零成本**。`vue-tsc --noEmit` 在 `npm run build` 里跑，0 error 才出包 |
| 状态库 | **不引入 Pinia** | 三个页面的状态生命周期都短于一次导航：生成态随跳转结束、引导态由 `GET /sessions/{id}` 重建、配额每次进页拉一次。引 store 只增加同步点 |
| B 流式 | **不做**，一次性 JSON | 知识库 18 条、P95 个位数毫秒，没有可流的内容；传输统一走 `lib/http.ts` |
| 关键 CSS 内联 | **否决** | 内联 `<style>` 需 `style-src 'unsafe-inline'`，与 `default-src 'self'` 冲突。改单文件 CSS + `<link>`，并关掉 `modulePreload.polyfill` |

一句话：**代码比方案简单得多**——没有 store、没有 SSE、没有独立 UI 组件库，状态在视图里，网络层只有一个文件。

## 1. 工程结构（实际）

```
apps/electro-assist/web/
├── index.html               # 无内联 script/style
├── vite.config.ts           # base / cssCodeSplit:false / modulePreload.polyfill:false
├── package.json             # 依赖只有 vue + vue-router（+ 构建期 vue-tsc / vite / typescript）
├── playwright.config.ts     # E2E：本机 msedge，双视口
└── src/
    ├── main.ts  App.vue     # 顶部 48px 深色条 + RouterView + 页脚声明
    ├── types.ts             # 与服务端契约对应的类型（385 行）
    ├── router/index.ts      # 6 条路由 + 通配回落
    ├── lib/http.ts          # 唯一网络层：15s 超时、错误归一、JSON 解析；不自动重试
    ├── lib/errors.ts        # 服务端 code → 用户文案映射
    ├── styles/              # tokens.css / base.css / print.css
    ├── figures/             # registry.ts + svg.ts + GuideFigure.vue + primitives/（7 个）
    └── views/               # LibraryView / NewGuideView / GuideView / RunView / RecordView / DiagnoseView
```

规模：前端 5238 行（vue/ts/css），最大文件 `RunView.vue` 825 行。

### 1.1 路由

| 路径 | 组件 | 加载 |
|---|---|---|
| `/` | `LibraryView` | 首屏 eager |
| `/new` | `NewGuideView` | 懒加载（表单 + 轮询 + 口令） |
| `/guide/:id` | `GuideView` | 懒加载（含图示渲染） |
| `/run/:sid` | `RunView` | 懒加载（判据表单 + 48px 操作条） |
| `/record/:sid` | `RecordView` | 懒加载（含打印样式） |
| `/diagnose` | `DiagnoseView` + `useDiagnoseRun` | 懒加载（双模式） |
| `/:pathMatch(.*)*` | → `/` | —— |

深链：Caddy 对该前缀 `try_files {path} /apps/electro-assist/index.html`，`/api/*` 必须在此之前被 `handle` 拦走。

### 1.2 CSP 与构建约束

```
default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self';
connect-src 'self'; frame-ancestors 'none'; base-uri 'none'
```

由此推出三条硬约束：不内联 script/style、`modulePreload.polyfill:false`、`assetsInlineLimit:0`。
CI 里有一条产物检查：`dist/index.html` 不得含无 `src` 的 `<script>`。

## 2. 网络层

```ts
export type ApiErrorKind = 'notfound' | 'ratelimit' | 'server' | 'network' | 'timeout'

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly status?: number,
    readonly code?: string,   // 服务端 detail.code，用于文案映射
    message?: string,
    readonly ref?: string,    // 500 的错误号，用户可报给运维
  ) { super(message ?? code ?? kind) }
}
```

判定顺序：`timedOut` → `timeout`；`!navigator.onLine` → `network`；`404` → `notfound`；
`429` → `ratelimit`；`≥500` → `server`。**不做自动重试**——生成接口有配额，"重试"必须由用户显式触发。

超时 15s，用 `AbortController` + `setTimeout`，`timedOut` 标记区分"超时"与"页面卸载主动 abort"。

> **为什么不用 `AbortSignal.timeout`**：Chrome <103 / Safari <16.4 没有这个静态方法，
> 调用会在 `fetch` 之前抛 `TypeError`，页面表现就是"未知错误"（真机踩过）。
> `AbortSignal.any` 同理保留手写 `combine()` 降级，并补了"信号已 abort"的判断。

## 3. 状态与数据

没有全局 store。每个视图自带 `phase`（`loading / ready / error` 或等价枚举），数据来自服务端：

| 页面 | 数据来源 | 状态 |
|---|---|---|
| 库页 | `GET /guides` | `phase` + 列表 |
| 生成页 | `POST /generate` → `GET /jobs/{id}` 轮询 | 表单 + 轮询 + 口令 token（`sessionStorage`） |
| 指导书 | `GET /guides/{id}` | `phase` + guide |
| 引导 | `GET /sessions/{id}` + `POST /steps/{seq}` | 本地当前步 + 服务端 `current_seq` |
| 记录 | `GET /records/{sid}` | `phase` + report |
| 排查 | `POST /diagnose` / `/diagnose/runs` | `useDiagnoseRun` composable |

跨页不缓存：刷新后由服务端重建。代价是 `/new` 刷新会回到空表单（已扣配额不退，`retry_of` 可申请豁免）。

口令 token 只放 `sessionStorage`（关标签页即失效），不写 `localStorage`；隐私模式下 `sessionStorage` 可能直接抛异常，已用 try/catch 退化为"仅本页有效"。

## 4. 图示渲染

`figures/registry.ts` 把 DSL 的 `kind` 映射到 7 个原语组件：
`step_card / meter / status_light / wiring / connector / torque_gauge / checklist`。
`GuideFigure.vue` 用 `defineAsyncComponent` 按需加载，未知类型降级为"无图版"而不是空白。

所有原语是**内联 SVG**（`svg.ts` 提供线宽/配色/标注工具函数）：继承 `currentColor`、可打印、零请求。
DSL 由后端生成并做 schema 校验，前端只负责按规格渲染——**前端不做任何布局推断**，
否则同一份指导书在不同版本会画出不同的图。

## 5. 打印

两套 print CSS 随路由动态加载，规则全在 `@media print` 内：

- 指导书：隐导航/按钮/页脚，卡片去边框去阴影，图示去底去圆角，线宽不变
- 记录：异常链单独成节；页眉用 `<thead>` 内单行（左编号 / 右时间），**不做页码**
- 打印强制亮色令牌，否则深色皮肤会打出黑底白字
- `content-visibility` 在打印时必须还原 `visible`，否则出空白页

## 6. 性能

| 项 | 预算（gzip） | 实测 |
|---|---|---|
| 首屏 JS | ≤75KB（硬顶 90KB） | **40.08KB** |
| 首屏 CSS | ≤14KB | **5.40KB** |
| 路由 chunk | ≤30KB | 最大 5.88KB（`DiagnoseView`） |
| 单个原语 chunk | ≤2KB | 由 `GuideFigure` 共享 chunk 承载 |

`cssCodeSplit:false` 让全站 CSS 合成一个文件（一次 RTT 拿全，代价是后续路由不再请求样式）；
路由 `() => import()` 分割；构建目标 `es2020`。

不引入虚拟滚动：上界确定（库 6 份、步骤 ≤20、候选 ≤8、记录 ≤30），
`content-visibility:auto` 足够，虚拟滚动反而破坏打印完整性与 Ctrl+F。

## 7. 测试现状

| 项 | 状态 |
|---|---|
| 类型检查 | `vue-tsc --noEmit`，0 error 才出包 |
| 单测 | **无**（未引入 Vitest） |
| E2E | Playwright 4 条：生成链路、A1 四步含复测、异常转排查、诊断会话；CI 内跑，失败阻断发布 |
| 打印 | Chromium 打印记录页，A4 三页无截断（真机验收 2026-10-21） |
| 可访问性 | 人工抽查键盘与 `aria`；**未跑 axe-core 全量扫描**（见根 `README.md` 的验收章节） |

为什么不补前端单测：核心判定全在服务端（194 条测试覆盖），前端只有 6 个视图；
E2E 抓的是 DOM 回归，比给 `lib/http.ts` 写 mock 更值钱。真要补，优先补 `errors.ts` 的映射表。

## 8. 已知坑（都踩过，别再踩）

| 坑 | 现象 | 正解 |
|---|---|---|
| `AbortSignal.timeout` | 真机上所有请求报"未知错误" | `AbortController` + `setTimeout` + `timedOut` 标记 |
| `hour12:false` | 部分内核输出 `24:42:45` | `hourCycle:'h23'`，并固定年月日时分秒 |
| 内联 script | CSP 拦截，白屏 | 关 `modulePreload.polyfill`，产物检查兜底 |
| `content-visibility` | 打印出空白页 | `@media print` 强制 `visible` |
| Vite 默认 base | 深链 404 | `base:'/apps/electro-assist/'` + Caddy `try_files` |
| 单位 chip 自适应 | 判据行参差 | chip 固定 44px，>3 字符统一 56px，绝不 `overflow:hidden` 截断 |

## 9. 未实现（方案里有、代码里没有）

| 项 | 现状 | 说明 |
|---|---|---|
| `stores/`（job/run/quota） | 不存在 | 状态在视图内；跨页靠服务端重建 |
| `lib/sse.ts` + 流式解析 | 不存在 | B 一次性 JSON |
| `lib/poll.ts` | 不存在 | 轮询内联在 `NewGuideView`（`setTimeout` 链 + 2s 退避） |
| `lib/idempotency.ts` | 不存在 | `RunView` 内直接拼 `{sid}:s{seq}:a{attempt}` |
| `composables/`（6 个） | 只有 `useDiagnoseRun` | 无 `useFocusTrap` / `useVisualViewport` |
| `components/ui/`（13 个） | 不存在 | 样式写在 `base.css` 与视图 `<style scoped>` |
| `job_id` 刷新续接 | 未做 | 刷新回 `/new` 重新提交 |
| 前端单测（Vitest） | 未做 | 见 §7 |
| `_fe-error` 上报端点 | 未做 | 控制器层没有捕获后上报 |

保留这张表的目的：读代码的人不必猜"是不是我没找到"，而是明确知道"这里就是没做"。
