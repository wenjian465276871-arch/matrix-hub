# 运维手册

> 版本 v2.2 · 状态：已确认 · 最后更新：2026-11-05
> 本文不含服务器地址、凭证与私有路径。补全信息的操作记录留在私有仓。
> v0.2 → v1.0（2026-10-20）：修正 §1「两个卷」与实际三条挂载不符；补 §11 待补项的现状；接口清单改指 `docs/API.md`。
> v1.0 → v1.1（2026-10-20）：新增 §12 发布草稿 CLI（`scripts/publish.py`），补上决策 #16 承诺的发布路径。
> v1.1 → v1.2（2026-10-21）：发布 CLI 已实测；Caddy 移除粒子死路由（显式 404）；记录页时间兼容修复已部署（详见私有仓验收记录）。
> v1.2 → v1.3（2026-10-21）：新增 §13 口令通道、§14 清理任务；`/healthz` 增加磁盘检查；切图独立限流；Caddy 移除无效 SSE 配置。
> v1.3 → v1.4（2026-10-21）：口令通道已在生产启用（值只在服务器 `.env`）；清理任务以**空跑 cron** 安装，日志落 `/opt/matrix-hub/cleanup.log`。
> v1.4 → v1.5（2026-10-31）：补 §16 样例刷新与 `[SAME]` 口径；新增 §17 密钥轮换演练；清理任务在生产真跑一次 `--apply`，cron 改每日 03:40。
> v1.5 → v1.6（2026-11-01）：新增 §18 当日上线与新接口；修正 §1 表数量（7 张业务表，迁移 v6）与 §2 备份份数口径（7+7=14 个文件）。
> v1.6 → v1.7（2026-11-03）：新增 §19 部署后 5xx 看门狗与工艺表；`/healthz` 增加 `http` 段（10 分钟滚动 5xx）；表数量 7 → 8，迁移 v6 → v7。
> v1.7 → v1.8（2026-11-03）：§19.3 改写为三道闸门——业务只读探针、`5xx ≥3 且 >1%`（取代"样本 ≥30"）、探针连续失败也回滚（零流量盲区）；探针抽到 `deploy/probe.sh` 以便本地验证。
> v1.8 → v1.9（2026-11-03）：新增 §5.0 访问日志落文件与 14 天保留（`roll_keep_for 336h`）；容器 stdout 只保留启动日志。
> v1.9 → v2.0（2026-11-04）：`/healthz` 增加 `scope=live|ready|electro|all`（readiness 失败 503，容器探针与部署闸门切到 `scope=ready`）；保留期增加"启动时 + 每日 03:40"应用内执行；备份目录/文件收紧到 700/600；新增 §19.5 迁移 v8（`jobs.source_type` + Guide 溯源字段）。
> v2.0 → v2.1（2026-11-04）：P2-8~12——工位贯通（迁移 **v9**：`jobs/processes.station` + `Guide.meta.station`）、故障原因权重、结论置信度与依据、全量注入 Provider（`KNOWLEDGE_PROVIDER=full`）、部署后 Top-3 自检闸门（`EVAL_MIN_TOP3`）。
> v2.1 → v2.2（2026-11-05）：快速检索的 `confidence` 对外改称**匹配度**（相似度非概率）；「置信度」只用于逐步诊断结论。契约字段名不变，仅文案与文档。

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
| `/srv/app_data/electro.db` | 业务库（guides/jobs/usage/sessions/records/diagnose_runs/diagnose_steps/processes，8 张 + 迁移表 v9），WAL 模式 |
| `/srv/app_data/uploads/` | 上传资产，每份一个目录（原图 + 切片 + meta.json） |
| `/srv/app_data/caddy/` | 证书与 ACME 账户状态 |

**权限**：API 进程 umask 为 077（`docker/supervisord.conf` 的 `umask=0077`，uvicorn 与
caddy 都继承），新建的库、WAL 与上传资产是 600/700。

> 2026-11-08 更正：这一行此前是**声明**，代码里没有任何地方设过 umask——线上实测
> `electro.db` 是 **644**。现在 umask 真的设了，但**存量文件不会自己变**，必须跑下面这条。

```bash
docker exec matrix-hub sh -c "chmod -R go-rwx /srv/app_data/uploads /srv/app_data/electro.db*"
```

> 同一个坑的第二半（2026-11-08）：数据卷里散落着 4 个 10-31 的手工 `.bak`（含访客文本、
> 权限 644），`cleanup.py` **不覆盖这类手工副本**——它只管库内数据与上传目录。
> 已删除；以后临时备份请放 `/opt/matrix-hub/backups`（700/600，有保留策略），别留在卷里。

**证书与数据库都在 app_data 卷里。** 重建容器不会丢；删卷才会。
`/healthz` 同时检查进程与数据库，`checks.db` 为 `error` 时返回 `status: degraded`。

**分级口径（2026-11-04 起）**：`/healthz` 支持 `scope`：

| scope | 检查项 | 失败时 |
|---|---|---|
| `live` | 仅进程 | 永远 200 |
| `ready` / `electro` | 进程 + DB + 磁盘 | **503**（容器探针与部署闸门用这个） |
| `all` | 再加 Caddy 端口 | **503** |
| 不带 scope | 原三项 + budget + http 窗口 | 永远 200（uptime 读预算用，不能改成 503） |

容器 `HEALTHCHECK`、`compose.yml` 与 `deploy/probe.sh` 已统一到 `?scope=ready`：
只探状态码，才能把"库挂了但进程还在"判成不健康。

## 2. 部署目录

服务器上 `/opt/matrix-hub/`：

