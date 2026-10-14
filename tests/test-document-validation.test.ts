import { describe, expect, it } from "bun:test";
import {
  assertResourceManifest,
  assertApiProcessRecord,
  assertTestDocument,
  retainManifestProcessHistory,
} from "../scripts/testing/document-validation";
import { manifestFixture } from "./helpers/resource-manifest";

describe("owned test document validation before consumption", () => {
  it("retains stopped API identities through restart and terminal release without mutating prior records", () => {
    const manifest = manifestFixture(
      "a".repeat(24),
      "/owned/runtime",
      "owner-token",
    );
    const owner = manifest.processes[0]!;
    const first = {
      role: "api" as const,
      pid: 1234,
      started: "first-start",
      script: "/owned/serve.ts",
    };
    const second = { ...first, pid: 1235, started: "second-start" };
    const original = structuredClone(manifest);
    const acquired = retainManifestProcessHistory(manifest, [owner, first]);
    const restarted = retainManifestProcessHistory(
      { ...manifest, processes: acquired },
      [owner, second],
    );
    const terminal = retainManifestProcessHistory(
      { ...manifest, phase: "cleanup", processes: restarted },
      [owner],
    );
    expect(terminal).toEqual([owner, first, second]);
    expect(manifest).toEqual(original);
    terminal[1]!.script = "/changed";
    expect(acquired[1]!.script).toBe("/owned/serve.ts");
  });
  it("rejects reused or changed identities and malformed history instead of overwriting it", () => {
    const manifest = manifestFixture(
      "a".repeat(24),
      "/owned/runtime",
      "owner-token",
    );
    const first = {
      role: "api" as const,
      pid: 1234,
      started: "first-start",
      script: "/owned/serve.ts",
    };
    manifest.processes.push(first);
    const original = structuredClone(manifest);
    for (const changed of [
      { ...first, started: "different-start" },
      { ...first, script: "/different" },
      { ...first, role: "test" as const },
      { ...first, hiddenCredential: "never-output" },
    ])
      expect(() => retainManifestProcessHistory(manifest, [changed])).toThrow(
        "identity changed",
      );
    expect(() =>
      retainManifestProcessHistory(manifest, [
        { ...first, pid: 1235, started: "" },
      ]),
    ).toThrow();
    expect(manifest).toEqual(original);
  });
  it("acquired declares private ownership without claiming an API or accepting hidden fields", () => {
    const acquired = {
      schemaVersion: 1,
      event: "acquired",
      runId: "a".repeat(24),
      manifestPath: "/owned/manifest.json",
    };
    expect(() =>
      assertTestDocument("session-event-v1", acquired),
    ).not.toThrow();
    expect(() =>
      assertTestDocument("session-event-v1", {
        ...acquired,
        apiOrigin: "http://127.0.0.1:42001",
      }),
    ).toThrow();
    expect(() =>
      assertTestDocument("session-event-v1", { ...acquired, runId: "wrong" }),
    ).toThrow();
  });
  it("rejects unsupported versions, hidden credentials and incomplete ownership fields", () => {
    const manifest = manifestFixture(
      "a".repeat(24),
      "/owned/runtime",
      "owner-token",
    );
    expect(() => assertResourceManifest(manifest)).not.toThrow();
    for (const invalid of [
      { ...manifest, schemaVersion: 2 },
      { ...manifest, processes: [] },
      { ...manifest, ownerToken: "secret" },
      { ...manifest, repoRoot: undefined },
      { ...manifest, createdAt: "not-a-date" },
    ])
      expect(() => assertResourceManifest(invalid)).toThrow();
  });
  it("rejects inconsistent run targets and duplicated/stale process ownership metadata", () => {
    const manifest = manifestFixture(
      "a".repeat(24),
      "/owned/runtime",
      "owner-token",
    );
    for (const invalid of [
      {
        ...manifest,
        targets: {
          ...manifest.targets,
          DATABASE_URL: `mc_test_${"b".repeat(24)}`,
        },
      },
      { ...manifest, orchestratorPid: 99999 },
      {
        ...manifest,
        processes: [...manifest.processes, ...manifest.processes],
      },
    ])
      expect(() => assertResourceManifest(invalid)).toThrow(
        "identity fields disagree",
      );
  });
  it("domain snapshots reject write mode, unexpected private data and unbounded results", () => {
    const row = {
      schemaVersion: 1,
      runId: "a".repeat(24),
      scope: "training-1",
      readOnly: true,
      trainingPlans: [],
      connections: [],
    };
    expect(() => assertTestDocument("domain-snapshot-v1", row)).not.toThrow();
    for (const invalid of [
      { ...row, readOnly: false },
      { ...row, password: "very-private-value" },
      { ...row, scope: "../escape" },
      { ...row, connections: Array(201).fill({}) },
    ])
      expect(() => assertTestDocument("domain-snapshot-v1", invalid)).toThrow();
  });
  it("connection snapshots validate the nine-table read-only projection without phase or invite values", () => {
    const emptyRows = {
      userProfiles: [],
      professionalSpecialties: [],
      inviteCodes: [],
      connections: [],
      connectionInviteGuards: [],
      pendingStudents: [],
      pendingStudentSlots: [],
      trackingAccess: [],
      activeSpecialties: [],
    };
    const snapshot = {
      schemaVersion: 1,
      kind: "connection-snapshot-v1",
      runId: "a".repeat(24),
      scope: "connection-1",
      readOnly: true,
      fixtureAuthUids: ["coach", "student"],
      target: {
        professionalAuthUid: "coach",
        studentAuthUid: "student",
        specialty: "fitness_coach",
      },
      rowCounts: {
        userProfiles: 0,
        professionalSpecialties: 0,
        inviteCodes: 0,
        connections: 0,
        connectionInviteGuards: 0,
        pendingStudents: 0,
        pendingStudentSlots: 0,
        trackingAccess: 0,
        activeSpecialties: 0,
      },
      rows: emptyRows,
    };
    expect(() =>
      assertTestDocument("connection-snapshot-v1", snapshot),
    ).not.toThrow();
    for (const invalid of [
      { ...snapshot, phase: "pending_confirmation" },
      { ...snapshot, rowCounts: { ...snapshot.rowCounts, connections: 201 } },
      {
        ...snapshot,
        rows: { ...emptyRows, inviteCodes: [{ codeValue: "private" }] },
      },
      { ...snapshot, kind: "domain-snapshot-v1" },
    ])
      expect(() =>
        assertTestDocument("connection-snapshot-v1", invalid),
      ).toThrow();
    expect(() =>
      assertTestDocument("session-event-v1", {
        schemaVersion: 1,
        id: "connection-snapshot-1",
        event: "connection-snapshotted",
        snapshotRef: "/owned/connection-snapshot-connection-1-private.json",
      }),
    ).not.toThrow();
  });
  it("session receipts accept completed connection snapshots alongside legacy operations", () => {
    const receipt = {
      schemaVersion: 1,
      runId: "a".repeat(24),
      repositories: {
        server: {
          sha: "b".repeat(40),
          dirty: false,
          workingTreeHash: "c".repeat(64),
        },
        client: {
          sha: "d".repeat(40),
          dirty: false,
          workingTreeHash: "e".repeat(64),
        },
      },
      startedAt: "2026-10-01T00:00:00.000Z",
      finishedAt: "2026-10-01T00:00:01.000Z",
      requests: [
        { id: "seed-1", op: "seed", outcome: "completed" },
        { id: "snapshot-1", op: "snapshot", outcome: "completed" },
        {
          id: "connection-snapshot-1",
          op: "connection-snapshot",
          outcome: "completed",
        },
        { id: "restart-1", op: "restart", outcome: "completed" },
        { id: "stop-1", op: "stop", outcome: "completed" },
      ],
      result: "passed",
      reason: null,
      cleanup: "cleaned",
      error: null,
      exitCode: 0,
    };
    expect(() =>
      assertTestDocument("session-receipt-v1", receipt),
    ).not.toThrow();
    expect(() =>
      assertTestDocument("session-receipt-v1", {
        ...receipt,
        requests: [
          ...receipt.requests,
          { id: "unsupported-1", op: "phase", outcome: "completed" },
        ],
      }),
    ).toThrow();
  });
  it("API ledgers require a bounded local origin and do not leak bad input in diagnostics", () => {
    const row = {
      schemaVersion: 1,
      runId: "a".repeat(24),
      ownerTokenHash: "b".repeat(64),
      pid: 1234,
      started: "known",
      script: "/owned/serve.ts",
      attempt: "one",
      origin: "http://127.0.0.1:42001",
    };
    expect(() => assertApiProcessRecord(row)).not.toThrow();
    for (const origin of ["https://example.com", "http://127.0.0.1:99999"])
      expect(() => assertApiProcessRecord({ ...row, origin })).toThrow();
    try {
      assertApiProcessRecord({ ...row, privatePassword: "very-private-value" });
      throw new Error("Validation must reject");
    } catch (error) {
      expect(String(error)).not.toContain("very-private-value");
    }
    expect(() => assertTestDocument("../not-a-schema", {})).toThrow("Unknown");
  });
});
