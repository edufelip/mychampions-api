import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import postgres from 'postgres';

// Runs infra/scripts/revenuecat-live-evidence.remote.ts the way the production container does
// (`bun -e` from the server root) against the local database, with fetch replaced so nothing reaches
// RevenueCat.
const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_server_local';
const databaseName = new URL(databaseUrl).pathname.slice(1);
const databasePassword = decodeURIComponent(new URL(databaseUrl).password);
const secretApiKey = 'sk_live_evidence_contract_secret';
const uidPrefix = `rc-evidence-${process.pid}-`;
const productionApi = {
  RAILWAY_PROJECT_ID: 'f8ac2da4-916e-4017-93dc-167e8a5ad9f3',
  RAILWAY_ENVIRONMENT_ID: '9ccf6768-f3fd-453a-86d0-b85e42759619',
  RAILWAY_SERVICE_ID: '6a0249fa-e25e-4a13-906b-c64965b63a51',
};

const FETCH_STUB = `
import { appendFileSync } from 'node:fs';

globalThis.fetch = (async (input, init) => {
  appendFileSync(
    process.env.FAKE_REVENUECAT_LOG,
    JSON.stringify({ url: String(input), method: init?.method ?? 'GET' }) + '\\n'
  );
  return new Response(process.env.FAKE_REVENUECAT_BODY ?? '{}', {
    status: Number(process.env.FAKE_REVENUECAT_STATUS ?? '200'),
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;
`;

const sql = postgres(databaseUrl, { max: 1 });
let program = '';
let workDir = '';
let uidCounter = 0;

function nextUid() {
  uidCounter += 1;
  return `${uidPrefix}${uidCounter}`;
}

function revenueCatCustomer(entitlements: { professional: boolean; ai: boolean }) {
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const active: Record<string, { expires_date: string; product_identifier: string }> = {};
  const subscriptions: Record<string, Record<string, never>> = {};
  if (entitlements.professional) {
    active.professional_pro = { expires_date: future, product_identifier: 'professional_monthly' };
    subscriptions.professional_monthly = {};
  }
  if (entitlements.ai) {
    active.student_pro = { expires_date: future, product_identifier: 'student_monthly' };
    subscriptions.student_monthly = {};
  }
  return JSON.stringify({
    request_date: new Date().toISOString(),
    subscriber: { entitlements: active, subscriptions },
  });
}

async function seedSnapshot(uid: string, professional: 'active' | 'lapsed', ai: 'active' | 'lapsed') {
  await sql`
    insert into subscription_entitlement_snapshots
      (auth_uid, professional_entitlement_status, ai_entitlement_status, observed_at)
    values (${uid}, ${professional}, ${ai}, now())
  `;
}