```
compose.yml            由仓库同步，不手改
deploy.sh              由仓库同步（部署 + 健康检查 + 业务探针）
probe.sh               由仓库同步（健康/业务只读探针，被 deploy.sh source）
postdeploy_watch.sh    由仓库同步（部署后 10 分钟 5xx 观察，可自动回滚）
backup.sh              由仓库同步（每日备份脚本）
.env            600，含 IMAGE / TAG / SITE_DOMAIN / ACME_EMAIL / DEEPSEEK_API_KEY，不入库
backup.env      600，部署级配置（当前只有 BACKUP_COS_BUCKET），不入库
deploy.log             deploy.sh / 看门狗追加写入的部署与回滚记录
watch.log              看门狗观察日志（每轮一行，10 分钟后自结束）
.incoming/             CI 暂存目录（原子 mv 前落盘，避免覆盖运行中的脚本）
backups/               SQLite + uploads 备份（卷外，各保留 7 份 ⇒ 14 个文件）
```

### 2.1 新实例重建清单（2026-11-08 补，对应评审 P3-3）

换机器时按这七步走，每步都有判据；顺序不能乱（备份依赖 coscli 与凭据）。

| # | 做什么 | 判据 |
|---|---|---|
| 1 | 装 Docker + compose 插件 | `docker compose version` 有输出 |
| 2 | 建目录与权限 | `install -d -o 10001 -g 10001 -m 700 /opt/matrix-hub/backups && ls -ld` 显示 `drwx------ 10001` |
| 3 | 写 `.env`（600）：`IMAGE` / `TAG` / `SITE_DOMAIN` / `ACME_EMAIL` / `DEEPSEEK_API_KEY` | `docker compose -f compose.yml config` 不报缺变量 |
| 4 | 写 `backup.env`（600）：`BACKUP_COS_BUCKET=ai2work-backup-1392959507` | `sudo bash -c '. /opt/matrix-hub/backup.env && echo $BACKUP_COS_BUCKET'` 有值 |
| 5 | 装 `coscli` **并校验**（§7.6.1），配 `/root/.cos.yaml`（600） | `coscli --version` = v1.0.9；`sha256sum /usr/local/bin/coscli` 与 §7.6.1 的表一致 |
| 6 | 装两条 cron：`17 3 * * *` 备份、`40 3 * * *` 清理（§14） | `crontab -l \| grep -c matrix-hub` = 2 |
| 7 | 首次验收 | `deploy.sh <sha>` 通过 → `/healthz?scope=ready` 三项 ok → `backup.sh` 末行 `cos=uploaded … files=2` → 站点生成一份草稿 |

> 前三步漏了会立刻报错（容器起不来）；**第 4–6 步漏了不会报错**——备份会一直打印
> `cos=skipped` 而没人发现。这是重建时最容易静默降级的地方，验收必须看第 7 步的
> `cos=uploaded`，不能只看「脚本跑完了」。

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
4. 健康检查：连续 3 次通过（每次间隔 5s，经 Caddy 443 检查 `/healthz?scope=ready`）
5. 业务只读探针：列表 / 详情 / 知识库三个真实 GET（`deploy/probe.sh`）
6. 知识库自检：`docker exec matrix-hub python -m scripts.eval_diagnose --quick --json`
   ——只跑检索、不调模型，约 50ms；Top-3 命中率低于 `EVAL_MIN_TOP3`（默认 0.8）
   或未覆盖识别不全，即判部署失败
