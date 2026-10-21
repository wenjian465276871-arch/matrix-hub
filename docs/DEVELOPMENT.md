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

- `store.init_db()`：建表 + 执行未应用的迁移（当前 v3）；
- `library.ensure_seeded()`：把 `samples/*.json` 按 id 增量 seed 成 published（已存在的不覆盖）。

默认数据库 `app_data/electro.db`，默认样例目录 `samples/`。常用覆盖：

```bash
DB_PATH=/tmp/electro.db GUIDE_DIR=./samples SEED_GUIDES=0 uvicorn main:app --port 8001
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
├── models/            Pydantic 契约：guide（schema 1.1）、visual（7 原语）、knowledge
├── routers/           25 个业务端点；只做参数校验与 HTTP 语义
├── services/          业务规则：generation / quota / jobqueue / criteria / sessions / library
│                      knowledge（混合召回）/ rerank（只排序）/ diagnosis（故障树推进）
├── store/             SQLite：db（连接/迁移）、dao（读写，不含业务规则）
├── llm/               Provider 协议、DeepSeek 实现、runner（重试/超时/校验）、pricing、prompts
├── passcode.py        口令 → 12h 令牌（HMAC）；只豁免每 IP 配额
├── knowledge/         door 11 / hvac 4 / pantograph 3 条 + eval_queries.json（21+2 条）
├── samples/           4 份 published 样例（车门 3 + 空调 1）
├── scripts/           eval / demo / export_openapi / publish / cleanup / smoke
└── tests/             179 条契约测试
web/
├── src/views/         列表、生成、详情、引导、记录、排查
├── src/figures/       7 个 SVG 原语 + registry + svg 工具
├── src/lib/http.ts    唯一网络层：超时、错误归一、JSON
├── src/styles/        tokens / base / print
└── src/types.ts       与后端契约对应的 TS 类型
```

**边界约定**：

- 判定只在 `services/criteria.py`；路由不判合格与否。
- 库表读写只在 `store/`；服务层不直接写 SQL。
- 模型只输出受 schema 约束的 JSON；`guide.id`、`verdict`、`is_demo`、`source_note` 由服务端覆盖。
- 前端不拼接业务规则；判据结果显示服务端返回的 `verdict`。

## 4. 测试与质量门禁

```bash
cd apps/electro-assist/api
pytest tests -q          # 164 passed
ruff check .             # 只开 E9/F63/F7/F82

cd ../web
npm run build            # vue-tsc + vite；构建期还有 CSP 内联检查（Dockerfile）
```

CI（`.github/workflows/ci.yml`）顺序：契约测试 → E2E 冒烟（与构建并行）→ ruff → 构建镜像（含 Caddyfile 校验、CSP 产物检查）→ 推 ACR → 服务器拉取 → 3 次健康检查 → 失败回滚。另有一条独立的 `uptime.yml` 每 10 分钟从 GitHub 探活。

**前端 E2E（2026-10-21 进 CI）**：`tests/e2e/smoke.spec.ts` 覆盖三条路径——列表→引导第 1 步→刷新保持、B 命中、B 未覆盖。不调模型，用启动时 seed 的案例与知识库。

```bash
# 本地：先起 API（临时库）与 preview，再跑
cd apps/electro-assist/api && DB_PATH=/tmp/e2e.db APP_ENV=dev python -m uvicorn main:app --port 8001
cd apps/electro-assist/web && npm run build && npm run preview -- --port 4173
E2E_CHANNEL=msedge npm run test:e2e        # 用系统 Edge，免下载浏览器
```

CI 里跑 `chromium`（`npx playwright install --with-deps chromium`），**部署依赖 E2E 通过**。

**已知缺口**：前端仍无组件单测；E2E 只覆盖主路径，不覆盖打印与软键盘（这两项靠真机验收）。

## 5. 发布草稿

生成结果是草稿，不进公开列表。发布只走 CLI：

```bash
python -m scripts.publish --list
python -m scripts.publish --publish g_xxxxxxxxxxxxxxxx
```

发布前会做一次 `Guide.model_validate`；已发布内容不会被再次生成覆盖。详细语义见 `OPERATIONS.md` §12。

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
