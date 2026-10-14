import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { queryOwnedProcess } from "./process-query";
import {
  loadTestManifest,
  type TestManifest,
} from "../../tests/helpers/test-database";
import {
  assertApiProcessRecord,
  assertResourceManifest,
} from "./document-validation";

export function isOwnedPrivateArtifactName(name: string): boolean {
  return /^(?:fixtures|snapshot|connection-snapshot)-[a-z0-9-]+\.private\.json$/.test(
    name,
  );
}

export function requireOwnedComposeResource(
  value: unknown,
  manifest: TestManifest,
  kind: "container" | "network",
): string {
  const row = value as {
    Id?: unknown;
    Labels?: Record<string, unknown>;
    Config?: { Labels?: Record<string, unknown> };
  } | null;
  const labels = kind === "container" ? row?.Config?.Labels : row?.Labels;
  if (
    !row ||
    typeof row.Id !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.Id) ||
    labels?.["com.docker.compose.project"] !== manifest.composeProject ||
    labels?.["com.mychampions.test.run"] !== manifest.runId ||
    labels?.["com.mychampions.test.owner-hash"] !== manifest.ownerTokenHash ||
    (kind === "container" &&
      (labels["com.docker.compose.service"] !== "postgres" ||
        (manifest.containerId !== null && manifest.containerId !== row.Id))) ||
    (kind === "network" && labels["com.docker.compose.network"] !== "default")
  )
    throw new Error(
      "Compose resource ownership mismatch; recovery ledger retained",
    );
  return row.Id;
}