7. 任一步失败 → 自动切回上一 TAG 并按同一口径复查；仍不健康则退出码 1

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
curl -s "https://<域名>/healthz?scope=ready"   # readiness：失败返回 503
curl -s https://<域名>/healthz                 # 完整报告：checks + budget + http 窗口
docker compose -f /opt/matrix-hub/compose.yml logs -f --tail 100 web
docker stats --no-stream
```

`checks.disk` 在剩余空间低于 `HEALTHZ_MIN_FREE_RATIO`（默认 0.10）时变 `error`，
整体 `status` 随之 `degraded`，部署脚本按 `status` 判回滚。**取不到磁盘信息同样算 error**：
看不见容量就不再是"健康"。**日志中不得出现密钥、token、请求体。**

### 5.0 访问日志与保留期（2026-11-03 改）

**访问日志不再走 stdout**，改为 Caddy 直接写文件：

```
/srv/app_data/logs/access.log            # 当前文件
/srv/app_data/logs/access-*.log.gz       # 滚动后的历史（gzip）
```

- 滚动：单文件 **2MiB**，保留 20 个文件、**14 天**（`roll_keep_for 336h`，按天向上取整）
- 磁盘上限约 **42MiB**（2MiB × 21）；时间删除只在**滚动时**生效，这是 lumberjack 的固有行为
- **2026-11-08 修**：`roll_size` 10MiB → 2MiB。实测流量约 1.3MB/天，10MiB 要 8 天才滚一次，
  滚出的文件再留 14 天，寿命可达 22 天；零流量站点则永远不滚，"14 天"等于不存在。
  改 2MiB 后约 1.5 天滚一次，寿命收敛到 ~15 天
- **零流量兜底**：`services/retention.py` 的 `prune_logs()` 每天随 03:40 清理跑一次——
  删除超过 14 天的 `access-*.log` / `.log.gz`；当前 `access.log` **只在 mtime 也超过 14 天时**才清空
  （mtime 证明这段时间没有任何写入，文件里不可能有保留期内的记录）。用截断不用 unlink：
  Caddy 持有该 fd，删掉会让后续写入落到已 unlink 的 inode 上，日志静默消失
- **线上实证（2026-11-08）**：部署瞬间把 6.6MB 的旧文件滚成
  `access-2026-11-08T07-44-20.024.log.gz`（251KB）；再造一个 20 天前的 `.log.gz` 跑
  `prune_logs()` → `{"rotated": 1}`，假文件被删、真实文件保留、当前文件未动
- 改动原因：原先 stdout + Docker `10MB×3` 的保留时长由流量决定，流量一涨就从"几个月"
  变成"几天"，"14 天"只是碰巧成立

```bash
docker exec matrix-hub tail -n 50 /srv/app_data/logs/access.log
docker exec matrix-hub sh -c 'ls -lh /srv/app_data/logs | tail'
```

日志在 `app_data` 卷内，**不进每日备份**（`backup.sh` 只备 DB 与 uploads），容器重建不丢。
容器自身 stdout **只有启动日志与 traceback**：uvicorn 用 `--no-access-log` 关掉了自己的
访问日志（2026-11-08 修，此前每条请求写两遍，`/healthz` 每 30 秒一次把 docker logs 刷满）。
`json-file` 10MB×3 只是兜底（计划 §9.4 #5）。

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
| 跨云副本 | `deploy/backup.sh` 上传到腾讯云 COS（§7.6） | 每日 03:17（同上） |

**SQLite 不能直接 `cp`。** WAL 模式下最新数据还在 `-wal` 文件里，热拷贝会得到
一个"少了最后几笔"的库，而且恢复时不会报错——这是最坏的一种备份。

`backup.sh` 的做法：容器内 `sqlite3.Connection.backup()` 在线热备 →
写到 `/srv/backups`（绑定到宿主机 `/opt/matrix-hub/backups`）→ `PRAGMA integrity_check`
→ 再把 `app_data/uploads` 打成 `uploads-*.tar.gz`（tar 必须在容器内执行，
宿主机看不到卷内路径）→ 两类各保留最近 7 份。备份在卷外，卷损坏时仍然可用。

> **轮转顺序（2026-11-08 修 P3-2）**：`backup.sh` 把本地 prune 放在**所有上传之后**。
> 原先是容器里做完就删，一旦随后 COS 上传失败（网络/凭据/额度），被删的旧份已经回不来，
> 而失败的恰恰是"异地那一层"。现在上传没走完就在 `set -e` 处退出，本地新旧全留，
> 下一次成功的运行再补做轮转。判据：手动让 `coscli` 失败时，`/opt/matrix-hub/backups`
> 的文件数**不减反增**，日志停在 `[FAIL]` 之前。
>
> **2026-11-08 00:43–00:48 生产实测**：正常跑 → `rotated db_kept=7 uploads_kept=7`（14 个文件）；
> 再用 `sudo env PATH=/usr/bin:/bin` 让 `coscli` 不可见 → `[FAIL] coscli 未安装`、`exit=1`、
> **没有 `轮转` 那一行**；随后清点 **16 个文件（db 8 + uploads 8）** —— 旧份一份没删，
> 多出来的是这次失败运行的新备份。次日 03:17 的正常运行会自动轮转回 7+7。

**权限**：备份目录为 700，`.db` 与 `.tar.gz` 均为 600（计划 §11.3.3 的
"加密或至少 root-only 600"，这里取后者）。脚本每次运行会把历史备份一并收紧：

```bash
docker exec matrix-hub sh -c "chmod 700 /srv/backups && chmod 600 /srv/backups/*.db /srv/backups/*.tar.gz"
```

> 2026-10-22 起备份包含上传目录。此前只备份 db：恢复后指导书在、图片全丢，
> 而图片是视觉原语与切图的输入，等于半个产品没了。

### 7.5 异地副本（2026-11-07）

本地备份挡不住"整台机器没了"。在 cron 环境里给一个第二位置即可：

```bash
BACKUP_OFFSITE_DIR=/mnt/nas/matrix-hub-backups   # 或任意挂载点
```

- 设置了就复制 `electro-*.db` 与 `uploads-*.tar.gz`，并**逐字节比对大小**，不一致退出 1；
- 没设置就打印 `offsite=skipped`——"跑完了"不等于"有异地副本"，不静默通过；
- 轮转与本地同口径（`KEEP`，默认 7），只清理这两类文件，不碰目录里的其他东西；
- **云对象存储**：脚本不碰凭证。把 OSS 挂到本机，或让 `rclone sync "$BACKUP_OFFSITE_DIR" oss:…`
  定时同步（AK 写 rclone.conf，权限 600）。手册不记录任何密钥。

验证（本机已用真实脚本块跑过：复制、比对、KEEP=3 轮转均通过）：

```bash
BACKUP_OFFSITE_DIR=/tmp/offsite ./backup.sh
# 末行应出现：offsite=copied dir=/tmp/offsite files=2 keep=7
```

> **未完成的部分**：生产上的第二位置（NAS 或 OSS）需要你提供路径/AK，脚本侧已就绪。

### 7.6 跨云副本：腾讯云 COS（2026-11-07 上线）

跨云这一层才是真正挡"阿里云整台机器没了"的。用腾讯云官方 CLI `coscli`，凭据放
`/root/.cos.yaml`（600），**脚本只读配置，不碰任何密钥**。

配置写在 `/opt/matrix-hub/backup.env`（600，脚本启动时 source），不动 cron 行：

```bash
BACKUP_COS_BUCKET=ai2work-backup-1392959507
```

- 桶：`ai2work-backup-1392959507`（广州 / **单 AZ** / **私有读写** / SSE-COS 加密）；
- 子用户 `ai2work-backup`：只有编程访问，策略 `ai2work-cos-backup` 限定这一个桶；
- 上传 `electro-*.db` 与 `uploads-*.tar.gz`，**失败即非零退出**，cron 日志里直接红；
- 没配 `BACKUP_COS_BUCKET` 就打印 `cos=skipped`，不静默通过。

**为什么不列举桶**：子用户只授了对象级权限，`coscli ls` 会 403（2026-11-07 实测）。
备份文件名由 `STAMP` 唯一确定，上传与删除都不需要列举，所以这不是缺陷。
代价是**远端不做轮转**——桶上挂一条生命周期规则（30 天过期）即可；没挂就是一直
累积，约 2.5MB/天（50GB 资源包够用几十年）。

验证（2026-11-07 23:15 生产实跑，全链路闭环）：

| 环节 | 结果 |
|---|---|
| 上传 | `electro-20261107-2315.db` **307,200 B** + `uploads-…tar.gz` **2,250,399 B**，末行 `cos=uploaded … files=2` |
| 回读 | `coscli cp` 下载该 db 到 `/tmp/v.db`，**307,200 B**（大小一致，不是 0） |
| 恢复校验 | `PRAGMA integrity_check` = `ok`；`guides 14 / sessions 17 / records 62` |

**最后那条 `guides=14` 是判据的核心**：空库同样能返回 `integrity: ok`，
2026-11-07 第一次验证就栽在这里——下载失败后 `sqlite3.connect()` 顺手建了个空库，
三个错误叠出一片假绿。验备份必须查**表的行数**，不能只看 integrity。

### 7.6.1 coscli 安装与升级（固定版本 + 校验）

`coscli` 是**以 root 运行的外部二进制**，和基础镜像一样必须有校验，否则等于把一个不受控的可执行文件放进 root 的 PATH（阶段评审 2026-11-08 的 P2-1）。

当前锁定：**v1.0.9**（2026-08-25 发布）

| 项 | 值 |
|---|---|
| 下载 | `https://github.com/tencentyun/coscli/releases/download/v1.0.9/coscli-v1.0.9-linux-amd64` |
| 官方校验清单 | 同 release 的 `sha256sum.log` |
| SHA256 | `a07de5ba2800147a700ed29036b0c76a4229088cee68e1682d0eae19b638a915` |
| 安装位置 | `/usr/local/bin/coscli`（755，root） |

