# API 参考

> 由 `apps/electro-assist/api/scripts/export_openapi.py` 从 `app.openapi()` 生成，**不要手改**。
> 接口变更后重跑脚本并提交本文件：`cd apps/electro-assist/api && ./.venv/Scripts/python.exe scripts/export_openapi.py`
> 服务版本：`0.6.0` ｜ 端点 **36** 个（业务 **35** + `/healthz`）

## 1. 约定

| 项 | 说明 |
|---|---|
| Base URL | 生产为同源 `/api/electro`；本地 `http://127.0.0.1:8001` |
| 反代 | Caddy 同源反代，**无 CORS**；API 只监听容器内 `127.0.0.1:8001` |
| 内容类型 | 除取图接口外均为 `application/json` |
| 错误体 | `{"detail": {"code": ..., "message": ...}}`，限流另带 `retry_after` |
| 幂等 | `POST /sessions/{id}/steps/{seq}` **必须**带 `Idempotency-Key` |
| 配额 | 生成 2/时·10/日（每 IP）、上传 6/时·20/日、会话 10/时；超限 429 + `Retry-After` |
| 可见性 | `GET /guides` 只返回 `published`；草稿凭随机 id 访问 |

## 2. 端点清单

| 方法 | 路径 | 说明 | 请求体 | 响应 |
|---|---|---|---|---|
| `POST` | `/api/electro/diagnose` | 按现象检索故障知识库；查不到返回 uncovered_reason；`stream=1` 时按 recall→rerank→done 三帧 SSE 推送 | `DiagnoseIn` | `200 · —` |
| `GET` | `/api/electro/diagnose/kb` | 知识库覆盖范围（子系统、条目数、版本） | `—` | `200 · object` |
| `POST` | `/api/electro/diagnose/runs` | 开始逐步诊断（故障树）：返回条目、首个检查项与候选 | `RunIn` | `201 · object` |
| `GET` | `/api/electro/diagnose/runs/{run_id}` | 取逐步诊断状态：已填步骤、当前检查、结论 | `—` | `200 · object` |
| `POST` | `/api/electro/diagnose/runs/{run_id}/abort` | 中止逐步诊断，保留已完成步骤 | `—` | `200 · object` |
| `POST` | `/api/electro/diagnose/runs/{run_id}/checks/{order}` | 回填一项检查（确认 pass/fail 或实测值），由服务端判定并推进 | `CheckIn` | `200 · object` |
| `POST` | `/api/electro/extract` | 图片识别：默认双通道（先转录后结构化），失败回退单通道并标注；每步与每条判据带 `trace`（服务端在转录行里重新定位的行号 + `ok`/`suspect`/`unverified` 三态）；不落库、不自动生成 | `ExtractIn` | `200 · object` |
| `POST` | `/api/electro/fe-error` | 前端错误上报：只写日志、不落库；字段白名单 + 单 IP 30/时限流 | `FeErrorIn` | `—` |
| `POST` | `/api/electro/generate` | 提交生成任务，返回 202 + job_id（单 worker 有界队列） | `GenerateIn` | `202 · object` |
| `GET` | `/api/electro/guides` | 指导书列表，**只含已发布**（草稿不进列表）；`q` 按标题/摘要/来源说明子串搜索 | `—` | `200 · object` |
| `GET` | `/api/electro/guides/{guide_id}` | 指导书详情；返回 `{status, guide, process_id}` 信封，草稿凭 id 可读 | `—` | `200 · object` |
| `PATCH` | `/api/electro/guides/{guide_id}` | 修正草稿文字与判据值（需口令令牌）：不能增删步骤、不能换判据类型；已发布 409 | `GuidePatch` | `200 · object` |
| `PUT` | `/api/electro/guides/{guide_id}/assets` | 草稿素材归位：全量重排已有素材到步骤/素材区；已发布 409 | `AttachIn` | `200 · object` |
| `POST` | `/api/electro/guides/{guide_id}/publish` | 发布草稿（需口令令牌）：每步必须有验收判据，缺一项即 409 并列出缺口 | `—` | `200 · object` |
| `GET` | `/api/electro/jobs/{job_id}` | 轮询生成任务状态，成功后带 guide_id | `—` | `200 · object` |
| `POST` | `/api/electro/passcode/verify` | 用访问口令换短期令牌（只豁免每 IP 配额，预算仍生效） | `PasscodeIn` | `200 · object` |
| `POST` | `/api/electro/processes` | 工艺文本预检：规则解析工序/工位/工具/安全与判据线索；`save=true` 时把原文落库并返回 `process_id`（默认不落库、不扣配额） | `ProcessIn` | `200 · object` |
| `GET` | `/api/electro/processes/{process_id}` | 取已保存的工艺原文（随机 id，不枚举；保留 30 天） | `—` | `200 · object` |
| `POST` | `/api/electro/processes/{process_id}/generate` | 用已保存的工艺重新生成（与 `/generate` 共用配额、预算与队列） | `ProcessGenerateIn` | `202 · object` |
| `GET` | `/api/electro/quota` | 查生成配额与全站预算余量 | `—` | `200 · object` |
| `GET` | `/api/electro/records/{session_id}` | 整份作业记录（按步骤分组、含每次尝试与异常链） | `—` | `200 · object` |
| `GET` | `/api/electro/records/{session_id}/export.html` | 导出作业记录为自包含 HTML（内联样式、无脚本、离线可读） | `—` | `200 · —` |
| `GET` | `/api/electro/schema/guide` | 取 Guide 的 JSON Schema（schema_version 1.2） | `—` | `200 · object` |
| `POST` | `/api/electro/schema/validate` | 校验一份 Guide，返回错误列表 | `object` | `200 · object` |
| `POST` | `/api/electro/schema/validate-visual` | 只校验视觉 DSL 片段 | `object` | `200 · object` |
| `GET` | `/api/electro/schema/visual` | 取视觉原语清单与动效槽位（13 种原语 + motion） | `—` | `200 · object` |
| `POST` | `/api/electro/sessions` | 开始一次作业会话（绑定 guide，设备/位置选填） | `StartIn` | `201 · object` |
| `GET` | `/api/electro/sessions/{session_id}` | 取会话状态：当前步号、指导书、已提交记录 | `—` | `200 · object` |
| `POST` | `/api/electro/sessions/{session_id}/finish` | 结束会话（done 需全部通过 / aborted 可随时） | `FinishIn` | `200 · object` |
| `POST` | `/api/electro/sessions/{session_id}/steps/{seq}` | 提交一步实测值；**必须带 Idempotency-Key**，判定在服务端 | `StepIn` | `200 · object` |
| `POST` | `/api/electro/uploads` | 上传工艺截图（≤5MB，限流 6/时·20/日） | `—` | `200 · object` |
| `GET` | `/api/electro/uploads/{asset_id}` | 取上传资产的元信息与切片清单 | `—` | `200 · object` |
| `POST` | `/api/electro/uploads/{asset_id}/slice` | 按模式切图（整图/表格/行带/密集文字） | `—` | `200 · object` |
| `POST` | `/api/electro/uploads/{asset_id}/slice/{region_id}/adopt` | 把切块复制成独立素材（记 derived_from，每源图 6 次上限） | `—` | `200 · object` |
| `GET` | `/api/electro/uploads/{asset_id}/{filename}` | 取原图或某张切片（二进制） | `—` | `200 · —` |
| `GET` | `/healthz` | 健康检查：进程 + 数据库 + 磁盘余量；`scope=live|ready|electro|all` 分级，readiness 失败返回 503 | `—` | `200 · object` |

