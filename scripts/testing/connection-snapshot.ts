import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import postgres from "postgres";
import {
  loadTestManifest,
  requireOwnedTestDatabase,
} from "../../tests/helpers/test-database";
import { assertTestDocument } from "./document-validation";
import type { ApplicationFixtures } from "./fixtures";

type IsoTimestamp = string;
type Specialty = "nutritionist" | "fitness_coach";
type ConnectionStatus = "invited" | "pending_confirmation" | "active" | "ended";

export type ConnectionSnapshot = {
  schemaVersion: 1;
  kind: "connection-snapshot-v1";
  runId: string;
  scope: string;
  readOnly: true;
  fixtureAuthUids: string[];
  target: {
    professionalAuthUid: string;
    studentAuthUid: string;
    specialty: "fitness_coach";
  };
  rowCounts: {
    userProfiles: number;
    professionalSpecialties: number;
    inviteCodes: number;
    connections: number;
    connectionInviteGuards: number;
    pendingStudents: number;
    pendingStudentSlots: number;
    trackingAccess: number;
    activeSpecialties: number;
  };
  rows: {
    userProfiles: {
      authUid: string;
      lockedRole: "student" | "professional" | null;
      acceptedTermsVersion: string | null;
      createdAt: IsoTimestamp;
      updatedAt: IsoTimestamp;
    }[];
    professionalSpecialties: {
      id: string;
      professionalAuthUid: string;
      specialty: Specialty;
      isActive: boolean;
      createdAt: IsoTimestamp;
      updatedAt: IsoTimestamp;
    }[];
    inviteCodes: {
      id: string;
      professionalAuthUid: string;
      specialty: Specialty;
      status: "active" | "rotated" | "revoked";
      createdAt: IsoTimestamp;
      updatedAt: IsoTimestamp;
      rotatedAt: IsoTimestamp | null;
    }[];
    connections: {
      id: string;
      professionalAuthUid: string;
      studentAuthUid: string;
      status: ConnectionStatus;
      specialty: Specialty;
      canceledReason: "code_rotated" | null;
      sourceInviteCodeId: string | null;
      createdAt: IsoTimestamp;
      updatedAt: IsoTimestamp;
      endedAt: IsoTimestamp | null;
    }[];
    connectionInviteGuards: {
      id: string;
      connectionId: string;
      professionalAuthUid: string;
      studentAuthUid: string;
      specialty: Specialty;
      status: "pending_confirmation";
      createdAt: IsoTimestamp;
      updatedAt: IsoTimestamp;
    }[];
    pendingStudents: {
      id: string;
      professionalAuthUid: string;
      studentAuthUid: string;
      slotId: string;
      nutritionistConnectionId: string | null;
      fitnessCoachConnectionId: string | null;
      createdAt: IsoTimestamp;
      updatedAt: IsoTimestamp;
    }[];
    pendingStudentSlots: {
      id: string;
      professionalAuthUid: string;
      slotId: string;
      studentAuthUid: string | null;
      updatedAt: IsoTimestamp;
    }[];
    trackingAccess: {
      id: string;
      studentAuthUid: string;
      professionalAuthUid: string;
      specialty: Specialty;
      connectionId: string;
      status: "active" | "ended";
      updatedAt: IsoTimestamp;
    }[];
    activeSpecialties: {
      id: string;
      studentAuthUid: string;
      professionalAuthUid: string;
      specialty: Specialty;
      connectionId: string;
      status: "active" | "ended";
      updatedAt: IsoTimestamp;
    }[];
  };
};

// Scope specialty/invite rows to fixture professional owners. Relationship and
// auxiliary rows also include selected connection IDs so a corrupt foreign
// endpoint cannot hide a guard, pending allocation, access row or specialty row.
// The artifact is intentionally independent of the generic domain snapshot.

function validateIdentity(scope: string, requestId: string): void {
  if (!/^[a-z0-9-]{1,32}$/.test(scope) || !/^[a-z0-9-]{1,48}$/.test(requestId))
    throw new Error("Invalid connection snapshot identity");
}