安装/升级一律走「下载 → 校验 → 原子替换」，**不要**直接 `curl -o /usr/local/bin/`：

```bash
cd /tmp
# 用官方文件名下载，才能让 sha256sum -c 直接对上清单里的条目
curl -fSLO https://github.com/tencentyun/coscli/releases/download/v1.0.9/coscli-v1.0.9-linux-amd64
curl -fsSLO https://github.com/tencentyun/coscli/releases/download/v1.0.9/sha256sum.log
sha256sum -c sha256sum.log --ignore-missing     # 期望：coscli-v1.0.9-linux-amd64: OK
```

校验通过后再替换（原子 `mv`，避免 cron 正在调用时文件被截断）：

```bash
install -m 755 coscli-v1.0.9-linux-amd64 /usr/local/bin/coscli.new
mv /usr/local/bin/coscli.new /usr/local/bin/coscli
coscli --version                                 # 期望：v1.0.9
rm -f /tmp/coscli-v1.0.9-linux-amd64 /tmp/sha256sum.log
```

`--ignore-missing` 是必要的：清单里还有 darwin / windows / arm 等 8 个平台，没下载的条目会被跳过而不是报错。

**升级规则**：先改本节的三行（版本号、URL、SHA256），再按上面步骤执行；版本号与哈希必须同时改，只改一个等于没校验。

**为什么不用官方安装脚本**：coscli 没有提供带签名的安装器，curl 管道执行（`curl … | sh`）比"下载后校验再装"更难审计。

### 7.6.2 备份 cron（首次安装）

首次安装（只需一次）：```bash
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

### 7.6.3 桶侧生命周期规则（2026-11-08 配置，脚本管不到）

**这一项不在任何脚本里，只在腾讯云控制台**——重建实例、换桶、换账号之后如果忘了配，**不会报任何错**，只会让远端对象无限累积（约 2.5MB/天，一年约 900MB）。写在这里，因为它和 `backup.env`（§2.1 重建清单第 4–6 步）是同一类"漏了不报错"的配置。

| 项 | 值 |
|---|---|
| 桶 | `ai2work-backup-1392959507`（广州 / 私有 / SSE-COS） |
| 规则名称 | `backup-30d` |
| 应用范围 | 整个存储桶 |
| 规则内容 | 当前版本文件删除：**30 天**；碎片删除：**30 天** |
| 状态 | **开启** |
| 历史版本 | 关闭（桶没开版本控制，开了也没意义） |
| 沉降（低频/归档/深归档） | **都不开**。沉降只降单价、不让对象消失，解决不了"无限增长"；而且会多一层"先解冻再下载"的恢复路径 |

**生效口径**：配完**次日 00:00 起**对已有对象生效（控制台弹窗原文）；期龄满 30 天的首个删除动作发生在配置日 +30 天的凌晨。所以"配完当天看桶大小没变化"是正常的，别当成没生效。

**为什么是 30 天**：本地 `backup.sh` 保留 7 天（`KEEP`），远端留 30 天，这是"3-2-1"里"一份异地"的最短合理窗口——够你发现"本地备份连续几天是坏的但已经被轮转掉了"这类问题。

**怎么验**：只能控制台看「生命周期」页的规则列表（状态 / 规则名称 / 规则内容三列）。两条走不通的路记一下，省得下次白试：
- `coscli v1.0.9` **没有 lifecycle 子命令**（只有 `bucket-acl` / `bucket-encryption` / `bucket-policy` / `bucket-tagging` / `bucket-versioning`）；
- 子用户 `ai2work-backup` 只授了上传类权限，没有 `cos:GetBucketLifecycle`，API 查也是 403。

**配错怎么办**：列表页该行右侧有「编辑 / 删除」。删除规则本身不删对象；但**已经按规则删掉的对象无法恢复**——所以别把天数往小改（例如 1 天），那会在次日凌晨清掉最近 7 天的异地副本。

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
| 上传目录 `UPLOAD_DIR=/srv/app_data/uploads` | 上传资产落在 `app_data` 卷，重建容器不丢；30 天清理由 `scripts/cleanup.py` 负责，**应用启动时与每日 03:40 各执行一次**（cron 保留为冗余，不是唯一通道） |
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
`curl --resolve ${SITE_DOMAIN}:443:127.0.0.1 https://.../healthz?scope=ready`，与部署后检查同口径。

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