## 3. 按模块

### diagnose

- `POST /api/electro/diagnose` — 按现象检索故障知识库；查不到返回 uncovered_reason；`stream=1` 时按 recall→rerank→done 三帧 SSE 推送
- `GET /api/electro/diagnose/kb` — 知识库覆盖范围（子系统、条目数、版本）
- `POST /api/electro/diagnose/runs` — 开始逐步诊断（故障树）：返回条目、首个检查项与候选
- `GET /api/electro/diagnose/runs/{run_id}` — 取逐步诊断状态：已填步骤、当前检查、结论
- `POST /api/electro/diagnose/runs/{run_id}/abort` — 中止逐步诊断，保留已完成步骤
- `POST /api/electro/diagnose/runs/{run_id}/checks/{order}` — 回填一项检查（确认 pass/fail 或实测值），由服务端判定并推进

### extract

- `POST /api/electro/extract` — 图片识别：默认双通道（先转录后结构化），失败回退单通道并标注；每步与每条判据带 `trace`（服务端在转录行里重新定位的行号 + `ok`/`suspect`/`unverified` 三态）；不落库、不自动生成

### generate

- `POST /api/electro/generate` — 提交生成任务，返回 202 + job_id（单 worker 有界队列）
- `GET /api/electro/jobs/{job_id}` — 轮询生成任务状态，成功后带 guide_id