async function runProgram(options: {
  uid: string;
  provider?: { professional: boolean; ai: boolean };
  providerStatus?: number;
  env?: Record<string, string>;
}) {
  const fetchLog = join(workDir, `fetch-${options.uid}.log`);
  await writeFile(fetchLog, '');
  const child = Bun.spawn(['bun', '--preload', join(workDir, 'fetch-stub.ts'), '-e', program], {
    cwd: serverRoot,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      DATABASE_URL: databaseUrl,
      REVENUECAT_SECRET_API_KEY: secretApiKey,
      ...productionApi,
      RAILWAY_DEPLOYMENT_ID: 'deployment-contract-test',
      EVIDENCE_APP_USER_ID: options.uid,
      EVIDENCE_EXPECTED_PROFESSIONAL_STATUS: 'active',
      EVIDENCE_EXPECTED_AI_STATUS: 'lapsed',
      EVIDENCE_TIMEOUT_SECONDS: '1',
      EVIDENCE_RAILWAY_PROJECT_ID: productionApi.RAILWAY_PROJECT_ID,
      EVIDENCE_RAILWAY_ENVIRONMENT_ID: productionApi.RAILWAY_ENVIRONMENT_ID,
      EVIDENCE_RAILWAY_SERVICE_ID: productionApi.RAILWAY_SERVICE_ID,
      EVIDENCE_DATABASE_NAME: databaseName,
      FAKE_REVENUECAT_LOG: fetchLog,
      FAKE_REVENUECAT_BODY: revenueCatCustomer(options.provider ?? { professional: true, ai: false }),
      FAKE_REVENUECAT_STATUS: String(options.providerStatus ?? 200),
      ...options.env,
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const providerCalls = (await readFile(fetchLog, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { url: string; method: string });

  return { exitCode, stdout, stderr, providerCalls };
}

function evidenceJson(stdout: string) {
  return JSON.parse(stdout.replace(/\nREVENUECAT_LIVE_EVIDENCE_CONVERGED\n?$/, ''));
}

beforeAll(async () => {
  program = await readFile(join(serverRoot, 'infra', 'scripts', 'revenuecat-live-evidence.remote.ts'), 'utf8');
  workDir = await mkdtemp(join(tmpdir(), 'revenuecat-live-evidence-'));
  await writeFile(join(workDir, 'fetch-stub.ts'), FETCH_STUB);
});

afterAll(async () => {
  await sql`delete from subscription_entitlement_snapshots where auth_uid like ${`${uidPrefix}%`}`;
  await sql.end();
  await rm(workDir, { recursive: true, force: true });
});

describe('RevenueCat live evidence program', () => {
  it('passes only when RevenueCat and the snapshot match, without printing credentials', async () => {
    const uid = nextUid();
    await seedSnapshot(uid, 'active', 'lapsed');

    const result = await runProgram({ uid });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trimEnd().split('\n').at(-1)).toBe('REVENUECAT_LIVE_EVIDENCE_CONVERGED');
    expect(evidenceJson(result.stdout)).toMatchObject({
      appUserId: uid,
      converged: true,
      revenueCatQueried: true,
      target: {
        railwayProjectId: productionApi.RAILWAY_PROJECT_ID,
        railwayEnvironmentId: productionApi.RAILWAY_ENVIRONMENT_ID,
        railwayServiceId: productionApi.RAILWAY_SERVICE_ID,
        railwayDeploymentId: 'deployment-contract-test',
        database: databaseName,
        readOnlySession: true,
      },
      revenueCat: { professionalEntitlementStatus: 'active', aiEntitlementStatus: 'lapsed' },
      serverSnapshot: { professionalEntitlementStatus: 'active', aiEntitlementStatus: 'lapsed' },
    });
    expect(result.providerCalls).toEqual([
      { url: `https://api.revenuecat.com/v1/subscribers/${uid}`, method: 'GET' },
    ]);
    for (const output of [result.stdout, result.stderr]) {
      expect(output).not.toContain(secretApiKey);
      expect(output).not.toContain(databasePassword);
    }
  });

  it('refuses a container outside the production api service before reading anything', async () => {
    const result = await runProgram({
      uid: nextUid(),
      env: {
        // The mychampions-dev project, whose api service also runs in an environment named production.
        RAILWAY_PROJECT_ID: '37922f57-f237-4f01-b59e-b547fdf4b414',
        // Unreachable: a database read would fail with a connection error instead of the refusal.
        DATABASE_URL: 'postgres://nobody:unused@127.0.0.1:9/none',
      },
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Refusing live evidence verification');
    expect(result.stderr).toContain('not the expected production api service');
    expect(result.stdout).toBe('');
    expect(result.providerCalls).toEqual([]);
  });

  it('refuses when the connected database is not the expected one', async () => {
    const uid = nextUid();
    await seedSnapshot(uid, 'active', 'lapsed');

    const result = await runProgram({ uid, env: { EVIDENCE_DATABASE_NAME: 'mychampions_server' } });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(`connected to database ${databaseName}, not mychampions_server`);
    expect(result.providerCalls).toEqual([]);
  });

  it('refuses without a server-only RevenueCat key', async () => {
    const result = await runProgram({
      uid: nextUid(),
      env: { REVENUECAT_SECRET_API_KEY: 'appl_public_key' },
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('server-only RevenueCat sk_* key');
    expect(result.stderr).not.toContain('appl_public_key');
    expect(result.providerCalls).toEqual([]);
  });

  it('never queries RevenueCat for an App User ID without a production snapshot', async () => {
    const result = await runProgram({ uid: nextUid() });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('RevenueCat was not queried');
    expect(result.stdout).not.toContain('REVENUECAT_LIVE_EVIDENCE_CONVERGED');
    expect(evidenceJson(result.stdout)).toMatchObject({ converged: false, revenueCatQueried: false });
    expect(result.providerCalls).toEqual([]);
  });

  it('fails at the deadline when the snapshot does not match RevenueCat', async () => {
    const uid = nextUid();
    await seedSnapshot(uid, 'lapsed', 'lapsed');

    const startedAt = Date.now();
    const result = await runProgram({ uid });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Production subscription snapshot did not converge before the deadline.');
    expect(result.stdout).not.toContain('REVENUECAT_LIVE_EVIDENCE_CONVERGED');
    expect(result.providerCalls.length).toBeGreaterThanOrEqual(1);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it('fails when RevenueCat does not match the expected state', async () => {
    const uid = nextUid();
    await seedSnapshot(uid, 'active', 'lapsed');

    const result = await runProgram({ uid, provider: { professional: false, ai: false } });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Canonical RevenueCat privileges do not match the expected live state.');
    expect(result.stdout).not.toContain('REVENUECAT_LIVE_EVIDENCE_CONVERGED');
  });

  it('does not let a failed RevenueCat read pass', async () => {
    const uid = nextUid();
    await seedSnapshot(uid, 'active', 'lapsed');

    const result = await runProgram({ uid, providerStatus: 500 });

    expect(result.exitCode).toBe(1);
    expect(evidenceJson(result.stdout)).toMatchObject({ converged: false, revenueCat: null });
    expect(result.stdout).not.toContain('REVENUECAT_LIVE_EVIDENCE_CONVERGED');
  });
});
