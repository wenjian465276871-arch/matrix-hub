# 运维手册

> 版本 v1.5 · 状态：已确认 · 最后更新：2026-10-21
> 本文不含服务器地址、凭证与私有路径。补全信息的操作记录留在私有仓。
> v0.2 → v1.0（2026-10-20）：修正 §1「两个卷」与实际三条挂载不符；补 §11 待补项的现状；接口清单改指 `docs/API.md`。
> v1.0 → v1.1（2026-10-20）：新增 §12 发布草稿 CLI（`scripts/publish.py`），补上决策 #16 承诺的发布路径。
> v1.1 → v1.2（2026-10-21）：发布 CLI 已实测；Caddy 移除粒子死路由（显式 404）；记录页时间兼容修复已部署（详见私有仓验收记录）。
> v1.2 → v1.3（2026-10-21）：新增 §13 口令通道、§14 清理任务；`/healthz` 增加磁盘检查；切图独立限流；Caddy 移除无效 SSE 配置。
> v1.3 → v1.4（2026-10-21）：口令通道已在生产启用（值只在服务器 `.env`）；清理任务以**空跑 cron** 安装，日志落 `/opt/matrix-hub/cleanup.log`；两周无异常后再改 `--apply`。

## 1. 运行形态

单个容器 `matrix-hub`，内部由 supervisord 托管两个进程：

| 进程 | 监听 | 作用 |
|---|---|---|
| Caddy | 80 / 443 | TLS（Let's Encrypt 自动签发续期）、安全头、静态资源、反代 |
| electro API | 127.0.0.1:8001 | 业务接口 + `/healthz` |

容器以 uid 10001 运行；80/443 通过 `setcap cap_net_bind_service` 获得绑定权限，不使用 root。

三个挂载（两个具名卷 + 一个绑定目录）：

- `matrix-hub_app_data` → `/srv/app_data`（SQLite、上传资产、Caddy 证书与状态）
- `matrix-hub_caddy_data` → `/data`（预留）
- `./backups` → `/srv/backups`（SQLite 备份，**卷外**；宿主目录需 `chown 10001:10001`）

卷内布局：

| 路径 | 内容 |
|---|---|
| `/srv/app_data/electro.db` | 业务库（guides/jobs/usage/sessions/records），WAL 模式 |
| `/srv/app_data/uploads/` | 上传资产，每份一个目录（原图 + 切片 + meta.json） |
| `/srv/app_data/caddy/` | 证书与 ACME 账户状态 |

**权限**：API 进程 umask 为 077，新建的库与上传资产是 600/700。
从旧版本升上来的实例需要一次性收紧历史文件：

```bash
docker exec matrix-hub sh -c "chmod -R go-rwx /srv/app_data/uploads /srv/app_data/electro.db*"
```

**证书与数据库都在 app_data 卷里。** 重建容器不会丢；删卷才会。
`/healthz` 同时检查进程与数据库，`checks.db` 为 `error` 时返回 `status: degraded`。

## 2. 部署目录

服务器上 `/opt/matrix-hub/`：

```
compose.yml     由仓库同步，不手改
deploy.sh       由仓库同步
backup.sh       由仓库同步（每日备份脚本）
.env            600，含 IMAGE / TAG / SITE_DOMAIN / ACME_EMAIL / DEEPSEEK_API_KEY，不入库
deploy.log      deploy.sh 追加写入的部署记录
backups/        SQLite 备份（卷外，保留最近 7 份）
```

## 3. 部署

**正常路径**：push 到 `main` → GitHub Actions 构建 → 推 ACR → **scp 同步 `deploy.sh` / `backup.sh` / `compose.yml`** → SSH 执行 `deploy.sh <sha>`。

> 2026-10-18 补：同步步骤此前缺失，CI 实际一直在跑服务器上的旧脚本——仓库改了不生效，
> 等于部署逻辑不在版本控制里。现在这些文件每次部署前从仓库覆盖到 `/opt/matrix-hub/`。
> 2026-10-19：`backup.sh` 一并同步；CI 并发改为**不取消进行中的部署**（避免 SSH 部署被中断在中间态）。

**手动路径**（CI 不可用时）：先 `scp deploy/deploy.sh docker/compose.yml` 到 `/opt/matrix-hub/`，再：

