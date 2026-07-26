#!/usr/bin/env bash
set -euo pipefail

ssh_host="${MYCHAMPIONS_VM_SSH_HOST:-digiocean}"
postgres_container="${MYCHAMPIONS_VM_POSTGRES_CONTAINER:-eduwaldo-postgres}"
remote_env_file="${MYCHAMPIONS_VM_ENV_FILE:-/opt/mychampions-server/infra/.env}"
server_database="mychampions_server"
server_role="mychampions_server_user"
catalog_reader_role="mychampions_catalog_reader"

usage() {
  cat <<'USAGE'
Usage: bash infra/scripts/provision-vm-db.sh [--dry-run|--apply]

Creates one isolated MyChampions application database and two non-superuser roles
on the approved digiocean Postgres container. It never drops or alters catalog
data. Existing target database, roles, or environment files cause a refusal.
USAGE
}

apply=false
case "${1:---dry-run}" in
  --dry-run) ;;
  --apply) apply=true ;;
  --help|-h)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

if [[ "$ssh_host" != "digiocean" ]]; then
  echo "Refusing VM provisioning: MYCHAMPIONS_VM_SSH_HOST must be digiocean." >&2
  exit 1
fi

if [[ "$postgres_container" != "eduwaldo-postgres" ]]; then
  echo "Refusing VM provisioning: MYCHAMPIONS_VM_POSTGRES_CONTAINER must be eduwaldo-postgres." >&2
  exit 1
fi

if [[ "$remote_env_file" != "/opt/mychampions-server/infra/.env" ]]; then
  echo "Refusing VM provisioning: MYCHAMPIONS_VM_ENV_FILE must be the approved server env path." >&2
  exit 1
fi

if [[ "$apply" != true ]]; then
  cat <<EOF
Dry run only. No VM state will change.
Target SSH host: $ssh_host
Target Postgres container: $postgres_container
New database: $server_database
New runtime role: $server_role
New catalog reader role: $catalog_reader_role
New secret env file: $remote_env_file

Run with --apply only after reviewing this exact target list.
EOF
  exit 0
fi

ssh -o BatchMode=yes "$ssh_host" bash -s -- \
  "$postgres_container" \
  "$remote_env_file" \
  "$server_database" \
  "$server_role" \
  "$catalog_reader_role" <<'REMOTE'
set -euo pipefail

postgres_container="$1"
remote_env_file="$2"
server_database="$3"
server_role="$4"
catalog_reader_role="$5"
food_database="mychampions_food_catalog"
food_owner="mychampions_food_catalog_user"
exercise_database="mychampions_exercise_catalog"
exercise_owner="mychampions_exercise_catalog_user"
temporary_env_file=""
created_targets=false

psql_admin_query() {
  local database="$1"
  shift
  docker exec "$postgres_container" psql -X -v ON_ERROR_STOP=1 -U admin -d "$database" "$@"
}

psql_admin_stdin() {
  local database="$1"
  shift
  docker exec -i "$postgres_container" psql -X -v ON_ERROR_STOP=1 -U admin -d "$database" "$@"
}

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
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = '$server_database' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS "$server_database";
DROP ROLE IF EXISTS "$catalog_reader_role";
DROP ROLE IF EXISTS "$server_role";
SQL
  fi

  exit "$exit_code"
}

trap cleanup_on_error EXIT

if [[ "$postgres_container" != "eduwaldo-postgres" || "$server_database" != "mychampions_server" || "$server_role" != "mychampions_server_user" || "$catalog_reader_role" != "mychampions_catalog_reader" ]]; then
  echo "Refusing VM provisioning: unsafe target names." >&2
  exit 1
fi

if [[ "$remote_env_file" != "/opt/mychampions-server/infra/.env" ]]; then
  echo "Refusing VM provisioning: unsafe environment-file target." >&2
  exit 1
fi

if ! command -v openssl >/dev/null || ! command -v node >/dev/null; then
  echo "VM must provide openssl and node before provisioning secrets." >&2
  exit 1
fi

if [[ -e "$remote_env_file" ]]; then
  echo "Refusing VM provisioning: $remote_env_file already exists; refusing credential rotation." >&2
  exit 1
fi

