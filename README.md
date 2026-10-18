# MATRIX HUB

个人作品集站点与业务模块的单仓。一个镜像、一个入口、一条流水线。

> 状态：**线上运行中**（2026-10-18 完成容器化割接）。单镜像 + Caddy 统一入口 + GitHub Actions 自动部署；电气调试助手模块开发中。

## 模块

| 模块 | 路径 | 说明 | 状态 |
|---|---|---|---|
| 门户 | `apps/portal/public` | 站点首页（自包含重写，零外链） | **已上线** |
| 新闻洞察 | —— | 新闻聚合（原 FastAPI 后端） | **已下架**（ADR-0002） |
| 粒子系统 | `apps/particle-system/legacy` | Canvas 视觉实验 | 暂停（待重构，ADR-0003） |
| 电气调试助手 | `apps/electro-assist` | 工艺文本/图片 → 指导书 → 引导作业 → 故障排查（Vue 3 + FastAPI） | 开发中（契约 + 上传切图已上线） |

## 架构一句话

单个容器内由 supervisord 托管 Caddy（80/443、TLS、CSP）与 electro API（:8001）；API 只监听回环地址，公网只经 Caddy。news-insight 已下架（ADR-0002），镜像与 `/healthz` 均不再包含它。镜像由 CI 构建并推送私有镜像仓，服务器只拉取、不编译。

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
# 电气调试助手（后端）
cd apps/electro-assist/api
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt -r requirements-dev.txt   # Windows
python -m pytest tests -q
uvicorn main:app --reload --port 8001
```

前端工程（Vue 3 + Vite）在 P1a-W1 建立，当前 `apps/electro-assist/web/` 仅为占位页。前端方案见 `../docs`（私有仓）与本仓 `docs/ARCHITECTURE.md`。

环境变量统一走 `.env`（见 `deploy/.env.example`），**任何密钥都不入库**。

## 文档导航

| 文档 | 内容 |
|---|---|
| [架构与取舍](docs/ARCHITECTURE.md) | 拓扑、请求链路、关键决策 |
| [部署与回滚](docs/OPERATIONS.md) | 部署/回滚/证书/备份/事故处置 |
| [A2 图片输入方案](docs/A2-IMAGE-INPUT.md) | 草案；**已降级为 P4 备选**（决策 #13） |
| [案例资料来源](docs/SOURCES.md) | 合规清单与登记规则 |
| [ADR 0001](docs/adr/0001-monorepo-single-image-caddy.md) · [0002](docs/adr/0002-p0-drop-news-insight.md) · [0003](docs/adr/0003-legacy-static-not-shipped.md) | 架构决策记录 |

`API.md` 由 CI 从 OpenAPI 导出（尚未接入）；`UI.md` / `UX.md` / `FRONTEND.md` 随前端工程在 P1a-W1 迁入；`DEMO.md` 在 P4 产出。**未产出的文档不在此列链接。**

## 说明

站点内的作业指导书与故障案例均为**演示数据**，由公开资料整理并虚构化改写，**不作为实际作业依据**，不含任何企业内部资料。
