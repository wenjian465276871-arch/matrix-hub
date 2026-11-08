# 前端实现方案（as-built）

> 版本 v1.2 · 最后更新：2026-11-01 · 代码位置 `apps/electro-assist/web`
> Vue 3.5 + Vite 6 + TypeScript，静态产物由 Caddy 直服，base `/apps/electro-assist/`。
> 本文是**代码结构说明**，不是设计稿：写"实际有什么"，以及"为什么比方案简单"。
> 视觉值见 `UI.md`，交互状态见 `UX.md`。

## 0. 四个前置决策

| 决策 | 结论 | 理由 |
|---|---|---|
| TypeScript | **采用** | 契约仍在演进，`Job`/判据都是联合类型，靠类型提前暴露漂移；esbuild 只剥类型，**产物零成本**。`vue-tsc --noEmit` 在 `npm run build` 里跑，0 error 才出包 |
| 状态库 | **不引入 Pinia** | 三个页面的状态生命周期都短于一次导航：生成态随跳转结束、引导态由 `GET /sessions/{id}` 重建、配额每次进页拉一次。引 store 只增加同步点 |
| B 流式 | ~~**不做**，一次性 JSON~~ → **做三帧业务流**（2026-11-01 起） | 原判断只对一半：召回是毫秒，但**重排是一次模型调用 1–4 秒**，等的就是它。流 `recall → rerank → done`，每帧对应一步真的完成；切三段发是假流式。传输走 `lib/sse.ts`（`fetch` + `getReader`，只有它能读到 429 与 `Retry-After`） |
| 关键 CSS 内联 | **否决** | 内联 `<style>` 需 `style-src 'unsafe-inline'`，与 `default-src 'self'` 冲突。改单文件 CSS + `<link>`，并关掉 `modulePreload.polyfill` |

一句话：**代码比方案简单得多**——没有 store、没有独立 UI 组件库，状态在视图里，网络层只有 `http.ts` + `sse.ts` 两个文件。

## 1. 工程结构（实际）

```
apps/electro-assist/web/
├── index.html               # 无内联 script/style
├── vite.config.ts           # base / cssCodeSplit:false / modulePreload.polyfill:false
├── package.json             # 依赖只有 vue + vue-router（+ 构建期 vue-tsc / vite / typescript）
├── playwright.config.ts     # E2E：本机 msedge，双视口
└── src/
    ├── main.ts  App.vue     # 顶部 48px 深色条 + RouterView + 页脚声明
    ├── types.ts             # 与服务端契约对应的类型（含 MotionTrack）
    ├── router/index.ts      # 8 条路由（含 /privacy 与通配回落）+ 焦点归位
    ├── lib/http.ts          # 唯一网络层：15s（上传 60s）超时、错误归一、JSON/multipart；不自动重试
    ├── lib/errors.ts        # 服务端 code → 用户文案映射
    ├── lib/theme.ts         # 皮肤单例：唯一 key electro-theme、唯一写入点、导入即上色
    ├── lib/jobhandoff.ts    # job_id + startedAt 的跨页交接（生成页续接、详情页「再生成」共用一份键名）
    ├── lib/viewport.ts      # visualViewport → --kb-inset（软键盘顶升底栏，阈值 120px）
    ├── styles/              # tokens.css（亮/暗两套令牌） / base.css / print.css
    ├── figures/             # registry.ts + svg.ts + motion.ts + GuideFigure.vue + primitives/（13 个）
    ├── components/          # ui/（确认弹层 / 抽屉 / 暗色提示条） + diagnose/（快速结果、逐步诊断）
    ├── composables/         # useDiagnoseRun（B 的逐步诊断状态机）
    └── views/               # Library / NewGuide / Guide / Run / Record / Diagnose / Privacy
```

规模：前端 **11,985 行 / 59 文件**（vue/ts/css，不含 12 份 `*.spec.ts`；2026-11-06 实测）。
最大文件 `NewGuideView.vue` **1,154 行**、`RunView.vue` **874 行**、`GuideView.vue` **814 行**。
拆分已于 2026-11-06 完成（见 §9.1）；剩余部分是职责集中的页面壳，**不再按行数强拆**。

