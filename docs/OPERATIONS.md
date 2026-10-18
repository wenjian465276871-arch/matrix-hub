# 运维手册

> 版本 v0.1 · 状态：草案 · 最后更新：2026-10-18
> 本文不含服务器地址、凭证与私有路径。补全信息的操作记录留在私有仓。

## 1. 运行形态

单个容器 `matrix-hub`，内部由 supervisord 托管两个进程：

| 进程 | 监听 | 作用 |
|---|---|---|
| Caddy | 80 / 443 | TLS（Let's Encrypt 自动签发续期）、安全头、静态资源、反代 |
| electro API | 127.0.0.1:8001 | 业务接口 + `/healthz` |

容器以 uid 10001 运行；80/443 通过 `setcap cap_net_bind_service` 获得绑定权限，不使用 root。

两个卷：

- `matrix-hub_app_data` → `/srv/app_data`（SQLite、上传资产、Caddy 证书与状态）
- `matrix-hub_caddy_data` → `/data`（预留）

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
.env            600，含 IMAGE / TAG / SITE_DOMAIN / ACME_EMAIL，不入库
deploy.log      deploy.sh 追加写入的部署记录
```

## 3. 部署

**正常路径**：push 到 `main` → GitHub Actions 构建 → 推 ACR → **scp 同步 `deploy.sh` 与 `compose.yml`** → SSH 执行 `deploy.sh <sha>`。

> 2026-10-18 补：同步步骤此前缺失，CI 实际一直在跑服务器上的旧脚本——仓库改了不生效，
> 等于部署逻辑不在版本控制里。现在这两个文件每次部署前从仓库覆盖到 `/opt/matrix-hub/`。

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
curl -s https://<域名>/healthz          # {"status":"ok","checks":{"electro":"ok"}}
docker compose -f /opt/matrix-hub/compose.yml logs -f --tail 100 web
docker stats --no-stream
```

日志走 stdout，由 Docker 轮转。**日志中不得出现密钥、token、请求体。**

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
| 运行数据（SQLite / 上传） | `app_data` 卷打包 | 每日 |
| 整机 | 云厂商快照 | 变更前手动 |

**SQLite 不能直接 `cp`。** WAL 模式下最新数据还在 `-wal` 文件里，热拷贝会得到
一个"少了最后几笔"的库，而且恢复时不会报错——这是最坏的一种备份。

正确做法（二选一）：

```bash
# 1) 容器内用 sqlite3 的在线备份（不需要停服，推荐）
docker exec matrix-hub python -c "import sqlite3;s=sqlite3.connect('/srv/app_data/electro.db');d=sqlite3.connect('/srv/app_data/electro.backup.db');s.backup(d);d.close()"

# 2) 停容器后连 -wal / -shm 一起打包
docker stop matrix-hub && tar czf app_data-$(date +%F).tgz -C /var/lib/docker/volumes/matrix-hub_app_data/_data .
```

备份产物必须加密（见私有仓备份规范），且**不要**把 `.env`、票据一起打进去。

恢复流程：停容器 → 解包覆盖 `app_data` 卷 → 起容器 → 校验 `/healthz` 与关键页面。

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
| 上传目录 `UPLOAD_DIR=/srv/app_data/uploads` | 上传资产落在 `app_data` 卷，重建容器不丢；**30 天清理未实现** |
| 依赖升级 | Pillow 13.0.0 / python-multipart 0.0.32 / numpy 2.2.1；升级前先跑 `pytest`，再验证线上上传与切图 |
| 部署变更门控 | 仅 `docs/**`、`*.md`、`.github/**` 的改动不重启生产；改代码仍会中断约 15–20 秒 |
| 镜像标签 | 一律用 commit SHA，禁止 `latest`；单镜像约 316MB（压缩后 80MB 量级），ACR 个人版保留不超过 3 个 |

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

实现是**进程内滑窗**（`apps/electro-assist/api/ratelimit.py`），前提是**单容器单 worker**。
重启即清零，这是刻意取舍：限流用于抬高滥用成本，精确计量走后续 SQLite `usage` 表。
**改成多 worker 或多实例后此机制失效**（各进程各记一份），必须换成 Caddy 层限流或 Redis。

IP 取自 `X-Forwarded-For` 的**最右一段**（由容器内 Caddy 追加）。若将来前置 CDN，需重新确认信任链。

### 10.3 回滚复查（2026-10-18 修复）

`deploy.sh` 的回滚复查原先探测 `http://127.0.0.1:8001/healthz`，但 8001 只在容器内监听、
宿主机不可达——**成功回滚也会打印"仍不健康"**。现统一走 `probe_health()`：
`curl --resolve ${SITE_DOMAIN}:443:127.0.0.1 https://.../healthz`，与部署后检查同口径。

## 11. 待补

- 每日备份定时任务（当前依赖云快照）
- 自动快照策略（轻量应用服务器不提供，需用 CI 定时调用 API 替代）
- 监控告警（`/healthz` 外部探测）
- **上传目录 30 天清理**（`app_data/uploads` 持续增长，当前 1.4MB 可忽略，P2 前必须做）
- 切图结果落 manifest（现每次 `/slice` 重算，既费 CPU 也无法回溯）
