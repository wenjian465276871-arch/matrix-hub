# 电气调试 AI 作业助手

把一段工艺文本变成**能照着做、做错会拦、做完有记录**的可视化作业指导书，并在作业异常时就地给出排查顺序。

> 状态：**A2 / A1 / B 三个模块已上线**（2026-10-21）。演示站：<https://www.superplayer007.cn/apps/electro-assist/>
> 站点内所有内容为**公开资料改写 + 虚构参数**的演示数据，页脚常驻「演示数据 · 非实际作业依据」。

---

## 1. 问题

轨道车辆电气调试现场有三个反复出现的摩擦点：

| 摩擦点 | 现场表现 | 现有做法的问题 |
|---|---|---|
| 工艺文件不可执行 | 一段文字写"测量开关门时间 2.0–3.5s"，但没告诉你用哪个档位、超差怎么办 | PDF 不会校验，也不会记录 |
| 作业过程无留痕 | 超差后复测通过，纸面只剩"合格" | 追溯不到"第一次是多少、为什么重测" |
| 异常靠老师傅 | 门关到一半弹开，新人只能等人来 | 经验不外化，晚班无人可问 |

**这不是"让 AI 写说明书"的项目。** 判据由人定义，系统只做三件事：把文本变成结构化步骤、在服务端判定合格与否、把每次尝试记下来。AI 负责表达，不负责发明事实。

---

## 2. 三个模块

| 模块 | 做什么 | 关键约束 |
|---|---|---|
| **A2** 可视化作业指导书 | 工艺文本 → 结构化 JSON + 视觉 DSL → 前端渲染（步骤卡 / 判据 / 7 种 SVG 图元 / 安全提示） | 模型只输出**受 schema 约束的规格**，不输出 HTML/JS；图元是构建期枚举，渲染失败降级为文字 |
| **A1** 交互式作业引导 | 逐步执行、提交实测值、服务端判据校验、失败不推进、复测留痕、**每步耗时**、记录可打印 | 判定在**服务端**算；改请求体塞 `verdict:"pass"` 无效；复测是**新增 attempt**，不覆盖旧记录；耗时按"本步最后一次提交 − 上一步最后一次提交"算，复测计入本步 |
| **B** 故障排查 | 现象 → 混合召回（关键词 + 稀疏向量）→ 受限重排 → **逐步诊断故障树**（回填实测值、服务端判定、异常即收敛） | 模型**只排序不写事实**：候选 id 之外的输出一律丢弃；条目、阈值、处置全部来自人工整理的公开资料改写 |

闭环：**A2 看懂 → A1 照做 → 异常转 B 兜底 → 记录回看**。

---

## 3. 架构

```
浏览器
  │ HTTPS（同源，无 CORS）
  ▼
Caddy ── 静态资源：镜像内 Vue 产物（CSP: default-src 'self'）
  │      /api/electro/* 反代
  ▼
FastAPI（127.0.0.1:8001，非 root uid 10001）
  ├─ SQLite（WAL，guides / jobs / usage / sessions / records / diagnose_runs / diagnose_steps）
  ├─ 生成：进程内单 worker 有界队列 → DeepSeek（结构化 JSON 输出）
  └─ 排查：HybridProvider（关键词 + n-gram/IDF 稀疏向量）→ 受限重排（模型只能排序）→ 故障树推进
```

单容器、单镜像、一条流水线：`push → 契约测试 → E2E 冒烟 → 构建（含 CSP 产物检查）→ 推私有镜像仓 → 服务器拉取 → 3 次健康检查 → 失败自动回滚`。服务器只拉镜像，不编译。另有 `uptime.yml` 每 10 分钟从 GitHub 外部探活。

细节与取舍见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，运维见 [`docs/OPERATIONS.md`](docs/OPERATIONS.md)，接口见 [`docs/API.md`](docs/API.md)。

---

## 4. 指标（全部可复现）

| 维度 | 数值 | 怎么测 |
|---|---|---|
| 后端契约测试 | **202 条通过** | `cd apps/electro-assist/api && pytest tests -q` |
| 静态检查 | 0 告警 | `ruff check .`（只开 `E9/F63/F7/F82`） |
| 错误可追溯 | 500 返回统一 JSON + 8 位 `ref`，响应头带 `X-Request-Id` | 任意错误请求观察响应 |
| 生成质量 | 真实调用 **10/10** 通过，一次通过率 80–100%，P50 8.8s，¥0.009/份 | `python scripts/eval_generate.py` |
| 生成链路（线上） | 8.0s / 7.0s 单份，¥0.0068–0.0086 | 线上 job 记录 |
| B 检索 | 知识库 **18 条 / 3 子系统**；Top-3 **21/21**，未覆盖 2/2，P50 **2.8ms** / P95 **4.6ms** | `python scripts/eval_diagnose.py` |
| 前端首屏 | **41.43 KB** gzip（预算 75KB），CSS **5.58 KB**（预算 14KB） | `npm run build` |
| 性能（Lighthouse Mobile，4G + 4×CPU，**线上实测**） | 库页 **Perf 100** / LCP **1.31s** / CLS **0** / TBT **70ms**；指导书页 **99** / **1.29s** / **0** / **124.5ms** | Lighthouse 13.5 + `scripts/lighthouse.mjs`（2026-10-23 线上） |
| 可访问性 | Lighthouse A11y **100**；**axe 0 violation**（4 页 × 手机/桌面 = 8 次扫描，线上同） | `scripts/axe.mjs`（含"注入低对比元素必须被抓到"的 harness 自检） |
| 契约面 | **25 个业务端点** + `/healthz` | [`docs/API.md`](docs/API.md)（由脚本导出） |
| 前端 E2E | **4 条冒烟**：列表→引导→刷新保持、B 命中、B 未覆盖、**B 逐步诊断收敛** | `cd apps/electro-assist/web && npm run test:e2e`（CI 跑 chromium） |