```bash
cd /opt/matrix-hub
./deploy.sh <git-sha>
```

`deploy.sh` 的行为：

1. 记录当前 TAG
2. `docker compose pull web`
3. 用新 TAG 启动
4. 健康检查：连续 3 次通过（每次间隔 5s，经 Caddy 443 检查 `/healthz`）
5. 失败 → 自动切回上一 TAG 并按同一口径复查；仍不健康则退出码 1

## 4. 回滚

```bash
cd /opt/matrix-hub
TAG=<上一个 sha> docker compose up -d web
```

镜像按 commit SHA 打标签，不存在“latest 覆盖”的问题。回滚时不要删卷——数据和证书都在卷里。

**极端情况**：容器怎么都起不来，且需要立刻恢复站点：

```bash
docker compose down
systemctl start nginx      # nginx 仍保留配置与证书，30 秒内可恢复
```

## 5. 健康检查与日志

```bash
curl -s https://<域名>/healthz          # {"status":"ok","checks":{"electro":"ok","db":"ok","disk":"ok"}}
docker compose -f /opt/matrix-hub/compose.yml logs -f --tail 100 web
docker stats --no-stream
```

`checks.disk` 在剩余空间低于 `HEALTHZ_MIN_FREE_RATIO`（默认 0.10）时变 `error`，
整体 `status` 随之 `degraded`，部署脚本按 `status` 判回滚。**取不到磁盘信息同样算 error**：
看不见容量就不再是"健康"。日志走 stdout。容器日志已限制为 `json-file`、单文件 10MB、保留 3 个（计划 §9.4 #5），
不会无限增长。**日志中不得出现密钥、token、请求体。**

### 5.1 预算水位与告警（2026-10-24 新增）

`/healthz` 额外返回一个 `budget` 块（**不参与 `status`**——预算是业务指标，不是存活信号；
算进 `checks` 会让"今天花了 85%"触发部署回滚一个正常版本）：

```json
"budget": {"day":"2026-10-24","used_micros":102000,"limit_micros":3000000,"ratio":0.034,"level":"ok"}
```

| level | 触发 | 动作 |
|---|---|---|
| `ok` | < `BUDGET_WARN_RATIO`（默认 0.80） | 无 |
| `warn` | ≥ 0.80 | 写一条 `WARNING` 日志（同一天只写一次） |
| `critical` | ≥ 0.95 | 写一条 `ERROR` 日志；再消耗即触发 `budget_exhausted` |

告警通道不新增基础设施：`uptime.yml` 读一次 `level`，
非 `ok` 就让 workflow 失败 → GitHub 按通知设置发邮件。日志侧用
`docker compose logs web | grep 日预算` 核对，同一天同一级别只出现一次（防日志刷屏）。

阈值可用 `BUDGET_WARN_RATIO` / `BUDGET_CRITICAL_RATIO` 覆盖；写成 0/负数/>1 时退回默认，
**不会**因为配置写错而永不告警。

## 6. 证书

Caddy 自动签发与续期，无需 cron。状态与证书在 `matrix-hub_app_data` 卷内。

排查：

```bash
echo | openssl s_client -connect <域名>:443 -servername <域名> 2>/dev/null | grep -E 'issuer=|Verify'
```

若续期失败（如 80 端口被占），Caddy 会持续重试并告警式记录；此时先确认 80 端口可被容器绑定。

## 7. 备份

| 对象 | 方式 | 频率 |
|---|---|---|
| 站点静态与代码 | Git（本仓库） | 每次提交 |
| 业务库 | `deploy/backup.sh`（SQLite 在线备份到卷外） | 每日 03:17（cron） |
| 上传资产 | 同一个脚本打包 `uploads-*.tar.gz`（容器内 tar） | 每日 03:17（cron） |
| 整机 | 云厂商快照 | 变更前手动 |

**SQLite 不能直接 `cp`。** WAL 模式下最新数据还在 `-wal` 文件里，热拷贝会得到
一个"少了最后几笔"的库，而且恢复时不会报错——这是最坏的一种备份。

