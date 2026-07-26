#!/usr/bin/env bash
set -euo pipefail

ssh_host="${MYCHAMPIONS_VM_SSH_HOST:-digiocean}"
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

Without --verify, validates the request and prints a no-SSH dry run.
With --verify, reads canonical RevenueCat customer privileges and the matching
production subscription snapshot through the existing digiocean SSH boundary.
It performs no provider or database writes and never prints credentials.
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

if [[ "$ssh_host" != "digiocean" ]]; then
  echo "Refusing live evidence verification: MYCHAMPIONS_VM_SSH_HOST must be digiocean." >&2
  exit 2
fi

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
  printf 'Dry run only. No SSH, provider read, or database read was performed.\n'
  printf 'Target: %s; App User ID: %s; expected professional=%s ai=%s; timeout=%ss.\n' \
    "$ssh_host" \
    "$app_user_id" \
    "$expected_professional_status" \
    "$expected_ai_status" \
    "$timeout_seconds"
  exit 0
fi

ssh "$ssh_host" bash -s -- \
  "$app_user_id" \
  "$expected_professional_status" \
  "$expected_ai_status" \
  "$timeout_seconds" <<'REMOTE_SCRIPT'
set -euo pipefail

app_user_id="$1"
expected_professional_status="$2"
expected_ai_status="$3"
timeout_seconds="$4"
running_containers=()

for candidate in mychampions-server-blue mychampions-server-green; do
  if [[ "$(docker inspect --format '{{.State.Running}}' "$candidate" 2>/dev/null || true)" == "true" ]]; then
    running_containers+=("$candidate")
  fi
done

if [[ ${#running_containers[@]} -ne 1 ]]; then
  echo "Expected exactly one running MyChampions server container." >&2
  exit 3
fi

server_container="${running_containers[0]}"

docker exec \
  -e EVIDENCE_APP_USER_ID="$app_user_id" \
  -e EVIDENCE_EXPECTED_PROFESSIONAL_STATUS="$expected_professional_status" \
  -e EVIDENCE_EXPECTED_AI_STATUS="$expected_ai_status" \
  -e EVIDENCE_TIMEOUT_SECONDS="$timeout_seconds" \
  "$server_container" \
  bun -e '
import postgres from "postgres";
import { RevenueCatRestCustomerManager } from "./src/subscription/revenuecat-customer-manager.ts";

const appUserId = process.env.EVIDENCE_APP_USER_ID ?? "";
const expectedProfessionalStatus =
  process.env.EVIDENCE_EXPECTED_PROFESSIONAL_STATUS ?? "";
const expectedAiStatus = process.env.EVIDENCE_EXPECTED_AI_STATUS ?? "";
const timeoutSeconds = Number(process.env.EVIDENCE_TIMEOUT_SECONDS ?? "180");
const secretApiKey = process.env.REVENUECAT_SECRET_API_KEY ?? "";

if (!secretApiKey.startsWith("sk_")) {
  throw new Error("The running server does not have a server-only RevenueCat sk_* key.");
}
if (!process.env.DATABASE_URL) {
  throw new Error("The running server does not have DATABASE_URL configured.");
}

const customerManager = new RevenueCatRestCustomerManager(secretApiKey);
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const deadline = Date.now() + timeoutSeconds * 1000;
let privileges = null;
let snapshot = null;
let converged = false;

try {
  while (Date.now() <= deadline) {
    try {
      privileges = await customerManager.getCustomerPrivileges(appUserId);
    } catch {
      // A transient provider failure must not let a stale successful read
      // satisfy the evidence gate. The next iteration performs a fresh read.
      privileges = null;
    }

    const rows = await sql`
      select
        auth_uid,
        professional_entitlement_status,
        ai_entitlement_status,
        professional_entitlement_expires_at,
        professional_entitlement_renewal_risk,
        observed_at,
        updated_at
      from subscription_entitlement_snapshots
      where auth_uid = ${appUserId}
      limit 1
    `;
    snapshot = rows[0] ?? null;

    const providerMatches =
      privileges?.professionalEntitlementStatus === expectedProfessionalStatus &&
      privileges?.aiEntitlementStatus === expectedAiStatus;
    const snapshotMatches =
      snapshot?.professional_entitlement_status === expectedProfessionalStatus &&
      snapshot?.ai_entitlement_status === expectedAiStatus;

    if (providerMatches && snapshotMatches) {
      converged = true;
      break;
    }

    if (Date.now() >= deadline) break;
    await Bun.sleep(5000);
  }
} finally {
  await sql.end();
}

const evidence = {
  appUserId,
  expected: {
    professionalEntitlementStatus: expectedProfessionalStatus,
    aiEntitlementStatus: expectedAiStatus,
  },
  revenueCat: privileges
    ? {
        professionalEntitlementStatus: privileges.professionalEntitlementStatus,
        aiEntitlementStatus: privileges.aiEntitlementStatus,
        professionalEntitlementExpiresAt: privileges.professionalEntitlementExpiresAt,
        professionalEntitlementRenewalRisk: privileges.professionalEntitlementRenewalRisk,
        observedAt: privileges.observedAt,
      }
    : null,
  serverSnapshot: snapshot
    ? {
        professionalEntitlementStatus: snapshot.professional_entitlement_status,
        aiEntitlementStatus: snapshot.ai_entitlement_status,
        professionalEntitlementExpiresAt:
          snapshot.professional_entitlement_expires_at?.toISOString?.() ??
          snapshot.professional_entitlement_expires_at ??
          null,
        professionalEntitlementRenewalRisk:
          snapshot.professional_entitlement_renewal_risk,
        observedAt:
          snapshot.observed_at?.toISOString?.() ?? snapshot.observed_at ?? null,
        updatedAt:
          snapshot.updated_at?.toISOString?.() ?? snapshot.updated_at ?? null,
      }
    : null,
};

console.log(JSON.stringify(evidence, null, 2));

if (
  !privileges ||
  privileges.professionalEntitlementStatus !== expectedProfessionalStatus ||
  privileges.aiEntitlementStatus !== expectedAiStatus
) {
  throw new Error("Canonical RevenueCat privileges do not match the expected live state.");
}
if (
  snapshot?.professional_entitlement_status !== expectedProfessionalStatus ||
  snapshot?.ai_entitlement_status !== expectedAiStatus
) {
  throw new Error("Production subscription snapshot did not converge before the deadline.");
}
if (!converged) {
  throw new Error(
    "RevenueCat privileges and the production snapshot did not converge in the same evidence iteration."
  );
}
'
REMOTE_SCRIPT
