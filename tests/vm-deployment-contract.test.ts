import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const EVIDENCE_SCRIPT = 'infra/scripts/verify-revenuecat-live-evidence.sh';
const EVIDENCE_PROGRAM = join(serverRoot, 'infra', 'scripts', 'revenuecat-live-evidence.remote.ts');
const RAILWAY_PRODUCTION_API = {
  projectId: 'f8ac2da4-916e-4017-93dc-167e8a5ad9f3',
  environmentId: '9ccf6768-f3fd-453a-86d0-b85e42759619',
  serviceId: '6a0249fa-e25e-4a13-906b-c64965b63a51',
};
const EVIDENCE_REQUEST = {
  REVENUECAT_TEST_APP_USER_ID: 'rc-live-contract-test',
  EXPECTED_PROFESSIONAL_STATUS: 'active',
  EXPECTED_AI_STATUS: 'lapsed',
};

// Stands in for the Railway CLI: records its argv and stdin, then answers like the relay would.
const FAKE_RAILWAY = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\0' "$@" > "$FAKE_RAILWAY_DIR/argv"
if [ -t 0 ]; then printf tty > "$FAKE_RAILWAY_DIR/stdin"; else cat > "$FAKE_RAILWAY_DIR/stdin"; fi
case "$FAKE_RAILWAY_MODE" in
  converged)
    printf '{"converged": true}\\nREVENUECAT_LIVE_EVIDENCE_CONVERGED\\n'
    ;;
  relay-without-command)
    printf '{"status":"provisioning"}\\n'
    ;;
  remote-refusal)
    echo 'Refusing live evidence verification: not the expected production api service.' >&2
    exit 2
    ;;
