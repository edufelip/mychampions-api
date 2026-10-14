import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Explicit, local Docker verification. No provider or application mutation.
const root = path.resolve(import.meta.dir, '../..');
process.chdir(root);
const reportRoot = path.join(
  root,
  '.qa/lifecycle',
  new Date().toISOString().replace(/[:.]/g, '-')
);
await mkdir(reportRoot, { recursive: true, mode: 0o700 });
async function spawnRun(label: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      'scripts/testing/run.ts',
      'integration',
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const complete = async () => {
    const code = await child.exited;
    const [out, err] = await output;
    await writeFile(path.join(reportRoot, `${label}.log`), `${out}\n${err}`, {
      mode: 0o600,
    });
    const receiptPath = out.match(/Integration receipt: (.+)/)?.[1];
    if (!receiptPath) throw new Error(`${label}: no receipt (exit ${code})`);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    const manifest = JSON.parse(
      await readFile(
        path.join(path.dirname(receiptPath), 'manifest.json'),
        'utf8'
      )
    );
    return { code, receipt, manifest, receiptPath };
  };
  return { child, complete };
}
const parallel = await Promise.all([
  spawnRun('parallel-a'),
  spawnRun('parallel-b'),
]);
const results = await Promise.all(parallel.map((run) => run.complete()));
if (
  results.some((r) => r.code !== 0 || r.receipt.cleanup !== 'cleaned') ||
  results[0]!.manifest.port === results[1]!.manifest.port ||
  results[0]!.manifest.composeProject === results[1]!.manifest.composeProject ||
  results[0]!.receipt.fixtureSummary.contentHash !==
    results[1]!.receipt.fixtureSummary.contentHash
)
  throw new Error('Concurrent isolation/repeatability verification failed');
const cancellations = [];
for (const { signal, during } of [
  { signal: 'SIGINT', during: 'tests' },
  { signal: 'SIGTERM', during: 'tests' },
  { signal: 'SIGTERM', during: 'api' },
] as const) {
  const before = new Set(await readdir(path.join(root, '.qa/runtime')));
  const run = await spawnRun(`${signal}-${during}`);
  const deadline = Date.now() + 90_000;
  let signalled = false;
  while (Date.now() < deadline) {
    const fresh = (await readdir(path.join(root, '.qa/runtime'))).filter(
      (name) => !before.has(name)
    );
    for (const name of fresh) {
      try {
        const manifest = JSON.parse(
          await readFile(
            path.join(root, '.qa/runtime', name, 'manifest.json'),
            'utf8'
          )
        );
        if (
          manifest.containerId &&
          manifest.phase === 'tests' &&
          manifest.testChildPid &&
          (during !== 'api' ||
            (await readdir(path.join(root, '.qa/runtime', name))).some((file) =>
              /^api-journeys-.*\.json$/.test(file)
            ))
        ) {
          run.child.kill(signal);
          signalled = true;
          break;
        }
      } catch {
        /* Manifest atomic update may still be in progress. */
      }
    }
    if (signalled || run.child.exitCode !== null) break;
    await Bun.sleep(25);
  }
  if (!signalled) {
    run.child.kill('SIGTERM');
    await run.complete();
    throw new Error(`No active owned target to cancel with ${signal}`);
  }
  const result = await run.complete();
  if (
    result.code !== (signal === 'SIGINT' ? 130 : 143) ||
    result.receipt.result !== 'cancelled' ||
    result.receipt.cleanup !== 'cleaned'
  )
    throw new Error(`${signal} cleanup/result contract failed`);
  cancellations.push({
    signal,
    during,
    receiptPath: result.receiptPath,
    exitCode: result.code,
  });
}
const allIds = [
  ...results.map((r) => r.manifest.composeProject),
  ...cancellations
    .map((r) => r.receiptPath.split('/').at(-2)!)
    .map((id) => `mc_test_${id}`),
];
for (const project of allIds) {
  for (const args of [
    ['ps', '-aq'],
    ['network', 'ls', '-q'],
  ]) {
    const check = Bun.spawnSync([
      'docker',
      ...args,
      '--filter',
      `label=com.docker.compose.project=${project}`,
    ]);
    if (check.exitCode !== 0 || check.stdout.toString().trim())
      throw new Error('Owned Docker resource leak detected');
  }
}
const report = {
  result: 'passed',
  parallelReceipts: results.map((r) => r.receiptPath),
  fixtureHash: results[0]!.receipt.fixtureSummary.contentHash,
  distinctPorts: results.map((r) => r.manifest.port),
  cancellations,
  cleanup: 'no-owned-containers-or-networks',
};
await writeFile(
  path.join(reportRoot, 'receipt.json'),
  JSON.stringify(report, null, 2),
  { mode: 0o600 }
);
console.log(`Lifecycle receipt: ${path.join(reportRoot, 'receipt.json')}`);