`backup.sh` 的做法：容器内 `sqlite3.Connection.backup()` 在线热备 →
写到 `/srv/backups`（绑定到宿主机 `/opt/matrix-hub/backups`）→ `PRAGMA integrity_check`
→ 再把 `app_data/uploads` 打成 `uploads-*.tar.gz`（tar 必须在容器内执行，
宿主机看不到卷内路径）→ 两类各保留最近 7 份。备份在卷外，卷损坏时仍然可用。

> 2026-10-22 起备份包含上传目录。此前只备份 db：恢复后指导书在、图片全丢，
> 而图片是视觉原语与切图的输入，等于半个产品没了。

首次安装（只需一次）：

```bash
install -d -o 10001 -g 10001 -m 700 /opt/matrix-hub/backups
chmod 755 /opt/matrix-hub/backup.sh
# 每天 03:17 备份；日志留在 /var/log
( crontab -l 2>/dev/null; echo '17 3 * * * /opt/matrix-hub/backup.sh >> /var/log/matrix-hub-backup.log 2>&1' ) | crontab -
```

手动执行与检查：

```bash
/opt/matrix-hub/backup.sh
ls -lh /opt/matrix-hub/backups | tail -8
tail -20 /var/log/matrix-hub-backup.log
```

### 7.4 恢复（演练过再算数）

```bash
cd /opt/matrix-hub
docker stop matrix-hub
docker run --rm \
  -v matrix-hub_app_data:/data \
  -v /opt/matrix-hub/backups:/b:ro \
  python:3.12-slim \
  sh -c 'cp /b/electro-YYYYMMDD-HHMM.db /data/electro.db && \
         rm -f /data/electro.db-wal /data/electro.db-shm && \
         tar xzf /b/uploads-YYYYMMDD-HHMM.tar.gz -C /data && \
         chown -R 10001:10001 /data/electro.db /data/uploads'
docker start matrix-hub
curl -s https://<域名>/healthz     # 期望 {"status":"ok","checks":{"electro":"ok","db":"ok"}}
```

恢复后核对：`docker exec matrix-hub python -c "import sqlite3;c=sqlite3.connect('/srv/app_data/electro.db');print(c.execute('select count(*) from guides').fetchone())"`
——数量应与备份时一致。**恢复演练每季度至少一次**，否则"有备份"只是心理安慰。

> 2026-10-19 首次演练：停容器 → 移走原库 → 用备份替换 → 启动，**4 秒恢复健康**，
> 3 guides（2 published + 1 draft）/ 1 job 与备份一致；原库保留 24h 后清理。

## 8. 事故处置

| 现象 | 首查 | 处置 |
|---|---|---|
| 站点 502/504 | `docker ps` 是否 healthy | 重启容器；仍失败则回滚 TAG |
| 证书错误 | 80 端口是否可达 | 检查端口占用与 DNS |
| 磁盘告警 | `df -h`、`docker system df` | `docker image prune`，清理旧日志 |
| 内存告警 | `docker stats` | 单实例约 70–300MB；超 800MB 说明有泄漏 |
| 误部署 | `deploy.log` 的 prev_tag | 按第 4 节回滚 |

## 9. 身份约定（GitHub CLI）

工作机上同时存在两个 GitHub 账号：**项目所有者账号**（本仓库归属）与**另一个长期项目的账号**。
后者是 `gh` 的默认 active 账号，本仓库**不去争抢**这个全局状态。

规则：

1. **不执行 `gh auth switch`**。切换全局 active 会让另一个长期项目掉线，代价比收益大。
2. 对本仓库的 API 操作，一律**命令内联指定身份**：

   ```bash
   GH_TOKEN=$(gh auth token --user <owner>) gh api repos/<owner>/matrix-hub/...
   ```

3. `git push` 走 SSH 密钥，密钥绑定的就是所有者账号，**与 active 账号无关**，因此推送不受影响。
4. 若某条命令需要 `security_events` 等额外 scope，对所有者账号执行一次
   `gh auth refresh -h github.com -u <owner> -s security_events`，不要给另一个账号加。

判断当前命令用的是谁：`gh auth status` 看 Active account；或直接 `GH_TOKEN=... gh api user -q .login` 回显。

## 10. 近期变更（2026-10-18）

