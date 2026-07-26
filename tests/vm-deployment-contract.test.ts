import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));

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

    expect(dockerfile).toContain('FROM oven/bun:1.3.10');
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

  it('keeps live RevenueCat evidence verification read-only and constrained to the production VM', async () => {
    const evidenceScript = await readFile(
      join(serverRoot, 'infra', 'scripts', 'verify-revenuecat-live-evidence.sh'),
      'utf8'
    );
    const dryRun = await runScript('infra/scripts/verify-revenuecat-live-evidence.sh', {
      env: {
        REVENUECAT_TEST_APP_USER_ID: 'rc-live-contract-test',
        EXPECTED_PROFESSIONAL_STATUS: 'active',
        EXPECTED_AI_STATUS: 'lapsed',
      },
    });
    const unsafeHost = await runScript('infra/scripts/verify-revenuecat-live-evidence.sh', {
      args: ['--verify'],
      env: {
        MYCHAMPIONS_VM_SSH_HOST: 'unsafe-host',
        REVENUECAT_TEST_APP_USER_ID: 'rc-live-contract-test',
        EXPECTED_PROFESSIONAL_STATUS: 'active',
        EXPECTED_AI_STATUS: 'lapsed',
      },
    });

    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).toContain('Dry run only. No SSH, provider read, or database read was performed.');
    expect(dryRun.stdout).toContain('rc-live-contract-test');
    expect(unsafeHost.exitCode).toBe(2);
    expect(unsafeHost.stderr).toContain('MYCHAMPIONS_VM_SSH_HOST must be digiocean');
    expect(evidenceScript).toContain('select');
    expect(evidenceScript).toContain('subscription_entitlement_snapshots');
    expect(evidenceScript).toContain('RevenueCatRestCustomerManager');
    expect(evidenceScript).not.toMatch(/\b(insert|update|delete|truncate|drop)\b/i);

    const timeoutLoopIndex = evidenceScript.indexOf('while (Date.now() <= deadline)');
    const providerRefreshIndex = evidenceScript.indexOf(
      'privileges = await customerManager.getCustomerPrivileges(appUserId)',
      timeoutLoopIndex
    );
    const snapshotRefreshIndex = evidenceScript.indexOf(
      'from subscription_entitlement_snapshots',
      timeoutLoopIndex
    );
    const combinedConvergenceIndex = evidenceScript.indexOf(
      'if (providerMatches && snapshotMatches)',
      timeoutLoopIndex
    );
    expect(timeoutLoopIndex).toBeGreaterThan(-1);
    expect(providerRefreshIndex).toBeGreaterThan(timeoutLoopIndex);
    expect(snapshotRefreshIndex).toBeGreaterThan(providerRefreshIndex);
    expect(combinedConvergenceIndex).toBeGreaterThan(snapshotRefreshIndex);
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
});