target_exists="$(psql_admin_query postgres -At -F '|' -c "SELECT EXISTS (SELECT FROM pg_database WHERE datname = '$server_database'), EXISTS (SELECT FROM pg_roles WHERE rolname = '$server_role'), EXISTS (SELECT FROM pg_roles WHERE rolname = '$catalog_reader_role')")"
if [[ "$target_exists" != "f|f|f" ]]; then
  echo "Refusing VM provisioning: isolated database or role target already exists ($target_exists)." >&2
  exit 1
fi

server_password="$(openssl rand -hex 32)"
catalog_reader_password="$(openssl rand -hex 32)"
jwt_plugin_secret="$(openssl rand -hex 32)"
auth_jwt_private_jwk="$(node -e 'const { generateKeyPairSync } = require("node:crypto"); const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 }); process.stdout.write(JSON.stringify(privateKey.export({ format: "jwk" })));')"

install -d -m 700 "$(dirname "$remote_env_file")"
umask 077
temporary_env_file="$(mktemp "${remote_env_file}.tmp.XXXXXX")"
cat > "$temporary_env_file" <<EOF
NODE_ENV=production
APP_VARIANT=production
PORT=3400
DATABASE_URL=postgres://${server_role}:${server_password}@eduwaldo-postgres:5432/${server_database}
FOOD_CATALOG_DATABASE_URL=postgres://${catalog_reader_role}:${catalog_reader_password}@eduwaldo-postgres:5432/${food_database}
EXERCISE_CATALOG_DATABASE_URL=postgres://${catalog_reader_role}:${catalog_reader_password}@eduwaldo-postgres:5432/${exercise_database}
JWT_ISSUER=mychampions-production
JWT_AUDIENCE=mychampions-mobile
JWT_PLUGIN_SECRET=${jwt_plugin_secret}
AUTH_JWT_PRIVATE_JWK=${auth_jwt_private_jwk}
LOCAL_DEV_AUTH_ENABLED=false
GCS_BUCKET=
STORAGE_GCS_CREDENTIALS_PATH=/run/secrets/mychampions-gcs-service-account.json
STORAGE_GCS_USE_ADC=false
GOOGLE_ANDROID_CLIENT_ID=
GOOGLE_IOS_CLIENT_ID=
GOOGLE_WEB_CLIENT_ID=
APPLE_CLIENT_ID=
REVENUECAT_SECRET_API_KEY=
REVENUECAT_WEBHOOK_AUTHORIZATION=
REVENUECAT_WEBHOOK_SIGNING_SECRET=
EOF

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

grant_catalog_reader() {
  local database="$1"
  local owner="$2"

  psql_admin_stdin "$database" <<SQL
GRANT CONNECT ON DATABASE "$database" TO "$catalog_reader_role";
GRANT USAGE ON SCHEMA public TO "$catalog_reader_role";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO "$catalog_reader_role";
ALTER DEFAULT PRIVILEGES FOR ROLE "$owner" IN SCHEMA public GRANT SELECT ON TABLES TO "$catalog_reader_role";
SQL
}

grant_catalog_reader "$food_database" "$food_owner"
grant_catalog_reader "$exercise_database" "$exercise_owner"

docker exec "$postgres_container" psql -X -v ON_ERROR_STOP=1 -U "$server_role" -d "$server_database" -Atc 'SELECT current_user || chr(58) || current_database()' >/dev/null
docker exec "$postgres_container" psql -X -v ON_ERROR_STOP=1 -U "$catalog_reader_role" -d "$food_database" -Atc 'SELECT 1 FROM catalog_foods LIMIT 1' >/dev/null
docker exec "$postgres_container" psql -X -v ON_ERROR_STOP=1 -U "$catalog_reader_role" -d "$exercise_database" -Atc 'SELECT 1 FROM catalog_exercises LIMIT 1' >/dev/null

install -m 600 "$temporary_env_file" "$remote_env_file"
rm -f "$temporary_env_file"
temporary_env_file=""
created_targets=false

printf 'Provisioned %s with non-superuser roles %s and %s.\n' "$server_database" "$server_role" "$catalog_reader_role"
printf 'Wrote VM runtime secrets to %s with mode 0600.\n' "$remote_env_file"
REMOTE
