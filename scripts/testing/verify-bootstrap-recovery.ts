import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createOwnedTestRuntime } from "./owned-runtime";
import { cleanupOwnedRun, requireOwnedComposeResource } from "./cleanup";

const root = path.resolve(import.meta.dir, "../..");
const output = path.join(
  root,
  ".qa/bootstrap-recovery",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
await mkdir(output, { recursive: true, mode: 0o700 });
const results: object[] = [];
const docker = async (args: string[]) => {
  const child = Bun.spawn(["docker", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const [code, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(code, 0, "Owned recovery verifier Docker command failed");
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
};
const gone = async (
  runtime: Awaited<ReturnType<typeof createOwnedTestRuntime>>,
) => {
  for (const args of [
    ["ps", "-aq"],
    ["network", "ls", "-q"],
  ])
    assert.equal(
      await docker([
        ...args,
        "--filter",
        `label=com.docker.compose.project=${runtime.manifest.composeProject}`,
      ]),
      "",
    );
  await assert.rejects(access(path.join(runtime.runRoot, "private.json")), {
    code: "ENOENT",
  });
  await assert.rejects(access(path.join(runtime.runRoot, "compose.env")), {
    code: "ENOENT",
  });
};
const labels = (
  runtime: Awaited<ReturnType<typeof createOwnedTestRuntime>>,
  owner = runtime.manifest.ownerTokenHash,
) => [
  "--label",
  `com.docker.compose.project=${runtime.manifest.composeProject}`,
  "--label",
  "com.docker.compose.network=default",
  "--label",
  `com.mychampions.test.run=${runtime.manifest.runId}`,
  "--label",
  `com.mychampions.test.owner-hash=${owner}`,
];
try {
  const created = await createOwnedTestRuntime();
  try {
    await docker([
      "compose",
      "--env-file",
      path.join(created.runRoot, "compose.env"),
      "-p",
      created.manifest.composeProject,
      "-f",
      "infra/docker-compose.test.yml",
      "create",
    ]);
    assert.equal(created.manifest.containerId, null);
    const id = await docker([
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${created.manifest.composeProject}`,
    ]);
    assert(id);
    const inspected = JSON.parse(await docker(["inspect", id])) as unknown[];
    const ownedId = requireOwnedComposeResource(
      inspected[0],
      created.manifest,
      "container",
    );
    await created.release();
    assert.equal(created.manifest.containerId, ownedId);
    const persisted = JSON.parse(
      await readFile(created.manifestPath, "utf8"),
    ) as { containerId: string };
    assert.equal(persisted.containerId, ownedId);
    await gone(created);
    results.push({
      label: "container-and-network-before-ID-persistence",
      runId: created.manifest.runId,
      recoveredContainerId: ownedId,
      cleanup: "cleaned",
    });
  } finally {
    await created.release();
  }

  const network = await createOwnedTestRuntime();
  try {
    await docker([
      "network",
      "create",
      ...labels(network),
      `${network.manifest.composeProject}_default`,
    ]);
    assert.equal(
      await docker([
        "ps",
        "-aq",
        "--filter",
        `label=com.docker.compose.project=${network.manifest.composeProject}`,
      ]),
      "",
    );
    await network.release();
    await gone(network);
    results.push({
      label: "network-only-before-container-creation",
      runId: network.manifest.runId,
      cleanup: "cleaned",
    });
  } finally {
    await network.release();
  }

  const foreign = await createOwnedTestRuntime();
  const wrongOwner = "f".repeat(64);
  const foreignId = await docker([
    "network",
    "create",
    ...labels(foreign, wrongOwner),
    `${foreign.manifest.composeProject}_default`,
  ]);
  try {
    await assert.rejects(foreign.release(), /ownership mismatch/);
    const inspected = JSON.parse(
      await docker(["network", "inspect", foreignId]),
    ) as { Id: string; Labels: Record<string, string> }[];
    assert.equal(inspected[0]!.Id, foreignId);
    assert.equal(
      inspected[0]!.Labels["com.mychampions.test.owner-hash"],
      wrongOwner,
    );
    await access(path.join(foreign.runRoot, "private.json"));
    results.push({
      label: "same-project-foreign-owner-refused-and-preserved",
      runId: foreign.manifest.runId,
      foreignNetworkPreserved: true,
      recoveryProofRetained: true,
    });
  } finally {
    // Only this verifier's directly created negative-control network is removed.
    const inspected = JSON.parse(
      await docker(["network", "inspect", foreignId]),
    ) as { Id: string; Labels: Record<string, string> }[];
    assert.equal(inspected[0]!.Id, foreignId);
    assert.equal(
      inspected[0]!.Labels["com.mychampions.test.owner-hash"],
      wrongOwner,
    );
    assert.equal(
      inspected[0]!.Labels["com.mychampions.test.run"],
      foreign.manifest.runId,
    );
    await docker(["network", "rm", foreignId]);
    await cleanupOwnedRun(foreign.manifest, foreign.manifestPath);
    await gone(foreign);
  }
  await writeFile(
    path.join(output, "receipt.json"),
    JSON.stringify(
      {
        result: "passed",
        scope: "owned bootstrap cleanup, not API/browser/native behavior",
        results,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    `Bootstrap recovery verification: ${path.join(output, "receipt.json")}`,
  );
} catch (error) {
  await writeFile(
    path.join(output, "failure.private.log"),
    error instanceof Error
      ? (error.stack ?? error.message)
      : "Recovery verifier failed",
    { mode: 0o600 },
  );
  console.error(
    "Bootstrap recovery verification failed; ownership evidence retained.",
  );
  process.exitCode = 2;
}
