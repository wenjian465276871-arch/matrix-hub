# MATRIX HUB

个人作品集站点与业务模块的单仓。一个镜像、一个入口、一条流水线。

> 状态：**线上运行中**（2026-10-18 完成容器化割接）。单镜像 + Caddy 统一入口 + GitHub Actions 自动部署；电气调试助手模块开发中。

## 模块

| 模块 | 路径 | 说明 | 状态 |
|---|---|---|---|
| 门户 | `apps/portal` | 站点首页与作品索引 | 迁移中 |
| 新闻洞察 | `apps/news-insight` | 新闻聚合与要点提取（FastAPI） | 迁移中 |
| 粒子系统 | `apps/particle-system` | Canvas 视觉实验 | 迁移中 |
| 电气调试助手 | `apps/electro-assist` | 工艺文本 → 可视化作业指导书 → 引导作业 → 故障排查（Vue 3 + FastAPI） | 开发中 |

## 架构一句话

单个容器内由 supervisord 托管 Caddy（80/443、TLS、CSP）、news API（:8000）、electro API（:8001）；两个 API 只监听回环地址，公网只经 Caddy。镜像由 CI 构建并推送私有镜像仓，服务器只拉取、不编译。

详见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 与 [`docs/adr/`](docs/adr/)。

## 目录

```
apps/             # 各业务模块（前端/后端源码）
services/gateway/ # 预留：跨模块聚合层
docker/           # Dockerfile、Caddyfile、compose
deploy/           # 部署与回滚脚本
docs/             # 架构、运维、接口、演示脚本、ADR
```

## 本地开发

各模块独立可跑，互不阻塞：

```bash
# 电气调试助手（前端）
cd apps/electro-assist/web && npm ci && npm run dev

# 新闻洞察（后端）
cd apps/news-insight && uv sync && uv run uvicorn app.main:app --reload
```

环境变量统一走 `.env`（见各模块 `.env.example`），**任何密钥都不入库**。

## 文档导航

- [架构与取舍](docs/ARCHITECTURE.md)
- [部署与回滚](docs/OPERATIONS.md)（待补）
- [接口说明](docs/API.md)（以 OpenAPI 为准）
- [界面规范](docs/UI.md) · [交互规范](docs/UX.md) · [前端方案](docs/FRONTEND.md)
- [演示脚本](docs/DEMO.md)（待补）
- [案例资料来源](docs/SOURCES.md)（合规清单，待补）

## 说明

站点内的作业指导书与故障案例均为**演示数据**，由公开资料整理并虚构化改写，**不作为实际作业依据**，不含任何企业内部资料。
