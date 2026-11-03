#!/bin/sh
# Generates nginx include files from environment variables.
set -eu
out=/etc/nginx/generated
mkdir -p "$out"

: "${ADMIN_ALLOW_CIDRS:=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,::1/128,fc00::/7,100.64.0.0/10}"
: > "$out/admin-allow.conf"
echo "$ADMIN_ALLOW_CIDRS" | tr ',' '\n' | while read -r c; do
  [ -n "$c" ] && echo "$c 1;" >> "$out/admin-allow.conf"
done

: > "$out/real-ip.conf"
if [ -n "${EDGE_TRUSTED_PROXIES:-}" ]; then
  echo "$EDGE_TRUSTED_PROXIES" | tr ',' '\n' | while read -r c; do
    [ -n "$c" ] && echo "set_real_ip_from $c;" >> "$out/real-ip.conf"
  done
  echo "real_ip_header X-Forwarded-For; real_ip_recursive on;" >> "$out/real-ip.conf"
fi

: > "$out/tls.conf"
if [ -f /etc/nginx/tls/fullchain.pem ] && [ -f /etc/nginx/tls/privkey.pem ]; then
  cat > "$out/tls.conf" <<CONF
listen 8443 ssl;
http2 on;
ssl_certificate /etc/nginx/tls/fullchain.pem;
ssl_certificate_key /etc/nginx/tls/privkey.pem;
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
add_header Strict-Transport-Security "max-age=31536000" always;
CONF
fi
mkdir -p /usr/share/nginx/empty 2>/dev/null || true