| 变更 | 影响 |
|---|---|
| 上传目录 `UPLOAD_DIR=/srv/app_data/uploads` | 上传资产落在 `app_data` 卷，重建容器不丢；30 天清理由 `scripts/cleanup.py --uploads-days 30` 负责（cron 仍空跑，转 `--apply` 前先看日志） |
| 依赖升级 | Pillow 13.0.0 / python-multipart 0.0.32 / numpy 2.2.1；升级前先跑 `pytest`，再验证线上上传与切图 |
| 部署变更门控 | 仅 `docs/**`、`*.md`、`.github/**` 的改动不重启生产；改代码仍会中断约 15–20 秒 |
| 镜像标签 | 一律用 commit SHA，禁止 `latest`；单镜像约 318MB（压缩后 80MB 量级），prune 保留 168h |

### 10.1 上传体积的三级限制（容易误解）

| 层 | 限制 | 位置 | 说明 |
|---|---|---|---|
| Caddy 全局 | 2 MB | `Caddyfile` `request_body` | 所有普通请求 |
| Caddy 上传路由 | 6 MB | `/api/electro/uploads*` 单独放宽 | 给应用层留余量 |
| 应用层 | **5 MB** | `imaging.MAX_BYTES` | 最终生效值；超限返回 413 |

**以应用层 5 MB 为准**，前两层只是让请求能到达应用。改限制时必须三处同步，否则会出现"网关放行、应用拒绝"或反之。

### 10.2 上传的频率限制（2026-10-18 新增）

| 维度 | 默认值 | 环境变量 | 超限返回 |
|---|---|---|---|
| 单 IP / 小时 | 6 | `UPLOAD_RATE_PER_HOUR` | 429 + `Retry-After` |
| 单 IP / 日 | 20 | `UPLOAD_RATE_PER_DAY` | 429 + `Retry-After` |
| 全站 / 日 | 200 | `UPLOAD_SITE_PER_DAY` | 429 + `Retry-After` |

实现是**进程内滑窗**（`apps/electro-assist/api/core/ratelimit.py`），前提是**单容器单 worker**。
重启即清零，这是刻意取舍：限流用于抬高滥用成本，精确计量走后续 SQLite `usage` 表。
**改成多 worker 或多实例后此机制失效**（各进程各记一份），必须换成 Caddy 层限流或 Redis。

IP 取自 `X-Forwarded-For` 的**最右一段**（由容器内 Caddy 追加）。若将来前置 CDN，需重新确认信任链。

### 10.3 回滚复查（2026-10-18 修复）

`deploy.sh` 的回滚复查原先探测 `http://127.0.0.1:8001/healthz`，但 8001 只在容器内监听、
宿主机不可达——**成功回滚也会打印"仍不健康"**。现统一走 `probe_health()`：
`curl --resolve ${SITE_DOMAIN}:443:127.0.0.1 https://.../healthz`，与部署后检查同口径。

### 10.4 生成配额与预算（2026-10-19 新增）

| 维度 | 默认值 | 环境变量 | 说明 |
|---|---|---|---|
| 单 IP / 小时 | 2 | `GENERATE_PER_HOUR` | 排队中的 job 也计数 |
| 单 IP / 日 | 10 | `GENERATE_PER_DAY` | 按北京时间日界 |
| 全站 / 日预算 | ¥3 | `GENERATE_DAILY_BUDGET_MICROS` | 微元整数；超限返回 429 `budget_exhausted` |
| 单次成本估算 | ¥0.03 | `GENERATE_ESTIMATE_MICROS` | 预检用，实测峰值约 ¥0.025 |

两条容易搞混的口径（决策 #17）：

- **失败/超时不占访客配额**：系统问题不该让用户当天没法再用；
- **失败仍计入全站预算**：token 已经烧掉了，不记就会在失败率高时漏掉最贵的调用。

`retry_of` 只在四个条件同时满足时豁免配额：同 IP、24 小时内、原 job 为
`failed`/`timeout`、且该 job 未被重试过。缺一条就返回 429。

接口：`POST /api/electro/generate` → 202 `{job_id}`；`GET /api/electro/jobs/{id}` 轮询；
`GET /api/electro/quota` 查余量。生成结果是**草稿**，只出现在详情链接里，不进公开列表。