### 1.1 路由

| 路径 | 组件 | 加载 |
|---|---|---|
| `/` | `LibraryView` | 首屏 eager |
| `/new` | `NewGuideView` | 懒加载（表单 + 轮询 + 口令） |
| `/guide/:id` | `GuideView` | 懒加载（含图示渲染） |
| `/run/:sid` | `RunView` | 懒加载（判据表单 + 48px 操作条） |
| `/record/:sid` | `RecordView` | 懒加载（含打印样式） |
| `/diagnose` | `DiagnoseView` + `useDiagnoseRun` | 懒加载（双模式） |
| `/privacy` | `PrivacyView` | 懒加载（数据与保留期，页脚常驻入口） |
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

超时默认 15s，用 `AbortController` + `setTimeout`，`timedOut` 标记区分"超时"与"页面卸载主动 abort"。
**上传走 60s**（`postForm` 的默认值）：读文件 + 转码 + 落盘，移动网络下 15s 不够。

三个出口，共用同一个 `request()`：

| 函数 | 用途 | 注意 |
|---|---|---|
| `getJson` / `postJson` | 业务读写 | `Content-Type: application/json` |
| `putJson` | 草稿素材归位 | 全量替换语义 |
| `postForm` | 图片上传 | **不要手设 `Content-Type`**，boundary 由浏览器生成 |

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

`figures/registry.ts` 把 DSL 的 `primitive` 映射到 13 个原语组件（静态导入，随 `GuideView` 的 chunk 一起加载）：
`step_card / meter / status_light / wiring / connector / torque_gauge / checklist /
motion_timeline / flow_arrow / callout / gate_state / table / annotation`。
`GuideFigure.vue` 用 `onErrorCaptured` 兜底，未知类型或渲染抛错都降级为 `fallback_text`，不是空白。

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
| 首屏 JS | ≤75KB（硬顶 90KB） | **46.04KB**（2026-11-07 构建；拆分后组件包装 +0.26KB） |
| 首屏 CSS | ≤14KB | **10.31KB**（暗色令牌、动效类、隐私页、横屏两栏、窄屏堆叠、加载更多、占位样式） |
| 路由 chunk | ≤30KB | 最大 **9.15KB**（`NewGuideView`，含预检/切图/识别/轮询） |
| 单个原语 chunk | ≤2KB | 由 `GuideFigure` 共享 chunk 承载 |

`cssCodeSplit:false` 让全站 CSS 合成一个文件（一次 RTT 拿全，代价是后续路由不再请求样式）；
路由 `() => import()` 分割；构建目标 `es2020`。

不引入虚拟滚动：上界确定（库 6 份、步骤 ≤20、候选 ≤8、记录 ≤30），
`content-visibility:auto` 足够，虚拟滚动反而破坏打印完整性与 Ctrl+F。

**落地位置（2026-11-07）**：只加在 `.figure__canvas`（包住 SVG 原语的那层），
`contain-intrinsic-size: auto 240px`。**不能整块跳过 `.step` 或 `.figure`**——
实测后几步 `innerText` 归零、题注从 CDP 全量 AX 树里消失，等于拿可访问性换性能。
只跳画布时题注仍在无障碍树里，正文与判据完全不受影响。
8 步 / 20 图的正式案例：TBT 中位 **531 → 265ms**，Perf 中位 **85.5 → 95**（线上 9 轮）。
打印必须在 print.css 里 `content-visibility: visible !important`：组件是 scoped 的
（`.figure__canvas[data-v-xxx]` 权重 0,2,0），同权重规则只能赌加载顺序。

## 7. 测试现状

