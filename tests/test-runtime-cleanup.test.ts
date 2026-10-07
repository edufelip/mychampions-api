import { afterAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  cleanupOwnedRun,
  isOwnedPrivateArtifactName,
  requireOwnedComposeResource,
} from "../scripts/testing/cleanup";
import type { TestManifest } from "./helpers/test-database";
import { manifestFixture } from "./helpers/resource-manifest";

const runId = randomBytes(12).toString("hex");
const root = path.resolve(import.meta.dir, "../.qa/runtime", runId);
await mkdir(root, { recursive: true, mode: 0o700 });
const manifest: TestManifest = manifestFixture(runId, root, "unit-owner-proof");
const manifestPath = path.join(root, "manifest.json");
await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
afterAll(() => rm(root, { recursive: true, force: true }));

describe("fail-closed owned runtime cleanup", () => {
  it("allows only the bounded owned fixture/snapshot artifact names", () => {
    for (const name of [
      "fixtures-connection-1.private.json",
      "snapshot-connection-1.private.json",
      "connection-snapshot-connection-1.private.json",
    ])
      expect(isOwnedPrivateArtifactName(name)).toBe(true);
    for (const name of [
      "private.json",
      "connection-snapshot-connection-1.json",
      "connection-snapshot-../escape.private.json",
      "credentials-connection-1.private.json",
    ])
      expect(isOwnedPrivateArtifactName(name)).toBe(false);
  });
  it("bootstrap recovery requires full owner/run/project/service labels, never the project prefix alone", () => {
    const resource = {
      Id: "a".repeat(64),
      Config: {
        Labels: {
          "com.docker.compose.project": manifest.composeProject,
          "com.docker.compose.service": "postgres",
          "com.mychampions.test.run": manifest.runId,
          "com.mychampions.test.owner-hash": manifest.ownerTokenHash,
        },
      },
    };
    expect(requireOwnedComposeResource(resource, manifest, "container")).toBe(
      resource.Id,
    );
    for (const [key, value] of [
      ["com.docker.compose.project", "production"],
      ["com.docker.compose.service", "foreign"],
      ["com.mychampions.test.run", "b".repeat(24)],
      ["com.mychampions.test.owner-hash", "c".repeat(64)],
      ["com.mychampions.test.owner-hash", undefined],
    ])
      expect(() =>
        requireOwnedComposeResource(
          {
            ...resource,
            Config: { Labels: { ...resource.Config.Labels, [key!]: value } },
          },
          manifest,
          "container",
        ),
      ).toThrow("ownership mismatch");
    expect(() =>
      requireOwnedComposeResource(
        resource,
        { ...manifest, containerId: "b".repeat(64) },
        "container",
      ),
    ).toThrow("ownership mismatch");
  });
  it("network-only bootstrap recovery rejects an unowned/default-name-only network", () => {
    const resource = {
      Id: "d".repeat(64),
      Labels: {
        "com.docker.compose.project": manifest.composeProject,
        "com.docker.compose.network": "default",
        "com.mychampions.test.run": manifest.runId,
        "com.mychampions.test.owner-hash": manifest.ownerTokenHash,
      },
    };
    expect(requireOwnedComposeResource(resource, manifest, "network")).toBe(
      resource.Id,
    );
    expect(() =>
      requireOwnedComposeResource(
        {
          ...resource,
          Labels: {
            ...resource.Labels,
            "com.mychampions.test.owner-hash": undefined,
          },
        },
        manifest,
        "network",
      ),
    ).toThrow("ownership mismatch");
    expect(() =>
      requireOwnedComposeResource(
        {
          ...resource,
          Labels: {
            ...resource.Labels,
            "com.docker.compose.network": "foreign",
          },
        },
        manifest,
        "network",
      ),
    ).toThrow("ownership mismatch");
  });
  it("rejects a mismatched Compose project before querying or deleting Docker resources", async () => {
    await expect(
      cleanupOwnedRun(
        { ...manifest, composeProject: "production-project" },
        manifestPath,
      ),
    ).rejects.toThrow("Cleanup manifest ownership mismatch");
    expect(
      JSON.parse(await readFile(manifestPath, "utf8")).composeProject,
    ).toBe(manifest.composeProject);
  });
  it("refuses a reused/foreign API PID and retains its recovery record", async () => {
    const ledger = path.join(root, "api-negative.json");
    const record = {
      schemaVersion: 1,
      runId,
      ownerTokenHash: manifest.ownerTokenHash,
      pid: process.pid,
      started: "wrong-process-start-time",
      script: "/foreign-script",
      attempt: "negative",
      origin: "http://127.0.0.1:42001",
    };
    await writeFile(ledger, JSON.stringify(record), { mode: 0o600 });
    await expect(cleanupOwnedRun(manifest, manifestPath)).rejects.toThrow(
      "API PID identity changed",
    );
    expect(JSON.parse(await readFile(ledger, "utf8")).pid).toBe(process.pid);
    expect(process.kill(process.pid, 0)).toBe(true);
  });
  it("an empty successful process query retains the API ledger without invoking Docker", async () => {
    const binaryRoot = path.join(root, "ambiguous-process-bin");
    await mkdir(binaryRoot, { mode: 0o700 });
    const marker = path.join(root, "docker-was-invoked");
    await writeFile(path.join(binaryRoot, "ps"), "#!/bin/sh\nexit 0\n", {
      mode: 0o700,
    });
    await writeFile(
      path.join(binaryRoot, "docker"),
      '#!/bin/sh\n: > "$MC_QUERY_MARKER"\nexit 90\n',
      { mode: 0o700 },
    );
    const ledger = path.join(root, "api-negative.json");
    const record = {
      schemaVersion: 1,
      runId,
      ownerTokenHash: manifest.ownerTokenHash,
      pid: process.pid,
      started: "ambiguous-process-start",
      script: "/unknown-script",
      attempt: "negative",
      origin: "http://127.0.0.1:42001",
    };
    await writeFile(ledger, JSON.stringify(record), { mode: 0o600 });
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        'import { cleanupOwnedRun } from "./scripts/testing/cleanup.ts"; import { loadTestManifest } from "./tests/helpers/test-database.ts"; await cleanupOwnedRun(loadTestManifest(), process.env.MC_TEST_MANIFEST);',
      ],
      {
        cwd: path.resolve(import.meta.dir, ".."),
        env: {
          PATH: binaryRoot,
          MC_TEST_MANIFEST: manifestPath,
          MC_QUERY_MARKER: marker,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const [, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).not.toBe(0);
      expect(stderr).toContain("Process identity query");
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse(await readFile(ledger, "utf8")).pid).toBe(process.pid);
      expect(process.kill(process.pid, 0)).toBe(true);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await child.exited;
    }
  });
});
