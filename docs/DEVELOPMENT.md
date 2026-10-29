# 开发指南

> 版本 v1.0 · 2026-10-21 · 面向第一次接手代码的人。
> 目标：**30 分钟内本地起站、跑通测试、知道改哪里不会踩坑。**
> 部署与回滚见 [`OPERATIONS.md`](OPERATIONS.md)；接口见 [`API.md`](API.md)。

## 1. 前置

| 依赖 | 版本 | 说明 |
|---|---|---|
| Python | 3.12 | 后端与测试 |
| Node.js | 22 | 前端构建（`npm ci`） |
| Git Bash / PowerShell | — | Windows 下命令示例用 Git Bash |
| Docker | 可选 | 只在需要验证镜像/Caddy 时用；日常开发不需要 |

## 2. 五分钟起站

### 2.1 后端

```bash
cd apps/electro-assist/api
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt -r requirements-dev.txt   # Windows
# .venv/bin/pip install -r requirements.txt -r requirements-dev.txt     # macOS/Linux

# 可选：不配 Key 也能起站，只读页面正常，/generate 会返回 503/auth
export DEEPSEEK_API_KEY='...'

python -m uvicorn main:app --reload --port 8001
```

启动时会做两件事：

- `store.init_db()`：建表 + 执行未应用的迁移（当前 v6）；
- `library.ensure_seeded()`：把 `data/samples/*.json` 按 id 增量 seed 成 published（已存在的不覆盖）。

默认数据库 `app_data/electro.db`，默认样例目录 `data/samples/`。常用覆盖：

```bash
DB_PATH=/tmp/electro.db GUIDE_DIR=./data/samples SEED_GUIDES=0 uvicorn main:app --port 8001
```

### 2.2 前端

```bash
cd apps/electro-assist/web
npm ci
npm run dev        # http://localhost:5173/apps/electro-assist/
```

`vite.config.ts` 的 `server.proxy` 与 `preview.proxy` 都把 `/api` 转到 `127.0.0.1:8001`，
所以前端代码里**不出现绝对后端地址**，与生产 Caddy 的同源反代一致。

生产验收必须用 build 产物（dev 的 HMR 违反 CSP）：

```bash
npm run build      # vue-tsc --noEmit + vite build
npm run preview    # http://localhost:4173/apps/electro-assist/
```

## 3. 代码地图

```
api/
├── main.py            FastAPI 装配、CORS/静态挂载、启动 seed、健康检查
├── core/              横切能力，不依赖任何业务模块
│   ├── assets.py      素材落盘约定与存在性校验（上传/生成/归位共用）
│   ├── imaging.py     图片准入（格式/尺寸/EXIF 剥离/重编码）
│   ├── slicing.py     版面切分（表格线/密集文字）
│   ├── ratelimit.py   进程内滑窗限流（单 worker 前提）
│   └── passcode.py    口令 → 12h 令牌（HMAC）；只豁免每 IP 配额
├── models/            Pydantic 契约：guide（schema 1.2）、visual（13 原语）、knowledge
├── routers/           30 个业务端点；只做参数校验与 HTTP 语义
├── services/          业务规则：generation / quota / jobqueue / criteria / sessions / library
│                      knowledge（混合召回）/ rerank（只排序）/ diagnosis（故障树推进）/ report_html
├── store/             SQLite：db（连接/迁移）、dao（读写，不含业务规则）
├── llm/               Provider 协议、DeepSeek 实现、runner（重试/超时/校验）、pricing、prompts、extract
├── data/              运行数据（与代码分离，全部随镜像发布）
│   ├── samples/       5 份 published 样例（车门 3 + 空调 1 + 受电弓 1）
│   ├── knowledge/     door 11 / hvac 4 / pantograph 3 条 + eval_queries.json
│   └── corpus/        8 份生成评测语料 + README
├── scripts/           eval / demo / export_openapi / check_metrics / publish / cleanup / smoke
└── tests/             259 条契约测试
web/
├── src/views/         列表、生成、详情、引导、记录、排查
├── src/figures/       13 个 SVG 原语 + registry + svg 工具
├── src/components/    ui/（确认弹层）与 diagnose/（快速结果、逐步诊断）
├── src/lib/http.ts    唯一网络层：超时、错误归一、JSON / multipart / PUT
├── src/styles/        tokens / base / print
└── src/types.ts       与后端契约对应的 TS 类型
```

