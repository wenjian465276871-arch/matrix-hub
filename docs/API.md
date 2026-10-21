# API 参考

> 由 `apps/electro-assist/api/scripts/export_openapi.py` 从 `app.openapi()` 生成，**不要手改**。
> 接口变更后重跑脚本并提交本文件：`cd apps/electro-assist/api && ./.venv/Scripts/python.exe scripts/export_openapi.py`
> 服务版本：`0.6.0` ｜ 端点 **26** 个（业务 **25** + `/healthz`）

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
| `POST` | `/api/electro/diagnose` | 按现象检索故障知识库；查不到返回 uncovered_reason | `DiagnoseIn` | `200 · object` |
| `GET` | `/api/electro/diagnose/kb` | 知识库覆盖范围（子系统、条目数、版本） | `—` | `200 · object` |
| `POST` | `/api/electro/diagnose/runs` | 开始逐步诊断（故障树）：返回条目、首个检查项与候选 | `RunIn` | `201 · object` |
| `GET` | `/api/electro/diagnose/runs/{run_id}` | 取逐步诊断状态：已填步骤、当前检查、结论 | `—` | `200 · object` |
| `POST` | `/api/electro/diagnose/runs/{run_id}/abort` | 中止逐步诊断，保留已完成步骤 | `—` | `200 · object` |
| `POST` | `/api/electro/diagnose/runs/{run_id}/checks/{order}` | 回填一项检查（确认 pass/fail 或实测值），由服务端判定并推进 | `CheckIn` | `200 · object` |
| `POST` | `/api/electro/generate` | 提交生成任务，返回 202 + job_id（单 worker 有界队列） | `GenerateIn` | `202 · object` |
| `GET` | `/api/electro/guides` | 指导书列表，**只含已发布**（草稿不进列表） | `—` | `200 · object` |
| `GET` | `/api/electro/guides/{guide_id}` | 指导书详情；返回 `{status, guide}` 信封，草稿凭 id 可读 | `—` | `200 · object` |
| `GET` | `/api/electro/jobs/{job_id}` | 轮询生成任务状态，成功后带 guide_id | `—` | `200 · object` |
| `POST` | `/api/electro/passcode/verify` | 用访问口令换短期令牌（只豁免每 IP 配额，预算仍生效） | `PasscodeIn` | `200 · object` |
| `GET` | `/api/electro/quota` | 查生成配额与全站预算余量 | `—` | `200 · object` |
| `GET` | `/api/electro/records/{session_id}` | 整份作业记录（按步骤分组、含每次尝试与异常链） | `—` | `200 · object` |
| `GET` | `/api/electro/schema/guide` | 取 Guide 的 JSON Schema（schema_version 1.1） | `—` | `200 · object` |
| `POST` | `/api/electro/schema/validate` | 校验一份 Guide，返回错误列表 | `object` | `200 · object` |
| `POST` | `/api/electro/schema/validate-visual` | 只校验视觉 DSL 片段 | `object` | `200 · object` |
| `GET` | `/api/electro/schema/visual` | 取视觉 DSL 的 JSON Schema（7 种原语） | `—` | `200 · object` |
| `POST` | `/api/electro/sessions` | 开始一次作业会话（绑定 guide，设备/位置选填） | `StartIn` | `201 · object` |
| `GET` | `/api/electro/sessions/{session_id}` | 取会话状态：当前步号、指导书、已提交记录 | `—` | `200 · object` |
| `POST` | `/api/electro/sessions/{session_id}/finish` | 结束会话（done 需全部通过 / aborted 可随时） | `FinishIn` | `200 · object` |
| `POST` | `/api/electro/sessions/{session_id}/steps/{seq}` | 提交一步实测值；**必须带 Idempotency-Key**，判定在服务端 | `StepIn` | `200 · object` |
| `POST` | `/api/electro/uploads` | 上传工艺截图（≤5MB，限流 6/时·20/日） | `—` | `200 · object` |
| `GET` | `/api/electro/uploads/{asset_id}` | 取上传资产的元信息与切片清单 | `—` | `200 · object` |
| `POST` | `/api/electro/uploads/{asset_id}/slice` | 按模式切图（整图/表格/行带/密集文字） | `—` | `200 · object` |
| `GET` | `/api/electro/uploads/{asset_id}/{filename}` | 取原图或某张切片（二进制） | `—` | `200 · —` |
| `GET` | `/healthz` | 健康检查：进程 + 数据库 + 磁盘余量，供部署脚本与容器探针使用 | `—` | `200 · object` |