export async function cleanupOwnedRun(
  manifest: TestManifest,
  manifestPath: string,
) {
  const diskManifest = loadTestManifest({ MC_TEST_MANIFEST: manifestPath });
  if (
    !/^[a-f0-9]{24}$/.test(manifest.runId) ||
    manifest.composeProject !== `mc_test_${manifest.runId}` ||
    manifest.runId !== diskManifest.runId ||
    manifest.ownerTokenHash !== diskManifest.ownerTokenHash ||
    manifest.containerId !== diskManifest.containerId
  )
    throw new Error("Cleanup manifest ownership mismatch");
  const runRoot = path.dirname(manifestPath);
  for (const name of (await readdir(runRoot)).filter((file) =>
    /^api-[a-z0-9-]+\.json$/.test(file),
  )) {
    const ledgerPath = path.join(runRoot, name);
    const record = JSON.parse(await readFile(ledgerPath, "utf8"));
    assertApiProcessRecord(record);
    if (
      record.runId !== manifest.runId ||
      record.ownerTokenHash !== manifest.ownerTokenHash ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 1
    )
      throw new Error(
        "Invalid API ownership record; preserving recovery evidence",
      );
    const currentStart = await queryOwnedProcess(record.pid, "lstart");
    if (currentStart !== undefined) {
      const command = await queryOwnedProcess(record.pid, "command");
      if (
        currentStart !== record.started ||
        !command?.includes(
          `${record.script} --run-id ${manifest.runId} --attempt ${record.attempt}`,
        )
      )
        throw new Error(
          "API PID identity changed; refusing to signal a foreign process",
        );
      process.kill(record.pid, "SIGTERM");
      const deadline = Date.now() + 10_000;
      let active = true;
      while (Date.now() < deadline) {
        const status = await queryOwnedProcess(record.pid, "stat");
        if (status === undefined || status.startsWith("Z")) {
          active = false;
          break;
        }
        await Bun.sleep(25);
      }
      if (active)
        throw new Error(
          "Owned API process did not stop; recovery record retained",
        );
    }
    await rm(ledgerPath, { force: true });
  }
  const privateEnvPath = path.join(path.dirname(manifestPath), "compose.env");
  const ids = Bun.spawnSync(
    [
      "docker",
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${manifest.composeProject}`,
    ],
    { timeout: 15_000, killSignal: "SIGKILL" },
  );
  if (ids.exitCode !== 0)
    throw new Error(
      "Cannot inspect owned containers; retaining recovery ledger.",
    );
  const containers = ids.stdout.toString().trim().split("\n").filter(Boolean);
  const networkIds = Bun.spawnSync(
    [
      "docker",
      "network",
      "ls",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${manifest.composeProject}`,
    ],
    { timeout: 15_000, killSignal: "SIGKILL" },
  );
  if (networkIds.exitCode !== 0)
    throw new Error(
      "Cannot inspect owned networks; retaining recovery ledger.",
    );
  const networks = networkIds.stdout
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
  if (containers.length > 1 || networks.length > 1)
    throw new Error(
      "Container ownership changed; retaining recovery ledger without deleting resources.",
    );
  let recoveredContainer: string | undefined;
  for (const [kind, resources] of [
    ["container", containers],
    ["network", networks],
  ] as const) {
    for (const id of resources) {
      const inspected = Bun.spawnSync(
        ["docker", ...(kind === "network" ? ["network"] : []), "inspect", id],
        { timeout: 15_000, killSignal: "SIGKILL" },
      );
      if (inspected.exitCode !== 0)
        throw new Error(
          "Cannot verify Compose resource ownership; recovery retained",
        );
      const values = JSON.parse(inspected.stdout.toString()) as unknown[];
      if (values.length !== 1)
        throw new Error("Unexpected Compose inspection result");
      const ownedId = requireOwnedComposeResource(values[0], manifest, kind);
      if (!ownedId.startsWith(id))
        throw new Error(
          "Compose inspection ID differs from requested resource",
        );
      if (kind === "container") recoveredContainer = ownedId;
    }
  }
  if (recoveredContainer && !manifest.containerId) {
    // Only the independently verified full owner labels permit bootstrap recovery.
    manifest.containerId = recoveredContainer;
    assertResourceManifest(manifest);
    const temporary = `${manifestPath}.tmp`;
    await writeFile(temporary, JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });
    await rename(temporary, manifestPath);
  }
  if (containers.length || networks.length) {
    const result = Bun.spawnSync(
      [
        "docker",
        "compose",
        "--env-file",
        privateEnvPath,
        "-p",
        manifest.composeProject,
        "-f",
        "infra/docker-compose.test.yml",
        "down",
        "--volumes",
        "--remove-orphans",
      ],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
        killSignal: "SIGKILL",
      },
    );
    if (result.exitCode !== 0)
      throw new Error(
        "Owned Compose cleanup failed; retaining recovery ledger.",
      );
  }
  for (const args of [
    ["ps", "-aq"],
    ["network", "ls", "-q"],
  ]) {
    const remaining = Bun.spawnSync(
      [
        "docker",
        ...args,
        "--filter",
        `label=com.docker.compose.project=${manifest.composeProject}`,
      ],
      { timeout: 15_000, killSignal: "SIGKILL" },
    );
    if (remaining.exitCode !== 0 || remaining.stdout.toString().trim())
      throw new Error(
        "Owned Compose resources survived cleanup; recovery ledger retained",
      );
  }
  await writeFile(
    path.join(path.dirname(manifestPath), "cleanup.json"),
    JSON.stringify(
      {
        status: "cleaned",
        runId: manifest.runId,
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await Promise.all(
    ["private.json", "compose.env"].map((name) =>
      rm(path.join(path.dirname(manifestPath), name), { force: true }),
    ),
  );
  await Promise.all(
    (await readdir(runRoot))
      .filter(isOwnedPrivateArtifactName)
      .map((name) => rm(path.join(runRoot, name), { force: true })),
  );
  await rm(path.join(runRoot, "storage"), { recursive: true, force: true });
}

if (import.meta.main) {
  try {
    const manifest = loadTestManifest();
    // Require the private owner proof even though cleanup does not issue SQL.
    const { createHash } = await import("node:crypto");
    const privateEnv = await readFile(
      path.join(path.dirname(process.env.MC_TEST_MANIFEST!), "private.json"),
      "utf8",
    );
    const env = JSON.parse(privateEnv);
    if (
      createHash("sha256")
        .update(env.MC_TEST_OWNER_TOKEN ?? "")
        .digest("hex") !== manifest.ownerTokenHash
    )
      throw new Error("Missing cleanup owner proof.");
    await cleanupOwnedRun(manifest, process.env.MC_TEST_MANIFEST!);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Cleanup failed");
    process.exitCode = 2;
  }
}