export async function captureConnectionSnapshot(
  scope: string,
  requestId: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  validateIdentity(scope, requestId);
  const manifest = loadTestManifest(env);
  if (!manifest.fixtureScopes.includes(scope))
    throw new Error("Connection snapshot scope was not seeded");

  const fixtures = JSON.parse(
    await readFile(
      path.join(manifest.artifactRoot, `fixtures-${scope}.private.json`),
      "utf8",
    ),
  ) as ApplicationFixtures;
  assertTestDocument("application-fixtures-v1", fixtures);
  if (fixtures.runId !== manifest.runId || fixtures.scope !== scope)
    throw new Error("Connection snapshot fixture identity mismatch");

  const fixtureAuthUids = Object.values(fixtures.accounts)
    .map((account) => account.authUid)
    .sort();
  if (new Set(fixtureAuthUids).size !== fixtureAuthUids.length)
    throw new Error("Connection snapshot fixture UIDs are not unique");

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
          throw new Error("Connection snapshot transaction is not read-only");
        await transaction`set local statement_timeout = '5000ms'`;

        const userProfiles = await transaction<
          ConnectionSnapshot["rows"]["userProfiles"]
        >`
          select auth_uid as "authUid",
            locked_role as "lockedRole",
            accepted_terms_version as "acceptedTermsVersion",
            created_at::text as "createdAt",
            updated_at::text as "updatedAt"
          from user_profiles
          where auth_uid in ${transaction(fixtureAuthUids)}
          order by auth_uid collate "C"
          limit 201`;
        const professionalSpecialties = await transaction<
          ConnectionSnapshot["rows"]["professionalSpecialties"]
        >`
          select id,
            professional_auth_uid as "professionalAuthUid",
            specialty,
            is_active as "isActive",
            created_at::text as "createdAt",
            updated_at::text as "updatedAt"
          from professional_specialties
          where professional_auth_uid in ${transaction(fixtureAuthUids)}
          order by id collate "C"
          limit 201`;
        const inviteCodes = await transaction<
          ConnectionSnapshot["rows"]["inviteCodes"]
        >`
          select id,
            professional_auth_uid as "professionalAuthUid",
            specialty,
            status,
            created_at::text as "createdAt",
            updated_at::text as "updatedAt",
            rotated_at::text as "rotatedAt"
          from invite_codes
          where professional_auth_uid in ${transaction(fixtureAuthUids)}
          order by id collate "C"
          limit 201`;
        const connections = await transaction<
          ConnectionSnapshot["rows"]["connections"]
        >`
          select id,
            professional_auth_uid as "professionalAuthUid",
            student_auth_uid as "studentAuthUid",
            status,
            specialty,
            canceled_reason as "canceledReason",
            source_invite_code_id as "sourceInviteCodeId",
            created_at::text as "createdAt",
            updated_at::text as "updatedAt",
            ended_at::text as "endedAt"
          from connections
          where professional_auth_uid in ${transaction(fixtureAuthUids)}
             or student_auth_uid in ${transaction(fixtureAuthUids)}
          order by id collate "C"
          limit 201`;
        const selectedConnectionIds = connections.map((row) => row.id);
        const connectionIdPredicate = selectedConnectionIds.length
          ? transaction`connection_id in ${transaction(selectedConnectionIds)}`
          : transaction`false`;
        const pendingConnectionPredicate = selectedConnectionIds.length
          ? transaction`
              nutritionist_connection_id in ${transaction(selectedConnectionIds)}
              or fitness_coach_connection_id in ${transaction(selectedConnectionIds)}
            `
          : transaction`false`;
        const connectionInviteGuards = await transaction<
          ConnectionSnapshot["rows"]["connectionInviteGuards"]
        >`
          select id,
            connection_id as "connectionId",
            professional_auth_uid as "professionalAuthUid",
            student_auth_uid as "studentAuthUid",
            specialty,
            status,
            created_at::text as "createdAt",
            updated_at::text as "updatedAt"
          from connection_invite_guards
          where professional_auth_uid in ${transaction(fixtureAuthUids)}
             or student_auth_uid in ${transaction(fixtureAuthUids)}
             or ${connectionIdPredicate}
          order by id collate "C"
          limit 201`;
        const pendingStudents = await transaction<
          ConnectionSnapshot["rows"]["pendingStudents"]
        >`
          select id,
            professional_auth_uid as "professionalAuthUid",
            student_auth_uid as "studentAuthUid",
            slot_id as "slotId",
            nutritionist_connection_id as "nutritionistConnectionId",
            fitness_coach_connection_id as "fitnessCoachConnectionId",
            created_at::text as "createdAt",
            updated_at::text as "updatedAt"
          from pending_students
          where professional_auth_uid in ${transaction(fixtureAuthUids)}
             or student_auth_uid in ${transaction(fixtureAuthUids)}
             or ${pendingConnectionPredicate}
          order by id collate "C"
          limit 201`;
        const selectedPendingSlotIds = pendingStudents.map(
          (row) => `${row.professionalAuthUid}_${row.slotId}`,
        );
        const pendingSlotPredicate = selectedPendingSlotIds.length
          ? transaction`id in ${transaction(selectedPendingSlotIds)}`
          : transaction`false`;
        const pendingStudentSlots = await transaction<
          ConnectionSnapshot["rows"]["pendingStudentSlots"]
        >`
          select id,
            professional_auth_uid as "professionalAuthUid",
            slot_id as "slotId",
            student_auth_uid as "studentAuthUid",
            updated_at::text as "updatedAt"
          from pending_student_slots
          where professional_auth_uid in ${transaction(fixtureAuthUids)}
             or student_auth_uid in ${transaction(fixtureAuthUids)}
             or ${pendingSlotPredicate}
          order by id collate "C"
          limit 201`;
        const trackingAccess = await transaction<
          ConnectionSnapshot["rows"]["trackingAccess"]
        >`
          select id,
            student_auth_uid as "studentAuthUid",
            professional_auth_uid as "professionalAuthUid",
            specialty,
            connection_id as "connectionId",
            status,
            updated_at::text as "updatedAt"
          from tracking_access
          where professional_auth_uid in ${transaction(fixtureAuthUids)}
             or student_auth_uid in ${transaction(fixtureAuthUids)}
             or ${connectionIdPredicate}
          order by id collate "C"
          limit 201`;
        const activeSpecialties = await transaction<
          ConnectionSnapshot["rows"]["activeSpecialties"]
        >`
          select id,
            student_auth_uid as "studentAuthUid",
            professional_auth_uid as "professionalAuthUid",
            specialty,
            connection_id as "connectionId",
            status,
            updated_at::text as "updatedAt"
          from active_specialties
          where professional_auth_uid in ${transaction(fixtureAuthUids)}
             or student_auth_uid in ${transaction(fixtureAuthUids)}
             or ${connectionIdPredicate}
          order by id collate "C"
          limit 201`;

        const rows = {
          userProfiles: [...userProfiles],
          professionalSpecialties: [...professionalSpecialties],
          inviteCodes: [...inviteCodes],
          connections: [...connections],
          connectionInviteGuards: [...connectionInviteGuards],
          pendingStudents: [...pendingStudents],
          pendingStudentSlots: [...pendingStudentSlots],
          trackingAccess: [...trackingAccess],
          activeSpecialties: [...activeSpecialties],
        } satisfies ConnectionSnapshot["rows"];
        const rowCounts = Object.fromEntries(
          Object.entries(rows).map(([name, values]) => [name, values.length]),
        ) as ConnectionSnapshot["rowCounts"];
        if (Object.values(rowCounts).some((count) => count > 200))
          throw new Error("Connection snapshot row bound exceeded");

        const snapshot: ConnectionSnapshot = {
          schemaVersion: 1,
          kind: "connection-snapshot-v1",
          runId: manifest.runId,
          scope,
          readOnly: true,
          fixtureAuthUids,
          target: {
            professionalAuthUid: fixtures.accounts.coach.authUid,
            studentAuthUid: fixtures.accounts.student.authUid,
            specialty: "fitness_coach",
          },
          rowCounts,
          rows,
        };
        assertTestDocument("connection-snapshot-v1", snapshot);
        return snapshot;
      },
    );
    const snapshotRef = path.join(
      manifest.artifactRoot,
      `connection-snapshot-${scope}-${requestId}.private.json`,
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
