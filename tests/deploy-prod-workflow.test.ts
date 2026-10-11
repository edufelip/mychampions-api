import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));

type WorkflowStep = { name?: string; run?: string };
type Workflow = { jobs: { deploy: { steps: WorkflowStep[] } } };

// Stands in for the Railway CLI. `logs` prints the success line only from read FAKE_SUCCESS_ON_READ on
// (0 = never), like Railway indexing the last pre-deploy line late.
const FAKE_RAILWAY = `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  deployment)
    printf '[{"id":"deployment-1","status":"SUCCESS"}]\\n'
    ;;
  logs)
    reads=$(( $(cat "$FAKE_DIR/reads" 2>/dev/null || echo 0) + 1 ))
    echo "$reads" > "$FAKE_DIR/reads"
    printf '[⣷] applying migrations...{\\n'
    if [ "$FAKE_SUCCESS_ON_READ" -gt 0 ] && [ "$reads" -ge "$FAKE_SUCCESS_ON_READ" ]; then
      printf '[✓] migrations applied successfully!\\n'
    fi
    ;;
esac
`;

const FAKE_SLEEP = `#!/usr/bin/env bash
echo "$1" >> "$FAKE_DIR/sleeps"
`;

async function migrationResultScript() {
  const workflow = Bun.YAML.parse(
    await readFile(join(serverRoot, '.github', 'workflows', 'deploy-prod.yml'), 'utf8')
  ) as Workflow;
  const step = workflow.jobs.deploy.steps.find((candidate) => candidate.name === 'Database migration result');
  if (!step?.run) throw new Error('Database migration result step not found');
  return step.run;
}

async function runMigrationResult(successOnRead: number) {
  const fakeDir = await mkdtemp(join(tmpdir(), 'fake-railway-deploy-'));
  try {
    await writeFile(join(fakeDir, 'railway'), FAKE_RAILWAY);
    await writeFile(join(fakeDir, 'sleep'), FAKE_SLEEP);
    await chmod(join(fakeDir, 'railway'), 0o755);
    await chmod(join(fakeDir, 'sleep'), 0o755);
    // GitHub runs `run:` steps with `bash -e {0}`.
    const child = Bun.spawn(['bash', '-e', '-c', await migrationResultScript()], {
      env: {
        ...process.env,
        PATH: `${fakeDir}:${process.env.PATH ?? ''}`,
        FAKE_DIR: fakeDir,
        FAKE_SUCCESS_ON_READ: String(successOnRead),
        RAILWAY_SERVICE: 'api',
        RAILWAY_ENVIRONMENT: 'production',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    const sleepsFile = Bun.file(join(fakeDir, 'sleeps'));

    return {
      exitCode,
      stdout,
      reads: Number((await readFile(join(fakeDir, 'reads'), 'utf8')).trim()),
      sleeps: (await sleepsFile.exists()) ? (await sleepsFile.text()).trim().split('\n') : [],
    };
  } finally {
    await rm(fakeDir, { recursive: true, force: true });
  }
}

describe('Deploy API (Production) database migration result', () => {
  it('passes on the first read when the migration result is already in the deployment log', async () => {
    const result = await runMigrationResult(1);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Railway deployment: deployment-1');
    expect(result.stdout).toContain('migrations applied successfully');
    expect(result.reads).toBe(1);
    expect(result.sleeps).toEqual([]);
  });

  it('keeps reading the log until the late-indexed migration result appears', async () => {
    const result = await runMigrationResult(3);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('migrations applied successfully');
    expect(result.reads).toBe(3);
    expect(result.sleeps).toEqual(['5', '5']);
  });

  it('fails after a bounded number of reads when the migration never succeeded', async () => {
    const result = await runMigrationResult(0);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('::error::No successful migration result found.');
    expect(result.reads).toBe(12);
    expect(result.sleeps).toHaveLength(11);
  });
});
