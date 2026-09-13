#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
infra_directory="$(cd "$script_directory/.." && pwd)"
nginx_template="$infra_directory/dev/nginx/mychampions-dev-server.conf"
nginx_site="/etc/nginx/sites-available/mychampions-dev-server"
nginx_enabled="/etc/nginx/sites-enabled/mychampions-dev-server"
acme_site="/etc/nginx/sites-available/mychampions-dev-server-acme"
acme_enabled="/etc/nginx/sites-enabled/mychampions-dev-server-acme"
public_domain="${PUBLIC_DOMAIN:-}"
certbot_email="${CERTBOT_EMAIL:-}"
apply=false

[[ "${1:---dry-run}" == "--dry-run" || "${1:-}" == "--apply" ]] || { echo "Usage: PUBLIC_DOMAIN=<dns> CERTBOT_EMAIL=<email> bash infra/scripts/bootstrap-dev-ingress.sh [--apply]" >&2; exit 2; }
[[ "${1:-}" != "--apply" ]] || apply=true
[[ -n "$public_domain" && "$public_domain" =~ ^[a-z0-9.-]+$ ]] || { echo "PUBLIC_DOMAIN must be a lower-case DNS name." >&2; exit 1; }
if [[ "$apply" != true ]]; then echo "Dry run only. Would create Dev-only TLS ingress for $public_domain on 127.0.0.1:3402."; exit 0; fi
[[ $EUID -eq 0 ]] || { echo "Run this script as root on the VM." >&2; exit 1; }
[[ -n "$certbot_email" && "$certbot_email" == *"@"* ]] || { echo "CERTBOT_EMAIL must be valid." >&2; exit 1; }
for command in certbot curl getent nginx systemctl; do command -v "$command" >/dev/null || { echo "Required command is unavailable: $command" >&2; exit 1; }; done
[[ -f "$nginx_template" ]] || { echo "Missing Nginx template: $nginx_template" >&2; exit 1; }
curl --fail --silent http://127.0.0.1:3402/health >/dev/null || { echo "Dev loopback health is required before ingress bootstrap." >&2; exit 1; }
vm_ip="$(curl -4fsS --connect-timeout 5 https://api.ipify.org)"
getent ahostsv4 "$public_domain" | awk '{print $1}' | sort -u | grep -Fxq "$vm_ip" || { echo "PUBLIC_DOMAIN does not resolve to this VM." >&2; exit 1; }

cleanup_acme() { rm -f "$acme_enabled" "$acme_site"; nginx -t >/dev/null 2>&1 && systemctl reload nginx || true; }
trap cleanup_acme EXIT
cat > "$acme_site" <<EOF
server { listen 80; listen [::]:80; server_name $public_domain; location /.well-known/acme-challenge/ { root /var/www/html; } location / { return 404; } }
EOF
ln -sfn "$acme_site" "$acme_enabled"
nginx -t && systemctl reload nginx
certbot certonly --webroot -w /var/www/html --non-interactive --agree-tos --email "$certbot_email" --keep-until-expiring -d "$public_domain"
cleanup_acme
trap - EXIT
sed "s/__PUBLIC_DOMAIN__/$public_domain/g" "$nginx_template" > "$nginx_site"
ln -sfn "$nginx_site" "$nginx_enabled"
nginx -t && systemctl reload nginx
curl --fail --silent --show-error --resolve "${public_domain}:443:127.0.0.1" "https://${public_domain}/health" >/dev/null
printf 'Dev ingress ready at https://%s.\n' "$public_domain"
