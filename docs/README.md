# 文档索引

> 版本 v1.1 · 2026-10-23 · 维护规则：**每份文档只回答一类问题；数字必须附命令与日期；历史结论进 `archive/`，未实现方案进 `proposals/`。**

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
| 图片输入做到哪一步 | [`proposals/A2-IMAGE-INPUT.md`](proposals/A2-IMAGE-INPUT.md)（P4 备选，未实现） |
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
| `docs/API.md` | 契约 | 当前 | OpenAPI 导出，26 端点（业务 25 + `/healthz`） |
| `docs/DEVELOPMENT.md` | 指南 | 当前 | 本地运行、测试、约定、常见坑 |
| `docs/OPERATIONS.md` | 运维 | 当前 | 部署/回滚/证书/备份/事故/发布 CLI |
| `docs/DEMO.md` | 演示 | 当前 | 5 分钟闭环 + 兜底 |
| `docs/SOURCES.md` | 合规 | 当前 | 案例与知识库来源登记（D-01～D-07、K-01～K-03） |
| `docs/proposals/A2-IMAGE-INPUT.md` | 提案 | **未实现** | P4 备选；上传/切图契约仍维护 |
| `docs/adr/0001` | ADR | 已接受 | 单仓单镜像 + Caddy |
| `docs/adr/0002` | ADR | 已接受 | P0 下架 news-insight |
| `docs/adr/0003` | ADR | 已接受 | 旧静态页归档、不入镜像 |
| `docs/archive/P0A-MIGRATION.md` | 归档 | 历史 | P0a 迁移方案与执行记录 |
| `apps/electro-assist/api/scripts/corpus/README.md` | 测试数据 | 当前 | 评测语料说明；04 已上架为 HVAC 案例 |
| `archive/particle-system-legacy/README.md` | 归档 | 历史 | 手势粒子实验，不构建、不服务 |
| `archive/portal-legacy/` | 归档 | 历史 | 旧门户，不构建、不服务 |

## 3. 当前基线（2026-10-23 本机实测）

| 项 | 值 | 采集 |
|---|---|---|
| 代码基线 | `203f90e`（现已上线） | `git log --oneline -1` |
| 契约测试 | **202 passed** | `pytest tests -q`（19.9s） |
| 业务端点 | 25 + `/healthz` | `app.routes`（`scripts/check_metrics.py`） |
| 首屏 | **41.43 KB gzip / CSS 5.58 KB** | `npm run build`（vue-tsc + vite） |
| 性能与可访问性 | 线上 Perf **100** / LCP **1.31s** / CLS **0**；A11y **100**；axe **0 violation** | `scripts/lighthouse.mjs`、`scripts/axe.mjs`（2026-10-23） |
| 线上数据 | guides 6（published 4）/ KB 18 条 / 3 子系统 | 容器内 `sqlite3` 与 `GET /diagnose/kb` |
| 真机验收 | 通过（Honor/5G，8 步 + 超差复测 + 3 页打印） | 私有仓 `reports/真机验收记录-2026-10-21.md` |
| 已知边界 | 前端无单测；axe/Lighthouse 全量扫描未做；备份同盘无异地 | 私有仓 `reports/项目审查与开发计划-2026-10-22.md` |

## 4. 维护规则

1. **一处权威**：同一事实只在一个地方写全，其余引用；指标必须写"值（命令，日期）"。
2. **分类落点**：计划/规范进私有仓；当前实现与契约进本仓；未实现方案进 `proposals/`；历史进 `archive/`；决策进 `adr/`。
3. **改接口必跑** `python scripts/export_openapi.py`；改文档路径必跑私有仓 `python tools/check_doc_links.py`。
4. **不写**：密钥、服务器密码、内部资料、未公开的设计迭代。
5. **历史不改写**：已发布的时点报告保留原结论；新结论写新报告并在旧报告头部标注"已被取代"。