**依赖方向**（重组后强制）：

```
main → routers → services / store / llm → core
```

`core/` 不反向引用业务模块：它只回答"文件在不在、图能不能收、请求是否超限、令牌是否有效"，不判断业务语义。新增横切能力先问一句"它需要知道 Step 或 Guide 吗"，需要就不属于 core。

**边界约定**：

- 判定只在 `services/criteria.py`；路由不判合格与否。
- 库表读写只在 `store/`；服务层不直接写 SQL。
- 模型只输出受 schema 约束的 JSON；`guide.id`、`verdict`、`is_demo`、`source_note` 由服务端覆盖。
- 前端不拼接业务规则；判据结果显示服务端返回的 `verdict`。

## 4. 测试与质量门禁

```bash
cd apps/electro-assist/api
pytest tests -q          # 259 passed（约 19s）
ruff check .             # 只开 E9/F63/F7/F82

cd ../web
npm run build            # vue-tsc + vite；构建期还有 CSP 内联检查（Dockerfile）
```

CI（`.github/workflows/ci.yml`）顺序：契约测试 + ruff + 依赖锁一致性 + 依赖漏洞扫描 + API 文档一致性 + 文档指标一致性 → E2E 冒烟（与构建并行）→ 构建镜像（含 Caddyfile 校验、CSP 产物检查）→ 推 ACR → 服务器拉取 → 3 次健康检查 → 失败回滚。另有一条独立的 `uptime.yml` 每 10 分钟从 GitHub 探活。

## 4.1 供应链固定（2026-10-24）

| 项 | 做法 |
|---|---|
| 后端依赖 | `requirements.lock`（`uv pip compile --generate-hashes`，305 个哈希）；镜像里 `pip install --require-hashes`，包被替换即构建失败 |
| 前端依赖 | `package-lock.json` + `npm ci` |
| CI Action | 全部固定到 40 位 commit sha，版本号只写在注释里（`# v4`） |
| 依赖更新 | `.github/dependabot.yml`：pip / npm / github-actions / docker 四个生态，每周一 03:00 开 PR（同生态 patch+minor 合组，避免 PR 洪水） |
| 漏洞扫描 | `pip-audit` 与 `npm audit` 进 CI，**continue-on-error**（计划口径：告警不阻塞） |

依赖升级的三条口径（2026-10-29 定）：

| 情况 | 做法 |
|---|---|
| 后端 pip | Dependabot 只改 `requirements.txt`，**必然卡在锁文件门禁**（它不跑 uv）。要合就先重生成 `requirements.lock`，再跑全量测试 |
| 前端三大件（vite / @vitejs/plugin-vue / vue-router） | **必须一次升**：vite 8 要 plugin-vue ≥6，vue-router 5 要 vite ≥7，单独提都是 `ERESOLVE`。已在 `dependabot.yml` 忽略这三者的 major |
| 基础镜像 | `node` 只跟 LTS（忽略 major）；`caddy` 保留自动 PR，但合并前要走一次网关窗口（反代 / CSP / 证书 / 回滚） |

改依赖的标准动作：

```bash
cd apps/electro-assist/api
# 1) 改 requirements.txt
# 2) 重生成锁文件（必须带 --python-version 3.12，CI 用同一命令比对）
uv pip compile requirements.txt --generate-hashes --python-version 3.12 -o requirements.lock
# 3) 本地确认能按哈希安装
pip install --dry-run --require-hashes -r requirements.lock
```

