// Runs inside the production `api` container on Railway. verify-revenuecat-live-evidence.sh sends it
// over `railway ssh` and evaluates it with `bun -e` from /app, so imports resolve from the image root.
// It reads the canonical RevenueCat customer and the production subscription snapshot with the
// container's own credentials, writes nothing, and never prints a credential.
import postgres from 'postgres';
import { RevenueCatRestCustomerManager } from './src/subscription/revenuecat-customer-manager.ts';

// The driver treats a run as passed only when this exact line is printed: the Railway SSH relay can end
// a session with exit 0 without running the command.
const CONVERGED_MARKER = 'REVENUECAT_LIVE_EVIDENCE_CONVERGED';
const POLL_INTERVAL_MS = 5000;

class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message);
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : null;
}

async function main(): Promise<number> {
  const env = process.env;
  const appUserId = env.EVIDENCE_APP_USER_ID ?? '';
  const expectedProfessionalStatus = env.EVIDENCE_EXPECTED_PROFESSIONAL_STATUS ?? '';
  const expectedAiStatus = env.EVIDENCE_EXPECTED_AI_STATUS ?? '';
  const timeoutSeconds = Number(env.EVIDENCE_TIMEOUT_SECONDS ?? '');
  const expectedTarget = {
    projectId: env.EVIDENCE_RAILWAY_PROJECT_ID ?? '',
    environmentId: env.EVIDENCE_RAILWAY_ENVIRONMENT_ID ?? '',
    serviceId: env.EVIDENCE_RAILWAY_SERVICE_ID ?? '',
    database: env.EVIDENCE_DATABASE_NAME ?? '',
  };

  if (appUserId.length > 96 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(appUserId)) {
    refuse('EVIDENCE_APP_USER_ID must be a nonblank safe ID of at most 96 characters.');
  }
  if (!['active', 'lapsed'].includes(expectedProfessionalStatus)) {
    refuse('EVIDENCE_EXPECTED_PROFESSIONAL_STATUS must be active or lapsed.');
  }
  if (!['active', 'lapsed'].includes(expectedAiStatus)) {
    refuse('EVIDENCE_EXPECTED_AI_STATUS must be active or lapsed.');
  }
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
    refuse('EVIDENCE_TIMEOUT_SECONDS must be an integer from 1 through 600.');
  }
  if (Object.values(expectedTarget).some((value) => !value)) {
    refuse('the expected Railway project, environment, service, and database are required.');
  }

  // Railway sets these in every service container. Checking them here, and not only through the CLI
  // flags, stops a session that landed anywhere but the production api service before it reads anything.
  const target = {
    projectId: env.RAILWAY_PROJECT_ID ?? '',
    environmentId: env.RAILWAY_ENVIRONMENT_ID ?? '',
    serviceId: env.RAILWAY_SERVICE_ID ?? '',
  };
  if (
    target.projectId !== expectedTarget.projectId ||
    target.environmentId !== expectedTarget.environmentId ||
    target.serviceId !== expectedTarget.serviceId
  ) {
    refuse(
      `this container is project=${target.projectId || 'unset'} environment=${target.environmentId || 'unset'} ` +
        `service=${target.serviceId || 'unset'}, not the expected production api service.`
    );
  }

  const secretApiKey = env.REVENUECAT_SECRET_API_KEY ?? '';
  if (!secretApiKey.startsWith('sk_')) {
    refuse('the running server does not have a server-only RevenueCat sk_* key.');
  }
  const databaseUrl = env.DATABASE_URL ?? '';
  if (!databaseUrl) {
    refuse('the running server does not have DATABASE_URL configured.');
  }

  const customerManager = new RevenueCatRestCustomerManager(secretApiKey);
  // The server's role can write, so the session itself is read-only: Postgres rejects any write.
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 10,
    connection: {
      application_name: 'revenuecat-live-evidence',
      default_transaction_read_only: 'on',
      statement_timeout: '10s',
    },
  });
  const deadline = Date.now() + timeoutSeconds * 1000;
  let database = '';
  let privileges = null;
  let snapshot = null;
  let revenueCatQueried = false;
  let converged = false;

  try {
    const [session] = await sql`
      select current_database() as database, current_setting('transaction_read_only') as read_only
    `;
    database = session?.database ?? '';
    if (database !== expectedTarget.database) {
      refuse(`connected to database ${database || 'unknown'}, not ${expectedTarget.database}.`);
    }
    if (session?.read_only !== 'on') {
      refuse('the database session is not read-only.');
    }

    while (Date.now() <= deadline) {
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

      // RevenueCat's v1 customer lookup creates a customer for an unknown App User ID. Production
      // snapshots are written only by the signed webhook, which already resolved this customer, so the
      // provider is read only once the snapshot exists. A missing or failed read leaves privileges null,
      // so a stale successful read can never satisfy a later iteration.
      privileges = null;
      if (snapshot) {
        revenueCatQueried = true;
        try {
          privileges = await customerManager.getCustomerPrivileges(appUserId);
        } catch {
          privileges = null;
        }
      }

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

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await Bun.sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
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
    target: {
      railwayProjectId: target.projectId,
      railwayEnvironmentId: target.environmentId,
      railwayServiceId: target.serviceId,
      railwayDeploymentId: env.RAILWAY_DEPLOYMENT_ID ?? null,
      railwayReplicaId: env.RAILWAY_REPLICA_ID ?? null,
      database,
      readOnlySession: true,
    },
    converged,
    revenueCatQueried,
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
          professionalEntitlementExpiresAt: isoOrNull(snapshot.professional_entitlement_expires_at),
          professionalEntitlementRenewalRisk: snapshot.professional_entitlement_renewal_risk,
          observedAt: isoOrNull(snapshot.observed_at),
          updatedAt: isoOrNull(snapshot.updated_at),
        }
      : null,
  };

  console.log(JSON.stringify(evidence, null, 2));

  if (!revenueCatQueried) {
    console.error(
      'No production subscription snapshot exists for this App User ID. RevenueCat was not queried, ' +
        'because its customer lookup creates unknown customers.'
    );
    return 1;
  }
  if (
    !privileges ||
    privileges.professionalEntitlementStatus !== expectedProfessionalStatus ||
    privileges.aiEntitlementStatus !== expectedAiStatus
  ) {
    console.error('Canonical RevenueCat privileges do not match the expected live state.');
    return 1;
  }
  if (
    snapshot?.professional_entitlement_status !== expectedProfessionalStatus ||
    snapshot?.ai_entitlement_status !== expectedAiStatus
  ) {
    console.error('Production subscription snapshot did not converge before the deadline.');
    return 1;
  }
  if (!converged) {
    console.error(
      'RevenueCat privileges and the production snapshot did not converge in the same evidence iteration.'
    );
    return 1;
  }

  console.log(CONVERGED_MARKER);
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Refusal) {
    console.error(`Refusing live evidence verification: ${message}`);
    process.exitCode = 2;
  } else {
    console.error(`Live evidence verification failed: ${message}`);
    process.exitCode = 1;
  }
}
