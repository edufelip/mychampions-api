#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
infra_directory="$(cd "$script_directory/.." && pwd)"
nginx_template="$infra_directory/nginx/mychampions-server.conf"
nginx_site="/etc/nginx/sites-available/mychampions-server"
nginx_enabled="/etc/nginx/sites-enabled/mychampions-server"
nginx_upstream_snippet="/etc/nginx/snippets/mychampions-server-upstream.conf"
active_slot_file="$infra_directory/.active_slot"
acme_site="/etc/nginx/sites-available/mychampions-server-acme"
acme_enabled="/etc/nginx/sites-enabled/mychampions-server-acme"
public_domain="${PUBLIC_DOMAIN:-}"
certbot_email="${CERTBOT_EMAIL:-}"
apply=false
acme_site_enabled=false
resume_existing_ingress=false

usage() {
  cat <<'USAGE'
Usage:
  PUBLIC_DOMAIN=api.example.com CERTBOT_EMAIL=ops@example.com \
    bash infra/scripts/bootstrap-public-ingress.sh [--apply]

Without --apply, the script only reports the planned first-ingress bootstrap.
USAGE
}

for argument in "$@"; do
  case "$argument" in
    --apply)
      apply=true
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $argument" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$public_domain" || ! "$public_domain" =~ ^[a-z0-9.-]+$ ]]; then
  echo "PUBLIC_DOMAIN must be a lower-case DNS name." >&2
  exit 1
fi

if [[ ! -f "$nginx_template" ]]; then
  echo "Missing Nginx template: $nginx_template" >&2
  exit 1
fi

if [[ "$apply" != true ]]; then
  cat <<DRY_RUN
Dry run only. No VM state will change.
Would bootstrap first public ingress for: $public_domain
Would require a healthy single blue/green slot, DNS resolving to this VM, and CERTBOT_EMAIL at apply time.
DRY_RUN
  exit 0
fi

if [[ $EUID -ne 0 ]]; then
  echo "Run this script as root on the VM." >&2
  exit 1
fi

for command in certbot curl docker getent nginx systemctl; do
  if ! command -v "$command" >/dev/null; then
    echo "Required command is unavailable: $command" >&2
    exit 1
  fi
done

existing_site=false
existing_certificate=false
if [[ -e "$nginx_site" || -e "$nginx_enabled" ]]; then
  existing_site=true
fi
if [[ -e "/etc/letsencrypt/live/$public_domain" ]]; then
  existing_certificate=true
fi

if [[ "$existing_site" == true && "$existing_certificate" == true ]]; then
  resume_existing_ingress=true
elif [[ "$existing_site" == true || "$existing_certificate" == true ]]; then
  echo "MyChampions ingress is only partially configured; inspect it before retrying." >&2
  exit 1
elif [[ -z "$certbot_email" || "$certbot_email" != *"@"* ]]; then
  echo "CERTBOT_EMAIL must be a valid contact email before certificate issuance." >&2
  exit 1
fi

blue_running="$(docker inspect --format '{{.State.Running}}' mychampions-server-blue 2>/dev/null || true)"
green_running="$(docker inspect --format '{{.State.Running}}' mychampions-server-green 2>/dev/null || true)"
blue_running="${blue_running:-false}"
green_running="${green_running:-false}"

case "$blue_running:$green_running" in
  true:false)
    active_slot="blue"
    active_port=3400
    ;;
  false:true)
    active_slot="green"
    active_port=3401
    ;;
  *)
    echo "Exactly one MyChampions server slot must be running before ingress bootstrap." >&2
    exit 1
    ;;
esac

if ! curl --fail --silent --show-error "http://127.0.0.1:${active_port}/health" >/dev/null; then
  echo "Active MyChampions slot failed loopback health: $active_slot." >&2
  exit 1
fi

vm_public_ip="$(curl -4fsS --connect-timeout 5 https://api.ipify.org)"
dns_addresses="$(getent ahostsv4 "$public_domain" | awk '{print $1}' | sort -u)"
if ! grep -Fxq "$vm_public_ip" <<<"$dns_addresses"; then
  echo "PUBLIC_DOMAIN does not resolve to this VM public IP: $vm_public_ip" >&2
  exit 1
fi

cleanup_acme_site() {
  local exit_code=$?
  if [[ "$acme_site_enabled" == true ]]; then
    rm -f "$acme_enabled" "$acme_site"
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx || true
    fi
  fi
  exit "$exit_code"
}
trap cleanup_acme_site EXIT

if [[ "$resume_existing_ingress" != true ]]; then
  cat >"$acme_site" <<ACME_SITE
server {
    listen 80;
    listen [::]:80;
    server_name $public_domain;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 404;
    }
}
ACME_SITE

  ln -sfn "$acme_site" "$acme_enabled"
  acme_site_enabled=true
  nginx -t
  systemctl reload nginx

  certbot certonly --webroot -w /var/www/html \
    --non-interactive --agree-tos --email "$certbot_email" \
    --keep-until-expiring -d "$public_domain"

  rm -f "$acme_enabled" "$acme_site"
  acme_site_enabled=false
fi

sed "s/__PUBLIC_DOMAIN__/$public_domain/g" "$nginx_template" >"$nginx_site"
ln -sfn "$nginx_site" "$nginx_enabled"
install -d -m 755 /etc/nginx/snippets
printf 'set $mychampions_server_upstream http://127.0.0.1:%s;\n' "$active_port" >"$nginx_upstream_snippet"
nginx -t
systemctl reload nginx

ingress_ready=false
for _ in $(seq 1 10); do
  if curl --fail --silent --show-error --resolve "${public_domain}:443:127.0.0.1" \
    "https://${public_domain}/health" >/dev/null; then
    ingress_ready=true
    break
  fi
  sleep 1
done

if [[ "$ingress_ready" != true ]]; then
  echo "TLS ingress health check failed for $public_domain." >&2
  exit 1
fi

printf '%s\n' "$active_slot" >"$active_slot_file"
trap - EXIT

printf 'MyChampions public ingress now routes %s through %s.\n' "$public_domain" "$active_slot"
