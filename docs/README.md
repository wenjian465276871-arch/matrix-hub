# 文档索引

> 版本 v1.5 · 2026-11-03 · 维护规则：**每份文档只回答一类问题；数字必须附命令与日期；历史结论进 `archive/`，未实现方案进 `proposals/`。**

## 1. 先看哪份

| 你想知道 | 看这份 |
|---|---|
| 这个项目是什么、能做什么、指标多少 | 仓库根 [`README.md`](../README.md) |
| 为什么这样设计、B 为什么只让模型排序 | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| 接口怎么调、字段是什么 | [`API.md`](API.md)（由 `scripts/export_openapi.py` 导出） |
| 视觉怎么定：颜色、字号、组件、打印 | [`UI.md`](UI.md) |
| 交互怎么走：页面、状态、反馈、边界 | [`UX.md`](UX.md) |
| 前端代码怎么组织、有哪些坑 | [`FRONTEND.md`](FRONTEND.md) |
| 本地怎么起、怎么测、有哪些坑 | [`DEVELOPMENT.md`](DEVELOPMENT.md) |
| 怎么部署、回滚、备份、发布草稿 | [`OPERATIONS.md`](OPERATIONS.md) |
| 怎么演示、兜底方案 | [`DEMO.md`](DEMO.md) |
| 案例内容从哪来、合规边界 | [`SOURCES.md`](SOURCES.md) |
| 某个架构决策的前因后果 | [`adr/`](adr/) |
| 图片输入做到哪一步 | [`archive/A2-IMAGE-INPUT.md`](archive/A2-IMAGE-INPUT.md)（双通道已实现：先转录后结构化；仍无文字坐标） |
| 一次性迁移记录 | [`archive/P0A-MIGRATION.md`](archive/P0A-MIGRATION.md) |

> `UI.md` / `UX.md` / `FRONTEND.md` 是**as-built 版本**：只写代码里真实存在的规格，
> 未落地的设计集中列在各文末"未实现"章节。设计稿原稿与迭代过程留在私有仓 `docs/design/`。

## 2. 文档清单

| 文档 | 类型 | 状态 | 说明 |
|---|---|---|---|
| `README.md`（根） | 总览 | 当前 | 问题 → 方案 → 架构 → 指标 → 演示 → 取舍 |
| `docs/README.md` | 索引 | 当前 | 本文件 |
| `docs/ARCHITECTURE.md` | 设计 | 当前 | 拓扑、请求链路、LLM 层、B 的取舍 |
| `docs/UI.md` | 规范 | 当前 | 视觉 as-built：令牌、组件、SVG 原语、打印 |
| `docs/UX.md` | 规范 | 当前 | 交互 as-built：信息架构、三条流程、状态与边界 |
| `docs/FRONTEND.md` | 方案 | 当前 | 前端 as-built：结构、网络层、性能、坑、未实现 |
| `docs/API.md` | 契约 | 当前 | OpenAPI 导出，36 端点（业务 35 + `/healthz`） |
| `docs/DEVELOPMENT.md` | 指南 | 当前 | 本地运行、测试、约定、常见坑 |
| `docs/OPERATIONS.md` | 运维 | 当前 | 部署/回滚/证书/备份/事故/发布 CLI |
| `docs/DEMO.md` | 演示 | 当前 | 5 分钟闭环 + 兜底 |
| `docs/SOURCES.md` | 合规 | 当前 | 案例与知识库来源登记（D-01～D-08、K-01～K-03） |
| `apps/electro-assist/api/scripts/README.md` | 清单 | 当前 | 10 个脚本的用途、读写面与"会不会碰生产数据" |
| `docs/adr/0004-process-entity-minimal.md` | ADR | 已接受 | 工艺原文最小落库（30 天），支撑详情页再生成 |
| `docs/archive/A2-IMAGE-INPUT.md` | 归档 | 已实现 | 图片输入方案；未落地部分只剩 OCR 文字坐标 |
| `docs/adr/0001` | ADR | 已接受 | 单仓单镜像 + Caddy |
| `docs/adr/0002` | ADR | 已接受 | P0 下架 news-insight |
| `docs/adr/0003` | ADR | 已接受 | 旧静态页归档、不入镜像 |
| `docs/archive/P0A-MIGRATION.md` | 归档 | 历史 | P0a 迁移方案与执行记录 |
| `apps/electro-assist/api/data/corpus/README.md` | 测试数据 | 当前 | 评测语料说明；04 已上架为 HVAC 案例 |
| `archive/particle-system-legacy/README.md` | 归档 | 历史 | 手势粒子实验，不构建、不服务 |
| `archive/portal-legacy/` | 归档 | 历史 | 旧门户，不构建、不服务 |

## 3. 当前基线（2026-11-06 本机实测；线上数据标注采集日）

| 项 | 值 | 采集 |
|---|---|---|
| 代码基线 | `5404382`（本地 HEAD；线上 tag 最后一次人工回读是 `ef7cffe`，2026-11-06 18:20） | `git rev-parse --short HEAD` |
| 契约测试 | **419 passed** | `pytest tests -q`（约 1 分钟） |
| 业务端点 | 35 + `/healthz` | `app.openapi()["paths"]`（`scripts/check_metrics.py`） |
| 首屏 | **46.04 KB gzip / CSS 10.31 KB** | `npm run build`（2026-11-07，vue-tsc + vite） |
| 性能与可访问性 | 库页 Perf **99** / LCP **1.29s** / CLS **0**；指导书页（8 步/20 图）**中位 95（9 轮 82–96，7/9 ≥90）** / LCP 1.42s / CLS 0 / TBT 中位 **265ms**；3 步页 94；A11y **100**；axe **0 violation** | `scripts/lighthouse.mjs`、`scripts/axe.mjs`（2026-11-07 线上复测，Lighthouse 13.6） |
| B 检索 | Top-3 **21/21**、未覆盖 **2/2**、P50 **2.8ms** / P95 **5.3ms**（441 采样） | `scripts/eval_diagnose.py`（2026-11-01） |
| 线上数据 | 已发布指导书 **5** / 草稿 2 / KB **18 条 / 3 子系统** / sessions 16 / records 62 / diagnose_runs 15（**2026-11-01 快照**，非当前值） | `GET /guides`、容器内 SQLite |
| 真机验收 | 通过（Honor/5G，8 步 + 超差复测 + 3 页打印） | 私有仓 `reports/真机验收记录-2026-10-21.md` |
| 已知边界 | 前端 **144 条**单测（覆盖率 57.71%）；指导书重页面 Perf **方差大**（9 轮 82–96，中位 95，最差一轮 TBT 749ms）；异地备份**已跨云上线**（腾讯云 COS，§7.6），远端未挂生命周期规则、约 2.5MB/天累积；`NewGuideView` **1,154 行** | 私有仓 `reports/计划缺口复核-2026-11-08.md` |

## 4. 维护规则

1. **一处权威**：同一事实只在一个地方写全，其余引用；指标必须写"值（命令，日期）"。
2. **分类落点**：计划/规范进私有仓；当前实现与契约进本仓；未实现方案进 `proposals/`；历史进 `archive/`；决策进 `adr/`。
3. **改接口必跑** `python scripts/export_openapi.py`；改文档路径必跑私有仓 `python tools/check_doc_links.py`。
4. **不写**：密钥、服务器密码、内部资料、未公开的设计迭代。
5. **历史不改写**：已发布的时点报告保留原结论；新结论写新报告并在旧报告头部标注"已被取代"。
