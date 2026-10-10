import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { ApplicationFixtures } from "./fixtures";
import {
  createOwnedTestRuntime,
  OWNED_SESSION_AUTH_RATE_LIMIT_MAX,
} from "./owned-runtime";
import { assertTestDocument } from "./document-validation";

// Explicit local-Docker verification of the private browser/native handoff boundary.
const root = path.resolve(import.meta.dir, "../..");
const reportRoot = path.join(
  root,
  ".qa/handoff",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
await mkdir(reportRoot, { recursive: true, mode: 0o700 });
type Event = {
  event: string;
  id?: string;
  runId?: string;
  manifestPath?: string;
  apiOrigin?: string;
  apiPid?: number;
  fixtureRef?: string;
  fixtureSummary?: { contentHash: string };
  receiptPath?: string;
  cleanup?: string;
  exitCode?: number;
};
async function* readEvents(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line) yield JSON.parse(line) as Event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
async function open(label: string, extraArgs: string[] = []) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      path.join(root, "scripts/testing/session.ts"),
      "--web-origin",
      "http://127.0.0.1:42001",
      ...extraArgs,
    ],
    {
      // Deliberately outside the server. Polluted parent data must not reach the API.
      cwd: path.resolve(root, "../mychampions"),
      env: {
        ...process.env,
        DATABASE_URL: "postgres://foreign/never-use",
        GOOGLE_WEB_CLIENT_ID: "foreign-client",
        GCS_BUCKET: "foreign-bucket",
        REVENUECAT_SECRET_API_KEY: "foreign-secret",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stderr = new Response(child.stderr).text();
  const events = readEvents(child.stdout);
  const observedApiPids = new Set<number>();
  const next = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const event = await Promise.race([
        (async () => {
          let nextEvent = await events.next();
          while (!nextEvent.done && nextEvent.value.event === "acquired") {
            assertTestDocument("session-event-v1", nextEvent.value);
            assert.equal(
              nextEvent.value.manifestPath,
              path.join(
                root,
                ".qa/runtime",
                nextEvent.value.runId!,
                "manifest.json",
              ),
            );
            nextEvent = await events.next();
          }
          return nextEvent;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error(`${label}: session response timeout`));
          }, 120_000);
        }),
      ]);
      assert(!event.done, `${label}: missing response`);
      if (event.value.apiPid) observedApiPids.add(event.value.apiPid);
      return event.value;
    } finally {
      clearTimeout(timer);
    }
  };
  let finished = false;
  const send = (request: object) => {
    child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.flush();
  };
  const complete = async (expectedCode = 0) => {
    const closed = await next();
    assert.equal(closed.event, "closed");
    const code = await child.exited;
    finished = true;
    await writeFile(path.join(reportRoot, `${label}.log`), await stderr, {
      mode: 0o600,
    });
    assert.equal(code, expectedCode);
    assert.equal(closed.exitCode, expectedCode);
    assert.equal(closed.cleanup, "cleaned");
    const receipt = JSON.parse(await readFile(closed.receiptPath!, "utf8"));
    const runRoot = path.dirname(closed.receiptPath!);
    const manifest = JSON.parse(
      await readFile(path.join(runRoot, "manifest.json"), "utf8"),
    );
    for (const args of [
      ["ps", "-aq"],
      ["network", "ls", "-q"],
    ]) {
      const result = Bun.spawnSync(
        [
          "docker",
          ...args,
          "--filter",
          `label=com.docker.compose.project=${manifest.composeProject}`,
        ],
        { timeout: 15000, killSignal: "SIGKILL" },
      );
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.toString().trim(), "");
    }
    await assert.rejects(stat(path.join(runRoot, "private.json")), {
      code: "ENOENT",
    });
    for (const pid of observedApiPids) {
      const probe = Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat="]);
      assert(
        probe.exitCode !== 0 ||
          !probe.stdout.toString().trim() ||
          probe.stdout.toString().trim().startsWith("Z"),
        `${label}: API PID survived cleanup`,
      );
    }
    return { receiptPath: closed.receiptPath, receipt, manifest };
  };
  return {
    child,
    next,
    send,
    complete,
    get finished() {
      return finished;
    },
    async emergencyStop() {
      if (!finished && child.exitCode === null) {
        child.kill("SIGTERM");
        await child.exited;
      }
    },
  };
}
const opened: Awaited<ReturnType<typeof open>>[] = [];
const results: unknown[] = [];
try {
  const direct = await createOwnedTestRuntime();
  try {
    await direct.start();
    // Direct/integration runtimes keep the production auth rate limit.
    assert.equal(direct.env.AUTH_RATE_LIMIT_MAX, undefined);
    await assert.rejects(direct.start(), /start only once/);
    const executingTest = Bun.spawn(
      [process.execPath, "--no-env-file", "-e", "await Bun.sleep(60000)"],
      { stdout: "ignore", stderr: "ignore" },
    );
    await direct.trackChild(executingTest);
    const firstRelease = direct.release();
    assert.equal(direct.release(), firstRelease);
    await firstRelease;
    assert.equal(await executingTest.exited, 143);
    assert.equal(executingTest.signalCode, "SIGTERM");
    await direct.release();
    await assert.rejects(direct.start(), /start only once/);
    results.push({
      label: "direct-idempotent-release",
      runId: direct.manifest.runId,
      result: "passed",
    });
  } finally {
    await direct.release();
  }
  const parallel = await Promise.all([open("parallel-a"), open("parallel-b")]);
  opened.push(...parallel);
  const ready = await Promise.all(parallel.map((session) => session.next()));
  for (const event of ready) assert.equal(event.event, "ready");
  assert.notEqual(ready[0]!.runId, ready[1]!.runId);
  assert.notEqual(ready[0]!.apiOrigin, ready[1]!.apiOrigin);
  assert.equal(
    ready[0]!.fixtureSummary!.contentHash,
    ready[1]!.fixtureSummary!.contentHash,
  );
  const manifests = await Promise.all(
    ready.map(async (event) =>
      JSON.parse(await readFile(event.manifestPath!, "utf8")),
    ),
  );
  assert.notEqual(manifests[0].port, manifests[1].port);
  const fixtures: ApplicationFixtures[] = [];
  for (const [index, session] of parallel.entries()) {
    session.send({ id: "seed-1", op: "seed", scope: "handoff-1" });
    const seeded = await session.next();
    assert.equal(seeded.event, "seeded");
    const fixture = JSON.parse(
      await readFile(seeded.fixtureRef!, "utf8"),
    ) as ApplicationFixtures;
    fixtures.push(fixture);
    assert.equal(fixture.runId, ready[index]!.runId);
    assert.equal((await stat(seeded.fixtureRef!)).mode & 0o777, 0o600);
    const env = JSON.parse(
      await readFile(
        path.join(path.dirname(seeded.fixtureRef!), "private.json"),
        "utf8",
      ),
    );
    assert(
      !env.GOOGLE_WEB_CLIENT_ID &&
        !env.GCS_BUCKET &&
        !env.REVENUECAT_SECRET_API_KEY,
    );
    assert.equal(env.WEB_ALLOWED_ORIGINS, "http://127.0.0.1:42001");
    assert.equal(
      env.AUTH_RATE_LIMIT_MAX,
      String(OWNED_SESSION_AUTH_RATE_LIMIT_MAX),
    );
  }
  assert.notEqual(
    fixtures[0]!.accounts.coach.authUid,
    fixtures[1]!.accounts.coach.authUid,
  );
  const account = fixtures[0]!.accounts.coach;
  const response = await fetch(`${ready[0]!.apiOrigin}/auth/email/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: account.email,
      password: account.password,
      sessionMode: "bearer",
    }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 201);
  // Native journeys sign in repeatedly through one loopback IP. The owned
  // session budget must not throttle past the production default of 20.
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const repeated = await fetch(`${ready[0]!.apiOrigin}/auth/email/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: account.email,
        password: account.password,
        sessionMode: "bearer",
      }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(repeated.status, 201, `repeated sign-in ${attempt + 2}`);
    await repeated.arrayBuffer();
  }
  const auth = (await response.json()) as {
    accessToken: string;
    profile: { authUid: string };
  };
  assert.equal(auth.profile.authUid, account.authUid);
  const planRoute = `/plans/training/${fixtures[0]!.savedPlanId}`;
  const saved = await fetch(`${ready[0]!.apiOrigin}${planRoute}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "QA Persisted Across Handoff Restart" }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(saved.status, 200);
  parallel[0]!.send({
    id: "restart-1",
    op: "restart",
    attempt: "handoff-restart",
  });
  const restarted = await parallel[0]!.next();
  assert.equal(restarted.event, "restarted");
  assert.notEqual(restarted.apiPid, ready[0]!.apiPid);
  const durable = await fetch(`${restarted.apiOrigin}${planRoute}`, {
    headers: { authorization: `Bearer ${auth.accessToken}` },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(durable.status, 200);
  assert.equal(
    ((await durable.json()) as { plan: { name: string } }).plan.name,
    "QA Persisted Across Handoff Restart",
  );
  for (const [index, session] of parallel.entries()) {
    session.send({ id: "stop-1", op: "stop" });
    results.push({
      label: index ? "parallel-b" : "parallel-a-restart",
      ...(await session.complete()),
    });
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const session = await open(signal);
    opened.push(session);
    assert.equal((await session.next()).event, "ready");
    session.child.kill(signal);
    results.push({
      label: signal,
      ...(await session.complete(signal === "SIGINT" ? 130 : 143)),
    });
  }
  const closedParent = await open("parent-close");
  opened.push(closedParent);
  assert.equal((await closedParent.next()).event, "ready");
  closedParent.child.stdin.end();
  results.push({ label: "parent-close", ...(await closedParent.complete(2)) });
  const duplicate = await open("duplicate-request");
  opened.push(duplicate);
  assert.equal((await duplicate.next()).event, "ready");
  duplicate.send({ id: "seed-1", op: "seed", scope: "duplicate" });
  assert.equal((await duplicate.next()).event, "seeded");
  duplicate.send({ id: "seed-1", op: "seed", scope: "another" });
  results.push({
    label: "duplicate-request",
    ...(await duplicate.complete(2)),
  });
  const timeout = await open("deadline", ["--deadline-ms", "20000"]);
  opened.push(timeout);
  assert.equal((await timeout.next()).event, "ready");
  results.push({ label: "deadline", ...(await timeout.complete(2)) });
  const report = {
    result: "passed",
    checks: [
      "two concurrent owned sessions from client cwd",
      "shared acquire single-start and idempotent release",
      "distinct DB/API ports and fixture owners",
      "provider credentials excluded",
      "owned session auth rate limit above the production default",
      "canonical seed hash equal",
      "normal auth/write API and persisted restart",
      "cleaned stop",
      "SIGINT",
      "SIGTERM",
      "parent EOF",
      "duplicate request rejection",
      "bounded deadline",
    ],
    results,
  };
  await writeFile(
    path.join(reportRoot, "receipt.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(`Handoff receipt: ${path.join(reportRoot, "receipt.json")}`);
} finally {
  await Promise.all(opened.map((session) => session.emergencyStop()));
}
