#!/bin/sh
# Railway entrypoint. The app reads the GCS service-account key from a file (STORAGE_GCS_CREDENTIALS_PATH);
# Railway has no secret files, so the key arrives base64-encoded in GCS_SERVICE_ACCOUNT_JSON_B64 and is
# written to a private temp file before the server starts. Without that variable it starts the server unchanged.
set -e
if [ -n "$GCS_SERVICE_ACCOUNT_JSON_B64" ]; then
  umask 077
  key_file="${GCS_SERVICE_ACCOUNT_KEY_FILE:-/tmp/gcs-service-account.json}"
  printf '%s' "$GCS_SERVICE_ACCOUNT_JSON_B64" | base64 -d > "$key_file"
  export STORAGE_GCS_CREDENTIALS_PATH="$key_file"
fi
if [ "$#" -eq 0 ]; then
  set -- bun run start
fi
exec "$@"
