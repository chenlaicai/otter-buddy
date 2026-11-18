#!/usr/bin/env bash
# TLS 证书一次性签发（阶段 6a）——Certbot webroot 模式（nginx 已装且 80 端口在听）
# 用法：在 ECS 上 sudo bash setup-tls.sh
set -euo pipefail

DOMAIN="otter.60.205.214.148.sslip.io"
WEBROOT="/var/www/certbot"

# 前置：80 端口的 server 块必须已就位（nginx-otter.conf 的第一个 server），否则 HTTP-01 挑战失败
if ! nginx -t 2>/dev/null; then
  echo "nginx config invalid — install nginx-otter.conf first" >&2
  exit 1
fi

mkdir -p "$WEBROOT"
systemctl reload nginx

if [ ! -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
  certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" --non-interactive --agree-tos --keep-until-expiring
else
  echo "certificate already exists at /etc/letsencrypt/live/${DOMAIN}/ — renewals handled by certbot.timer"
fi

echo "next: verify nginx-otter.conf 443 block certificate paths, then systemctl reload nginx"
