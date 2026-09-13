#!/usr/bin/env bash
set -euo pipefail

ssh_host="${MYCHAMPIONS_DEV_VM_SSH_HOST:-digiocean}"
postgres_container="${MYCHAMPIONS_DEV_VM_POSTGRES_CONTAINER:-eduwaldo-postgres}"
remote_env_file="${MYCHAMPIONS_DEV_VM_ENV_FILE:-/opt/mychampions-dev-server/shared/.env}"
server_database="mychampions_dev"
server_role="mychampions_dev_user"
catalog_reader_role="mychampions_dev_catalog_reader"
apply=false

usage() {
  cat <<'USAGE'
Usage:
  DEV_GOOGLE_ANDROID_CLIENT_ID=<id> DEV_GOOGLE_IOS_CLIENT_ID=<id> \
  DEV_GOOGLE_WEB_CLIENT_ID=<id> DEV_APPLE_CLIENT_ID=<bundle-id> \
  bash infra/scripts/provision-dev-vm-db.sh [--apply]

Creates the isolated MyChampions Dev database, least-privileged roles, and
runtime environment. It never alters the production MyChampions database or
production environment file. The default is a no-write dry run.
USAGE
}

case "${1:---dry-run}" in
  --dry-run) ;;
  --apply) apply=true ;;
  --help|-h) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

if [[ "$ssh_host" != "digiocean" ]] || [[ "$postgres_container" != "eduwaldo-postgres" ]] ||
  [[ "$remote_env_file" != "/opt/mychampions-dev-server/shared/.env" ]]; then
  echo "Refusing Dev provisioning: target does not match the approved Dev VM/container/env file." >&2
  exit 1
fi

if [[ "$apply" != true ]]; then
  cat <<EOF
Dry run only. No VM state will change.
Target SSH host: $ssh_host
Target Postgres container: $postgres_container
New Dev database: $server_database
New Dev runtime role: $server_role
New Dev catalog reader role: $catalog_reader_role
New Dev environment file: $remote_env_file
EOF
  exit 0
fi

for required_name in DEV_GOOGLE_ANDROID_CLIENT_ID DEV_GOOGLE_IOS_CLIENT_ID DEV_GOOGLE_WEB_CLIENT_ID DEV_APPLE_CLIENT_ID; do
  if [[ -z "${!required_name:-}" ]]; then
    echo "$required_name must be configured before Dev provisioning." >&2
    exit 1
  fi
done

ssh -o BatchMode=yes "$ssh_host" bash -s -- \
  "$postgres_container" "$remote_env_file" "$server_database" "$server_role" "$catalog_reader_role" \
  "$DEV_GOOGLE_ANDROID_CLIENT_ID" "$DEV_GOOGLE_IOS_CLIENT_ID" "$DEV_GOOGLE_WEB_CLIENT_ID" "$DEV_APPLE_CLIENT_ID" <<'REMOTE'
set -euo pipefail

postgres_container="$1"
remote_env_file="$2"
server_database="$3"
server_role="$4"
catalog_reader_role="$5"
google_android_client_id="$6"
google_ios_client_id="$7"
google_web_client_id="$8"
apple_client_id="$9"
food_database="mychampions_food_catalog"
food_owner="mychampions_food_catalog_user"
exercise_database="mychampions_exercise_catalog"
exercise_owner="mychampions_exercise_catalog_user"
temporary_env_file=""
created_targets=false

if [[ "$postgres_container" != "eduwaldo-postgres" || "$remote_env_file" != "/opt/mychampions-dev-server/shared/.env" ||
  "$server_database" != "mychampions_dev" || "$server_role" != "mychampions_dev_user" ||
  "$catalog_reader_role" != "mychampions_dev_catalog_reader" ]]; then
  echo "Refusing Dev provisioning: unsafe target names." >&2
  exit 1
fi

for command in docker openssl node install mktemp; do
  command -v "$command" >/dev/null || { echo "Required command is unavailable: $command" >&2; exit 1; }
done

psql_admin_query() { docker exec "$postgres_container" psql -X -v ON_ERROR_STOP=1 -U admin -d "$1" "${@:2}"; }
psql_admin_stdin() { local database="$1"; shift; docker exec -i "$postgres_container" psql -X -v ON_ERROR_STOP=1 -U admin -d "$database" "$@"; }

cleanup_on_error() {
  local exit_code=$?
  rm -f "$temporary_env_file"
  if [[ "$exit_code" -ne 0 && "$created_targets" == true ]]; then
    set +e
    psql_admin_stdin "$food_database" <<SQL
ALTER DEFAULT PRIVILEGES FOR ROLE "$food_owner" IN SCHEMA public REVOKE SELECT ON TABLES FROM "$catalog_reader_role";
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM "$catalog_reader_role";
REVOKE USAGE ON SCHEMA public FROM "$catalog_reader_role";
REVOKE CONNECT ON DATABASE "$food_database" FROM "$catalog_reader_role";
SQL
    psql_admin_stdin "$exercise_database" <<SQL
ALTER DEFAULT PRIVILEGES FOR ROLE "$exercise_owner" IN SCHEMA public REVOKE SELECT ON TABLES FROM "$catalog_reader_role";
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM "$catalog_reader_role";
REVOKE USAGE ON SCHEMA public FROM "$catalog_reader_role";
REVOKE CONNECT ON DATABASE "$exercise_database" FROM "$catalog_reader_role";
SQL
    psql_admin_stdin postgres <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$server_database' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS "$server_database";
DROP ROLE IF EXISTS "$catalog_reader_role";
DROP ROLE IF EXISTS "$server_role";
SQL
  fi
  exit "$exit_code"
}
trap cleanup_on_error EXIT