> CI 比对时会过滤注释行：uv 把「输入路径」写进头部与 `# via`，从仓库根跑和从 `api/` 跑天然不同，直接 `diff` 会永远失败。

**已知未清**：`starlette 0.41.3`（FastAPI 0.115.6 的传递依赖）被 pip-audit 报了 12 条 advisory（PYSEC-2026-*）。
升级需要同步抬 FastAPI 并回归 194 条测试，单独排一轮；当前扫描结果只告警、不阻塞发布。


**前端 E2E（2026-10-21 进 CI）**：`tests/e2e/smoke.spec.ts` 覆盖四条路径——列表→引导第 1 步→刷新保持、B 命中、B 未覆盖、素材上传。不调模型，用启动时 seed 的案例与知识库。

```bash
# 本地：先起 API（临时库）与 preview，再跑
cd apps/electro-assist/api && DB_PATH=/tmp/e2e.db APP_ENV=dev python -m uvicorn main:app --port 8001
cd apps/electro-assist/web && npm run build && npm run preview -- --port 4173
E2E_CHANNEL=msedge npm run test:e2e        # 用系统 Edge，免下载浏览器
```

CI 里跑 `chromium`（`npx playwright install --with-deps chromium`），**部署依赖 E2E 通过**。

**已知缺口**：前端仍无组件单测；E2E 只覆盖主路径，不覆盖打印与软键盘（这两项靠真机验收）。

### 4.1 性能与可访问性实测

两个脚本都不进 CI（lighthouse 会拖慢流水线），按需手动跑：

```bash
cd apps/electro-assist/web
npm i --no-save axe-core lighthouse      # 只装本地，不改 package.json

# 前置：API 8001 + vite preview 4173
node scripts/lighthouse.mjs http://localhost:4173/apps/electro-assist/ lh.json
node scripts/axe.mjs                      # 4 页 × 2 视口；有违规退出码 2
```

当前基线（2026-10-23，移动端 390×844）：Perf **99** / LCP **1.55s** / CLS **0** / TBT **84ms**，
A11y **100**，axe **0 violation**。改动 UI 后请重跑——CLS 与对比度都是"不看不知道"的指标。

> 踩过的坑：axe 用 `page.addScriptTag` 注入会被 CSP 拦，必须 `page.evaluate(src)`；
> 空结果要先用"注入低对比元素"自检，否则分不清"没问题"和"没跑起来"。

## 5. 发布草稿

生成结果是草稿，不进公开列表。发布只走 CLI：

```bash
python -m scripts.publish --list
python -m scripts.publish --publish g_xxxxxxxxxxxxxxxx
```

发布前会做一次 `Guide.model_validate`；已发布内容不会被再次生成覆盖。详细语义见 `OPERATIONS.md` §12。

## 5.1 现场素材（图片）

链路是「用户上传 → 随生成请求带上 → 进草稿素材区 → 人在草稿页挂到某一步」。
生成链路里**模型看不到图**：识别是另一条入口（§5.3），必须人确认后才变成文本。

| 环节 | 位置 | 约定 |
|---|---|---|
| 上传 | `POST /uploads`（`routers/uploads.py`） | ≤5MB、长边 ≥1000px、只收 PNG/JPEG/WebP，EXIF 剥离后重编码为 PNG |
| 切图 | `POST /uploads/{id}/slice` | 返回整图 + 局部块；每资产 5 次上限 |
| 采纳切块 | `POST /uploads/{id}/slice/{region_id}/adopt` | 把块复制成**独立 asset**（含 `meta.json`），`derived_from` 记来源；每源图 6 次上限 |
| 存在性 | `core/assets.py` | `assets.exists()` 校验 PNG + `meta.json` 都在；生成入口 422 `asset_not_found` |
| 随生成 | `GenerateIn.assets`（≤4）→ `jobs.assets_json` | 只存 `asset_id + caption`，不存路径 |
| 落草稿 | `services/generation._attach_assets()` | 全部进 `Guide.assets`；**模型的 assets 输出在 runner 里被剥掉** |
| 归位 | `PUT /guides/{id}/assets` | 全量替换；只接受这份草稿已有的 id；已发布 409 |
| 渲染 | `GuideView.vue` | 步骤内 `figure` + 文末「现场素材」区；编号全文连续；打印 `break-inside: avoid` |

