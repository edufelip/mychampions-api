#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
infra_directory="$(cd "$script_directory/.." && pwd)"
app_directory="$(cd "$infra_directory/.." && pwd)"
compose_file="$infra_directory/docker-compose.vm.yml"
env_file="$infra_directory/.env"
gcs_credentials_file="$infra_directory/secrets/mychampions-gcs-service-account.json"
nginx_template="$infra_directory/nginx/mychampions-server.conf"
nginx_site="/etc/nginx/sites-available/mychampions-server"
nginx_enabled="/etc/nginx/sites-enabled/mychampions-server"
nginx_upstream_snippet="/etc/nginx/snippets/mychampions-server-upstream.conf"
active_slot_file="$infra_directory/.active_slot"
public_domain="${PUBLIC_DOMAIN:-}"
image_repository="${IMAGE_REPOSITORY:-}"
image_tag="${IMAGE_TAG:-}"
image_pull="${IMAGE_PULL:-true}"

if [[ -z "$public_domain" || ! "$public_domain" =~ ^[a-z0-9.-]+$ ]]; then
  echo "PUBLIC_DOMAIN must be a lower-case DNS name." >&2
  exit 1
fi

if [[ -z "$image_repository" || -z "$image_tag" ]]; then
  echo "IMAGE_REPOSITORY and IMAGE_TAG must be explicitly set for a production cutover." >&2
  exit 1
fi

if [[ "$image_tag" == "main" || "$image_tag" == "latest" ]]; then
  echo "IMAGE_TAG must be an immutable image tag, not $image_tag." >&2
  exit 1
fi

if [[ "$image_pull" != "true" && "$image_pull" != "false" ]]; then
  echo "IMAGE_PULL must be true or false." >&2
  exit 1
fi

for required_file in "$compose_file" "$env_file" "$gcs_credentials_file" "$nginx_template"; do
  if [[ ! -f "$required_file" ]]; then
    echo "Missing deployment prerequisite: $required_file" >&2
    exit 1
  fi
done

read_configured_env_value() {
  local key="$1"
  awk -v key="$key" '
    index($0, key "=") == 1 {
      value = substr($0, length(key) + 2)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      first = substr(value, 1, 1)
      last = substr(value, length(value), 1)
      if (length(value) >= 2 && ((first == "\"" && last == "\"") || (first == "\047" && last == "\047"))) {
        value = substr(value, 2, length(value) - 2)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      }
      result = value
    }
    END { print result }
  ' "$env_file"
}

if [[ -z "$(read_configured_env_value AUTH_JWT_PRIVATE_JWK)" ]] ||
  [[ -z "$(read_configured_env_value GCS_BUCKET)" ]]; then
  echo "The runtime env file must contain configured AUTH_JWT_PRIVATE_JWK and GCS_BUCKET values." >&2
  exit 1
fi

for revenuecat_runtime_key in \
  REVENUECAT_SECRET_API_KEY \
  REVENUECAT_WEBHOOK_AUTHORIZATION \
  REVENUECAT_WEBHOOK_SIGNING_SECRET; do
  revenuecat_runtime_value="$(read_configured_env_value "$revenuecat_runtime_key")"
  if [[ -z "$revenuecat_runtime_value" ]]; then
    echo "The runtime env file must contain a configured ${revenuecat_runtime_key} value." >&2
    exit 1
  fi
  if [[ "$revenuecat_runtime_key" == "REVENUECAT_SECRET_API_KEY" &&
    "$revenuecat_runtime_value" != sk_* ]]; then
    echo "REVENUECAT_SECRET_API_KEY must be a server-only sk_* key before production cutover." >&2
    exit 1
  fi
done

if [[ ! -f "/etc/letsencrypt/live/$public_domain/fullchain.pem" || ! -f "/etc/letsencrypt/live/$public_domain/privkey.pem" ]]; then
  echo "TLS certificates for $public_domain are required before ingress cutover." >&2
  exit 1
fi

if ! getent ahosts "$public_domain" >/dev/null; then
  echo "PUBLIC_DOMAIN does not resolve on this VM: $public_domain" >&2
  exit 1
fi

if ! docker network inspect root_default >/dev/null; then
  echo "Expected Docker network root_default is unavailable." >&2
  exit 1
fi

export IMAGE_REPOSITORY="$image_repository"
export IMAGE_TAG="$image_tag"

blue_running="$(docker inspect --format '{{.State.Running}}' mychampions-server-blue 2>/dev/null || true)"
green_running="$(docker inspect --format '{{.State.Running}}' mychampions-server-green 2>/dev/null || true)"
blue_running="${blue_running:-false}"
green_running="${green_running:-false}"

case "$blue_running:$green_running" in
  true:false)
    detected_slot="blue"
    ;;
  false:true)
    detected_slot="green"
    ;;
  *)
    echo "Exactly one MyChampions server slot must be running before cutover." >&2
    exit 1
    ;;
esac

current_slot="$detected_slot"
if [[ -f "$active_slot_file" ]]; then
  recorded_slot="$(tr -d '[:space:]' <"$active_slot_file")"
  if [[ "$recorded_slot" != "blue" && "$recorded_slot" != "green" ]]; then
    echo "Invalid active slot in $active_slot_file: $recorded_slot" >&2
    exit 1
  fi
  if [[ "$recorded_slot" != "$detected_slot" ]]; then
    echo "Active slot marker disagrees with the running container: $recorded_slot vs $detected_slot." >&2
    exit 1
  fi
  current_slot="$recorded_slot"
fi

case "$current_slot" in
  blue)
    target_slot="green"
    target_port=3401
    ;;
  green)
    target_slot="blue"
    target_port=3400
    ;;
  *)
    echo "Invalid active slot in $active_slot_file: $current_slot" >&2
    exit 1
    ;;
esac

if [[ "$image_pull" == "true" ]]; then
  docker compose -f "$compose_file" pull blue green migrate
else
  if ! docker image inspect "${image_repository}:${image_tag}" >/dev/null 2>&1; then
    echo "Preloaded image is unavailable for no-pull cutover: ${image_repository}:${image_tag}" >&2
    exit 1
  fi
  echo "Skipping registry pull for verified preloaded image: ${image_repository}:${image_tag}"
fi

docker compose -f "$compose_file" run --rm migrate
docker compose -f "$compose_file" up -d "$target_slot"

for _ in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:${target_port}/health" >/dev/null; then
    break
  fi
  sleep 1
done

if ! curl --fail --silent "http://127.0.0.1:${target_port}/health" >/dev/null; then
  echo "Target slot failed health check: $target_slot" >&2
  exit 1
fi

sudo install -d -m 755 /etc/nginx/snippets
sed "s/__PUBLIC_DOMAIN__/$public_domain/g" "$nginx_template" | sudo tee "$nginx_site" >/dev/null
sudo ln -sfn "$nginx_site" "$nginx_enabled"
printf 'set $mychampions_server_upstream http://127.0.0.1:%s;\n' "$target_port" | sudo tee "$nginx_upstream_snippet" >/dev/null
sudo nginx -t
sudo systemctl reload nginx

printf '%s\n' "$target_slot" > "$active_slot_file"
docker compose -f "$compose_file" stop "$current_slot" || true

printf 'MyChampions server now routes %s through %s.\n' "$public_domain" "$target_slot"