### guides

- `GET /api/electro/guides` — 指导书列表，**只含已发布**（草稿不进列表）；`q` 按标题/摘要/来源说明子串搜索
- `GET /api/electro/guides/{guide_id}` — 指导书详情；返回 `{status, guide, process_id}` 信封，草稿凭 id 可读
- `PATCH /api/electro/guides/{guide_id}` — 修正草稿文字与判据值（需口令令牌）：不能增删步骤、不能换判据类型；已发布 409
- `PUT /api/electro/guides/{guide_id}/assets` — 草稿素材归位：全量重排已有素材到步骤/素材区；已发布 409
- `POST /api/electro/guides/{guide_id}/publish` — 发布草稿（需口令令牌）：每步必须有验收判据，缺一项即 409 并列出缺口

### ops

- `POST /api/electro/fe-error` — 前端错误上报：只写日志、不落库；字段白名单 + 单 IP 30/时限流
- `GET /healthz` — 健康检查：进程 + 数据库 + 磁盘余量；`scope=live|ready|electro|all` 分级，readiness 失败返回 503

### passcode

- `POST /api/electro/passcode/verify` — 用访问口令换短期令牌（只豁免每 IP 配额，预算仍生效）

### processes

- `POST /api/electro/processes` — 工艺文本预检：规则解析工序/工位/工具/安全与判据线索；`save=true` 时把原文落库并返回 `process_id`（默认不落库、不扣配额）
- `GET /api/electro/processes/{process_id}` — 取已保存的工艺原文（随机 id，不枚举；保留 30 天）
- `POST /api/electro/processes/{process_id}/generate` — 用已保存的工艺重新生成（与 `/generate` 共用配额、预算与队列）

### quota

- `GET /api/electro/quota` — 查生成配额与全站预算余量

### records

- `GET /api/electro/records/{session_id}` — 整份作业记录（按步骤分组、含每次尝试与异常链）
- `GET /api/electro/records/{session_id}/export.html` — 导出作业记录为自包含 HTML（内联样式、无脚本、离线可读）

### schema

- `GET /api/electro/schema/guide` — 取 Guide 的 JSON Schema（schema_version 1.2）
- `POST /api/electro/schema/validate` — 校验一份 Guide，返回错误列表
- `POST /api/electro/schema/validate-visual` — 只校验视觉 DSL 片段
- `GET /api/electro/schema/visual` — 取视觉原语清单与动效槽位（13 种原语 + motion）

### sessions

- `POST /api/electro/sessions` — 开始一次作业会话（绑定 guide，设备/位置选填）
- `GET /api/electro/sessions/{session_id}` — 取会话状态：当前步号、指导书、已提交记录
- `POST /api/electro/sessions/{session_id}/finish` — 结束会话（done 需全部通过 / aborted 可随时）
- `POST /api/electro/sessions/{session_id}/steps/{seq}` — 提交一步实测值；**必须带 Idempotency-Key**，判定在服务端

### uploads

- `POST /api/electro/uploads` — 上传工艺截图（≤5MB，限流 6/时·20/日）
- `GET /api/electro/uploads/{asset_id}` — 取上传资产的元信息与切片清单
- `POST /api/electro/uploads/{asset_id}/slice` — 按模式切图（整图/表格/行带/密集文字）
- `POST /api/electro/uploads/{asset_id}/slice/{region_id}/adopt` — 把切块复制成独立素材（记 derived_from，每源图 6 次上限）
- `GET /api/electro/uploads/{asset_id}/{filename}` — 取原图或某张切片（二进制）

## 4. 数据模型

字段与约束以 `apps/electro-assist/api/models/` 为准，本节只列形状。

### AssetIn

| 字段 | 类型 | 必填 |
|---|---|---|
| `asset_id` | `string` | 是 |
| `caption` | `—` | 否 |

### AttachIn

| 字段 | 类型 | 必填 |
|---|---|---|
| `assets` | `AttachItem[]` | 否 |

### AttachItem

| 字段 | 类型 | 必填 |
|---|---|---|
| `asset_id` | `string` | 是 |
| `caption` | `string` | 是 |
| `step_id` | `—` | 否 |