为什么切块要"采纳"成新 asset，而不是让 Guide 直接引用 `a_xxx_r2.png`：
`assets.exists()` 只认 `<id>/<id>.png + meta.json` 一种形态。让引用层理解两种形态，
清理脚本、生成校验、前端 URL 都要跟着分叉；复制几十 KB 换一条干净契约，划算。

三条不能破的边界：

1. **模型不碰素材**。给模型看的 schema 由 `llm/prompts.output_schema()` 删掉 `assets` 字段；
   即便它硬塞，runner 解析后也会剥掉。位置是事实，事实由人给。
2. **已发布只读**。`PUT` 遇 `published` 直接 409；`save_guide` 的 upsert 也只更新 draft。
3. **不能清空**。传空数组会 422 `assets_required`——归位只认已有素材，清空后没有入口加回来。

改这块时最容易踩的坑：`step.assets` 与 `guide.assets` 的**全局唯一**校验在 `Guide._check_steps`。
赋值不会重跑 pydantic 的 model_validator，所以 `PUT` 里显式 `model_validate` 了一次。

### 5.2 存量指导书的版本戳

`schema_version` 是"这份文档按哪版契约写的"，不是"服务端当前支持哪版"。

- 新生成与草稿归位一律写当前版本（`models/guide.SCHEMA_VERSION`）；
- 早期样例写的是 1.0/1.1，`ensure_seeded` 只补缺、不覆盖，于是库里会长期留着旧版本号；
- 启动时 `library.normalize_schema_versions()` 做一次归一：**先按当前 Guide 校验通过，只改版本戳**，
  steps / criteria / figures / assets 一个字不动；校验不过就跳过（说明内容真的不兼容，留着旧号是诚实的）。

排障提示：`GET /guides` 顶层的 `schema_version` 才是**当前契约版本**；单份指导书里的
`guide.schema_version` 是**这份文档自己的**。看到后者是 1.1 不代表部署失败。

### 5.3 图片识别（`POST /extract`）

**单通道**，与决策 #13 的 P4 口径一致："做单通道（二选一）或继续延后"。
用 `deepseek-flash` 的原生视觉输入，不再引第二个供应商。

| 环节 | 位置 | 约定 |
|---|---|---|
| 入口 | `routers/extract.py` | ≤3 张、每张必须已存在；限流 3/时 · 8/日 · 全站 30/日 |
| 提示词 | `llm/extract.py` | 只转录可见文字；数值逐字照抄；看不清写 null |
| 三层校验 | `llm/extract.py: reconcile()` | 结构（pydantic）→ 语义（值必须出现在转录里）→ 回溯（`source_line`） |
| 预算 | `quota.check(unlimited=True)` + `store.record_usage` | 只跳每 IP 生成配额；**全站预算照算**，失败调用也记账 |
| 确认 | `NewGuideView.vue` | 结果只回填文本框，`needs_review` 恒 true；不自动生成、不自动发布 |

必须记住的一条：**数值不在转录里就清空判据**。模型读图时最危险的不是漏字，
是"看起来合理"的补数——`1.0–2.0s` 和 `2.0–3.5s` 在页面上一样整齐，
现场照着做才知道错。校验逻辑宁可多标 `unverified`，也不放行一个没出处的数。

未配置 `DEEPSEEK_API_KEY` 时返回 503 `vision_not_configured`，不是 500——
这是配置缺失，不是服务故障，前端要能据此提示"手工录入"。

### 5.4 工艺预检（`POST /processes`）

