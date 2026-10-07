import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { loadTestManifest } from './test-database';
import { assertApiProcessRecord } from '../../scripts/testing/document-validation';

export async function startOwnedApiServer(
  attempt: string,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal
) {
  const manifest = loadTestManifest(env);
  if (!/^[a-z0-9-]{1,48}$/.test(attempt))
    throw new Error('Invalid API attempt');
  const ledger = path.join(
    path.dirname(env.MC_TEST_MANIFEST!),
    `api-${attempt}.json`
  );
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      path.resolve(import.meta.dir, '../../scripts/testing/serve.ts'),
      '--run-id',
      manifest.runId,
      '--attempt',
      attempt,
    ],
    { env, stdout: 'pipe', stderr: 'pipe' }
  );
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  let stopPromise: Promise<void> | undefined;
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGTERM');
      const deadline = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 10_000);
      try {
        await child.exited;
        await output;
      } finally {
        clearTimeout(deadline);
      }
    })();
    return stopPromise;
  };
  const deadline = Date.now() + 15_000;
  let origin: string | undefined;
  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Owned API startup cancelled');
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error('Owned API exited before readiness');
      try {
        const row = JSON.parse(await readFile(ledger, 'utf8'));
        assertApiProcessRecord(row);
        if (
          row.pid === child.pid &&
          row.runId === manifest.runId &&
          row.ownerTokenHash === manifest.ownerTokenHash &&
          /^http:\/\/127\.0\.0\.1:\d+$/.test(row.origin)
        ) {
          const health = await fetch(`${row.origin}/health`, {
            signal: AbortSignal.timeout(1000),
          });
          if (health.ok) {
            origin = row.origin;
            break;
          }
        }
      } catch {
        /* Wait for owned readiness/health, bounded above. */
      }
      await Bun.sleep(25);
    }
    if (!origin) throw new Error('Owned API readiness timeout');
  } catch (error) {
    await stop();
    const [, diagnostics] = await output;
    const redacted = Object.entries(env)
      .filter(
        ([key, value]) => value && /TOKEN|PASSWORD|DATABASE_URL/.test(key)
      )
      .reduce(
        (text, [, value]) => text.replaceAll(value!, '[redacted]'),
        diagnostics
      );
    const message = `${error instanceof Error ? error.message : 'API harness failed'}: ${redacted.slice(0, 3000)}`;
    if (/^[a-z0-9-]+\.test\.ts$/.test(env.MC_TEST_FILE ?? ''))
      await writeFile(
        path.join(
          path.dirname(env.MC_TEST_MANIFEST!),
          `${env.MC_TEST_FILE}.harness.json`
        ),
        JSON.stringify({ classification: 'harness-blocked', error: message }),
        { mode: 0o600 }
      );
    throw new Error(message);
  }
  return {
    origin,
    pid: child.pid,
    stop,
  };
}
