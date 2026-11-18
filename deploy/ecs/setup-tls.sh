#!/usr/bin/env bash
# TLS 证书一次性签发（阶段 6a）——Certbot webroot 模式。
# 用法：在 ECS 上 sudo bash setup-tls.sh
# 两阶段（避免 chicken-and-egg：443 块引用的证书签发前不存在，整配置装上 nginx -t 会挂）：
#   阶段一：仅装 80 段（HTTP→ACME）→ reload → certbot 签发
#   阶段二：装完整配置（80+443）→ reload
set -euo pipefail

DOMAIN="otter.60.205.214.148.sslip.io"
WEBROOT="/var/www/certbot"
CONF_DST="/etc/nginx/conf.d/otter-buddy.conf"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$WEBROOT"

if [ ! -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
  # 阶段一：80-only（ACME 挑战 + 重定向；无证书引用）
  cat > "$CONF_DST" <<EOF
server {
    server_name ${DOMAIN};
    listen 80;
    listen [::]:80;
    location /.well-known/acme-challenge/ { root ${WEBROOT}; }
    location / { return 301 https://\$host\$request_uri; }
}
EOF
  nginx -t && systemctl reload nginx
  certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" --non-interactive --agree-tos --keep-until-expiring
else
  echo "certificate already exists — skipping issuance"
fi

# 阶段二：完整配置（80 + 443 TLS）
cp "${SCRIPT_DIR}/nginx-otter.conf" "$CONF_DST"
nginx -t && systemctl reload nginx
echo "TLS ready: https://${DOMAIN}/"
