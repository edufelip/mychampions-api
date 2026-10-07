import { randomBytes, createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  requireOwnedTestDatabase,
  type TestManifest,
  type DatabaseKey,
} from "../../tests/helpers/test-database";
import { cleanupOwnedRun } from "./cleanup";
import { fingerprintOwnedRepository } from "./repository-fingerprint";
import { queryOwnedProcess } from "./process-query";
import {
  assertResourceManifest,
  assertApiProcessRecord,
  retainManifestProcessHistory,
} from "./document-validation";

const root = path.resolve(import.meta.dir, "../..");

// Server-owned resource acquisition only. Callers own their tests and signal forwarding.
export function validateOwnedWebOrigins(origins: readonly string[]) {
  return origins.map((origin) => {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(
        "Owned API web origins must be explicit loopback HTTP origins",
      );
    }
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.origin !== origin ||
      Number(url.port) < 1024 ||
      Number(url.port) > 65535 ||
      !url.port
    )
      throw new Error(
        "Owned API web origins must be explicit loopback HTTP origins",
      );
    return origin;
  });
}

export async function createOwnedTestRuntime(
  options: { webOrigins?: readonly string[] } = {},
) {
  // Validate caller data before creating even a private ledger.
  const webOrigins =
    options.webOrigins && validateOwnedWebOrigins(options.webOrigins);
  // Fingerprint both worktrees before creating a runtime directory, ledger,
  // compose environment, or any other owned resource. A non-regular untracked
  // entry is a bounded preflight failure, never a reason to follow a symlink.
  const repositories: TestManifest["repositories"] = {};
  for (const [name, dir] of [
    ["server", root],
    ["client", path.resolve(root, "../mychampions")],
  ] as const) {
    repositories[name] = await fingerprintOwnedRepository(dir);
  }

  const runId = randomBytes(12).toString("hex");
  const ownerToken = randomBytes(32).toString("hex");
  const password = randomBytes(24).toString("hex");
  const runRoot = path.join(root, ".qa/runtime", runId);
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(runRoot, "manifest.json");
  const composeEnv = path.join(runRoot, "compose.env");
  const targets = {
    DATABASE_URL: `mc_test_${runId}`,
    FOOD_CATALOG_DATABASE_URL: `mc_test_${runId}_food`,
    EXERCISE_CATALOG_DATABASE_URL: `mc_test_${runId}_exercise`,
  };
  const manifest: TestManifest = {
    schemaVersion: 1,
    runId,
    composeProject: `mc_test_${runId}`,
    containerId: null,
    ownerTokenHash: createHash("sha256").update(ownerToken).digest("hex"),
    port: 0,
    targets,
    artifactRoot: runRoot,
    repoRoot: await realpath(root),
    runtimeRoot: await realpath(path.dirname(runRoot)),
    createdAt: new Date().toISOString(),
    repositories,
    orchestratorPid: process.pid,
    testChildPid: null,
    phase: "bootstrap",
    fixtureScopes: [],
    processes: [],
  };
  const processIdentity = async (
    pid: number,
    script: string,
    role: "orchestrator" | "test" | "api",
  ) => {
    const started = await queryOwnedProcess(pid, "lstart");
    if (!started)
      throw new Error("Cannot establish owned process start identity");
    return {
      role,
      pid,
      started,
      script: path.resolve(script),
    };
  };
  const orchestrator = await processIdentity(
    process.pid,
    process.argv[1]!,
    "orchestrator",
  );
  let trackedTest: Awaited<ReturnType<typeof processIdentity>> | undefined;
  await writeFile(
    composeEnv,
    `MC_TEST_PASSWORD=${password}\nMC_TEST_DATABASE=${targets.DATABASE_URL}\nMC_TEST_RUN_ID=${runId}\nMC_TEST_OWNER_HASH=${manifest.ownerTokenHash}\n`,
    { mode: 0o600 },
  );
  const persist = async () => {
    const processes = [orchestrator];
    if (trackedTest) processes.push(trackedTest);
    for (const file of (await readdir(runRoot)).filter((name) =>
      /^api-[a-z0-9-]+\.json$/.test(name),
    )) {
      const record: unknown = JSON.parse(
        await readFile(path.join(runRoot, file), "utf8"),
      );
      assertApiProcessRecord(record);
      if (
        record.runId !== runId ||
        record.ownerTokenHash !== manifest.ownerTokenHash ||
        file !== `api-${record.attempt}.json`
      )
        throw new Error("API record ownership mismatch");
      processes.push({
        role: "api",
        pid: record.pid,
        started: record.started,
        script: record.script,
      });
    }
    manifest.processes = retainManifestProcessHistory(manifest, processes);
    assertResourceManifest(manifest);
    const temporary = `${manifestPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, manifestPath);
  };
  await persist();
  const compose = [
    "docker",
    "compose",
    "--env-file",
    composeEnv,
    "-p",
    manifest.composeProject,
    "-f",
    "infra/docker-compose.test.yml",
  ];
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let cancelled: NodeJS.Signals | null = null;
  const cancel = (signal: NodeJS.Signals) => {
    cancelled = signal;
    child?.kill(signal);
  };
  const command = async (argv: string[], env = process.env) => {
    if (cancelled) throw new Error("cancelled");
    const commandChild = Bun.spawn(argv, {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    child = commandChild;
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      if (commandChild.exitCode === null) commandChild.kill("SIGKILL");
    }, 120_000);
    let code: number;
    let out: string;
    let err: string;
    try {
      [code, out, err] = await Promise.all([
        commandChild.exited,
        new Response(commandChild.stdout).text(),
        new Response(commandChild.stderr).text(),
      ]);
    } finally {
      clearTimeout(deadline);
      child = undefined;
    }
    if (timedOut)
      throw new Error(`Harness command ${argv[0]} timed out (120000ms)`);
    if (code !== 0)
      throw new Error(
        `Harness command ${argv[0]} failed (${code}). ${err.replaceAll(password, "[redacted]")}`,
      );
    return out.trim();
  };
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    MC_TEST_MANIFEST: manifestPath,
    MC_TEST_OWNER_TOKEN: ownerToken,
  };
  await writeFile(path.join(runRoot, "private.json"), JSON.stringify(env), {
    mode: 0o600,
  });
  let started = false;
  let releasePromise: Promise<void> | undefined;
  return {
    manifest,
    manifestPath,
    runRoot,
    env,
    persist,
    cancel,
    get cancelled() {
      return cancelled;
    },
    async trackChild(value: ReturnType<typeof Bun.spawn> | undefined) {
      child = value;
      trackedTest = value
        ? await processIdentity(value.pid, process.execPath, "test")
        : undefined;
    },
    redact(value: string) {
      return value
        .replaceAll(password, "[redacted]")
        .replaceAll(ownerToken, "[redacted]");
    },
    async start() {
      if (started || releasePromise)
        throw new Error("Owned runtime may start only once before release");
      started = true;
      await command([...compose, "create"]);
      manifest.containerId = await command([...compose, "ps", "-aq"]);
      await persist();
      const inspect = JSON.parse(
        await command(["docker", "inspect", manifest.containerId]),
      )[0];
      if (
        inspect.Config.Labels["com.docker.compose.project"] !==
          manifest.composeProject ||
        inspect.Config.Labels["com.docker.compose.service"] !== "postgres" ||
        inspect.Config.Labels["com.mychampions.test.run"] !== runId ||
        inspect.Config.Labels["com.mychampions.test.owner-hash"] !==
          manifest.ownerTokenHash
      )
        throw new Error("Bootstrap container ownership mismatch");
      await command([...compose, "up", "-d", "--wait", "--wait-timeout", "90"]);
      const binding = await command([...compose, "port", "postgres", "5432"]);
      if (!/^127\.0\.0\.1:\d+$/.test(binding))
        throw new Error("Unexpected database port binding");
      manifest.port = Number(binding.split(":")[1]);
      await persist();
      Object.assign(env, {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        APP_VARIANT: "dev",
        NODE_ENV: "test",
        GCS_BUCKET: "",
        REVENUECAT_SECRET_API_KEY: "",
        MC_TEST_MANIFEST: manifestPath,
        MC_TEST_OWNER_TOKEN: ownerToken,
      });
      if (webOrigins) env.WEB_ALLOWED_ORIGINS = webOrigins.join(",");
      for (const key of Object.keys(targets) as DatabaseKey[])
        env[key] =
          `postgres://mc_test:${password}@127.0.0.1:${manifest.port}/${targets[key]}`;
      await writeFile(path.join(runRoot, "private.json"), JSON.stringify(env), {
        mode: 0o600,
      });
      // Bootstrap is allowed only inside the newly-created, label-verified container.
      const primary = postgres(env.DATABASE_URL!, { max: 1 });
      try {
        for (const key of [
          "FOOD_CATALOG_DATABASE_URL",
          "EXERCISE_CATALOG_DATABASE_URL",
        ] as DatabaseKey[])
          await primary.unsafe(`CREATE DATABASE "${targets[key]}"`);
      } finally {
        await primary.end();
      }
      for (const key of Object.keys(targets) as DatabaseKey[]) {
        const sql = postgres(env[key]!, { max: 1 });
        try {
          await sql`create schema mc_test_ownership`;
          await sql`create table mc_test_ownership.marker (singleton boolean primary key check (singleton), run_id text not null, owner_token_hash text not null)`;
          await sql`insert into mc_test_ownership.marker values (true, ${runId}, ${manifest.ownerTokenHash})`;
        } finally {
          await sql.end();
        }
        await requireOwnedTestDatabase(key, env);
      }
      // Keep parent-child stdout reserved for protocol messages. Postgres defaults
      // to logging multi-line notice objects there during migration bootstrap.
      const migrationClient = postgres(
        await requireOwnedTestDatabase("DATABASE_URL", env),
        {
          max: 1,
          onnotice: (notice) => console.error(`Test DB notice: ${notice.code}`),
        },
      );
      try {
        await migrate(drizzle(migrationClient), {
          migrationsFolder: path.join(root, "drizzle"),
        });
      } finally {
        await migrationClient.end();
      }
      const { seedCatalogs } = await import("./seed");
      await seedCatalogs(env);
      const { verifyCatalogSeeds } = await import("./verify");
      return verifyCatalogSeeds(env);
    },
    release() {
      if (releasePromise) return releasePromise;
      releasePromise = (async () => {
        if (child?.exitCode === null && child.signalCode === null) {
          const ownedChild = child;
          ownedChild.kill("SIGTERM");
          const deadline = setTimeout(() => {
            if (ownedChild.exitCode === null) ownedChild.kill("SIGKILL");
          }, 10_000);
          try {
            await ownedChild.exited;
          } finally {
            clearTimeout(deadline);
          }
          child = undefined;
        }
        trackedTest = undefined;
        manifest.phase = "cleanup";
        manifest.testChildPid = null;
        let persistError: unknown;
        try {
          await persist();
        } catch (error) {
          persistError = error;
        }
        await cleanupOwnedRun(manifest, manifestPath);
        if (persistError)
          throw new Error(
            "Cannot persist final ownership state; cleanup was attempted.",
          );
      })();
      return releasePromise;
    },
  };
}