不调模型、不落库、不扣配额。它只回答"这段文本里认得出哪些字段、缺哪些"。

- 规则解析在 `routers/processes.py`：`工序：`/`工位：`/`工具：`/`安全：` 前缀行 + 编号步骤；
- 判据线索只做"有没有"的判断（区间、≤/≥、带单位数值），**不判定合格与否**；
- 返回 `missing` 与 `warnings`，前端贴在文本框下方展示；
- 计划 §3.5 写的"创建工艺"落地为预检：建实体就要建表、版本与清理策略，
  而 `/generate` 已经能直接吃文本，多一个没有消费者的实体只会多一处空壳。

### 5.5 作业报告导出（`GET /records/{sid}/export.html`）

服务端渲染自包含 HTML（`services/report_html.py`），`Content-Disposition: attachment`。

- 样式内联，无外链、无脚本：文件要能在离线电脑上双击打开；
- 所有用户输入走 `html.escape`——备注里写 `<script>` 时，导出文件不能执行它；
- 报告含"关联排查结论"：`report()` 按 `session_id` 关联 `diagnose_runs`，不复制结论内容；
- 前端另有 `window.print()`，两者并存：打印给现场，HTML 给归档与转发。

## 6. 改文档的规矩

| 文档 | 放什么 |
|---|---|
| `docs/README.md` | 索引与阅读路径；新增文档必须在这里登记 |
| `docs/ARCHITECTURE.md` | 为什么这样设计；不写操作步骤 |
| `docs/OPERATIONS.md` | 怎么部署/回滚/备份/发布；不写设计理由 |
| `docs/DEVELOPMENT.md` | 怎么本地跑、怎么测、有哪些坑 |
| `docs/API.md` | **只由脚本生成**：`python scripts/export_openapi.py`，不手改 |
| `docs/proposals/` | 未实现方案；头部必须写状态与降级口径 |
| `docs/archive/` | 历史记录；不再维护，但保留可追溯性 |
| `docs/adr/` | 一个决策一篇，写背景/决策/理由/后果 |

数字必须写"值（命令，日期）"。改路径后跑私有仓 `python tools/check_doc_links.py`。

## 7. 常见坑（都是实际踩过的）

| 坑 | 现象 | 正确做法 |
|---|---|---|
| `AbortSignal.timeout` | 旧手机浏览器报"未知错误"，请求未发出 | 用 `AbortController` + `setTimeout`，见 `lib/http.ts` |
| `hour12: false` | 部分内核把 00:42 显示成 24:42 | 用 `hourCycle: 'h23'` |
| SQLite 直接 `cp` 备份 | WAL 里的最后几笔丢失且不报错 | 用 `sqlite3.backup()`（`deploy/backup.sh`） |
| 延迟事务并发写 | 偶发 `SQLITE_BUSY` | 写事务用 `BEGIN IMMEDIATE` |
| 模型输出 `guide.id` 当主键 | 两人生成同一工序互相覆盖 | 服务端分配随机 id（`new_guide_id()`） |
| 客户端传 `verdict` | 改请求就能把超差变合格 | 判定在服务端；请求体不接收 verdict |
| CSP 内联 script/style | 页面空白、控制台 CSP 报错 | 产物检查在 Dockerfile；不要加内联样式/脚本 |
| 在微信里打印 | 无法调起系统打印 | 先"在浏览器中打开" |
| 本地 `curl` 走了系统代理 | 连不上/证书错误 | `curl --noproxy '*'` |

## 8. 不要做的事

- 不要在运行时调用境外 API 或 CDN（大陆网络 + CSP）。
- 不要把密钥写进代码、文档、日志；只放 `.env`（600）。
- 不要为"看起来更 AI"加向量库/多轮 Agent；先看 `ARCHITECTURE.md` 的取舍。
- 不要让未发布内容进公开列表；发布走 CLI。
- 不要手改 `docs/API.md`、迁移语句、已发布案例内容。
