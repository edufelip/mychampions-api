#!/usr/bin/env bash
set -euo pipefail

approved_project="mychampions-fb928"
approved_bucket="mychampions-server-media-942354515358"
approved_region="us-west1"
approved_service_account_name="mychampions-server-storage"
approved_ssh_host="digiocean"
remote_env_file="/opt/mychampions-server/infra/.env"
remote_credentials_path="/opt/mychampions-server/infra/secrets/mychampions-gcs-service-account.json"
remote_credentials_dir="$(dirname "$remote_credentials_path")"
container_credentials_path="/run/secrets/mychampions-gcs-service-account.json"

usage() {
  cat <<'USAGE'
Usage: bash infra/scripts/provision-gcs.sh [--dry-run|--apply]

Provisions the approved MyChampions Google Cloud Storage project, private media
bucket, least-privilege service account, and its VM-only credential. The
default is a no-write preflight.
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

project_id="${MYCHAMPIONS_GCP_PROJECT_ID:-$approved_project}"
bucket_name="${MYCHAMPIONS_GCS_BUCKET:-$approved_bucket}"
bucket_region="${MYCHAMPIONS_GCS_REGION:-$approved_region}"
service_account_name="${MYCHAMPIONS_GCS_SERVICE_ACCOUNT:-$approved_service_account_name}"
ssh_host="${MYCHAMPIONS_VM_SSH_HOST:-$approved_ssh_host}"

require_approved_target() {
  local variable_name="$1"
  local expected="$2"
  local actual="$3"
  local kind="$4"

  if [[ "$actual" != "$expected" ]]; then
    echo "Refusing GCS provisioning: $variable_name must be the approved $kind $expected." >&2
    exit 1
  fi
}

require_approved_target "MYCHAMPIONS_GCP_PROJECT_ID" "$approved_project" "$project_id" "project"
require_approved_target "MYCHAMPIONS_GCS_BUCKET" "$approved_bucket" "$bucket_name" "bucket"
require_approved_target "MYCHAMPIONS_GCS_REGION" "$approved_region" "$bucket_region" "region"
require_approved_target "MYCHAMPIONS_GCS_SERVICE_ACCOUNT" "$approved_service_account_name" "$service_account_name" "service account"
require_approved_target "MYCHAMPIONS_VM_SSH_HOST" "$approved_ssh_host" "$ssh_host" "SSH host"

if [[ "$apply" != true ]]; then
  cat <<EOF
Dry run only. No Google Cloud or VM state will change.
Target project: $approved_project
Target private bucket: gs://$approved_bucket
Target bucket region: $approved_region
Target VM credential path: $remote_credentials_path

Run with --apply only after reviewing this exact target list.
EOF
  exit 0
fi

for required_command in gcloud jq ssh scp; do
  if ! command -v "$required_command" >/dev/null; then
    echo "Missing required command: $required_command." >&2
    exit 1
  fi
done

if ! ssh -o BatchMode=yes "$ssh_host" "test -f '$remote_env_file'"; then
  echo "VM runtime environment file is missing: $remote_env_file." >&2
  exit 1
fi

if ssh -o BatchMode=yes "$ssh_host" "test -e '$remote_credentials_path'"; then
  echo "Refusing GCS credential creation: $remote_credentials_path already exists." >&2
  exit 1
fi

if ! ssh -o BatchMode=yes "$ssh_host" "install -d -m 700 '$remote_credentials_dir' && test ! -e '$remote_credentials_path'"; then
  echo "Unable to prepare the VM GCS credential destination safely." >&2
  exit 1
fi

if ! gcloud projects describe "$project_id" --format='value(projectNumber)' >/dev/null 2>&1; then
  echo "Approved Google Cloud project is unavailable: $project_id." >&2
  exit 1
fi

verified_billing_enabled="$(gcloud billing projects describe "$project_id" --format='value(billingEnabled)')"
if [[ "$verified_billing_enabled" != "True" ]]; then
  echo "Approved Google Cloud project requires billing enabled: $project_id." >&2
  exit 1
fi

gcloud services enable storage.googleapis.com --project="$project_id" --quiet

project_number="$(gcloud projects describe "$project_id" --format='value(projectNumber)')"
if gcloud storage buckets describe "gs://$bucket_name" --project="$project_id" >/dev/null 2>&1; then
  bucket_metadata="$(gcloud storage buckets describe "gs://$bucket_name" --project="$project_id" --raw --format=json)"
  bucket_project_number="$(jq -r '.projectNumber // empty' <<<"$bucket_metadata")"
  existing_region="$(jq -r '.location // empty' <<<"$bucket_metadata")"
  uniform_access="$(jq -r '.iamConfiguration.uniformBucketLevelAccess.enabled // false' <<<"$bucket_metadata")"
  public_access_prevention="$(jq -r '.iamConfiguration.publicAccessPrevention // empty' <<<"$bucket_metadata")"
  if [[ "$bucket_project_number" != "$project_number" || "$existing_region" != "US-WEST1" || "$uniform_access" != "true" || "$public_access_prevention" != "enforced" ]]; then
    echo "Refusing GCS provisioning: existing bucket does not match the approved private-storage contract." >&2
    exit 1
  fi
else
  gcloud storage buckets create "gs://$bucket_name" \
    --project="$project_id" \
    --location="$bucket_region" \
    --default-storage-class=STANDARD \
    --uniform-bucket-level-access \
    --public-access-prevention \
    --quiet
fi

service_account_email="$service_account_name@$project_id.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$service_account_email" --project="$project_id" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$service_account_name" \
    --project="$project_id" \
    --display-name="MyChampions Server Storage" \
    --quiet
fi

wait_for_service_account_key_api() {
  for _ in $(seq 1 30); do
    if gcloud iam service-accounts keys list \
      --iam-account="$service_account_email" \
      --project="$project_id" \
      --format='value(name)' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  echo "Service account key API did not become ready in time: $service_account_email." >&2
  return 1
}

wait_for_service_account_key_api

gcloud storage buckets add-iam-policy-binding "gs://$bucket_name" \
  --member="serviceAccount:$service_account_email" \
  --role="roles/storage.objectAdmin" \
  --condition=None \
  --project="$project_id" \
  --quiet >/dev/null

temporary_key_file="$(mktemp "${TMPDIR:-/tmp}/mychampions-gcs-key.XXXXXX")"
temporary_gcloud_config="$(mktemp -d "${TMPDIR:-/tmp}/mychampions-gcloud.XXXXXX")"
healthcheck_object=""
created_key_id=""
remote_incoming_path="$remote_credentials_path.incoming.$$"
remote_key_installed=false
completed=false

cleanup() {
  local exit_code=$?
  set +e

  if [[ -n "$healthcheck_object" ]]; then
    CLOUDSDK_CONFIG="$temporary_gcloud_config" gcloud storage rm "gs://$bucket_name/$healthcheck_object" --quiet >/dev/null 2>&1
  fi
  if [[ "$completed" != true && "$remote_key_installed" == true ]]; then
    ssh -o BatchMode=yes "$ssh_host" "rm -f '$remote_credentials_path'" >/dev/null 2>&1
  fi
  ssh -o BatchMode=yes "$ssh_host" "rm -f '$remote_incoming_path'" >/dev/null 2>&1
  if [[ "$completed" != true && -n "$created_key_id" ]]; then
    gcloud iam service-accounts keys delete "$created_key_id" \
      --iam-account="$service_account_email" \
      --project="$project_id" \
      --quiet >/dev/null 2>&1
  fi
  rm -f "$temporary_key_file"
  rm -rf "$temporary_gcloud_config"
  exit "$exit_code"
}
trap cleanup EXIT

chmod 600 "$temporary_key_file"
gcloud iam service-accounts keys create "$temporary_key_file" \
  --iam-account="$service_account_email" \
  --project="$project_id" \
  --quiet >/dev/null
created_key_id="$(jq -r '.private_key_id // empty' "$temporary_key_file")"
if [[ -z "$created_key_id" ]]; then
  echo "Created GCS credential did not include a private key identifier." >&2
  exit 1
fi

CLOUDSDK_CONFIG="$temporary_gcloud_config" gcloud auth activate-service-account "$service_account_email" \
  --key-file="$temporary_key_file" \
  --project="$project_id" \
  --quiet >/dev/null
healthcheck_object="provision-check/$(date +%s)-$$.txt"
printf 'mychampions-gcs-provision-check\n' | \
  CLOUDSDK_CONFIG="$temporary_gcloud_config" gcloud storage cp - "gs://$bucket_name/$healthcheck_object" --quiet
healthcheck_contents="$(CLOUDSDK_CONFIG="$temporary_gcloud_config" gcloud storage cat "gs://$bucket_name/$healthcheck_object")"
if [[ "$healthcheck_contents" != "mychampions-gcs-provision-check" ]]; then
  echo "GCS service-account verification returned unexpected content." >&2
  exit 1
fi
CLOUDSDK_CONFIG="$temporary_gcloud_config" gcloud storage rm "gs://$bucket_name/$healthcheck_object" --quiet
healthcheck_object=""

scp -q -p "$temporary_key_file" "$ssh_host:$remote_incoming_path"
ssh -o BatchMode=yes "$ssh_host" bash -s -- "$remote_incoming_path" "$remote_credentials_path" <<'REMOTE'
set -euo pipefail

incoming_path="$1"
credentials_path="$2"

install -d -m 700 "$(dirname "$credentials_path")"
if [[ -e "$credentials_path" ]]; then
  echo "Refusing GCS credential installation: destination already exists." >&2
  exit 1
fi
( set -o noclobber; cat "$incoming_path" > "$credentials_path" )
chmod 600 "$credentials_path"
rm -f "$incoming_path"
REMOTE
remote_key_installed=true

ssh -o BatchMode=yes "$ssh_host" bash -s -- \
  "$remote_env_file" \
  "$bucket_name" \
  "$container_credentials_path" <<'REMOTE'
set -euo pipefail

env_file="$1"
bucket_name="$2"
container_credentials_path="$3"
temporary_env_file="$(mktemp "${env_file}.tmp.XXXXXX")"

cleanup() {
  rm -f "$temporary_env_file"
}
trap cleanup EXIT

awk \
  -v bucket_name="$bucket_name" \
  -v container_credentials_path="$container_credentials_path" \
  '
  /^GCS_BUCKET=/ {
    print "GCS_BUCKET=" bucket_name
    found_bucket = 1
    next
  }
  /^STORAGE_GCS_CREDENTIALS_PATH=/ {
    print "STORAGE_GCS_CREDENTIALS_PATH=" container_credentials_path
    found_credentials_path = 1
    next
  }
  /^STORAGE_GCS_USE_ADC=/ {
    print "STORAGE_GCS_USE_ADC=false"
    found_adc = 1
    next
  }
  { print }
  END {
    if (!found_bucket || !found_credentials_path || !found_adc) {
      exit 1
    }
  }
  ' "$env_file" > "$temporary_env_file"

install -m 600 "$temporary_env_file" "$env_file"
REMOTE

ssh -o BatchMode=yes "$ssh_host" bash -s -- \
  "$remote_env_file" \
  "$remote_credentials_path" \
  "$bucket_name" \
  "$container_credentials_path" <<'REMOTE'
set -euo pipefail

env_file="$1"
credentials_path="$2"
bucket_name="$3"
container_credentials_path="$4"

test "$(stat -c '%a' "$credentials_path")" = "600"
grep -qx "GCS_BUCKET=$bucket_name" "$env_file"
grep -qx "STORAGE_GCS_CREDENTIALS_PATH=$container_credentials_path" "$env_file"
grep -qx "STORAGE_GCS_USE_ADC=false" "$env_file"
REMOTE

completed=true
printf 'Provisioned private bucket gs://%s and installed its VM-only credential.\n' "$bucket_name"