### 4.1 这组数字是怎么来的，以及它抓到了什么

测量口径：Chrome 兼容内核（本机 Edge）无头模式，Lighthouse 13.5 默认移动端配置
（390×844、4×CPU、模拟 4G）；axe-core 4.14 用 CDP 注入（CSP 禁内联 `<script>`，
但 `Runtime.evaluate` 不受 `script-src` 约束），扫描 4 个页面 × 2 个视口。
复现：`node apps/electro-assist/web/scripts/lighthouse.mjs <url>`、`node scripts/axe.mjs`
（两个包按需 `npm i --no-save`，不拖慢 CI）。

**第一次跑出来并不达标，三处是真缺陷，已修：**

| 发现 | 证据 | 修法 |
|---|---|---|
| 12px 辅助文字对比度 **4.43:1**，低于 AA 的 4.5 | Lighthouse `color-contrast`：`--c-ink-3` `#6B7A83` on `#FFF` | 加深到 `#626F78`（对白 5.17:1、对页面底 4.85:1） |
| **CLS 0.072**（目标 ≤0.05） | 骨架 2 项 → 真实 6 张卡片，页脚从视口内被顶出去 | `.container` 撑满首屏 `calc(100dvh - var(--nav-h))`，页脚初始就在视口外 |
| 键盘焦点只有浏览器默认 **1px** 焦点环 | Tab 走查 18 次，`outline: auto 1px`，浅底上几乎不可见 | 加 `:focus-visible` 主色 2px 环（+2px offset） |

修完复测：库页 CLS **0.072 → 0**、A11y **94 → 100**、axe 由 1 类违规 → **0**。
部署到线上后（`203f90e`）再跑一遍，线上是 **Perf 100 / LCP 1.31s / CLS 0 / TBT 70ms**，三项修复均生效。
这比"一上来就是满分"更值得写进 README——它说明扫描确实能抓到东西。

---

## 5. 演示

| 作业异常 | 一键转排查（带上下文） | 未覆盖 |
|---|---|---|
| ![异常](docs/assets/a1-exception-mobile.png) | ![转排查](docs/assets/handoff-mobile.png) | ![未覆盖](docs/assets/diagnose-uncovered-mobile.png) |

- **5 分钟演示脚本**：[`docs/DEMO.md`](docs/DEMO.md)（含旁白、兜底方案、不要说的话）
- **85 秒录屏**：[`docs/assets/demo.webm`](docs/assets/demo.webm)
- **正式案例**：`g_door_switch_formal_001`，8 步 / 14 图，含接插件针脚与端子线色；来源登记在 [`docs/SOURCES.md`](docs/SOURCES.md)
- **迁移案例（两个子系统）**：`g_hvac_cooling_check`（5 步，客室空调制冷功能检查）与
  `g_pantograph_raise_check`（5 步 / 6 图，受电弓升弓功能检查，含气路压力与升弓时间判据）——
  用来证明同一套契约/渲染/引导能换子系统，不是只为车门写的；两个案例才能排除"恰好空调和车门相似"
- **故障诊断**：知识库覆盖车门 11 / 空调 4 / 受电弓 3，共 18 条；现场可走"逐步诊断"，填实测值由服务端判超差并收敛到结论
- 现场网络不可靠时，直接用预生成案例与预跑记录，**演示不依赖实时生成**

---

## 6. 三个刻意的"不做"

| 不做 | 原因 |
|---|---|
| **不引入 embedding 服务与向量库** | 18 条知识库用**进程内** n-gram/IDF 稀疏向量 + 人工关键词就够：Top-3 21/21、P95 4.2ms、零外部依赖。条目上万再上 embedding 与向量库——`KnowledgeProvider` 已是替换点，路由与返回结构不用动 |
| **不做运行时 Agent 代码生成** | 图元是构建期固定的 7 个原语，模型只输出参数。现场要的是**可预期**：同一份输入渲染结果稳定，出问题能定位到哪一行规格 |
| **不上多容器 / 消息队列** | 2C2G 上 broker 的运维成本大于收益。单 worker 有界队列，队满直接 503——比无限堆线程诚实。代价写在 `OPERATIONS.md` 的"待补"里 |