**写入增长**：每次作业约 4–8 条记录，单条 < 2KB。清理任务已上线（§14）：会话/记录/诊断 180 天、
任务与用量 90 天、访客草稿 30 天，每日 03:40 `--apply`。

**权限**：会话与记录凭随机 id 访问，无登录。不要往记录里写个人信息。

## 11. 待补

- 备份恢复演练常态化（每季度一次，脚本见 §7.4）
- 自动快照策略（轻量应用服务器不提供，需用 CI 定时调用 API 替代）
- 监控告警：**GitHub Actions 定时探活已加**（`.github/workflows/uptime.yml`，查 `/healthz`、页面与 guides；失败会以 workflow 失败通知）。**注意实际频次**：cron 写每 10 分钟，但 GitHub 调度实测日均约 2–8 次（10-22～10-30），最坏间隔可达数小时；它只是低成本兜底，需要分钟级告警请外接 UptimeRobot 一类服务
- 清理任务**已从空跑转真删**（§14，2026-10-31；cron 每日 03:40，先备份后删）
- 异地备份：**已上线跨云副本**（腾讯云 COS，见 §7.6；`BACKUP_COS_BUCKET` 写在 `/opt/matrix-hub/backup.env`）。剩余小事：桶上挂 30 天生命周期规则（远端不做轮转，约 2.5MB/天累积）
- 切图结果落 manifest（现每次 `/slice` 重算，既费 CPU 也无法回溯；已加次数上限与限流）
- 多实例部署前替换进程内队列与限流（`services/jobqueue.py`、`core/ratelimit.py`、`services/sessions.py` 均假设单 worker）
- ~~**真实密钥轮换（需本人）**~~ **已执行（2026-11-07 23:31）**：四步全走完——发新 Key → 改 `/opt/matrix-hub/.env`（只换一行，`getpass` 交互输入）→ `--force-recreate` → 23:35 吊销旧 Key。验收用**真实生成**而非健康检查（`j_b806bcebcc28461d` succeeded，12s）。详见 §17.3。剩一件：`.env.bak-*` 于 11-14 后清理。
- ~~**GitHub secret scanning / push protection（需本人）**~~ **已确认（2026-11-07 23:50）**：仓库 `Settings → Advanced Security` 上 **Secret Protection 已启用**（按钮显示 `Disable` 即为开启），**Push protection 开关为 ON**；个人账号级 `Push protection for yourself` 亦为开启。**取证说明**：未鉴权 API 的 `security_and_analysis` 字段返回 `null`（需 admin token），所以只能由本人截图确认，无命令行证据。私有仓 `AI2Work` 不开——私有仓的 secret scanning 属 GitHub Advanced Security，需付费；要防的是公开仓。
- ~~**卸载 nginx（需本人，观察期早已结束）**~~ **已执行（2026-11-08 00:00）**：先 `ss -lntp` 确认 80/443 只有 `docker-proxy`、nginx 为 `inactive`+`disabled`，再 `apt-get purge -y nginx nginx-common nginx-core`。实际移除 **10 个包**（含 `python3-certbot-nginx` 与 6 个 `libnginx-mod-*`）。验证：`dpkg -l | grep -c nginx` = **0**、`/healthz?scope=ready` = 200、站点页 = 200。Caddy 证书在 `caddy_data` 卷内，不受影响；`/var/www/html` 因非空被 dpkg 保留，可日后手动清理
- **certbot.timer 保留（2026-11-08 记，计划 §9.4 #9 的偏差）**：计划写的是"stop+disable nginx/certbot，观察期后卸载"，nginx 已卸，但 `certbot.timer` 仍 `enabled`（每天 05:07 / 17:07 各跑一次）。尝试 `systemctl disable --now certbot.timer` 时被宿主安全策略拒绝（理由：关闭自动续期属于削弱安全维护机制），**未绕过**。实际影响为零——Caddy 用 `caddy_data` 卷里的自签 ACME 证书，`/etc/letsencrypt` 里那套已无人引用；它的续期即便失败也只写自己的日志。**结论：保留，不再尝试停用**；若将来要彻底清掉，需本人先在控制台确认没有其他站点依赖 Let's Encrypt 证书

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
- 不存在的 id 退出码为 1；数据未通过 Guide 校验时拒绝发布并打印原因；
- **发布前强制补齐（§12.4）**：每一步都必须有验收判据，否则退出码 **2** 并逐条列出
  （如 `s03「检查门机紧固件力矩」没有验收判据`）。草稿允许留空——原文没写就不编；
  但"已发布却没有验收标准"等于把判断责任推给现场。同一条闸门也拦 seed 与样例刷新：
  缺判据的样例不会以 published 进库，刷新已发布样例时会直接报错。

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

**2026-11-04 起，应用自己也执行清理**（计划 §11.3.3 的"应用启动时 + 每日"）：