[[ ! -e "$remote_env_file" ]] || { echo "Refusing Dev provisioning: environment file already exists." >&2; exit 1; }
target_exists="$(psql_admin_query postgres -At -F '|' -c "SELECT EXISTS (SELECT FROM pg_database WHERE datname = '$server_database'), EXISTS (SELECT FROM pg_roles WHERE rolname = '$server_role'), EXISTS (SELECT FROM pg_roles WHERE rolname = '$catalog_reader_role')")"
[[ "$target_exists" == "f|f|f" ]] || { echo "Refusing Dev provisioning: Dev targets already exist ($target_exists)." >&2; exit 1; }

server_password="$(openssl rand -hex 32)"
catalog_reader_password="$(openssl rand -hex 32)"
jwt_plugin_secret="$(openssl rand -hex 32)"
auth_jwt_private_jwk="$(node -e 'const { generateKeyPairSync } = require("node:crypto"); const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 }); process.stdout.write(JSON.stringify(privateKey.export({ format: "jwk" })));')"

created_targets=true
psql_admin_stdin postgres <<SQL
CREATE ROLE "$server_role" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '$server_password';
CREATE ROLE "$catalog_reader_role" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '$catalog_reader_password';
CREATE DATABASE "$server_database" OWNER "$server_role";
REVOKE ALL ON DATABASE "$server_database" FROM PUBLIC;
GRANT CONNECT ON DATABASE "$server_database" TO "$server_role";
SQL
psql_admin_stdin "$server_database" <<SQL
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO "$server_role";
SQL
for catalog in "$food_database:$food_owner" "$exercise_database:$exercise_owner"; do
  database="${catalog%%:*}"; owner="${catalog#*:}"
  psql_admin_stdin "$database" <<SQL
GRANT CONNECT ON DATABASE "$database" TO "$catalog_reader_role";
GRANT USAGE ON SCHEMA public TO "$catalog_reader_role";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO "$catalog_reader_role";
ALTER DEFAULT PRIVILEGES FOR ROLE "$owner" IN SCHEMA public GRANT SELECT ON TABLES TO "$catalog_reader_role";
SQL
done

docker exec "$postgres_container" psql -X -v ON_ERROR_STOP=1 -U "$server_role" -d "$server_database" -Atc 'SELECT current_user || chr(58) || current_database()' >/dev/null
docker exec "$postgres_container" psql -X -v ON_ERROR_STOP=1 -U "$catalog_reader_role" -d "$food_database" -Atc 'SELECT 1 FROM catalog_foods LIMIT 1' >/dev/null
docker exec "$postgres_container" psql -X -v ON_ERROR_STOP=1 -U "$catalog_reader_role" -d "$exercise_database" -Atc 'SELECT 1 FROM catalog_exercises LIMIT 1' >/dev/null

install -d -m 700 "$(dirname "$remote_env_file")"
umask 077
temporary_env_file="$(mktemp "${remote_env_file}.tmp.XXXXXX")"
cat > "$temporary_env_file" <<EOF
NODE_ENV=development
APP_VARIANT=dev
PORT=3400
DATABASE_URL=postgres://${server_role}:${server_password}@eduwaldo-postgres:5432/${server_database}
FOOD_CATALOG_DATABASE_URL=postgres://${catalog_reader_role}:${catalog_reader_password}@eduwaldo-postgres:5432/${food_database}
EXERCISE_CATALOG_DATABASE_URL=postgres://${catalog_reader_role}:${catalog_reader_password}@eduwaldo-postgres:5432/${exercise_database}
JWT_ISSUER=mychampions-dev
JWT_AUDIENCE=mychampions-mobile
JWT_PLUGIN_SECRET=${jwt_plugin_secret}
AUTH_JWT_PRIVATE_JWK=${auth_jwt_private_jwk}
LOCAL_DEV_AUTH_ENABLED=false
GCS_BUCKET=
STORAGE_GCS_CREDENTIALS_PATH=
STORAGE_GCS_USE_ADC=false
GOOGLE_ANDROID_CLIENT_ID=${google_android_client_id}
GOOGLE_IOS_CLIENT_ID=${google_ios_client_id}
GOOGLE_WEB_CLIENT_ID=${google_web_client_id}
APPLE_CLIENT_ID=${apple_client_id}
MEAL_PHOTO_ANALYZER=local_mock
WEB_ALLOWED_ORIGINS=http://localhost:8081,http://127.0.0.1:8081
REVENUECAT_SECRET_API_KEY=
REVENUECAT_WEBHOOK_AUTHORIZATION=
REVENUECAT_WEBHOOK_SIGNING_SECRET=
EOF
install -m 600 "$temporary_env_file" "$remote_env_file"
rm -f "$temporary_env_file"
temporary_env_file=""
created_targets=false
printf 'Provisioned isolated Dev database %s and non-superuser roles.\n' "$server_database"
REMOTE