| 项 | 状态 |
|---|---|
| 类型检查 | `vue-tsc --noEmit`，0 error 才出包 |
| 单测 | **158 条**（Vitest 5.1 + @vue/test-utils + happy-dom）；覆盖率 **61.23 / 51.23 / 52.30 / 63.28**，四维阈值 54/52/43/43 **阻断** CI（2026-11-08） |
| E2E | Playwright **26 条**：6 条冒烟 + 抽屉/暗色/打印/取消 4 条 + 续接/倒计时/时间预算/隐私/**成功即跳转** 5 条 + **横屏两栏 1 条**（844×390 两栏、667×375 回落单列、390×844 竖屏不变）+ **窄屏与超限 1 条**（320 宽表格堆叠/判据堆叠、软键盘顶升 240px、点击放大层焦点与 Esc、超限按钮改文案后由服务端判异常）+ **收尾 4 条**（800ms 转骨架与提交阶段取消、路由焦点归位 h1、列表加载更多 12/页、打印表头 `table-header-group`）+ **降级与再生成 2 条**（无图示/无素材时占位可见且判据仍在、详情页「再生成一份草稿」打到正确端点并交接 job）；交互类一律 route mock，不花 token；CI 内跑，失败阻断发布 |
| 打印 | Chromium 打印记录页，A4 三页无截断（真机验收 2026-10-21） |
| 可访问性 | axe-core **0 violation**（4 页 × 2 视口 = 8 次扫描，**2026-11-07 线上复测**）；Lighthouse A11y **100**。本轮复测先抓到页脚链接对比度 1.1:1（8/8 全红），改 `--c-ink-2` 后清零；同日补 skip-link 与 13 个原语的 `<title>`（改动后 axe 复跑仍 0） |

单测边界（2026-11-06 起不再"没做"，改为"分工"）：纯逻辑与交互组件进 Vitest
（`lib/*` + 7 个抽出的面板 + 3 个页面壳）；13 个视觉原语只做参数校验与降级冒烟，
渲染正确性仍靠 E2E 与人工走查——E2E 跑构建产物、**不插桩**，不计入覆盖率，
所以"E2E 绿"不能替代单测数字。核心判定仍全在服务端（417 条测试），
前端单测盯的是"同一份数据在界面上被画错/被丢掉"这类问题。

## 8. 已知坑（都踩过，别再踩）

| 坑 | 现象 | 正解 |
|---|---|---|
| `AbortSignal.timeout` | 真机上所有请求报"未知错误" | `AbortController` + `setTimeout` + `timedOut` 标记 |
| `hour12:false` | 部分内核输出 `24:42:45` | `hourCycle:'h23'`，并固定年月日时分秒 |
| 内联 script | CSP 拦截，白屏 | 关 `modulePreload.polyfill`，产物检查兜底 |
| `content-visibility` | 打印出空白页；整块跳过还会让题注从无障碍树消失 | 屏幕只跳 `.figure__canvas`（题注留容器外）；打印 `visible !important`（scoped 0,2,0，普通规则压不住） |
| Vite 默认 base | 深链 404 | `base:'/apps/electro-assist/'` + Caddy `try_files` |
| 单位 chip 自适应 | 判据行参差 | chip 固定 44px，>3 字符统一 56px，绝不 `overflow:hidden` 截断 |
| 全局导入的 CSS 撞类名 | 诊断页的 `.step` 把指导书步骤卡变成 flex 横排，390px 屏横向溢出 300px、标题一行一个字 | 全局 CSS 的类名必须带模块前缀（`.dstep` / `.diag-disclaimer`）；`cssCodeSplit:false` 意味着所有样式同域，撞名会跨页生效 |

## 9. 未实现与已知边界（方案里有、代码里没有）

| 项 | 现状 | 说明 |
|---|---|---|
| `stores/`（job/run/quota） | 不存在 | 状态在视图内；跨页靠服务端重建。**有意为之**，不是欠账 |
| `lib/poll.ts` | 不存在 | 轮询内联在 `NewGuideView`（`setTimeout` 链 + 2s 退避 + 175s 预算） |
| `lib/idempotency.ts` | 不存在 | `RunView` 内直接拼 `{sid}:s{seq}:a{attempt}` |
| `composables/` | 只有 `useDiagnoseRun` | 无 `useFocusTrap` / `useVisualViewport`（后者的逻辑在 `lib/viewport.ts`） |
| `components/ui/` | **已有 4 个**：`ConfirmDialog` / `SiteDrawer` / `ThemeNoticeBar` / `LiveRegion` | 其他按钮、卡片仍是 CSS 类，不建组件库 |

**2026-11-01 从这张表里移除的三项**（已实现，留一行记录避免有人以为还在）：

| 原欠账 | 落地位置 |
|---|---|
| `lib/sse.ts` + 流式解析 | `lib/sse.ts`（`postStream`，fetch + `getReader` 按帧解析）；`DiagnoseView` 消费 recall→rerank→done。**2026-11-08 加重连**：断流且已收帧、未收终止帧时自动重连一次，带 `Last-Event-ID`（值是最后一个事件名），服务端跳过已发帧；一帧未收不重连（那等于重跑整个请求） |
| `_fe-error` 上报端点 | 后端 `routers/fe.py`（只写日志、不落库）+ 前端 `lib/report.ts`（每会话 20 条上限、60s 去重） |

**2026-11-08 新增（能力，不是欠账）**：识别结果的逐条溯源落在 `components/newguide/TraceList.vue`，
数据来自 `POST /extract` 返回的 `fields.steps[i].trace` / `.criterion_trace`（服务端在转录行里
重新定位，三态 `ok` / `suspect` / `unverified`）。前端只负责不撒谎：`suspect` 必须显示「待核」，
`unverified` 必须显示「指不回原文」且**不是按钮**——点不开的东西不该长得像按钮。

同日还有**生成侧的判据来源标记**：`GuideView` 的判据行显示「有据 · 第 N 行」/「待核 · 第 N 行」
（`.criterion__src`，`title` 带原文片段），数据来自 `Criterion.provenance`，由
`services/provenance.py` 在生成落库前用原文定位回填。三点约定：

- **没有标记 ≠ 数值错**，只代表没有证据链（手写输入的指导书就没有），所以不渲染"无据"占位；
- 标记与数值必须包在同一个 `.criterion__tail` 里——`.criterion` 是 `space-between`，
  三项平铺会把标签、数值、来源拉成三段等距；
- 打印时去掉描边与底色，否则浅绿边框在白纸上糊成灰块。
| `aria-live` 双区 | `components/ui/LiveRegion.vue` + `lib/announce.ts`（`polite` / `assertive` 两区，2s 去重） |

### 9.1 大文件拆分（2026-11-06 已执行，不再是"未执行"）

| 文件 | 拆分前 | 现在 | 抽出的组件 / 纯逻辑 | 结论 |
|---|---|---|---|---|
| `NewGuideView.vue` | 1,413 行 | **1,158 行** | `AssetShelf` 290 / `PasscodePanel` 161 / `ExtractPanel` 153 / `TraceList` 327 | 三轮拆完；剩余部分是状态耦合（`text` 既是输入又是回填目标），再拆要动逻辑，收益低于风险。**2026-11-08 加 `TraceList`**：识别结果的逐条溯源（每步 / 每条判据「来自第几行」+ 点击展开原文）。与 `ExtractPanel` 分工明确——摘要回答"要不要重识别"，逐条回答"这一条能不能信"；合成一个会让那块面板很快变成第二个千行文件 |
| `RunView.vue` | 961 行 | **887 行** | `StepResult` 169 / `RunBar` 134 + `lib/runeval.ts` | 同上；横屏媒体查询随 `RunBar` 一起搬，否则主按钮宽度会塌 |
| `GuideView.vue` | 1,155 行 | **833 行** | `AttachPanel` 233 / `EditPanel` 260 + `lib/guidepatch.ts` | 同上。**2026-11-08 加判据来源标记**（+19 行：`provenanceText()` + 模板一处 + `.criterion__tail` 包裹），没有新组件——它的消费者只有判据行 |

判断标准（2026-11-06 修订）：**超过 600 行且混多个职责才拆**；纯页面壳（模板长、状态集中）不按行数强拆。
`DiagnoseView`（516）/ `RecordView`（503）/ `LibraryView`（335）评估后不拆，改为补组件单测。

两条代价记在这里，避免下次再踩：① 拆组件时**媒体查询必须一起搬**（scoped 不穿透；`RunBar` 漏搬横屏规则后主按钮从 240px 变 684px，被 E2E 几何断言抓到）；② `<script setup>` 不能写 `export interface`，共享类型必须进 `types.ts`。

保留这张表的目的：读代码的人不必猜"是不是我没找到"，而是明确知道"这里就是没做、为什么没做"。