### Body_upload_api_electro_uploads_post

| 字段 | 类型 | 必填 |
|---|---|---|
| `file` | `string` | 是 |

### CheckIn

| 字段 | 类型 | 必填 |
|---|---|---|
| `result` | `—` | 否 |
| `value` | `—` | 否 |
| `note` | `string` | 否 |

### Context

| 字段 | 类型 | 必填 |
|---|---|---|
| `guide_id` | `—` | 否 |
| `step_seq` | `—` | 否 |
| `criterion_id` | `—` | 否 |

### CriterionPatch

| 字段 | 类型 | 必填 |
|---|---|---|
| `id` | `string` | 是 |
| `label` | `—` | 否 |
| `unit` | `—` | 否 |
| `min` | `—` | 否 |
| `max` | `—` | 否 |
| `options` | `—` | 否 |

### DiagnoseIn

| 字段 | 类型 | 必填 |
|---|---|---|
| `symptom` | `string` | 是 |
| `system` | `—` | 否 |
| `top_k` | `integer` | 否 |
| `context` | `—` | 否 |

### ExtractIn

| 字段 | 类型 | 必填 |
|---|---|---|
| `asset_ids` | `string[]` | 是 |

### FeErrorIn

| 字段 | 类型 | 必填 |
|---|---|---|
| `message` | `string` | 是 |
| `kind` | `string` | 否 |
| `source` | `string` | 否 |
| `route` | `string` | 否 |
| `ref` | `string` | 否 |
| `stack` | `string` | 否 |

### FinishIn

| 字段 | 类型 | 必填 |
|---|---|---|
| `status` | `enum(done / aborted)` | 否 |
| `note` | `string` | 否 |

### GenerateIn

| 字段 | 类型 | 必填 |
|---|---|---|
| `text` | `string` | 是 |
| `retry_of` | `—` | 否 |
| `assets` | `AssetIn[]` | 否 |
| `source_type` | `enum(text / image)` | 否 |
| `station` | `—` | 否 |

### GuidePatch

| 字段 | 类型 | 必填 |
|---|---|---|
| `title` | `—` | 否 |
| `summary` | `—` | 否 |
| `steps` | `—` | 否 |

### HTTPValidationError

| 字段 | 类型 | 必填 |
|---|---|---|
| `detail` | `ValidationError[]` | 否 |

### PasscodeIn

| 字段 | 类型 | 必填 |
|---|---|---|
| `code` | `string` | 是 |

### ProcessGenerateIn

| 字段 | 类型 | 必填 |
|---|---|---|
| `retry_of` | `—` | 否 |
| `assets` | `AssetIn[]` | 否 |

### ProcessIn

| 字段 | 类型 | 必填 |
|---|---|---|
| `text` | `string` | 是 |
| `system` | `—` | 否 |
| `save` | `boolean` | 否 |
| `title` | `—` | 否 |

### RunIn

| 字段 | 类型 | 必填 |
|---|---|---|
| `symptom` | `string` | 是 |
| `system` | `—` | 否 |
| `entry_id` | `—` | 否 |
| `session_id` | `—` | 否 |

### StartIn

| 字段 | 类型 | 必填 |
|---|---|---|
| `guide_id` | `string` | 是 |
| `device` | `string` | 否 |
| `location` | `string` | 否 |

### StepIn

| 字段 | 类型 | 必填 |
|---|---|---|
| `values` | `object` | 否 |
| `note` | `string` | 否 |

### StepPatch

| 字段 | 类型 | 必填 |
|---|---|---|
| `id` | `string` | 是 |
| `title` | `—` | 否 |
| `action` | `—` | 否 |
| `criteria` | `—` | 否 |

### ValidationError

| 字段 | 类型 | 必填 |
|---|---|---|
| `loc` | `string | integer[]` | 是 |
| `msg` | `string` | 是 |
| `type` | `string` | 是 |
| `input` | `—` | 否 |
| `ctx` | `object` | 否 |

## 5. 错误码

> 由 `apps/electro-assist/api/core/errors.py` 的 `ERROR_CODES` 登记，本节由脚本渲染。
> **双向校验**：代码里出现未登记的码、或表里存在没人用的码，`--check` 都会失败。

