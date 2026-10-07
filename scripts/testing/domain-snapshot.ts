import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import postgres from "postgres";
import {
  loadTestManifest,
  requireOwnedTestDatabase,
} from "../../tests/helpers/test-database";
import { assertTestDocument } from "./document-validation";
import type { ApplicationFixtures } from "./fixtures";

export type DomainSnapshot = {
  schemaVersion: 1;
  runId: string;
  scope: string;
  readOnly: true;
  trainingPlans: {
    id: string;
    studentAuthUid: string;
    ownerProfessionalUid: string | null;
    sourceKind: "predefined" | "assigned" | "self_managed";
    name: string | null;
    isArchived: boolean;
    isDraft: boolean;
    lifecycleConnectionId: string | null;
    createdAt: string;
    updatedAt: string;
    sessions: Record<string, unknown>[];
  }[];
  connections: {
    id: string;
    professionalAuthUid: string;
    studentAuthUid: string;
    status: "invited" | "pending_confirmation" | "active" | "ended";
    specialty: "nutritionist" | "fitness_coach";
    canceledReason: string | null;
    sourceInviteCodeId: string | null;
    sourceInviteCodeValue: string | null;
    createdAt: string;
    updatedAt: string;
    endedAt: string | null;
  }[];
};

export async function captureDomainSnapshot(
  scope: string,
  requestId: string,
  env: NodeJS.ProcessEnv,
) {
  if (!/^[a-z0-9-]{1,32}$/.test(scope) || !/^[a-z0-9-]{1,48}$/.test(requestId))
    throw new Error("Invalid snapshot identity");
  const manifest = loadTestManifest(env);
  if (!manifest.fixtureScopes.includes(scope))
    throw new Error("Snapshot scope was not seeded");
  const fixtures = JSON.parse(
    await readFile(
      path.join(manifest.artifactRoot, `fixtures-${scope}.private.json`),
      "utf8",
    ),
  ) as ApplicationFixtures;
  assertTestDocument("application-fixtures-v1", fixtures);
  if (fixtures.runId !== manifest.runId || fixtures.scope !== scope)
    throw new Error("Snapshot fixture identity mismatch");
  const uids = Object.values(fixtures.accounts).map(
    (account) => account.authUid,
  );
  const sql = postgres(await requireOwnedTestDatabase("DATABASE_URL", env), {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 5,
  });
  try {
    const snapshot = await sql.begin(
      "isolation level repeatable read read only",
      async (transaction) => {
        const [mode] = await transaction<
          { transaction_read_only: string }[]
        >`show transaction_read_only`;
        if (mode?.transaction_read_only !== "on")
          throw new Error("Snapshot transaction is not read-only");
        await transaction`set local statement_timeout = '5000ms'`;
        const trainingPlans = await transaction<
          DomainSnapshot["trainingPlans"]
        >`
        select id, student_auth_uid as "studentAuthUid", owner_professional_uid as "ownerProfessionalUid",
          source_kind as "sourceKind", name, is_archived as "isArchived", is_draft as "isDraft",
          lifecycle_connection_id as "lifecycleConnectionId", sessions,
          created_at::text as "createdAt", updated_at::text as "updatedAt"
        from training_plans
        where student_auth_uid in ${transaction(uids)} or owner_professional_uid in ${transaction(uids)}
        order by id limit 201`;
        const connections = await transaction<DomainSnapshot["connections"]>`
        select id, professional_auth_uid as "professionalAuthUid", student_auth_uid as "studentAuthUid", status, specialty,
          canceled_reason as "canceledReason", source_invite_code_id as "sourceInviteCodeId", source_invite_code_value as "sourceInviteCodeValue",
          created_at::text as "createdAt", updated_at::text as "updatedAt", ended_at::text as "endedAt"
        from connections
        where professional_auth_uid in ${transaction(uids)} and student_auth_uid in ${transaction(uids)}
        order by id limit 201`;
        if (trainingPlans.length > 200 || connections.length > 200)
          throw new Error("Snapshot row bound exceeded");
        return {
          schemaVersion: 1,
          runId: manifest.runId,
          scope,
          readOnly: true,
          trainingPlans: [...trainingPlans],
          connections: [...connections],
        };
      },
    );
    assertTestDocument("domain-snapshot-v1", snapshot);
    const snapshotRef = path.join(
      manifest.artifactRoot,
      `snapshot-${scope}-${requestId}.private.json`,
    );
    await writeFile(snapshotRef, JSON.stringify(snapshot), {
      mode: 0o600,
      flag: "wx",
    });
    return snapshotRef;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