### 10.5 资源护栏与镜像回收（2026-10-19 新增）

- 容器 `mem_limit: 1200m`：2C2G 主机上，一次异常生成 + Pillow 解码就可能打满内存；
  超限让容器重启，而不是拖死整机。
- 日志 `json-file` / 10MB / 3 个：默认无上限，Caddy 访问日志会一直长。
- `deploy.sh` 改为 `docker image prune -af --filter until=168h`：
  不带 `-a` 只清 dangling，带 tag 的镜像永不回收（10-19 实测已堆 15 个）。

磁盘检查：

```bash
docker system df
docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | wc -l
```

### 10.6 CI 部署并发（2026-10-19 新增）

`cancel-in-progress: false`。部署经 SSH 在服务器上执行，取消 runner 会留下
"镜像已换、健康检查没跑完"的中间态。代价是连续 push 会排队，单次约 2 分钟，可接受。
deploy job 另加 `timeout-minutes: 20`，避免 SSH 卡死时一直挂着。

### 10.7 A1 引导与会话（2026-10-19 新增）

| 端点 | 作用 | 备注 |
|---|---|---|
| `POST /api/electro/sessions` | 开始一次作业 | 201；每 IP 10 次/时（`SESSION_PER_HOUR`，进程内滑窗） |
| `GET /api/electro/sessions/{id}` | 会话 + 指导书 + 已提交记录 | 刷新续接靠它 |
| `POST /api/electro/sessions/{id}/steps/{seq}` | 提交一步 | **必须带 `Idempotency-Key`**；判定服务端算 |
| `POST /api/electro/sessions/{id}/finish` | `done` / `aborted` | `done` 要求全部步骤通过 |
| `GET /api/electro/records/{session_id}` | 整份作业记录 | 打印页数据源，含异常链 |

**复测不是覆盖**：每次提交 `records.attempt + 1`，旧记录保留；`fail`/`warn`
不推进 `current_seq`。迁移 3 重建了 `records` 表以去掉旧的
`UNIQUE(session_id, step_id)`——那条约束会把复测当重复丢弃。

**写入增长**：每次作业约 4–8 条记录，单条 < 2KB。当前无清理任务；
`records/sessions` 的 30 天清理与 `uploads` 同期做（见 §11）。

**权限**：会话与记录凭随机 id 访问，无登录。不要往记录里写个人信息。

## 11. 待补

- 备份恢复演练常态化（每季度一次，脚本见 §7.4）
- 自动快照策略（轻量应用服务器不提供，需用 CI 定时调用 API 替代）
- 监控告警：**GitHub Actions 定时探活已加**（`.github/workflows/uptime.yml`，查 `/healthz`、页面与 guides；失败会以 workflow 失败通知）。**注意实际频次**：cron 写每 10 分钟，但 GitHub 调度实测日均约 2–8 次（10-22～10-30），最坏间隔可达数小时；它只是低成本兜底，需要分钟级告警请外接 UptimeRobot 一类服务
- 清理任务**已实现并安装空跑 cron**（§14，2026-10-21）；两周报告正常后评估改 `--apply`
- 切图结果落 manifest（现每次 `/slice` 重算，既费 CPU 也无法回溯；已加次数上限与限流）
- 多实例部署前替换进程内队列与限流（`services/jobqueue.py`、`core/ratelimit.py`、`services/sessions.py` 均假设单 worker）

## 12. 发布草稿（CLI）

生成结果默认是草稿，不进公开列表（决策 #16）。发布没有后台页面，只在服务器上执行：

```bash
# 列出草稿（id / 子系统 / 步数 / 更新时间 / 标题）
docker exec matrix-hub python -m scripts.publish --list

# 发布指定草稿
docker exec matrix-hub python -m scripts.publish --publish g_xxxxxxxxxxxxxxxx
```

发布后：

- `GET /api/electro/guides` 会包含该条；前端列表刷新即可看到；
- `published_at` 写入当前时间；已发布内容**不可被再次生成覆盖**（`save_guide` 会跳过）；
- 重复执行 `--publish` 是幂等的，输出 `[SKIP]`，不会改发布时间；
- 不存在的 id 退出码为 1；数据未通过 Guide 校验时拒绝发布并打印原因。

