import { afterAll, describe, expect, it } from "bun:test";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDatabase } from "../src/db/client";
import {
  captureConnectionSnapshot,
  type ConnectionSnapshot,
} from "../scripts/testing/connection-snapshot";
import {
  assertApiProcessRecord,
  assertResourceManifest,
} from "../scripts/testing/document-validation";
import { seedApplicationFixtures } from "../scripts/testing/fixtures";
import {
  loadTestManifest,
  requireOwnedTestDatabase,
} from "./helpers/test-database";
import { startOwnedApiServer } from "./helpers/test-api-server";

type Session = { accessToken: string };

const database = createDatabase(await requireOwnedTestDatabase());
let server: Awaited<ReturnType<typeof startOwnedApiServer>> | undefined;

afterAll(async () => {
  await server?.stop();
  await database.close();
});

async function request<T>(
  method: string,
  route: string,
  body?: unknown,
  session?: Session,
) {
  if (!server) throw new Error("API not started");
  const response = await fetch(`${server.origin}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(session ? { authorization: `Bearer ${session.accessToken}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : null) as T,
  };
}

async function signIn(account: {
  email: string;
  password: string;
}): Promise<Session> {
  const response = await request<Session>("POST", "/auth/email/sign-in", {
    email: account.email,
    password: account.password,
    sessionMode: "bearer",
  });
  expect(response.status).toBe(201);
  return response.body;
}

async function readSnapshot(ref: string): Promise<ConnectionSnapshot> {
  return JSON.parse(await readFile(ref, "utf8")) as ConnectionSnapshot;
}

