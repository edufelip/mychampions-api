import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import {
  assertResourceManifest,
  type ResourceManifest,
} from '../../scripts/testing/document-validation';

export type DatabaseKey =
  | 'DATABASE_URL'
  | 'FOOD_CATALOG_DATABASE_URL'
  | 'EXERCISE_CATALOG_DATABASE_URL';
export type TestManifest = ResourceManifest;

export function validateTestTarget(
  raw: string | undefined,
  manifest: TestManifest,
  key: DatabaseKey,
  token: string | undefined
) {
  const reject = () => {
    throw new Error(
      'Unsafe/unowned test database. Use bun run test:integration; developer and remote databases are forbidden.'
    );
  };
  if (
    !raw ||
    !token ||
    !manifest ||
    manifest.schemaVersion !== 1 ||
    !/^[a-f0-9]{24}$/.test(manifest.runId)
  )
    return reject();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject();
  }
  const expectedName = `mc_test_${manifest.runId}${key === 'DATABASE_URL' ? '' : key === 'FOOD_CATALOG_DATABASE_URL' ? '_food' : '_exercise'}`;
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== '127.0.0.1' ||
    Number(url.port) !== manifest.port ||
    manifest.port === 15432 ||
    manifest.port < 1024 ||
    manifest.port > 65535 ||
    url.pathname !== `/${expectedName}` ||
    manifest.targets[key] !== expectedName ||
    url.username !== 'mc_test' ||
    !url.password ||
    url.search ||
    url.hash ||
    manifest.composeProject !== `mc_test_${manifest.runId}` ||
    createHash('sha256').update(token).digest('hex') !== manifest.ownerTokenHash
  )
    return reject();
  return raw;
}

export function loadTestManifest(
  env: NodeJS.ProcessEnv = process.env
): TestManifest {
  if (!env.MC_TEST_MANIFEST)
    throw new Error(
      'Missing MC_TEST_MANIFEST. DB tests require the owned disposable integration runner.'
    );
  const actual = realpathSync(env.MC_TEST_MANIFEST);
  const root = realpathSync(path.resolve(import.meta.dir, '../../.qa/runtime'));
  const manifest: unknown = JSON.parse(readFileSync(actual, 'utf8'));
  assertResourceManifest(manifest);
  const repoRoot = realpathSync(path.resolve(import.meta.dir, '../..'));
  if (
    actual !== path.join(root, manifest.runId, 'manifest.json') ||
    manifest.runtimeRoot !== root ||
    manifest.repoRoot !== repoRoot ||
    manifest.artifactRoot !== path.dirname(actual) ||
    manifest.composeProject !== `mc_test_${manifest.runId}` ||
    !manifest.processes.some(
      (record) =>
        record.role === 'orchestrator' &&
        record.pid === manifest.orchestratorPid
    )
  )
    throw new Error('Manifest must belong to this repository runtime ledger.');
  return manifest;
}

export async function requireOwnedTestDatabase(
  key: DatabaseKey = 'DATABASE_URL',
  env: NodeJS.ProcessEnv = process.env
) {
  const manifest = loadTestManifest(env);
  const raw = validateTestTarget(
    env[key],
    manifest,
    key,
    env.MC_TEST_OWNER_TOKEN
  );
  const sql = postgres(raw, { max: 1, connect_timeout: 5 });
  try {
    const rows =
      await sql`select run_id, owner_token_hash from mc_test_ownership.marker where singleton = true`;
    if (
      rows.length !== 1 ||
      rows[0].run_id !== manifest.runId ||
      rows[0].owner_token_hash !== manifest.ownerTokenHash
    )
      throw new Error(
        'Database ownership marker mismatch. No test mutation permitted.'
      );
  } finally {
    await sql.end({ timeout: 2 });
  }
  return raw;
}
