import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createOwnedTestRuntime } from "./owned-runtime";

const root = path.resolve(import.meta.dir, "../..");
process.chdir(root);
const requiredBun = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
).engines.bun;
if (Bun.version !== requiredBun) {
  console.error(
    `Tests require Bun ${requiredBun}; use ../scripts/server-bun.sh run test:unit or test:integration.`,
  );
  process.exit(2);
}
const mode = process.argv[2];
if (!["unit", "integration"].includes(mode ?? "") || process.argv.length > 3) {
  console.error("Usage: bun scripts/testing/run.ts unit|integration");
  process.exit(2);
}
const files = (await readdir(path.join(root, "tests")))
  .filter(
    (file) =>
      file.endsWith(".test.ts") &&
      (mode === "integration"
        ? file.startsWith("postgres-")
        : !file.startsWith("postgres-")),
  )
  .sort();
if (!files.length) {
  console.error("No requested tests");
  process.exit(2);
}
if (mode === "unit") {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "test",
      ...files.map((file) => `./tests/${file}`),
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.exitCode = await child.exited;
} else {
  const runtime = await createOwnedTestRuntime();
  const { manifest, runRoot, env, persist } = runtime;
  const { runId, repositories } = manifest;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const interrupt = () => runtime.cancel("SIGINT");
  const terminate = () => runtime.cancel("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  let exitCode = 2;
  const attempts: {
    file: string;
    exitCode: number;
    durationMs: number;
    classification: string;
  }[] = [];
  let fixtureSummary: Awaited<
    ReturnType<(typeof import("./verify"))["verifyCatalogSeeds"]>
  > | null = null;
  let errorMessage: string | null = null;
  try {
    fixtureSummary = await runtime.start();
    exitCode = 0;
    for (const file of files) {
      if (runtime.cancelled) throw new Error("cancelled");
      const start = performance.now();
      child = Bun.spawn(
        [process.execPath, "--no-env-file", "test", `./tests/${file}`],
        {
          cwd: root,
          env: { ...env, MC_TEST_FILE: file },
          stdout: "inherit",
          stderr: "inherit",
        },
      );
      await runtime.trackChild(child);
      manifest.phase = "tests";
      manifest.testChildPid = child.pid;
      await persist();
      const code = await child.exited;
      child = undefined;
      await runtime.trackChild(undefined);
      let classification = code === 0 ? "passed" : "test-failure";
      try {
        const block = JSON.parse(
          await readFile(path.join(runRoot, `${file}.harness.json`), "utf8"),
        );
        if (block.classification === "harness-blocked") {
          classification = "harness-blocked";
          errorMessage = block.error;
          exitCode = 2;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      attempts.push({
        file,
        exitCode: code,
        durationMs: Math.round(performance.now() - start),
        classification,
      });
      if (code !== 0 && exitCode !== 2) exitCode = 1;
    }
  } catch (error) {
    errorMessage =
      error instanceof Error
        ? runtime.redact(error.message)
        : "harness failure";
    console.error(errorMessage);
    exitCode = 2;
  } finally {
    let cleanup = "cleaned";
    try {
      await runtime.release();
    } catch (error) {
      cleanup = "failed-recovery-ledger-retained";
      errorMessage = error instanceof Error ? error.message : "cleanup failed";
      exitCode = 2;
    }
    if (runtime.cancelled)
      exitCode = runtime.cancelled === "SIGINT" ? 130 : 143;
    await writeFile(
      path.join(runRoot, "receipt.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          runId,
          repositories,
          dataMode: "postgres",
          fixtureSummary,
          requestedFiles: files,
          attempts,
          firstAttemptPassed: attempts.filter(
            (a) => a.exitCode === 0 && a.classification === "passed",
          ).length,
          result: runtime.cancelled
            ? "cancelled"
            : exitCode === 0
              ? "passed"
              : exitCode === 1
                ? "test-failure"
                : "harness-blocked",
          cleanup,
          error: errorMessage,
          exitCode,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(`Integration receipt: ${path.join(runRoot, "receipt.json")}`);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    process.exitCode = exitCode;
  }
}