> 为什么不做 `--unpublish`：撤下已发布内容涉及"访客可能已经看过/引用过"的语义，
> 且当前没有鉴权与审计。需要撤下时，走数据库变更并记录原因，不提供一个随手可点的反向开关。


## 13. 口令通道（2026-10-21）

用途：现场连续演示或批量生成时，临时不受「每 IP 2 次/时、10 次/日」限制。
**它不豁免全站日预算**，也不是身份体系——没有用户、没有后台。

> **当前状态（2026-10-21 23:03）**：本站已启用（48 位随机 hex，仅存服务器 `.env`，600）。
> 查看口令（在服务器上执行，不要把输出贴到聊天/文档）：
> `grep '^ELECTRO_PASSCODE=' /opt/matrix-hub/.env`
> 线上验证：正确口令 200 + 令牌；错误口令 401；坏令牌调 `/generate` 401（不建 job）。

配置（服务器 `.env`，600）：

```bash
# 生成随机口令（不要用示例值）
openssl rand -base64 24

# 写入 /opt/matrix-hub/.env
ELECTRO_PASSCODE=<上一步的输出>
```

改完 `.env` 需要重建容器才生效：

```bash
cd /opt/matrix-hub && docker compose up -d web
```

使用：

```bash
# 1) 换令牌（12 小时有效）
curl -s -X POST https://<域名>/api/electro/passcode/verify \
  -H 'Content-Type: application/json' -d '{"code":"<口令>"}'
# → {"token":"v1.<exp>.<sig>","expires_in":43200}

# 2) 生成时带上令牌
curl -s -X POST https://<域名>/api/electro/generate \
  -H 'Content-Type: application/json' \
  -H 'X-Passcode-Token: v1.<exp>.<sig>' \
  -d '{"text":"..."}'
```

边界：

| 项 | 规则 |
|---|---|
| 令牌有效期 | 12 小时；过期后重新验证 |
| 轮换口令 | 改 `.env` 重启，**旧令牌立即失效**（签名密钥由口令派生） |
| 关闭功能 | 注释掉 `ELECTRO_PASSCODE` 重启；验证接口返回 503 |
| 验证限流 | 每 IP 10 次/时、50 次/日；全站 500 次/日 |
| 失败表现 | 口令错误 401 `passcode_invalid`；令牌无效 401（生成接口也是 401，不静默降级） |
| 日志 | 口令与令牌**一律不得写入日志**；排查只看 `code` |
| 预算 | 照旧生效；预算耗尽仍返回 429 `budget_exhausted` |

## 14. 清理任务（2026-10-21，2026-10-21 补诊断表）

```bash
# 预演（默认，不删任何东西）
docker exec matrix-hub python -m scripts.cleanup

# 确认后执行
docker exec matrix-hub python -m scripts.cleanup --apply
```

默认保留期与理由：

| 数据 | 默认 | 理由 |
|---|---|---|
| 上传目录 | 30 天（按目录 mtime），**被任何指导书引用的资产永久保留** | 未入稿的截图只用于生成确认期；已入稿的图是页面内容，删了就是裂图 |
| 会话 + 记录 | 180 天 | 作业留痕要能回溯；180 天后才清 |
| 逐步诊断（run + steps） | 180 天 | 与作业记录同口径；含僵尸会话（长期 active 的也按创建时间清） |
| **访客草稿** | **30 天** | 草稿里有访客粘的工艺文本，留着就是隐私负债；与"产品内容"不是一回事 |
| 已结束任务 | 90 天 | 排障用；queued/running 永不删 |
| 用量明细 | **90 天** | 对齐计划 §11.3.3；当天预算只依赖当天，删旧行不影响熔断 |
| 已发布指导书 | **永不删** | 产品内容；草稿到期才清 |

防呆：删除草稿时 SQL 会再判一次 `status='draft'`——plan 与 apply 之间有人把它发布了，也不会被删。

首次执行前先备份（§7.1），并保留 dry-run 输出。

**2026-10-31 已在生产手工执行一次 `--apply`**（先 `sqlite3 backup` 到 `.bak-20261031T0209`）：
插入一条 40 天前的演练草稿 → dry-run 报「草稿 1」→ `--apply` 删除 1 条 → `guides` 回到 7、`integrity_check=ok`。
即删除链路在线上真跑过，不是只写在文档里。

