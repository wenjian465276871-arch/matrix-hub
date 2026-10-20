# P0a 迁移方案

> **历史记录，不再维护（2026-10-21 注）**：本文的路径已变——`apps/particle-system/legacy` 与 `apps/portal/legacy` 移到 `archive/`，`services/gateway` 空占位删除；当前结构见 [`../README.md`](../README.md) 与 ADR-0003。
> 版本 v1.0 · 状态：**已完成（2026-10-18）**
> 注意：第 3 节"静态文件原样迁入"已被 **ADR-0003** 取代——旧页依赖 CDN，改为归档不服务、门户重写。
> 原定"迁移 news 后端"已由 **ADR-0002** 取消。
> 依据：ADR-0001（单仓单镜像）、ADR-0002（P0 下架 news-insight）

## 1. 现状实测

| 路径 | 形态 | 体积 | 文件数 |
|---|---|---|---|
| `/var/www/matrix-hub/portal/web` | 手写 `index.html`，无构建链 | 20K | 1 |
| `/var/www/matrix-hub/apps/particle-system/src` | 原生 JS（`app.js` + 4 个 module） | 72K | 8 |
| `/var/www/matrix-hub/apps/news-insight/frontend` | 手写 `index.html` | 32K | 1 |
| `/var/www/insightpulse` | FastAPI 源码（api/core/db/models/schemas） | 106M | — |

运行态：仅 nginx；`8000` 无监听；无数据库安装；`/opt` 为空（旧假设作废）。

## 2. 目标结构

```
matrix-hub/
├── apps/
│   ├── portal/public/index.html          # 从服务器原样迁入
│   ├── particle-system/public/           # 原样迁入（src/* → public/*）
│   └── electro-assist/
│       ├── web/                          # Vue 3 + Vite，构建产物进镜像
│       └── api/                          # FastAPI，源码进镜像
├── services/gateway/                     # P0 空置，仅占位
├── docker/  Dockerfile · Caddyfile · compose.yml
└── deploy/  deploy.sh · rollback.sh
```

镜像内布局：

```
/srv/static/portal/          ← apps/portal/public
/srv/static/particle/        ← apps/particle-system/public
/srv/static/electro/         ← apps/electro-assist/web 构建产物
/opt/electro/                ← apps/electro-assist/api
```

## 3. 迁移清单

| # | 源 | 目标 | 方式 |
|---|---|---|---|
| 1 | `portal/web/index.html` | `apps/portal/public/index.html` | 逐文件传输，原样保存 |
| 2 | `particle-system/src/*`（8 文件） | `apps/particle-system/public/` | 逐文件传输；`index.html` 里的 `./src/` 路径同步改为 `./` |
| 3 | `insightpulse` 后端 | —— | **不迁**（ADR-0002） |
| 4 | `news-insight/frontend/index.html` | —— | **不迁** |
| 5 | nginx `superplayer.conf` | `docker/Caddyfile` | 语义重写，不复制粘贴 |

传输方式：`swas_exec.py exec` 逐文件 `cat`，本地落盘。总量 <100KB，不打包。超过 200KB 时改用 `tar cz | base64 -w0` 分块。

## 4. 实施步骤

1. **拉取静态文件**（9 个）→ 落到 monorepo，修正 particle 的引用路径。
2. **写 `docker/Dockerfile`**：三阶段——node 构建 electro web；python 装 electro api 依赖；运行阶段装 Caddy 二进制 + supervisor。基础镜像按 digest 固定。
3. **写 `docker/Caddyfile`**：80→443 跳转、TLS、安全头与 CSP、`/srv/static/*` 静态、`/api/electro/*` 反代 `127.0.0.1:8001`、SSE 路由 `flush_interval -1` + `transport http { read_timeout 300s }`。
4. **写 `docker/compose.yml`**：单服务、两卷（`caddy_data`、`app_data`）、非 root、无 docker socket。
5. **写 `deploy/deploy.sh`**：pull → 记录当前镜像 → up -d → 健康检查（30s 内连续 3 次 200）→ 失败回滚。
6. **本地构建验证**：`docker build` + 起容器 + `curl` 三处（`/`、`/apps/particle-system/`、`/healthz`）。
7. **推送 ACR**：手动一次，确认服务器能拉。
8. **P0b 割接**：停 nginx 前先 run 新容器占 8080，验证通过再切 80/443。

## 5. 验收

| 项 | 判据 |
|---|---|
| 静态 | `GET /` 返回门户；`GET /apps/particle-system/` 返回粒子页；资源 200 |
| 后端 | `GET /healthz` → `{"status":"ok","checks":{"electro":"ok"}}` |
| 已下架 | `GET /api/news/anything` → 404（不是 502） |
| 安全头 | 响应含 CSP、HSTS、`X-Content-Type-Options` |
| 端口 | 容器外仅 80/443；`ss -lntp` 无 8000/8001 |
| 回滚 | `deploy.sh` 注入错误后能自动切回上一镜像 |

## 6. 风险

| 风险 | 应对 |
|---|---|
| particle 改造时路径改错 | 先原样迁，跑通再改引用；保留 git 历史便于对比 |
| Caddy 的 SSE 配置写错层级 | `caddy validate` 必须在 CI 与本地各跑一次 |
| 割接窗口内证书签发失败 | 先保留 nginx 与 80 端口，失败 5 分钟内回退 |
| electro 依赖装不进镜像 | 先只装最小依赖跑 `/healthz`，业务依赖随功能增量加 |
