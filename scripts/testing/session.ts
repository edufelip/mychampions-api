import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createOwnedTestRuntime } from "./owned-runtime";
import { seedApplicationFixtures } from "./fixtures";
import { captureDomainSnapshot } from "./domain-snapshot";
import { captureConnectionSnapshot } from "./connection-snapshot";
import { startOwnedApiServer } from "../../tests/helpers/test-api-server";
import { parseSessionOptions, parseSessionRequest } from "./session-protocol";
import { assertTestDocument } from "./document-validation";

// Private parent-child stdio only. No fixture/reset/SQL operation is exposed over HTTP.
async function main() {
  const requiredBun = JSON.parse(
    await readFile(path.resolve(import.meta.dir, "../../package.json"), "utf8"),
  ).engines.bun;
  if (Bun.version !== requiredBun)
    throw new Error(`Owned sessions require Bun ${requiredBun}`);
  const options = parseSessionOptions(process.argv.slice(2));
  const runtime = await createOwnedTestRuntime(options);
  let api: Awaited<ReturnType<typeof startOwnedApiServer>> | undefined;
  const startedAt = new Date().toISOString();
  const requests: { id: string; op: string; outcome: string }[] = [];
  const requestIds = new Set<string>();
  const scopes = new Set<string>();
  const attempts = new Set(["session-start"]);
  const abort = new AbortController();
  let reason: "SIGINT" | "SIGTERM" | "timeout" | "parent-closed" | null = null;
  let exitCode = 2;
  let errorMessage: string | null = null;
  let cleanup = "pending";
  let requestedStop = false;
  const interrupt = () => cancel("SIGINT");
  const terminate = () => cancel("SIGTERM");
  function cancel(cause: NonNullable<typeof reason>) {
    reason ??= cause;
    runtime.cancel(cause === "SIGINT" ? "SIGINT" : "SIGTERM");
    abort.abort();
  }
  const deadline = setTimeout(() => cancel("timeout"), options.deadlineMs);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  // Cancellation/parent death also wakes an idle protocol reader.
  const reader = Bun.stdin.stream().getReader();
  abort.signal.addEventListener(
    "abort",
    () => {
      void reader.cancel().catch(() => {});
    },
    { once: true },
  );
  const reply = async (value: unknown) => {
    const event = { schemaVersion: 1, ...(value as object) };
    assertTestDocument("session-event-v1", event);
    await Bun.write(Bun.stdout, `${JSON.stringify(event)}\n`);
  };
  try {
    await reply({
      event: "acquired",
      runId: runtime.manifest.runId,
      manifestPath: runtime.manifestPath,
    });
    const fixtureSummary = await runtime.start();
    if (reason) throw new Error("Owned session cancelled during acquisition");
    api = await startOwnedApiServer("session-start", runtime.env, abort.signal);
    runtime.manifest.phase = "tests";
    await runtime.persist();
    await reply({
      event: "ready",
      runId: runtime.manifest.runId,
      manifestPath: runtime.manifestPath,
      apiOrigin: api.origin,
      apiPid: api.pid,
      fixtureSummary,
    });
    const decoder = new TextDecoder();
    let pending = "";
    while (!requestedStop && !reason) {
      const { done, value } = await reader.read();
      if (done) {
        cancel("parent-closed");
        break;
      }
      pending += decoder.decode(value, { stream: true });
      if (pending.length > 65_536)
        throw new Error("Owned session request exceeds size limit");
      let lineEnd: number;
      while (
        !requestedStop &&
        !reason &&
        (lineEnd = pending.indexOf("\n")) >= 0
      ) {
        const line = pending.slice(0, lineEnd);
        pending = pending.slice(lineEnd + 1);
        const request = parseSessionRequest(JSON.parse(line));
        if (requestIds.has(request.id))
          throw new Error("Duplicate owned session request ID");
        requestIds.add(request.id);
        if (request.op === "seed") {
          if (scopes.has(request.scope))
            throw new Error(
              "Fixture scope already used; each attempt needs a new scope",
            );
          scopes.add(request.scope);
          await seedApplicationFixtures(request.scope, runtime.env);
          runtime.manifest.fixtureScopes.push(request.scope);
          await runtime.persist();
          await reply({
            id: request.id,
            event: "seeded",
            fixtureRef: path.join(
              runtime.runRoot,
              `fixtures-${request.scope}.private.json`,
            ),
          });
        } else if (request.op === "snapshot") {
          if (!scopes.has(request.scope))
            throw new Error("Snapshot scope was not seeded");
          const snapshotRef = await captureDomainSnapshot(
            request.scope,
            request.id,
            runtime.env,
          );
          await reply({ id: request.id, event: "snapshotted", snapshotRef });
        } else if (request.op === "connection-snapshot") {
          if (!scopes.has(request.scope))
            throw new Error("Connection snapshot scope was not seeded");
          const snapshotRef = await captureConnectionSnapshot(
            request.scope,
            request.id,
            runtime.env,
          );
          await reply({
            id: request.id,
            event: "connection-snapshotted",
            snapshotRef,
          });
        } else if (request.op === "restart") {
          if (attempts.has(request.attempt))
            throw new Error("Duplicate owned API attempt ID");
          attempts.add(request.attempt);
          const previousPid = api.pid;
          await api.stop();
          api = await startOwnedApiServer(
            request.attempt,
            runtime.env,
            abort.signal,
          );
          await runtime.persist();
          await reply({
            id: request.id,
            event: "restarted",
            apiOrigin: api.origin,
            apiPid: api.pid,
            previousPid,
          });
        } else {
          requestedStop = true;
          exitCode = 0;
        }
        requests.push({ id: request.id, op: request.op, outcome: "completed" });
      }
    }
  } catch (error) {
    errorMessage = runtime.redact(
      error instanceof Error ? error.message : "Owned session harness failed",
    );
    console.error(errorMessage);
    exitCode = 2;
  } finally {
    clearTimeout(deadline);
    let stopError: unknown;
    try {
      await api?.stop();
    } catch (error) {
      stopError = error;
    }
    try {
      await runtime.release();
      if (stopError) throw stopError;
      cleanup = "cleaned";
    } catch (error) {
      cleanup = "failed-recovery-ledger-retained";
      errorMessage = runtime.redact(
        error instanceof Error ? error.message : "Owned session cleanup failed",
      );
      exitCode = 2;
    }
    if (reason)
      exitCode = reason === "SIGINT" ? 130 : reason === "SIGTERM" ? 143 : 2;
    const receiptPath = path.join(runtime.runRoot, "session-receipt.json");
    const receipt = {
      schemaVersion: 1,
      runId: runtime.manifest.runId,
      repositories: runtime.manifest.repositories,
      startedAt,
      finishedAt: new Date().toISOString(),
      requests,
      result:
        reason === "SIGINT" || reason === "SIGTERM"
          ? "cancelled"
          : exitCode === 0
            ? "passed"
            : "harness-blocked",
      reason,
      cleanup,
      error: errorMessage,
      exitCode,
    };
    assertTestDocument("session-receipt-v1", receipt);
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2), {
      mode: 0o600,
    });
    await reply({ event: "closed", receiptPath, cleanup, exitCode });
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    process.exitCode = exitCode;
  }
}

await main().catch((error: unknown) => {
  // Validation failures occur before ownership acquisition and contain no caller values.
  console.error(
    error instanceof Error ? error.message : "Owned session preflight failed",
  );
  process.exitCode = 2;
});