**同日已把 cron 从"每周日空跑"改为"每日真删"**（2026-10-31 02:26，`crontab -l` 已核对，`systemctl is-active cron` = active）：

```bash
# 备份 03:17 → 清理 03:40：先备份再删，出事能回滚
17 3 * * * /opt/matrix-hub/backup.sh >> /var/log/matrix-hub-backup.log 2>&1
40 3 * * * /usr/bin/docker exec matrix-hub python -m scripts.cleanup --apply >> /opt/matrix-hub/cleanup.log 2>&1
```

日志 `/opt/matrix-hub/cleanup.log`（600）。`--apply` 不可逆：要改窗口先跑一次 dry-run 看条数与样例。

> 清理是**不可逆**的。`--apply` 前先看一眼 dry-run 的条数与样例；输出里没有删除明细就说明没匹配到数据。

## 15. 错误号与重排预算（2026-10-22）

**错误号（ref）**：所有响应带 `X-Request-Id`；未捕获异常统一返回
`{"detail":{"code":"internal_error","message":"...","ref":"<8位>"}}`。
排障顺序：用户报 `ref` → `docker logs matrix-hub | grep "<ref>"` → 同一行里有堆栈与路径。
没有 ref 的 500 属于缺陷，不要靠时间对齐日志。

**重排预算**：B 模块的模型重排有自己的日预算，**不占用生成的 ¥3**：

```bash
# 服务器 .env
RERANK_DAY_MICROS=300000   # ¥0.3/日；按单次 ≈¥0.001 估算，约 300 次
```

- 预算耗尽只是**跳过重排**，检索结果照常返回（关键词顺序）；
- 结果按 `query + 候选集` 缓存 10 分钟，命中时 `rerank.cached=true`；
- 想看今天花了多少：响应里的 `rerank.cost_micros` 累加，或查 `usage` 表。

## 16. 2026-10-29/30 变更（A2 六项 + 目录重组）

**新增接口**（都在 `/api/electro` 下）：

| 接口 | 用途 | 资源限制 |
|---|---|---|
| `POST /extract` | 图片单通道识别，只回填文本 | 3 张/次；每 IP 3/时、8/日；全站 30/日；按图片 token 计入全站日预算 |
| `POST /processes` | 工艺文本预检（规则解析） | 无额外限制；不调模型、不扣配额 |
| `POST /uploads/{id}/slice/{region}/adopt` | 切块采纳为独立素材 | 每源图 6 次 |
| `GET /records/{sid}/export.html` | 下载自包含 HTML 报告 | 无额外限制；不落盘、`no-store` |

**识别依赖**：复用现有 `DEEPSEEK_API_KEY` 与 `deepseek-flash`（原生视觉），**不需要新供应商**。
未配置 Key 时 `/extract` 返回 503 `vision_not_configured`，其余功能不受影响。

**目录变化**（镜像内路径同步，`uvicorn main:app` 不变）：

```
/opt/electro/core/          横切能力（assets / imaging / slicing / ratelimit / passcode）
/opt/electro/data/          samples / knowledge / corpus
```

排障提示：如果容器里找不到 `imaging.py`，先看 `/opt/electro/core/`——2026-10-30 起已迁入 `core/`。

**存量样例刷新（2026-10-30 起有工具）**：`ensure_seeded` 仍只补缺失、不覆盖；
要更新已发布样例的内容，用**显式**脚本，别手工删行重 seed：

```bash
# 容器内，先看差异（默认 dry-run）
docker exec -w /opt/electro matrix-hub python -m scripts.refresh_sample
# 确认后写入
docker exec -w /opt/electro matrix-hub python -m scripts.refresh_sample --yes
```

口径：**只换内容，保留 id / status / created_at / published_at**。
`[SAME]` 指**规范化后的内容完全一致**。旧版只比图数/原语数/动效数，于是「把动效从一张图挪到另一张」「给仪表补 value」这类改动会被误判成无变化而跳过——2026-10-31 生产上真漏过一次（hvac 的 value 修补）。
因此 `sessions.guide_id` 与 `records.step_id` 继续有效，现场会话与历史记录不会断。
两条前置条件不满足就整份拒绝（不做半套更新）：记录必须是 `published`；
步骤 id 序列必须与文件完全一致（变了意味着老记录找不到对应步骤）。