错误体统一为 `{"detail": {"code": ..., "message": ...}}`；429 另带 `retry_after`，
5xx 另带 `ref`（与 `X-Request-Id` 同值，供查日志）。异步任务的码在 `GET /jobs/{id}` 的
`error_code` 字段，不是 `detail.code`。

### 5.1 码表

| code | HTTP | 含义 | 产生位置 |
|---|---|---|---|
| `rate_limited` | 429 | 该 IP 的窗口配额已用完，响应带 `retry_after` | `core/ratelimit.py 调用方` |
| `auth` | 由端点定 | 上游鉴权失败：Key 无效、被吊销或额度耗尽 | `llm/deepseek.py` |
| `bad_request` | 由端点定 | 上游拒绝请求（参数或模型名有误） | `llm/deepseek.py` |
| `network` | 由端点定 | 上游网络失败：连接超时、DNS、TLS | `llm/deepseek.py` |
| `rate_limit` | 由端点定 | 上游限流（不是本站配额） | `llm/deepseek.py` |
| `server` | 由端点定 | 上游 5xx | `llm/deepseek.py` |
| `timeout` | 由端点定 | 上游在单次调用时限内没有返回 | `llm/deepseek.py` |
| `truncated` | 由端点定 | 输出被 `max_tokens` 截断，JSON 不完整 | `llm/deepseek.py` |
| `validation` | 由端点定 | 模型输出不是合法 JSON，或字段不合 schema | `llm/deepseek.py` |
| `budget` | 由端点定 | 剩余时间预算不足以再发起一次调用（不是上游错误） | `llm/runner.py` |
| `internal_error` | 500 | 未预期异常，响应带 `ref` 供查日志 | `main.py` |
| `invalid_request` | 422 | 请求体不合 schema（字段缺失、类型错、长度越界） | `main.py` |
| `resume_mismatch` | 由端点定 | `Last-Event-ID` 不在本次流的事件序列里（跨请求续读不被支持），应重发请求 | `routers/diagnose.py` |
| `run_not_found` | 404 | 逐步诊断会话不存在 | `routers/diagnose.py` |
| `stream_failed` | 由端点定 | 流内失败帧：召回或重排阶段抛错，连接已结束 | `routers/diagnose.py` |
| `asset_not_found` | 422 | 素材不存在或已过期 | `routers/extract.py` |
| `assets_required` | 422 | 至少要提供 1 项（图片 / 素材项） | `routers/extract.py` |
| `duplicate_asset` | 422 | 同一张图在本次提交里出现两次 | `routers/extract.py` |
| `extract_invalid` | 502 | 模型输出不合结构化 schema，无法当作识别结果 | `routers/extract.py` |
| `too_many_assets` | 422 | 一次提交的图片超过 3 张 | `routers/extract.py` |
| `vision_not_configured` | 503 | 服务端没配置视觉模型 Key，识别入口整体关闭 | `routers/extract.py` |
| `asset_duplicate` | 422 | 同一素材被挂到两个位置（一个素材只能归位一次） | `routers/guides.py` |
| `bad_caption` | 422 | 素材说明为空，或含标记语法（说明是纯文本） | `routers/guides.py` |
| `guide_invalid` | 409 | 草稿数据无法解析成 Guide（库里存的 JSON 与当前 schema 不兼容） | `routers/guides.py` |
| `passcode_disabled` | 503 | 服务端没配置口令，写入口整体关闭 | `routers/guides.py` |
| `passcode_required` | 401 | 该操作需要口令令牌，请求没带 `X-Passcode-Token` | `routers/guides.py` |
| `published_locked` | 409 | 已发布的指导书不可改；要改内容请生成新版本 | `routers/guides.py` |
| `step_not_found` | 422 | 草稿里没有该 `step_id` | `routers/guides.py` |
| `unknown_asset` | 422 | 这份草稿里没有该素材，无法归位 | `routers/guides.py` |
| `not_found` | 404 | 资源不存在，或凭当前 id 读不到 | `routers/guides.py 等` |
| `passcode_invalid` | 401 | 口令或令牌不正确 / 已过期（令牌 12 小时） | `routers/jobs.py` |
| `input_too_long` | 422 | 工艺文本超过 20,000 字符上限 | `routers/processes.py` |
| `input_too_short` | 422 | 工艺文本少于 10 字符，不够生成一份指导书 | `routers/processes.py` |
| `process_not_found` | 404 | 工艺原文不存在，或已过 30 天保留期 | `routers/processes.py` |
| `idempotency_key_required` | 400 | 提交步骤必须带 `Idempotency-Key`，否则无法保证重投不产生第二条记录 | `routers/sessions.py` |
| `session_not_found` | 404 | 会话不存在 | `routers/sessions.py` |
| `adopt_limit` | 429 | 同一张图被复制成独立素材的次数超过上限（6 次） | `routers/uploads.py` |
| `bad_asset_id` | 400 | 素材 id 格式不合法（应为 `a_` + 16 位十六进制） | `routers/uploads.py` |
| `bad_path` | 400 | 取图路径不合法（文件名不在该素材的切片清单里） | `routers/uploads.py` |
| `bad_region_id` | 400 | 切块 id 格式不合法 | `routers/uploads.py` |
| `region_not_found` | 404 | 切块不存在 | `routers/uploads.py` |
| `slice_limit` | 429 | 同一张图的切图次数超过上限（每图 12 次/时） | `routers/uploads.py` |
| `too_large` | 413 | 图片超过 5MB | `routers/uploads.py` |
| `unreadable` | 422 | 图片无法解码（损坏、或不是 png/jpg/webp） | `routers/uploads.py` |
| `invalid_value` | 由端点定 | 实测值不是数字，或不在判据允许的取值域内 | `services/criteria.py` |
| `manual_not_confirmed` | 由端点定 | 人工确认类判据未勾选确认 | `services/criteria.py` |
| `missing_criterion` | 由端点定 | 该步有判据没有提交结果 | `services/criteria.py` |
| `unknown_criterion` | 由端点定 | 提交了该步不存在的判据 id | `services/criteria.py` |
| `check_not_found` | 由端点定 | 该诊断会话没有这个检查项序号 | `services/diagnosis.py` |
| `duplicate_check` | 由端点定 | 该检查项已回填过，不能重复提交（改结论请重开一轮） | `services/diagnosis.py` |
| `entry_not_found` | 由端点定 | 知识库里没有该条目 id | `services/diagnosis.py` |
| `result_required` | 由端点定 | 该检查项要求 pass/fail 结论，提交里没有 | `services/diagnosis.py` |
| `run_finished` | 由端点定 | 诊断会话已收束，不再接受回填 | `services/diagnosis.py` |
| `value_invalid` | 由端点定 | 实测值格式不合法 | `services/diagnosis.py` |
| `value_required` | 由端点定 | 该检查项要求实测值，提交里没有 | `services/diagnosis.py` |
| `wrong_order` | 由端点定 | 回填的检查项不是当前待办项 | `services/diagnosis.py` |
| `busy` | 由端点定 | 生成队列已满，任务未被接收（异步任务的 `error_code`） | `services/generation.py` |
| `internal` | 由端点定 | 生成过程抛了非 LLM 异常（异步任务的 `error_code`，详情是异常类名） | `services/generation.py` |
| `guide_missing` | 由端点定 | 开始会话时指定的指导书不存在 | `services/sessions.py` |
| `guide_not_found` | 由端点定 | 会话关联的指导书已被删除 | `services/sessions.py` |
| `out_of_order` | 由端点定 | 提交的步序与当前进度不连续 | `services/sessions.py` |
| `record_missing` | 由端点定 | 该步还没有任何记录，无法读取或导出 | `services/sessions.py` |
| `session_closed` | 由端点定 | 会话已结束（done / aborted），不能再提交 | `services/sessions.py` |
| `step_already_passed` | 由端点定 | 该步已通过，不允许重投（要复测请对未通过步提交） | `services/sessions.py` |
| `steps_incomplete` | 由端点定 | 结束会话时仍有步骤未通过（`done` 的前置条件） | `services/sessions.py` |

### 5.2 前缀族（f-string 拼出来的码）

| 前缀 | 形态 | 含义 | 产生位置 |
|---|---|---|---|
| `extract_` | `extract_{kind}` | 图片识别时上游失败，`kind` 取 `auth` / `network` / `timeout` / `rate_limit` / `server` / `truncated` / `validation` / `bad_request` / `budget` 之一；前端提示按 kind 分档 | `routers/extract.py` |
| `http_` | `http_{status}` | 框架自身抛的 `HTTPException`（无此路由 404、方法不允许 405 等）被收进统一信封时补的码 | `main.py` |