另外明确不做：多轮对话式排查（决策记录在案）、后台管理页（没有鉴权就不做后台，发布走 CLI）、暗色皮肤（皮肤不是能力）。

**写入治理**：公开浏览；生成入口每 IP 2 次/时、10 次/日 + 全站日预算 ¥3；上传与切图各自限流；有口令可换 12 小时令牌，**只豁免每 IP 配额，不豁免全站预算**。口令只存服务器 `.env`，不进仓库、不进日志。

---

## 7. 本地运行

```bash
# 后端
cd apps/electro-assist/api
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt -r requirements-dev.txt   # Windows
python -m pytest tests -q
uvicorn main:app --reload --port 8001

# 前端（生产验收必须用 build 产物：dev 的 HMR 违反 CSP）
cd apps/electro-assist/web
npm ci
npm run dev
```

常用脚本：

```bash
python scripts/eval_generate.py --dry-run            # 列举评测语料，不调模型
python scripts/eval_generate.py --env-file <.env>    # 批量评测（8 份语料，约 ¥0.1）
python scripts/eval_diagnose.py                      # 检索命中率与 P95
python scripts/demo_flow.py --base http://127.0.0.1:8001   # 全流程自检
python -m scripts.publish --list                     # 列出草稿（发布只走 CLI）
python -m scripts.publish --publish <guide_id>       # 发布指定草稿
python scripts/export_openapi.py                     # 重新生成 docs/API.md
python -m scripts.cleanup                            # 清理预演（dry-run）
python -m scripts.cleanup --apply                    # 清理 30/180/90/365 天前的运行数据
```

环境变量统一走 `.env`（模板见 `deploy/.env.example`），**任何密钥都不入库**。

---

## 8. 目录

```
apps/electro-assist/api   FastAPI：models / routers / services / store / llm / knowledge / scripts / tests
apps/electro-assist/web   Vue 3 + TS：views / figures（7 原语）/ lib/http.ts / styles
apps/portal/public        门户首页（自包含，零外链）
archive/                  不构建、不服务的历史代码（particle-system-legacy / portal-legacy，ADR-0003）
docker/                   Dockerfile（多阶段）/ Caddyfile / compose.yml / supervisord.conf
deploy/                   deploy.sh / backup.sh / .env.example
docs/                     文档索引、架构、运维、接口、演示、开发指南、来源、提案、ADR、assets
```

`apps/news-insight/` 已于 P0 下架（ADR-0002），不再保留目录；`services/gateway/` 空占位已删除，出现第二个业务模块时再建。

---

## 9. 文档

| 文档 | 内容 |
|---|---|
| [文档索引](docs/README.md) | 按"想了解什么"组织的入口 |
| [架构与取舍](docs/ARCHITECTURE.md) | 拓扑、请求链路、LLM 层、B 为什么只让模型排序 |
| [视觉规范](docs/UI.md) | 令牌、组件、7 个 SVG 原语、打印（as-built） |
| [交互规范](docs/UX.md) | 页面与路由、三条流程、状态与边界（as-built） |
| [前端实现](docs/FRONTEND.md) | 工程结构、网络层、性能预算、已知坑（as-built） |
| [部署与回滚](docs/OPERATIONS.md) | 部署/回滚/证书/备份/事故处置/发布 CLI |
| [API 参考](docs/API.md) | 26 个端点（业务 25 + 健康检查），由 OpenAPI 导出 |
| [开发指南](docs/DEVELOPMENT.md) | 本地起站、测试、构建、约定与常见坑 |
| [演示脚本](docs/DEMO.md) | 5 分钟闭环演示 |
| [案例来源](docs/SOURCES.md) | 合规清单与登记规则 |
| [A2 图片输入](docs/proposals/A2-IMAGE-INPUT.md) | **P4 备选提案**，未实现；上传/切图契约仍维护 |
| [ADR 0001](docs/adr/0001-monorepo-single-image-caddy.md) · [0002](docs/adr/0002-p0-drop-news-insight.md) · [0003](docs/adr/0003-legacy-static-not-shipped.md) | 架构决策记录 |
| [P0a 迁移方案](docs/archive/P0A-MIGRATION.md) | 已完成的一次性迁移记录（归档） |

界面与交互规范、前端实现方案以 **as-built** 形式收录（`docs/UI.md` / `docs/UX.md` / `docs/FRONTEND.md`）：
只写代码里真实存在的规格，未落地的设计在各文末集中登记。设计稿原稿与迭代过程留在项目管理仓。

---

## 10. 边界

- 演示数据，**不作为实际作业依据**；所有数值为虚构示例，不含任何企业内部资料。
- 生成结果是**草稿**，不进公开列表；发布在服务器执行 `python -m scripts.publish --publish <guide_id>`（先 `--list` 查 id）。
- 单人项目，未做多租户与横向扩展；容量按 2 核 2G 设计。
- **许可**：代码 MIT；案例文本、步骤、判据、图示与录屏为**合成演示内容**，不构成作业依据，详见 [`LICENSE`](LICENSE) 的内容声明。