写入前先备份库：

```bash
docker exec matrix-hub python -c "import sqlite3;s=sqlite3.connect('/srv/app_data/electro.db');d=sqlite3.connect('/srv/app_data/electro.db.bak-$(date -u +%Y%m%dT%H%M)');s.backup(d);d.close()"
```

本地演练（2026-10-31，用 `b5cfe72` 的旧样例造库）：`g_door_switch_formal_001` 14 图 / 7 原语 / 0 动效 →
20 图 / 13 原语 / 3 动效；`created_at` 与 `published_at` 未变，会话与记录各 1 条仍可读。

## 17. 密钥轮换演练（2026-10-31，计划 §11.6 P4）

**结论**：轮换机制可用、失败模式可控；真实 Key 未动（见末尾"边界"）。

### 17.1 演练方式（不碰生产 .env）

用同一镜像起一个**隔离实例**，只把 `DEEPSEEK_API_KEY` 换成无效值，其余（DB、上传目录、端口）都独立：

```bash
docker run -d --rm --name keydrill --entrypoint python \
  -e DEEPSEEK_API_KEY=sk-invalid-drill-not-a-real-key \
  -e DB_PATH=/tmp/keydrill.db -e UPLOAD_DIR=/tmp/keydrill_up -e APP_ENV=dev \
  -p 127.0.0.1:18001:8001 <镜像> -m uvicorn main:app --host 0.0.0.0 --port 8001
```

### 17.2 观测结果

| 检查项 | 结果 |
|---|---|
| `/healthz` | **200**（健康检查不依赖 LLM Key，Key 错不会把站点判死） |
| 提交生成 | 202 正常受理，job 在 **1 秒内** failed，`error_code=auth` |
| 错误信息 | provider 原文 `Authentication Fails, Your api key: ****-key is invalid（HTTP 401）`——**密钥被掩码** |
| 费用 | `cost_micros=0`、tokens 全 0（失败不计费） |
| 日志泄露 | `docker logs keydrill | grep -c sk-invalid-drill` = **0** |
| 生产影响 | 同期生产站 200、容器 healthy |
| 清理 | 演练容器已删除（`docker ps` 只剩 `matrix-hub`） |

### 17.3 真实轮换步骤（2 分钟，需本人在 DeepSeek 控制台发新 Key）

```bash
# 0) 备份（拷文件，不要打印内容）
cp -p /opt/matrix-hub/.env /opt/matrix-hub/.env.bak-$(date -u +%Y%m%dT%H%M) && chmod 600 /opt/matrix-hub/.env.bak-*

# 1) 只替换这一行（用编辑器或 sed，别 cat 出来）
sed -i 's|^DEEPSEEK_API_KEY=.*|DEEPSEEK_API_KEY=<新 Key>|' /opt/matrix-hub/.env

# 2) 重建容器让 env 生效（restart 不会重新读 .env）
cd /opt/matrix-hub && docker compose -f compose.yml up -d --force-recreate web

# 3) 验证
curl -s https://www.superplayer007.cn/healthz
docker inspect matrix-hub --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -c DEEPSEEK   # 只数条数，不打印值
# 提交一次真实生成（2/小时配额），确认 job succeeded

# 4) 确认新 Key 可用后，去控制台吊销旧 Key
```

**回滚**：`cp -p /opt/matrix-hub/.env.bak-* /opt/matrix-hub/.env && cd /opt/matrix-hub && docker compose -f compose.yml up -d --force-recreate web`。

### 17.4 边界（如实记录）

- **没有替换生产 Key**：读取/改写 `/opt/matrix-hub/.env` 里的密钥被宿主安全层拦下（判为敏感凭据访问），
  我没有绕过它，也没有把 Key 打印出来。所以"发新 Key → 替换 → 重启 → 验活 → 吊销旧 Key"这四步
  需要你在控制台操作时执行一次；上面的失败模式与回滚路径已经演练过。
- 演练证明的是**失败侧**：Key 错时站点不挂、错误可读、不计费、不泄露。