## 3. 按模块

### diagnose

- `POST /api/electro/diagnose` — 按现象检索故障知识库；查不到返回 uncovered_reason
- `GET /api/electro/diagnose/kb` — 知识库覆盖范围（子系统、条目数、版本）
- `POST /api/electro/diagnose/runs` — 开始逐步诊断（故障树）：返回条目、首个检查项与候选
- `GET /api/electro/diagnose/runs/{run_id}` — 取逐步诊断状态：已填步骤、当前检查、结论
- `POST /api/electro/diagnose/runs/{run_id}/abort` — 中止逐步诊断，保留已完成步骤
- `POST /api/electro/diagnose/runs/{run_id}/checks/{order}` — 回填一项检查（确认 pass/fail 或实测值），由服务端判定并推进

### generate

- `POST /api/electro/generate` — 提交生成任务，返回 202 + job_id（单 worker 有界队列）
- `GET /api/electro/jobs/{job_id}` — 轮询生成任务状态，成功后带 guide_id

### guides

- `GET /api/electro/guides` — 指导书列表，**只含已发布**（草稿不进列表）
- `GET /api/electro/guides/{guide_id}` — 指导书详情；返回 `{status, guide}` 信封，草稿凭 id 可读

### ops

- `GET /healthz` — 健康检查：进程 + 数据库 + 磁盘余量，供部署脚本与容器探针使用

### passcode

- `POST /api/electro/passcode/verify` — 用访问口令换短期令牌（只豁免每 IP 配额，预算仍生效）

### quota

- `GET /api/electro/quota` — 查生成配额与全站预算余量

### records

- `GET /api/electro/records/{session_id}` — 整份作业记录（按步骤分组、含每次尝试与异常链）

### schema

- `GET /api/electro/schema/guide` — 取 Guide 的 JSON Schema（schema_version 1.1）
- `POST /api/electro/schema/validate` — 校验一份 Guide，返回错误列表
- `POST /api/electro/schema/validate-visual` — 只校验视觉 DSL 片段
- `GET /api/electro/schema/visual` — 取视觉 DSL 的 JSON Schema（7 种原语）

### sessions

- `POST /api/electro/sessions` — 开始一次作业会话（绑定 guide，设备/位置选填）
- `GET /api/electro/sessions/{session_id}` — 取会话状态：当前步号、指导书、已提交记录
- `POST /api/electro/sessions/{session_id}/finish` — 结束会话（done 需全部通过 / aborted 可随时）
- `POST /api/electro/sessions/{session_id}/steps/{seq}` — 提交一步实测值；**必须带 Idempotency-Key**，判定在服务端

### uploads

- `POST /api/electro/uploads` — 上传工艺截图（≤5MB，限流 6/时·20/日）
- `GET /api/electro/uploads/{asset_id}` — 取上传资产的元信息与切片清单
- `POST /api/electro/uploads/{asset_id}/slice` — 按模式切图（整图/表格/行带/密集文字）
- `GET /api/electro/uploads/{asset_id}/{filename}` — 取原图或某张切片（二进制）

## 4. 数据模型

字段与约束以 `apps/electro-assist/api/models/` 为准，本节只列形状。

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

### DiagnoseIn

| 字段 | 类型 | 必填 |
|---|---|---|
| `symptom` | `string` | 是 |
| `system` | `—` | 否 |
| `top_k` | `integer` | 否 |
| `context` | `—` | 否 |

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

### HTTPValidationError

| 字段 | 类型 | 必填 |
|---|---|---|
| `detail` | `ValidationError[]` | 否 |

### PasscodeIn

| 字段 | 类型 | 必填 |
|---|---|---|
| `code` | `string` | 是 |

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

### ValidationError

| 字段 | 类型 | 必填 |
|---|---|---|
| `loc` | `string | integer[]` | 是 |
| `msg` | `string` | 是 |
| `type` | `string` | 是 |
