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

- `matrix-hub_app_data` → `/srv/app_data`（SQLite、Caddy 证书与状态）
- `matrix-hub_caddy_data` → `/data`（预留）

**证书存在 app_data 卷里。** 重建容器不会重新签发；删卷才会。

## 2. 部署目录

服务器上 `/opt/matrix-hub/`：

```
compose.yml     由仓库同步，不手改
deploy.sh       由仓库同步
.env            600，含 IMAGE / TAG / SITE_DOMAIN / ACME_EMAIL，不入库
deploy.log      deploy.sh 追加写入的部署记录
```

## 3. 部署

**正常路径**：push 到 `main` → GitHub Actions 构建 → 推 ACR → SSH 执行 `deploy.sh <sha>`。

**手动路径**（CI 不可用时）：

```bash
cd /opt/matrix-hub
./deploy.sh <git-sha>
```

`deploy.sh` 的行为：

1. 记录当前 TAG
2. `docker compose pull web`
3. 用新 TAG 启动
4. 健康检查：连续 3 次通过（每次间隔 5s，检查 `/healthz` 与站点首页）
5. 失败 → 自动切回上一 TAG 并复查；仍不健康则退出码 1

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

恢复流程：停容器 → 解包覆盖 `app_data` 卷 → 起容器 → 校验 `/healthz` 与关键页面。

## 8. 事故处置

| 现象 | 首查 | 处置 |
|---|---|---|
| 站点 502/504 | `docker ps` 是否 healthy | 重启容器；仍失败则回滚 TAG |
| 证书错误 | 80 端口是否可达 | 检查端口占用与 DNS |
| 磁盘告警 | `df -h`、`docker system df` | `docker image prune`，清理旧日志 |
| 内存告警 | `docker stats` | 单实例约 70–300MB；超 800MB 说明有泄漏 |
| 误部署 | `deploy.log` 的 prev_tag | 按第 4 节回滚 |

## 9. 待补

- 每日备份定时任务（当前依赖云快照）
- 自动快照策略（轻量应用服务器不提供，需用 CI 定时调用 API 替代）
- 监控告警（`/healthz` 外部探测）