- 启动后 3 秒在后台线程跑一次（`RETENTION_ON_START`，prod 默认开）；
- 每日 03:40 由 `services/retention.py` 调度（`RETENTION_ENABLED`，prod 默认开）。
- 时间取 **03:40 而不是计划原文的 03:00**：备份在 03:17，先备份后删不可倒置。
- cron 保留：进程整个挂掉时，它是最后一道冗余；两条通道都跑同一套 `cleanup` 逻辑，重复执行无害。

关闭某一项：`RETENTION_ENABLED=0` / `RETENTION_ON_START=0`；改时间：`RETENTION_AT=HH:MM`。

日志 `/opt/matrix-hub/cleanup.log`（600）。`--apply` 不可逆：要改窗口先跑一次 dry-run 看条数与样例。

> 清理是**不可逆**的。`--apply` 前先看一眼 dry-run 的条数与样例；输出里没有删除明细就说明没匹配到数据。

**重试实测（2026-11-08 01:09，端到端，非单测）**

单测早就覆盖了 `run_with_retry` 的四个分支，缺的是"真实进程里到底会不会重试"。做法：本地临时库 + 端口 8015 + `RETENTION_AT` 设为 1 分钟后 + `RETENTION_RETRY_S=1`，启动后把库文件截成 0 字节制造确定性失败。

| 观察点 | 实测 |
|---|---|
| 调度线程是否按时醒来 | 设 `01:09`，实际 `01:09:02` 触发 |
| 重试次数 | 日志出现 2 次「失败（第 N/3 次）**，1 秒后重试**」+ 1 次「连续失败 3 次，本轮放弃」= **3 次尝试** |
| 状态落盘 | `consecutive_failures: 3`、`last_error: "OperationalError: no such table: sessions"` |
| 恢复后 | `consecutive_failures: 0`、`last_success_at` 刷新 → **成功即清零** |

**定时分支已直接观测（2026-11-08 16:44）**

同镜像在容器内起一个**隔离进程**验证调度，不碰生产数据：`DB_PATH` 指向库副本、
`UPLOAD_DIR` 指向空目录、`RETENTION_STATE_PATH=/tmp/…`、`RETENTION_ENABLED=1`、
`RETENTION_ON_START=0`、`RETENTION_AT` 设为 1 分钟后。

| 观察点 | 实测 |
|---|---|
| 线程是否准点醒 | 设 `16:44`，状态文件时间戳就是 `16:44:00` |
| 写了哪个触发者 | `last_trigger: "scheduled"` |
| 定时字段 | `last_scheduled_run_at: "2026-11-08T16:44:00+08:00"` 出现 |

**生产 03:40 仍以 `/healthz?scope=all` 的 `retention.last_scheduled_run_at` 为准**：
`last_success_at` 每次容器重建都会被启动清理刷新，只有 `last_scheduled_run_at`
是"定时那次"的专属凭据（这也是 2026-11-08 加它的原因）。

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

**已执行（2026-11-07 23:31，本人操作，AI 逐步指导）**：

| 步 | 结果 |
|---|---|
| 备份 | `cp -p` 到 `.env.bak-*`（600） |
| 替换 | 只改 `DEEPSEEK_API_KEY` 一行；文件 397 B 不变；用 `getpass` 交互输入，**不进 shell 历史、不进进程参数** |
| 重建 | `Container matrix-hub Recreated`（1.2s） |
| 吊销旧凭据 | 23:35 控制台删除 |

**验收口径（重要）**：`/healthz?scope=ready` 三项全 ok **不足以**证明新凭据可用——健康检查不调模型，填错照样全绿。真正的判据是**跑一次真实生成**：
`POST /api/electro/generate` → `202` → 任务 `j_b806bcebcc28461d` → **succeeded**，12s，8,521 micros。
以后任何动 LLM 凭据的操作，验收都必须包含这一步。

遗留：`.env.bak-*` 保留作回滚路径，**2026-11-14 之后删除**。

### 17.4 边界（如实记录）

- **没有替换生产 Key**：读取/改写 `/opt/matrix-hub/.env` 里的密钥被宿主安全层拦下（判为敏感凭据访问），
  我没有绕过它，也没有把 Key 打印出来。所以"发新 Key → 替换 → 重启 → 验活 → 吊销旧 Key"这四步
  需要你在控制台操作时执行一次；上面的失败模式与回滚路径已经演练过。
- 演练证明的是**失败侧**：Key 错时站点不挂、错误可读、不计费、不泄露。

## 18. 2026-11-01 上线与新增运维口径

**上线**：`c026149`（CI 五作业全绿，部署约 2 分钟）。本次**无迁移、无 schema 变更、无新依赖**，
回滚到上一 TAG 即可，数据不受影响。

> 2026-11-01 02:26 追记：随后一次**纯结构/文档**提交 `6d070fa` 也已部署（CI run `41229091583`，五作业全绿），
> 功能等价于 `c026149`；容器内可见 `/opt/electro/scripts/_bootstrap.py` 与 `scripts/README.md`。

| 变更 | 运维影响 |
|---|---|
| `GET /guides` 支持 `limit`（默认 12，上限 50）/`offset`，返回 `total`/`has_more` | 旧客户端不带参数仍工作；`limit=0` 或 `>50` 返回 422 |
| 发布 CLI 增加判据闸门 | 缺验收判据的草稿**拒绝发布**，退出码 **2**（区别于失败 1）。cron/脚本若判 `!=0` 需区分这两种 |
| 生成等待 800ms 后才转骨架 | 纯前端，无接口变化 |
| 打印表头 `table-header-group` | 纯样式；记录页编号/时间仍只出现在首页页眉（已知限制，UI.md §7） |

