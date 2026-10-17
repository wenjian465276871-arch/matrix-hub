# syntax=docker/dockerfile:1
# P0 骨架镜像：Caddy（唯一入口）+ electro API + 静态站点
# 构建只在 CI 发生；服务器只拉成品镜像

# ---- Caddy 二进制来源（正式构建时改为按 digest 固定）----
FROM caddy:2.8-alpine AS caddy-bin

# ---- 运行镜像 ----
FROM python:3.12-slim

ARG APP_UID=10001
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    APP_ENV=prod \
    XDG_DATA_HOME=/srv/app_data/caddy \
    XDG_CONFIG_HOME=/srv/app_data/caddy \
    UPLOAD_DIR=/srv/app_data/uploads

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      supervisor curl ca-certificates tzdata libcap2-bin \
 && rm -rf /var/lib/apt/lists/* \
 && ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime

COPY --from=caddy-bin /usr/bin/caddy /usr/bin/caddy

WORKDIR /opt/electro
COPY apps/electro-assist/api/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY apps/electro-assist/api/ ./

COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY docker/supervisord.conf /etc/supervisor/supervisord.conf

COPY apps/portal/public /srv/static/portal
COPY apps/electro-assist/web /srv/static/electro

RUN groupadd -g ${APP_UID} app \
 && useradd -u ${APP_UID} -g app -m -s /usr/sbin/nologin app \
 && mkdir -p /srv/app_data /var/log/supervisor \
 && chown -R app:app /srv /opt/electro /var/log/supervisor \
 && setcap 'cap_net_bind_service=+ep' /usr/bin/caddy

USER app

EXPOSE 80 443

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8001/healthz || exit 1

CMD ["supervisord", "-c", "/etc/supervisor/supervisord.conf", "-n"]