esac
`;

async function runEvidenceVerifier(
  options: { args?: string[]; env?: Record<string, string>; railwayMode?: string } = {}
) {
  const fakeDir = await mkdtemp(join(tmpdir(), 'fake-railway-'));
  try {
    await writeFile(join(fakeDir, 'railway'), FAKE_RAILWAY);
    await chmod(join(fakeDir, 'railway'), 0o755);
    const child = Bun.spawn(['bash', EVIDENCE_SCRIPT, ...(options.args ?? [])], {
      cwd: serverRoot,
      env: {
        ...process.env,
        ...EVIDENCE_REQUEST,
        PATH: `${fakeDir}:${process.env.PATH ?? ''}`,
        FAKE_RAILWAY_DIR: fakeDir,
        FAKE_RAILWAY_MODE: options.railwayMode ?? 'converged',
        ...options.env,
      },
      // Railway must never see this: the verifier gives the CLI /dev/null.
      stdin: new Blob(['stdin-must-not-reach-railway']),
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const argvFile = Bun.file(join(fakeDir, 'argv'));
    const stdinFile = Bun.file(join(fakeDir, 'stdin'));

    return {
      exitCode,
      stdout,
      stderr,
      railwayArgv: (await argvFile.exists()) ? (await argvFile.text()).split('\0').slice(0, -1) : null,
      railwayStdin: (await stdinFile.exists()) ? await stdinFile.text() : null,
    };
  } finally {
    await rm(fakeDir, { recursive: true, force: true });
  }
}

async function runScript(
  path: string,
  options: { args?: string[]; env?: Record<string, string | undefined> } = {}
) {
  const child = Bun.spawn(['bash', path, ...(options.args ?? [])], {
    cwd: serverRoot,
    env: { ...process.env, ...options.env },
    stderr: 'pipe',
    stdout: 'pipe',
  });

  return {
    exitCode: await child.exited,
    stderr: await new Response(child.stderr).text(),
    stdout: await new Response(child.stdout).text(),
  };
}

describe('VM deployment contract', () => {
  it('pins Bun and keeps application traffic loopback-only behind the existing VM network', async () => {
    const dockerfile = await readFile(join(serverRoot, 'Dockerfile'), 'utf8');
    const compose = await readFile(join(serverRoot, 'infra', 'docker-compose.vm.yml'), 'utf8');

    expect(dockerfile).toContain('FROM oven/bun:1.3.14');
    expect(compose).toContain('127.0.0.1:3400:3400');
    expect(compose).toContain('127.0.0.1:3401:3400');
    expect(compose).toContain('root_default:');
    expect(compose).toContain('external: true');
    expect(compose).toContain('env_file: .env');
  });

  it('keeps GCS credentials mounted read-only and migrations separate from serving containers', async () => {
    const compose = await readFile(join(serverRoot, 'infra', 'docker-compose.vm.yml'), 'utf8');

    expect(compose).toContain('/run/secrets/mychampions-gcs-service-account.json:ro');
    expect(compose).toContain('migrate:');
    expect(compose).toContain('"db:migrate"');
  });

  it('limits VM database provisioning to the isolated server and read-only catalog roles', async () => {
    const provision = await readFile(join(serverRoot, 'infra', 'scripts', 'provision-vm-db.sh'), 'utf8');

    expect(provision).toContain('mychampions_server');
    expect(provision).toContain('mychampions_server_user');
    expect(provision).toContain('mychampions_catalog_reader');
    expect(provision).toContain('CREATE DATABASE');
    expect(provision).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE');
    expect(provision).toContain('GRANT SELECT ON ALL TABLES IN SCHEMA public');
    expect(provision).toContain('ALTER DEFAULT PRIVILEGES');
    expect(provision).toContain('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    expect(provision).toContain('GRANT USAGE, CREATE ON SCHEMA public TO "$server_role"');
    expect(provision).toContain('REVENUECAT_SECRET_API_KEY=');
    expect(provision).toContain('REVENUECAT_WEBHOOK_AUTHORIZATION=');
    expect(provision).toContain('REVENUECAT_WEBHOOK_SIGNING_SECRET=');
    expect(provision).toContain('TRUSTED_PROXY_HEADER=x-real-ip');
    expect(provision).toContain('--apply');
    expect(provision).toContain('psql_admin_query()');
    expect(provision).toContain('psql_admin_stdin()');
    expect(provision).toContain('target_exists="$(psql_admin_query');
    expect(provision).not.toContain('target_exists="$(psql_admin_stdin');
    expect(provision).toContain(
      'install -m 600 "$temporary_env_file" "$remote_env_file"\nrm -f "$temporary_env_file"\ntemporary_env_file=""'
    );
  });

  it('defaults VM database provisioning to no-write mode and rejects an unsafe SSH target', async () => {
    const dryRun = await runScript('infra/scripts/provision-vm-db.sh');
    const unsafeHost = await runScript('infra/scripts/provision-vm-db.sh', {
      env: { MYCHAMPIONS_VM_SSH_HOST: 'not-digiocean' },
    });

    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).toContain('Dry run only. No VM state will change.');
    expect(dryRun.stdout).toContain('mychampions_server');
    expect(unsafeHost.exitCode).toBe(1);
    expect(unsafeHost.stderr).toContain('MYCHAMPIONS_VM_SSH_HOST must be digiocean');
  });

  it('uses a health-checked migration-before-cutover deployment and an Nginx local upstream', async () => {
    const deploy = await readFile(join(serverRoot, 'infra', 'scripts', 'deploy-vm.sh'), 'utf8');
    const nginx = await readFile(join(serverRoot, 'infra', 'nginx', 'mychampions-server.conf'), 'utf8');

    expect(deploy).toContain('run --rm migrate');
    expect(deploy).toContain('/health');
    expect(deploy).toContain('nginx -t');
    expect(deploy).toContain('IMAGE_REPOSITORY and IMAGE_TAG must be explicitly set');
    expect(deploy).not.toContain('IMAGE_REPOSITORY:-ghcr.io/edufelip/mychampions-server');
    expect(deploy).toContain("docker inspect --format '{{.State.Running}}' mychampions-server-blue");
    expect(deploy).toContain('Exactly one MyChampions server slot must be running before cutover.');
    expect(deploy).toContain('REVENUECAT_SECRET_API_KEY');
    expect(deploy).toContain('REVENUECAT_WEBHOOK_AUTHORIZATION');
    expect(deploy).toContain('REVENUECAT_WEBHOOK_SIGNING_SECRET');
    expect(deploy).toContain('read_configured_env_value');
    expect(deploy).toContain('revenuecat_runtime_value="$(read_configured_env_value');
    expect(deploy).toContain('[[ -z "$revenuecat_runtime_value" ]]');
    expect(deploy).not.toContain('grep -q "^${revenuecat_runtime_key}=."');
    expect(deploy).toContain('server-only sk_* key before production cutover');
    expect(nginx).toContain('127.0.0.1');
    expect(nginx).toContain('$mychampions_server_upstream');
    expect(nginx).toContain('/health');
    expect(nginx).toContain('client_max_body_size 8m;');
    expect(nginx).toContain('listen 443 ssl;');
    expect(nginx).not.toContain('listen 443 ssl http2;');
  });

  it('requires an explicit immutable image reference before production cutover', async () => {
    const result = await runScript('infra/scripts/deploy-vm.sh', {
      env: { PUBLIC_DOMAIN: 'api.example.com' },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('IMAGE_REPOSITORY and IMAGE_TAG must be explicitly set');
  });

  it('supports only an explicit preloaded-image mode for direct VM transfers', async () => {
    const deploy = await readFile(join(serverRoot, 'infra', 'scripts', 'deploy-vm.sh'), 'utf8');

    expect(deploy).toContain('IMAGE_PULL must be true or false');
    expect(deploy).toContain('docker image inspect "${image_repository}:${image_tag}"');
    expect(deploy).toContain('Skipping registry pull for verified preloaded image');
  });

  it('refuses deployment before Docker or Nginx when the required VM secrets are absent', async () => {
    const result = await runScript('infra/scripts/deploy-vm.sh', {
      env: {
        PUBLIC_DOMAIN: 'api.example.com',
        IMAGE_REPOSITORY: 'registry.example/mychampions-server',
        IMAGE_TAG: 'immutable-test-tag',
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Missing deployment prerequisite');
  });

  describe('live RevenueCat evidence verifier on Railway', () => {
    it('defaults to a dry run that names the pinned production target and never calls Railway', async () => {
      const dryRun = await runEvidenceVerifier();

      expect(dryRun.exitCode).toBe(0);
      expect(dryRun.stdout).toContain(
        'Dry run only. No Railway SSH, provider read, or database read was performed.'
      );
      expect(dryRun.stdout).toContain(RAILWAY_PRODUCTION_API.projectId);
      expect(dryRun.stdout).toContain(RAILWAY_PRODUCTION_API.environmentId);
      expect(dryRun.stdout).toContain(RAILWAY_PRODUCTION_API.serviceId);
      expect(dryRun.stdout).toContain('database mychampions_server');
      expect(dryRun.stdout).toContain('rc-live-contract-test');
      expect(dryRun.railwayArgv).toBeNull();
    });

    it('rejects unsafe requests before calling Railway', async () => {
      const unsafeUid = await runEvidenceVerifier({
        args: ['--verify'],
        env: { REVENUECAT_TEST_APP_USER_ID: 'rc-live;printenv' },
      });
      const unknownArgument = await runEvidenceVerifier({ args: ['--project=mychampions-dev'] });
      const unsafeTimeout = await runEvidenceVerifier({
        args: ['--verify'],
        env: { REVENUECAT_EVIDENCE_TIMEOUT_SECONDS: '601' },
      });

      expect(unsafeUid.exitCode).toBe(2);
      expect(unsafeUid.stderr).toContain('REVENUECAT_TEST_APP_USER_ID must be a nonblank safe ID');
      expect(unknownArgument.exitCode).toBe(2);
      expect(unknownArgument.stderr).toContain('Unknown argument: --project=mychampions-dev');
      expect(unsafeTimeout.exitCode).toBe(2);
      expect(unsafeTimeout.stderr).toContain('REVENUECAT_EVIDENCE_TIMEOUT_SECONDS must be an integer');
      expect(unsafeUid.railwayArgv).toBeNull();
      expect(unknownArgument.railwayArgv).toBeNull();
      expect(unsafeTimeout.railwayArgv).toBeNull();
    });

    it('runs the read-only program only in the pinned production api service over one remote line', async () => {
      const program = await readFile(EVIDENCE_PROGRAM, 'utf8');
      const result = await runEvidenceVerifier({ args: ['--verify'] });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('REVENUECAT_LIVE_EVIDENCE_CONVERGED');
      expect(result.stdout).toContain('converged in the same iteration');
      expect(result.railwayStdin).toBe('');

      const [subcommand, ...rest] = result.railwayArgv ?? [];
      const remoteLine = rest.at(-1) ?? '';
      expect(subcommand).toBe('ssh');
      expect(rest).toEqual([
        '--project',
        RAILWAY_PRODUCTION_API.projectId,
        '--environment',
        RAILWAY_PRODUCTION_API.environmentId,
        '--service',
        RAILWAY_PRODUCTION_API.serviceId,
        '--',
        remoteLine,
      ]);

      const match = remoteLine.match(
        new RegExp(
          '^cd /app && EVIDENCE_APP_USER_ID=rc-live-contract-test' +
            ' EVIDENCE_EXPECTED_PROFESSIONAL_STATUS=active' +
            ' EVIDENCE_EXPECTED_AI_STATUS=lapsed' +
            ' EVIDENCE_TIMEOUT_SECONDS=180' +
            ` EVIDENCE_RAILWAY_PROJECT_ID=${RAILWAY_PRODUCTION_API.projectId}` +
            ` EVIDENCE_RAILWAY_ENVIRONMENT_ID=${RAILWAY_PRODUCTION_API.environmentId}` +
            ` EVIDENCE_RAILWAY_SERVICE_ID=${RAILWAY_PRODUCTION_API.serviceId}` +
            ' EVIDENCE_DATABASE_NAME=mychampions_server' +
            ` bun -e "\\$\\(printf '%s' '([A-Za-z0-9+/=]+)' \\| base64 -d\\)"$`
        )
      );
      expect(match).not.toBeNull();
      expect(Buffer.from(match?.[1] ?? '', 'base64').toString('utf8')).toBe(program);
    });

    it('fails when Railway SSH exits 0 without the evidence result', async () => {
      const result = await runEvidenceVerifier({
        args: ['--verify'],
        railwayMode: 'relay-without-command',
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Railway SSH ended without the evidence result');
      expect(result.stdout).not.toContain('converged in the same iteration');
    });

    it('fails with the remote status when the program refuses or fails', async () => {
      const result = await runEvidenceVerifier({ args: ['--verify'], railwayMode: 'remote-refusal' });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Refusing live evidence verification');
      expect(result.stderr).toContain('Live RevenueCat evidence did not pass (exit 2).');
      expect(result.stdout).not.toContain('converged in the same iteration');
    });

    it('keeps the in-container program read-only, credential-free, and same-iteration', async () => {
      const verifier = await readFile(join(serverRoot, EVIDENCE_SCRIPT), 'utf8');
      const program = await readFile(EVIDENCE_PROGRAM, 'utf8');

      expect(verifier).not.toContain('digiocean');
      expect(verifier).not.toContain('docker exec');
      expect(verifier).not.toMatch(/railway (run|connect|variables)\b/);
      expect(program).toContain("default_transaction_read_only: 'on'");
      expect(program).toContain("current_setting('transaction_read_only')");
      expect(program).toContain('RAILWAY_PROJECT_ID');
      expect(program).toContain('RAILWAY_ENVIRONMENT_ID');
      expect(program).toContain('RAILWAY_SERVICE_ID');
      expect(program).toContain('RevenueCatRestCustomerManager');
      expect(program).not.toMatch(/\b(insert|update|delete|truncate|drop|alter|grant)\b/i);
      expect(program).not.toMatch(/console\.\w+\([^;]*(secretApiKey|databaseUrl|DATABASE_URL|REVENUECAT_SECRET_API_KEY)/);

      const readOnlyCheckIndex = program.indexOf("refuse('the database session is not read-only.')");
      const timeoutLoopIndex = program.indexOf('while (Date.now() <= deadline)', readOnlyCheckIndex);
      const snapshotRefreshIndex = program.indexOf('from subscription_entitlement_snapshots', timeoutLoopIndex);
      const providerResetIndex = program.indexOf('privileges = null;', snapshotRefreshIndex);
      const providerGateIndex = program.indexOf('if (snapshot) {', providerResetIndex);
      const providerRefreshIndex = program.indexOf(
        'privileges = await customerManager.getCustomerPrivileges(appUserId)',
        providerGateIndex
      );
      const combinedConvergenceIndex = program.indexOf(
        'if (providerMatches && snapshotMatches)',
        providerRefreshIndex
      );
      expect(readOnlyCheckIndex).toBeGreaterThan(-1);
      expect(timeoutLoopIndex).toBeGreaterThan(readOnlyCheckIndex);
      expect(snapshotRefreshIndex).toBeGreaterThan(timeoutLoopIndex);
      expect(providerResetIndex).toBeGreaterThan(snapshotRefreshIndex);
      expect(providerGateIndex).toBeGreaterThan(providerResetIndex);
      expect(providerRefreshIndex).toBeGreaterThan(providerGateIndex);
      expect(combinedConvergenceIndex).toBeGreaterThan(providerRefreshIndex);
    });
  });

  it('has a guarded bootstrap path for first public ingress without replacing a healthy slot', async () => {
    const bootstrap = await readFile(join(serverRoot, 'infra', 'scripts', 'bootstrap-public-ingress.sh'), 'utf8');

    expect(bootstrap).toContain('apply=false');
    expect(bootstrap).toContain('CERTBOT_EMAIL');
    expect(bootstrap).toContain('certbot certonly --webroot');
    expect(bootstrap).toContain('mychampions-server-blue');
    expect(bootstrap).toContain('mychampions-server-green');
    expect(bootstrap).toContain('blue_running="${blue_running:-false}"');
    expect(bootstrap).toContain('green_running="${green_running:-false}"');
    expect(bootstrap).toContain('resume_existing_ingress');
    expect(bootstrap).toContain('ln -sfn "$nginx_site" "$nginx_enabled"');
    expect(bootstrap).toContain('seq 1 10');
    expect(bootstrap).toContain('nginx -t');
    expect(bootstrap).toContain('.active_slot');
    expect(bootstrap).toContain('--resolve');
  });

  it('keeps Firebase-distribution Dev API/database deployment separate from production', async () => {
    const compose = await readFile(
      join(serverRoot, 'infra', 'dev', 'docker-compose.vm.yml'),
      'utf8'
    );
    const provision = await readFile(
      join(serverRoot, 'infra', 'scripts', 'provision-dev-vm-db.sh'),
      'utf8'
    );
    const ingress = await readFile(
      join(serverRoot, 'infra', 'scripts', 'bootstrap-dev-ingress.sh'),
      'utf8'
    );
    const deploy = await readFile(
      join(serverRoot, 'infra', 'scripts', 'deploy-dev-vm.sh'),
      'utf8'
    );

    expect(compose).toContain('name: mychampions-dev-server');
    expect(compose).toContain('127.0.0.1:3402:3400');
    expect(compose).toContain('/opt/mychampions-dev-server/shared/.env');
    expect(compose).toContain('mychampions-dev-server-storage');
    expect(compose).not.toContain('mychampions-gcs-service-account.json');
    expect(provision).toContain('mychampions_dev');
    expect(provision).toContain('mychampions_dev_user');
    expect(provision).toContain('mychampions_dev_catalog_reader');
    expect(provision).toContain('NODE_ENV=development');
    expect(provision).toContain('APP_VARIANT=dev');
    expect(provision).toContain('LOCAL_DEV_AUTH_ENABLED=false');
    expect(provision).toContain('TRUSTED_PROXY_HEADER=x-real-ip');
    expect(provision).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE');
    expect(ingress).toContain('127.0.0.1:3402');
    expect(deploy).toContain('run --rm migrate');
    expect(deploy).toContain('docker compose -f "$compose_file" up -d app');
    expect(deploy).not.toContain('mychampions-server-blue');
    expect(deploy).not.toContain('mychampions-server-green');
  });

  it('defaults Dev provisioning to no-write mode and refuses an alternate target', async () => {
    const dryRun = await runScript('infra/scripts/provision-dev-vm-db.sh');
    const unsafeHost = await runScript('infra/scripts/provision-dev-vm-db.sh', {
      env: { MYCHAMPIONS_DEV_VM_SSH_HOST: 'unsafe-host' },
    });

    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).toContain('Dry run only. No VM state will change.');
    expect(dryRun.stdout).toContain('mychampions_dev');
    expect(unsafeHost.exitCode).toBe(1);
    expect(unsafeHost.stderr).toContain('target does not match the approved Dev VM');
  });
});