**线上取证（2026-11-01 01:45–02:00）**：

```bash
curl -s https://<域名>/healthz          # status ok，budget.level ok
curl -s 'https://<域名>/api/electro/guides?limit=2&offset=2'   # total 5 / has_more true
curl -s 'https://<域名>/api/electro/guides?limit=0'            # 422
```

容器 `Up (healthy)`，镜像 tag `c026149…`；库 7 份指导书（published 5 + draft 2）、
sessions 16 / records 62 / diagnose_runs 15；磁盘 7.9G/40G（22%），容器 82MiB。

**日常检查顺序不变**：`/healthz` → `docker ps` → `deploy.log` 末三行 → `cleanup.log` 末三行。

## 19. 部署后 5xx 看门狗与工艺表（2026-11-03）

### 19.1 为什么健康检查不够

`deploy.sh` 的 3 次探测只回答"进程起没起来、库能不能打开"。一个起来了但每个业务请求都 502 的
版本（上游 Key 失效、迁移写坏、依赖缺包）能满分通过，用户看到的是整站不可用。计划 §9.4 #11
要求"10 分钟内 5xx >1% 即回滚"，此前只有前半句（探测）没有后半句（错误率）。

### 19.2 数据从哪来

应用进程内维护一个 10 分钟滚动窗口（`api/core/httpwindow.py`，每分钟一个桶）：

```bash
curl -s https://<域名>/healthz | python3 -m json.tool   # 或在容器内 curl 127.0.0.1:8001
# "http": {"window_s": 600, "requests": 42, "errors_5xx": 0, "ratio": 0.0}
```

口径三条：**4xx 不算错误**（参数写错不是服务坏了）；**`/healthz` 不计入**（探针会把真实
比例稀释一个数量级）；**进程重启清零**（只看"这一版跑起来之后"）。窗口不落库，不做历史趋势。

### 19.3 三道闸门：业务探针 → 5xx 统计 → 探针失效

**第一道：部署时的业务只读探针**（`deploy/probe.sh`，2026-11-03 新增）。
`healthz` 只证明"进程活着、库能开、磁盘没满"；迁移写坏、router 没注册、
SPA 回退吃掉接口路径，都能满分通过。所以健康检查之后立刻打三条真实用户路径：

| 探测 | 判据 |
|---|---|
| `GET /api/electro/guides?limit=1` | 响应以 `{` 开头且含 `"items": [` |
| `GET /api/electro/guides/{列表第一条 id}` | 响应以 `{` 开头且含 `"guide": {`（列表为空时跳过） |
| `GET /api/electro/diagnose/kb` | 响应以 `{` 开头且 `"count" >= 1` |

任一失败 → **立即回滚**，不等 10 分钟。不花配额、不调模型、不写库。
必须校验响应结构而不是只看状态码：Caddy 的 SPA 回退会把不存在的路径变成 200 HTML。

本地可直接验证（不需要发版）：

```bash
cd /opt/matrix-hub
SITE_DOMAIN=localhost PROBE_BASE_URL=http://127.0.0.1:8001 bash -c '. ./probe.sh; probe_business && echo PASS'
```

**第二道：10 分钟 5xx 统计**（`postdeploy_watch.sh`，健康检查通过后 `setsid` 后台跑，不阻塞 CI）。
判据是 **`5xx >= 3 条 且 比例 > 1%`**：

- 绝对数做主判据：演示站 10 分钟常常只有 3–5 个请求，`1/5 = 20%` 只是**一次**故障，
  不足以证明这一版更坏；`3/20` 才是模式。
- 比例做上限保护：`3/5000`（0.06%）不回滚，避免大流量下被零星错误触发。
- 依据：Google SRE Workbook 第 5 章低流量服务的处理，以及低流量告警实践里
  "比率必须配一个绝对下限"的共识。

**第三道：探针失效**（零流量盲区）。容器或 Caddy 挂了就没有请求，错误率恒为 0%，
统计永远绿。所以 `healthz` 连续 2 次不通（`WATCH_PROBE_FAIL_LIMIT`）也回滚，
`reason=probe_failed`。

统计触发与探针触发共用同一份 `do_rollback`：核对线上 tag（防止拿旧结论回滚新版本）→
`TAG=<prev> docker compose up -d web` → 6 次探测 → 探通则把 `.env` 的 `TAG` 一并改回
（否则下次手工 `up -d` 又会把坏版本拉起来）→ 往 `deploy.log` 写一条。

```bash
tail -50 /opt/matrix-hub/watch.log      # 观察过程（日志如实区分"无请求/少量 5xx/正常"）
tail -5  /opt/matrix-hub/deploy.log     # 回滚记录（reason=postdeploy_5xx | probe_failed）
./postdeploy_watch.sh --self-test       # 只验判定逻辑，不碰容器（8 个用例）
```

调参（一般不用改）：`WATCH_WINDOW_MIN` / `WATCH_INTERVAL_S` / `WATCH_MIN_ERRORS` /
`WATCH_5XX_PCT` / `WATCH_PROBE_FAIL_LIMIT`。

**连续部署（2026-11-03 实测补充）**：看门狗**不设互斥锁**。原先的 `.watch.lock`
在"10 分钟内发两版"时会让第二版一启动就撞锁退出——最该盯的那次反而没人看。
现在多实例共存是安全的：每轮回滚前都核对线上 tag，旧实例发现 tag 已变就自行退出。
另外，观察器脚本由 CI 用「暂存目录 + `mv`」原子替换：`scp` 直接覆盖同名文件会让
正在运行的实例读到半截内容，实测报 `unexpected EOF` 当场死掉。

