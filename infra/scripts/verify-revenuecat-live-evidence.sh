#!/usr/bin/env bash
set -euo pipefail

# Production API on Railway since 2026-10-07 (ET-250). Ids, not names: the mychampions-dev project also
# has an `api` service in an environment named `production`.
readonly railway_project_id="f8ac2da4-916e-4017-93dc-167e8a5ad9f3"     # mychampions-prod
readonly railway_environment_id="9ccf6768-f3fd-453a-86d0-b85e42759619" # production
readonly railway_service_id="6a0249fa-e25e-4a13-906b-c64965b63a51"     # api
readonly database_name="mychampions_server"
readonly converged_marker="REVENUECAT_LIVE_EVIDENCE_CONVERGED"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
remote_program="${script_dir}/revenuecat-live-evidence.remote.ts"
app_user_id="${REVENUECAT_TEST_APP_USER_ID:-}"
expected_professional_status="${EXPECTED_PROFESSIONAL_STATUS:-}"
expected_ai_status="${EXPECTED_AI_STATUS:-}"
timeout_seconds="${REVENUECAT_EVIDENCE_TIMEOUT_SECONDS:-180}"
verify=false

usage() {
  cat <<'EOF'
Usage:
  REVENUECAT_TEST_APP_USER_ID=<uid> \
  EXPECTED_PROFESSIONAL_STATUS=active|lapsed \
  EXPECTED_AI_STATUS=active|lapsed \
    bash infra/scripts/verify-revenuecat-live-evidence.sh [--verify]

Without --verify, validates the request and prints a dry run without contacting Railway.
With --verify, runs infra/scripts/revenuecat-live-evidence.remote.ts inside the production
Railway `api` service (project mychampions-prod, environment production) over `railway ssh`.
It reads canonical RevenueCat customer privileges and the matching production subscription
snapshot with that container's own credentials. It performs no provider or database writes
and never prints credentials. Requires a logged-in Railway CLI and an SSH key registered with
Railway (`railway ssh keys list`).
EOF
}

case "${1:-}" in
  "")
    ;;
  --verify)
    verify=true
    ;;
  --help|-h)
    usage
    exit 0
    ;;
  *)
    echo "Unknown argument: $1" >&2
    usage >&2
    exit 2
    ;;
esac

if [[ -z "$app_user_id" || ${#app_user_id} -gt 96 || ! "$app_user_id" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*$ ]]; then
  echo "REVENUECAT_TEST_APP_USER_ID must be a nonblank safe ID of at most 96 characters." >&2
  exit 2
fi

case "$expected_professional_status" in
  active|lapsed)
    ;;
  *)
    echo "EXPECTED_PROFESSIONAL_STATUS must be active or lapsed." >&2
    exit 2
    ;;
esac

case "$expected_ai_status" in
  active|lapsed)
    ;;
  *)
    echo "EXPECTED_AI_STATUS must be active or lapsed." >&2
    exit 2
    ;;
esac

if [[ ! "$timeout_seconds" =~ ^[0-9]+$ ]] || (( timeout_seconds < 1 || timeout_seconds > 600 )); then
  echo "REVENUECAT_EVIDENCE_TIMEOUT_SECONDS must be an integer from 1 through 600." >&2
  exit 2
fi

if [[ "$verify" != "true" ]]; then
  printf 'Dry run only. No Railway SSH, provider read, or database read was performed.\n'
  printf 'Target: Railway project mychampions-prod (%s), environment production (%s), service api (%s), database %s.\n' \
    "$railway_project_id" \
    "$railway_environment_id" \
    "$railway_service_id" \
    "$database_name"
  printf 'App User ID: %s; expected professional=%s ai=%s; timeout=%ss.\n' \
    "$app_user_id" \
    "$expected_professional_status" \
    "$expected_ai_status" \
    "$timeout_seconds"
  exit 0
fi

if ! command -v railway >/dev/null 2>&1; then
  echo "The Railway CLI is required for --verify (https://docs.railway.com/cli)." >&2
  exit 2
fi

if [[ ! -f "$remote_program" ]]; then
  echo "Missing remote evidence program: ${remote_program}" >&2
  exit 2
fi

# One line of base64 on both BSD and GNU base64.
encoded_program="$(base64 < "$remote_program" | tr -d '\n')"

# A single remote shell line built only from validated values and base64, so it means the same thing
# whether or not the CLI re-quotes its words. It carries no credentials: the program reads
# DATABASE_URL and REVENUECAT_SECRET_API_KEY from the container's own environment.
remote_command="cd /app && EVIDENCE_APP_USER_ID=${app_user_id}"
remote_command+=" EVIDENCE_EXPECTED_PROFESSIONAL_STATUS=${expected_professional_status}"
remote_command+=" EVIDENCE_EXPECTED_AI_STATUS=${expected_ai_status}"
remote_command+=" EVIDENCE_TIMEOUT_SECONDS=${timeout_seconds}"
remote_command+=" EVIDENCE_RAILWAY_PROJECT_ID=${railway_project_id}"
remote_command+=" EVIDENCE_RAILWAY_ENVIRONMENT_ID=${railway_environment_id}"
remote_command+=" EVIDENCE_RAILWAY_SERVICE_ID=${railway_service_id}"
remote_command+=" EVIDENCE_DATABASE_NAME=${database_name}"
remote_command+=" bun -e \"\$(printf '%s' '${encoded_program}' | base64 -d)\""

# stdin from /dev/null: the CLI then never offers to register an SSH key, and ssh runs without a PTY so
# the output stays clean. All three target flags are set, so the CLI ignores any linked project.
if output="$(
  railway ssh \
    --project "$railway_project_id" \
    --environment "$railway_environment_id" \
    --service "$railway_service_id" \
    -- "$remote_command" </dev/null
)"; then
  status=0
else
  status=$?
fi

if [[ -n "$output" ]]; then
  printf '%s\n' "$output"
fi

if (( status != 0 )); then
  echo "Live RevenueCat evidence did not pass (exit ${status})." >&2
  exit "$status"
fi

# The Railway SSH relay can end a session with exit 0 without running the command, so exit 0 alone is
# not evidence.
if ! grep -Fqx "$converged_marker" <<<"$output"; then
  echo "Railway SSH ended without the evidence result; treating the run as failed." >&2
  exit 1
fi

echo "RevenueCat and the Railway production snapshot converged in the same iteration."
