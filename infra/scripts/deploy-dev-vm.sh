#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
infra_directory="$(cd "$script_directory/.." && pwd)"
compose_file="$infra_directory/dev/docker-compose.vm.yml"
nginx_template="$infra_directory/dev/nginx/mychampions-dev-server.conf"
nginx_site="/etc/nginx/sites-available/mychampions-dev-server"
nginx_enabled="/etc/nginx/sites-enabled/mychampions-dev-server"
public_domain="${PUBLIC_DOMAIN:-}"
image_repository="${IMAGE_REPOSITORY:-}"
image_tag="${IMAGE_TAG:-}"
image_pull="${IMAGE_PULL:-false}"

[[ $EUID -eq 0 ]] || { echo "Run this script as root on the VM." >&2; exit 1; }
[[ -n "$public_domain" && "$public_domain" =~ ^[a-z0-9.-]+$ ]] || { echo "PUBLIC_DOMAIN must be a lower-case DNS name." >&2; exit 1; }
[[ -n "$image_repository" && -n "$image_tag" && "$image_tag" != "latest" && "$image_tag" != "main" ]] || { echo "Use an explicit immutable IMAGE_REPOSITORY and IMAGE_TAG." >&2; exit 1; }
[[ "$image_pull" == true || "$image_pull" == false ]] || { echo "IMAGE_PULL must be true or false." >&2; exit 1; }
[[ -f "$compose_file" && -f "$nginx_template" && -f /opt/mychampions-dev-server/shared/.env ]] || { echo "Missing Dev deployment prerequisite." >&2; exit 1; }
[[ -f "/etc/letsencrypt/live/$public_domain/fullchain.pem" ]] || { echo "Dev TLS certificate is required." >&2; exit 1; }
docker network inspect root_default >/dev/null
export IMAGE_REPOSITORY="$image_repository" IMAGE_TAG="$image_tag"
if [[ "$image_pull" == true ]]; then docker compose -f "$compose_file" pull migrate app; else docker image inspect "${image_repository}:${image_tag}" >/dev/null; fi
docker compose -f "$compose_file" run --rm migrate
docker compose -f "$compose_file" up -d app
for _ in $(seq 1 30); do curl --fail --silent http://127.0.0.1:3402/health >/dev/null && break; sleep 1; done
curl --fail --silent http://127.0.0.1:3402/health >/dev/null || { echo "Dev container failed loopback health." >&2; exit 1; }
sed "s/__PUBLIC_DOMAIN__/$public_domain/g" "$nginx_template" > "$nginx_site"
ln -sfn "$nginx_site" "$nginx_enabled"
nginx -t && systemctl reload nginx
curl --fail --silent --show-error --resolve "${public_domain}:443:127.0.0.1" "https://${public_domain}/health" >/dev/null
printf 'Dev server now routes https://%s from image %s:%s.\n' "$public_domain" "$image_repository" "$image_tag"
