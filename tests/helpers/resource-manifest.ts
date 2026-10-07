import { createHash } from 'node:crypto';
import path from 'node:path';
import type { TestManifest } from './test-database';

export function manifestFixture(
  runId: string,
  artifactRoot: string,
  token: string
): TestManifest {
  const repoRoot = path.resolve(import.meta.dir, '../..');
  const repository = {
    sha: '1'.repeat(40),
    dirty: false,
    workingTreeHash: '2'.repeat(64),
  };
  return {
    schemaVersion: 1,
    runId,
    composeProject: `mc_test_${runId}`,
    containerId: null,
    ownerTokenHash: createHash('sha256').update(token).digest('hex'),
    port: 0,
    targets: {
      DATABASE_URL: `mc_test_${runId}`,
      FOOD_CATALOG_DATABASE_URL: `mc_test_${runId}_food`,
      EXERCISE_CATALOG_DATABASE_URL: `mc_test_${runId}_exercise`,
    },
    repoRoot,
    runtimeRoot: path.join(repoRoot, '.qa/runtime'),
    artifactRoot,
    createdAt: new Date(0).toISOString(),
    repositories: { server: repository, client: repository },
    orchestratorPid: process.pid,
    testChildPid: null,
    phase: 'bootstrap',
    fixtureScopes: [],
    processes: [
      {
        role: 'orchestrator',
        pid: process.pid,
        started: 'unit-fixture',
        script: path.resolve(import.meta.path),
      },
    ],
  };
}
