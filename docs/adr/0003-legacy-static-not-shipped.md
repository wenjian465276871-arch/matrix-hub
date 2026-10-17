# ADR-0003：旧静态页不入镜像，门户重写

- 状态：已接受
- 日期：2026-10-17
- 关联：ADR-0001（单镜像 + Caddy + CSP）、ADR-0002（下架 news）

## 背景

P0a 迁移方案原计划把 `portal` 与 `particle-system` 原样迁入镜像。实际拉取文件后检查引用，发现两者都依赖外网资源：

| 页面 | 外部依赖 | 后果 |
|---|---|---|
| `portal/index.html` | `cdn.tailwindcss.com`、`fonts.googleapis.com` | CSP `script-src 'self'` 直接拦截；大陆访问不稳定 |
| `particle-system` | `fastly.jsdelivr.net/npm/@mediapipe/*`（5 个） | 同上；且 mediapipe 需摄像头，被 `Permissions-Policy: camera=()` 阻断 |
| 两者 | 指向 `/apps/news-insight/` 的入口 | 该模块已下架（ADR-0002），成为死链 |

也就是说：**照搬 = 页面能返回 200，但渲染空白、控制台满屏 CSP 报错。**

## 决策

1. 旧页面原样归档到 `apps/*/legacy/`，**不参与构建、不对外服务**，仅作改造参考。
2. P0 阶段上线一版**自包含门户页**（`apps/portal/public/`）：零外链、系统字体、原子化 CSS，内容与旧页一致（三个模块 + 说明 + 备案号）。
3. `particle-system` 在 P0 只保留占位入口（门户上标"暂停服务"），重构排到 P4；重构方向是**去掉 mediapipe 与 CDN**，保留纯 Canvas 效果。
4. 不为此放宽 CSP，也不为旧页面开 `unsafe-inline`。

## 理由

- **安全基线优先于页面保真**：为了一个 12KB 的手写页放宽 CSP，等于给全站开口子，收益与风险完全不匹配。
- **旧页没有工程化价值**：无构建链、CDN 依赖、样式由 Tailwind CDN 运行时生成，改造比重写贵。
- **作品集角度重写更划算**：新门户用统一设计令牌，后续 A2 指导书页沿用同一套视觉，风格一致。

## 后果

**正面**
- 镜像真正自包含，运行时零外网依赖（符合 §8.1）。
- CSP 保持 `default-src 'self'`，无例外。
- 门户页体积从"CDN + Tailwind 运行时"降到 ~5KB HTML + ~4KB CSS。

**负面**
- 旧门户的视觉细节不会 1:1 保留，需要接受一次视觉变化。
- 粒子系统在 P0–P3 期间不可用（门户显示"暂停服务"）。
- 首页文案需重写（已完成，内容是事实陈述，不夸大）。

**约束**
- 任何新页面不得引用外部 CDN；字体用系统字体栈；图标内联 SVG。
- 静态资源的引用一律用相对路径，确保挂在 `/apps/<name>/` 子路径下也能工作。