async function registerOwnedFixtureScopes(
  env: NodeJS.ProcessEnv,
  scopes: readonly string[],
) {
  if (
    scopes.length === 0 ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !/^[a-z0-9-]{1,32}$/.test(scope))
  )
    throw new Error("Invalid fixture scope registration");
  const manifest = loadTestManifest(env);
  const manifestPath = path.join(manifest.artifactRoot, "manifest.json");
  if (
    path.resolve(env.MC_TEST_MANIFEST ?? "") !== manifestPath ||
    manifest.artifactRoot !== path.dirname(manifestPath)
  )
    throw new Error("Fixture scope registration ownership mismatch");
  const next = {
    ...manifest,
    fixtureScopes: [...new Set([...manifest.fixtureScopes, ...scopes])].sort(),
  };
  assertResourceManifest(next);
  const temporary = `${manifestPath}.fixture-scopes.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  try {
    await rename(temporary, manifestPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function writeOwnedEvidence(name: string, value: unknown) {
  const manifest = loadTestManifest(process.env);
  await writeFile(
    path.join(manifest.artifactRoot, name),
    `${JSON.stringify(value, null, 2)}\n`,
    {
      mode: 0o600,
      flag: "wx",
    },
  );
}

function unrelatedRows(
  snapshot: ConnectionSnapshot,
  allowance: {
    connectionId: string;
    pendingGuardId: string;
    pendingStudentId: string;
    pendingStudentSlotId: string;
    pendingStudentSlotName: string;
    activeTrackingId: string;
    activeSpecialtyId: string;
    professionalAuthUid: string;
    studentAuthUid: string;
    specialty: "fitness_coach";
  },
) {
  return {
    userProfiles: snapshot.rows.userProfiles,
    professionalSpecialties: snapshot.rows.professionalSpecialties,
    inviteCodes: snapshot.rows.inviteCodes,
    connections: snapshot.rows.connections.filter(
      (row) =>
        !(
          row.id === allowance.connectionId &&
          row.professionalAuthUid === allowance.professionalAuthUid &&
          row.studentAuthUid === allowance.studentAuthUid &&
          row.specialty === allowance.specialty
        ),
    ),
    connectionInviteGuards: snapshot.rows.connectionInviteGuards.filter(
      (row) =>
        !(
          row.id === allowance.pendingGuardId &&
          row.connectionId === allowance.connectionId &&
          row.professionalAuthUid === allowance.professionalAuthUid &&
          row.studentAuthUid === allowance.studentAuthUid &&
          row.specialty === allowance.specialty
        ),
    ),
    pendingStudents: snapshot.rows.pendingStudents.filter(
      (row) =>
        !(
          row.id === allowance.pendingStudentId &&
          row.professionalAuthUid === allowance.professionalAuthUid &&
          row.studentAuthUid === allowance.studentAuthUid &&
          row.slotId === allowance.pendingStudentSlotName &&
          row.nutritionistConnectionId === null &&
          (row.fitnessCoachConnectionId === allowance.connectionId ||
            row.fitnessCoachConnectionId === null)
        ),
    ),
    pendingStudentSlots: snapshot.rows.pendingStudentSlots.filter(
      (row) =>
        !(
          row.id === allowance.pendingStudentSlotId &&
          row.professionalAuthUid === allowance.professionalAuthUid &&
          row.slotId === allowance.pendingStudentSlotName &&
          (row.studentAuthUid === allowance.studentAuthUid ||
            row.studentAuthUid === null)
        ),
    ),
    trackingAccess: snapshot.rows.trackingAccess.filter(
      (row) =>
        !(
          row.id === allowance.activeTrackingId &&
          row.connectionId === allowance.connectionId &&
          row.studentAuthUid === allowance.studentAuthUid &&
          row.professionalAuthUid === allowance.professionalAuthUid &&
          row.specialty === allowance.specialty
        ),
    ),
    activeSpecialties: snapshot.rows.activeSpecialties.filter(
      (row) =>
        !(
          row.id === allowance.activeSpecialtyId &&
          row.connectionId === allowance.connectionId &&
          row.studentAuthUid === allowance.studentAuthUid &&
          row.professionalAuthUid === allowance.professionalAuthUid &&
          row.specialty === allowance.specialty
        ),
    ),
  };
}

describe("connection snapshot public transition", () => {
  it("captures an unlinked baseline, normal pending/active API transitions and unchanged fixture state", async () => {
    const fixtures = await seedApplicationFixtures("connection-snapshot");
    const otherFixtures = await seedApplicationFixtures(
      "connection-snapshot-other",
    );
    await registerOwnedFixtureScopes(process.env, [
      "connection-snapshot",
      "connection-snapshot-other",
    ]);
    const otherBeforeRef = await captureConnectionSnapshot(
      "connection-snapshot-other",
      "before",
      process.env,
    );
    const otherBefore = await readSnapshot(otherBeforeRef);
    const api = await startOwnedApiServer("connection-snapshot");
    server = api;
    const manifest = loadTestManifest(process.env);
    const apiLedger = JSON.parse(
      await readFile(
        path.join(manifest.artifactRoot, "api-connection-snapshot.json"),
        "utf8",
      ),
    ) as unknown;
    assertApiProcessRecord(apiLedger);
    if (
      apiLedger.runId !== manifest.runId ||
      apiLedger.ownerTokenHash !== manifest.ownerTokenHash ||
      apiLedger.pid !== api.pid ||
      apiLedger.attempt !== "connection-snapshot" ||
      apiLedger.origin !== api.origin
    )
      throw new Error("Owned API ledger identity mismatch");
    await writeOwnedEvidence("connection-journey-api-evidence.private.json", {
      schemaVersion: 1,
      runId: manifest.runId,
      scope: "connection-snapshot",
      apiPid: apiLedger.pid,
      apiStarted: apiLedger.started,
      apiOrigin: apiLedger.origin,
    });
    const coach = await signIn(fixtures.accounts.coach);
    const student = await signIn(fixtures.accounts.student);

    const beforeRef = await captureConnectionSnapshot(
      "connection-snapshot",
      "before",
      process.env,
    );
    const before = await readSnapshot(beforeRef);
    expect(
      before.rows.connections.filter(
        (row) =>
          row.professionalAuthUid === before.target.professionalAuthUid &&
          row.studentAuthUid === before.target.studentAuthUid &&
          row.specialty === before.target.specialty,
      ),
    ).toHaveLength(0);

    const invite = await request<{
      inviteCode: { id: string; codeValue: string };
    }>("GET", "/professional/invite-codes/fitness_coach", undefined, coach);
    expect(invite.status).toBe(200);

    const submitted = await request<{ connectionId: string; status: string }>(
      "POST",
      "/connections/invite-submissions",
      { code: invite.body.inviteCode.codeValue },
      student,
    );
    expect(submitted.status).toBe(201);
    expect(submitted.body.status).toBe("pending_confirmation");

    const studentPending = await request<{
      connections: { id: string; status: string }[];
    }>("GET", "/connections", undefined, student);
    expect(studentPending.status).toBe(200);
    expect(
      studentPending.body.connections.some(
        (row) =>
          row.id === submitted.body.connectionId &&
          row.status === "pending_confirmation",
      ),
    ).toBe(true);
    const coachPending = await request<{
      students: { studentAuthUid: string }[];
    }>("GET", "/professional/students", undefined, coach);
    expect(coachPending.status).toBe(200);
    expect(
      coachPending.body.students.some(
        (row) => row.studentAuthUid === fixtures.accounts.student.authUid,
      ),
    ).toBe(true);

    const pendingRef = await captureConnectionSnapshot(
      "connection-snapshot",
      "pending",
      process.env,
    );
    const pending = await readSnapshot(pendingRef);
    const pendingConnection = pending.rows.connections.find(
      (row) => row.id === submitted.body.connectionId,
    );
    expect(pendingConnection?.status).toBe("pending_confirmation");
    expect(pendingConnection?.professionalAuthUid).toBe(
      fixtures.accounts.coach.authUid,
    );
    expect(pendingConnection?.studentAuthUid).toBe(
      fixtures.accounts.student.authUid,
    );
    expect(pendingConnection?.specialty).toBe("fitness_coach");
    expect(pendingConnection?.sourceInviteCodeId).toBe(
      invite.body.inviteCode.id,
    );
    expect(JSON.stringify(pending)).not.toContain(
      invite.body.inviteCode.codeValue,
    );
    const pendingGuards = pending.rows.connectionInviteGuards.filter(
      (row) => row.connectionId === submitted.body.connectionId,
    );
    expect(pendingGuards).toHaveLength(1);
    const pendingGuard = pendingGuards[0]!;
    expect(pendingGuard.professionalAuthUid).toBe(
      fixtures.accounts.coach.authUid,
    );
    expect(pendingGuard.studentAuthUid).toBe(fixtures.accounts.student.authUid);
    expect(pendingGuard.specialty).toBe("fitness_coach");
    expect(pendingGuard.status).toBe("pending_confirmation");
    const pendingStudents = pending.rows.pendingStudents.filter(
      (row) =>
        row.professionalAuthUid === fixtures.accounts.coach.authUid &&
        row.studentAuthUid === fixtures.accounts.student.authUid &&
        row.fitnessCoachConnectionId === submitted.body.connectionId,
    );
    expect(pendingStudents).toHaveLength(1);
    const pendingStudent = pendingStudents[0]!;
    expect(pendingStudent.nutritionistConnectionId).toBeNull();
    expect(pendingStudent.fitnessCoachConnectionId).toBe(
      submitted.body.connectionId,
    );
    const pendingSlot = pending.rows.pendingStudentSlots.find(
      (row) =>
        row.id ===
          `${fixtures.accounts.coach.authUid}_${pendingStudent.slotId}` &&
        row.professionalAuthUid === fixtures.accounts.coach.authUid &&
        row.slotId === pendingStudent.slotId &&
        row.studentAuthUid === fixtures.accounts.student.authUid,
    );
    expect(pendingSlot).toBeDefined();
    if (!pendingSlot)
      throw new Error("Pending connection slot was not observed");

    const confirmed = await request<{ connectionId: string; status: string }>(
      "POST",
      `/connections/${submitted.body.connectionId}/confirm`,
      {},
      coach,
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("active");

    const studentActive = await request<{
      connections: { id: string; status: string }[];
    }>("GET", "/connections", undefined, student);
    expect(studentActive.status).toBe(200);
    expect(
      studentActive.body.connections.some(
        (row) =>
          row.id === submitted.body.connectionId && row.status === "active",
      ),
    ).toBe(true);
    const coachActive = await request<{
      students: { studentAuthUid: string }[];
    }>("GET", "/professional/students", undefined, coach);
    expect(coachActive.status).toBe(200);
    expect(
      coachActive.body.students.some(
        (row) => row.studentAuthUid === fixtures.accounts.student.authUid,
      ),
    ).toBe(true);

    const activeRef = await captureConnectionSnapshot(
      "connection-snapshot",
      "active",
      process.env,
    );
    const active = await readSnapshot(activeRef);
    const otherAfterRef = await captureConnectionSnapshot(
      "connection-snapshot-other",
      "after",
      process.env,
    );
    const otherAfter = await readSnapshot(otherAfterRef);
    const activeConnection = active.rows.connections.find(
      (row) => row.id === submitted.body.connectionId,
    );
    expect(activeConnection?.status).toBe("active");
    expect(activeConnection?.professionalAuthUid).toBe(
      fixtures.accounts.coach.authUid,
    );
    expect(activeConnection?.studentAuthUid).toBe(
      fixtures.accounts.student.authUid,
    );
    expect(activeConnection?.specialty).toBe("fitness_coach");
    expect(activeConnection?.id).toBe(pendingConnection?.id);
    expect(activeConnection?.sourceInviteCodeId).toBe(
      invite.body.inviteCode.id,
    );
    expect(activeConnection?.sourceInviteCodeId).toBe(
      pendingConnection?.sourceInviteCodeId,
    );
    expect(activeConnection?.createdAt).toBe(pendingConnection?.createdAt);
    expect(
      Date.parse(activeConnection?.updatedAt ?? ""),
    ).toBeGreaterThanOrEqual(Date.parse(pendingConnection?.updatedAt ?? ""));
    expect(
      active.rows.connectionInviteGuards.filter(
        (row) => row.connectionId === submitted.body.connectionId,
      ),
    ).toHaveLength(0);
    const activePendingStudents = active.rows.pendingStudents.filter(
      (row) => row.id === pendingStudent.id,
    );
    expect(activePendingStudents).toHaveLength(1);
    const activePendingStudent = activePendingStudents[0]!;
    expect(activePendingStudent.professionalAuthUid).toBe(
      fixtures.accounts.coach.authUid,
    );
    expect(activePendingStudent.studentAuthUid).toBe(
      fixtures.accounts.student.authUid,
    );
    expect(activePendingStudent.slotId).toBe(pendingStudent.slotId);
    expect(activePendingStudent.nutritionistConnectionId).toBeNull();
    expect(activePendingStudent.fitnessCoachConnectionId).toBeNull();
    const activeSlots = active.rows.pendingStudentSlots.filter(
      (row) => row.id === pendingSlot!.id,
    );
    expect(activeSlots).toHaveLength(1);
    const activeSlot = activeSlots[0]!;
    expect(activeSlot.professionalAuthUid).toBe(
      fixtures.accounts.coach.authUid,
    );
    expect(activeSlot.slotId).toBe(pendingStudent.slotId);
    expect(activeSlot.studentAuthUid).toBeNull();
    const activeTrackingGrants = active.rows.trackingAccess.filter(
      (row) => row.connectionId === submitted.body.connectionId,
    );
    expect(activeTrackingGrants).toHaveLength(1);
    const activeTrackingGrant = activeTrackingGrants[0]!;
    expect(activeTrackingGrant.studentAuthUid).toBe(
      fixtures.accounts.student.authUid,
    );
    expect(activeTrackingGrant.professionalAuthUid).toBe(
      fixtures.accounts.coach.authUid,
    );
    expect(activeTrackingGrant.specialty).toBe("fitness_coach");
    expect(activeTrackingGrant.status).toBe("active");
    const activeSpecialtyGrants = active.rows.activeSpecialties.filter(
      (row) => row.connectionId === submitted.body.connectionId,
    );
    expect(activeSpecialtyGrants).toHaveLength(1);
    const activeSpecialtyGrant = activeSpecialtyGrants[0]!;
    expect(activeSpecialtyGrant.studentAuthUid).toBe(
      fixtures.accounts.student.authUid,
    );
    expect(activeSpecialtyGrant.professionalAuthUid).toBe(
      fixtures.accounts.coach.authUid,
    );
    expect(activeSpecialtyGrant.specialty).toBe("fitness_coach");
    expect(activeSpecialtyGrant.status).toBe("active");

    const allowance = {
      connectionId: submitted.body.connectionId,
      pendingGuardId: pendingGuard.id,
      pendingStudentId: pendingStudent.id,
      pendingStudentSlotId: pendingSlot!.id,
      pendingStudentSlotName: pendingStudent.slotId,
      activeTrackingId: activeTrackingGrant.id,
      activeSpecialtyId: activeSpecialtyGrant.id,
      professionalAuthUid: fixtures.accounts.coach.authUid,
      studentAuthUid: fixtures.accounts.student.authUid,
      specialty: "fitness_coach" as const,
    };
    expect(unrelatedRows(before, allowance)).toEqual(
      unrelatedRows(pending, allowance),
    );
    expect(unrelatedRows(pending, allowance)).toEqual(
      unrelatedRows(active, allowance),
    );
    const otherScopeUnchanged =
      JSON.stringify(otherAfter) === JSON.stringify(otherBefore);
    expect(otherScopeUnchanged).toBe(true);
    const otherAuthUids = Object.values(otherFixtures.accounts).map(
      (account) => account.authUid,
    );
    const mainSnapshots = JSON.stringify([before, pending, active]);
    for (const authUid of otherAuthUids)
      expect(mainSnapshots).not.toContain(authUid);
    await writeOwnedEvidence("connection-journey-evidence.private.json", {
      schemaVersion: 1,
      runId: manifest.runId,
      scope: "connection-snapshot",
      snapshotStages: {
        before: {
          rowCounts: before.rowCounts,
          targetConnectionStatus: null,
        },
        pending: {
          rowCounts: pending.rowCounts,
          targetConnectionStatus: pendingConnection?.status ?? null,
        },
        active: {
          rowCounts: active.rowCounts,
          targetConnectionStatus: activeConnection?.status ?? null,
        },
      },
      returnedConnectionId: submitted.body.connectionId,
      normalRouteStatuses: {
        inviteLookup: invite.status,
        submit: submitted.status,
        studentPendingList: studentPending.status,
        coachPendingList: coachPending.status,
        confirm: confirmed.status,
        studentActiveList: studentActive.status,
        coachActiveList: coachActive.status,
      },
      otherScopeUnchanged,
    });
  }, 60_000);
});