**边界（如实记录）**：窗口在进程内，容器重启即清空，只覆盖"部署后 10 分钟"，不是长期监控；
窗口内没有真实请求时不做统计判定（探针仍在看）。长期可用性靠 `uptime.yml` 的外部探活，
但它受 GitHub 调度限制（实测日均 2–8 次，不是每 10 分钟）。

### 19.4 工艺表（迁移 v7）

`processes` 存生成输入的原文与派生标题，供详情页「再生成一份草稿」使用。
`jobs.process_id` / `guides.process_id` 记录来源，DB 索引 `idx_guides_process` 供清理判引用。

- 保留期 30 天（与访客草稿一致），**写时顺带清理**：`create_process` 在同一事务里删除
  过期且没有指导书引用的行。没有新增 cron——一个必须记得配的定时任务是运维负债。
- `POST /processes` 默认仍是纯预检（`save=false`），行为不变；`save=true` 才落库。
- `POST /processes/{id}/generate` 与 `/generate` 共用配额、预算与队列：换入口不是换额度。

**回滚影响**：迁移只加表加列，旧版本代码不认识新列也能跑（SQLite 的 `SELECT *` 多列无害），
但**回滚到 v6 之前的镜像不会删除 `processes` 表**；数据保留，属预期。

### 19.5 输入形态、工位与溯源（迁移 v8/v9，2026-11-04）

`jobs.source_type TEXT NOT NULL DEFAULT 'text'`（`text` / `image`）：worker 只拿 job_id，
输入形态必须随任务落库，否则重启续跑会丢；存量任务与"用工艺重新生成"默认 text。

`jobs.station` / `processes.station`（迁移 v9）：预检解析出的工位此前只回给前端，
落库即丢；现在随 job 写进 `Guide.meta.station`，"用同一份工艺重新生成"也能复用。

Guide 契约同步增加（均可选，旧数据无需迁移）：

| 字段 | 位置 | 说明 |
|---|---|---|
| `meta.source_type` | Guide | `text` / `image`，服务端按 job 写入，模型不得填 |
| `meta.station` | Guide | 工位，预检/人工给；空值不落盘 |
| `step.provenance` | Step | `asset_id / line / bbox / raw_text / flag`；**要求 `action` 逐字来自原文**才填，不做数值回退 |
| `criterion.provenance` | Criterion | 同上，精度到判据；按标签整句（ok）→ 同一行数值（suspect）→ 不填 |

`provenance` 由识别链路/受信生产者填写，**不在给模型看的 schema 里**（模型没有读图能力，
让它输出 bbox 就是让它编坐标）。当前图片路径是"识别 → 回填文本 → 生成"，

> **2026-11-08 更新**：字段级回填已接入（`services/provenance.py`，生成落库前执行），
> 上一句"尚未接入"作废。线上 11 份指导书里 22 条判据带 provenance。
> 同批把 `Provenance.confidence` 标为**废弃**：不再写出（`exclude=True`），但仍读得懂
> 存量 JSON——库里 5 份指导书写着 `"confidence": null`，直接删字段会让它们在
> A1 开始 / 编辑 / 发布时解析失败（`extra="forbid"`）。`bbox` 保留但恒为 null
> （无视觉服务返回坐标），等真接上 OCR 再说。

**回填命中率（2026-11-08 实测，用线上 6 份有工艺原文的指导书离线重跑）**：

| 粒度 | 命中 | 说明 |
|---|---|---|
| 判据 | **22 / 44（50.0%）** | 补不上的多是 `manual` 与概括语（"作业区域通风良好并设警示"原文没有逐字对应句），以及模型改写过的标签 |
| 步骤 | **5 / 28（17.9%）** | 动作几乎总被改写成"标题+说明"，逐字保留才填。**改写的不填是设计**——指错行比指不回去危险 |

样本小（6 份），但结论稳定：命中率取决于模型"照抄"的程度，不取决于定位算法本身。

**回滚影响**：旧镜像不认识 `jobs.source_type` / `station` 列，读写不受影响；
`meta.source_type` 与 `meta.station` 在 JSON 里，但 **text 来源与空工位不落这两个字段**
（`exclude_if`），旧镜像仍能读取；只有 **image 来源或带工位**的草稿会被旧版本的
`extra="forbid"` 拒绝——回滚前确认这批草稿不需要读取。

### 19.6 检索口径与部署自检（2026-11-04）

- **原因权重**：`likely_causes` 接受 `["原因A", …]` 或 `[{"text":"…","weight":0.8}, …]`。
  旧知识库无需改：字符串按人工顺序补默认权重（1.0 / 0.75 / 0.5 / 0.25，最低 0.2）。
- **匹配度与置信度**：快速检索每条命中带 `confidence` 字段，但**页面文案是「匹配度」**——
  `score/10` 的相似度，不是概率；命名为"置信度"会让正确命中显示成 47%，现场误判为不可靠。
  逐步诊断的结论才叫「置信度」：`confidence`（按证据强度：实测超差 0.85–0.95、
  人工确认 0.7–0.8、未定位 0.4、中止 0）与 `basis`（检查项、期望、现场值、来源）。
- **Provider 切换**：`KNOWLEDGE_PROVIDER=hybrid`（默认）/ `keyword` / `full`。
  `full` 把小知识库全部条目送进重排 prompt，仅用于对比；超过 20 条自动回退 hybrid。
- **部署自检**：`scripts/eval_diagnose.py --quick --json` 不调模型（约 50ms），
  Top-3 命中率与未覆盖识别都过才算部署成功；门槛由 `EVAL_MIN_TOP3` 控制。
