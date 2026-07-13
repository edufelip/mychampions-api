import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function runScript(options: { args?: string[]; env?: Record<string, string | undefined> } = {}) {
  const child = Bun.spawn(['bash', 'infra/scripts/provision-gcs.sh', ...(options.args ?? [])], {
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

describe('GCS provisioning contract', () => {
  it('defaults to no-write mode and refuses an alternate project target', async () => {
    const dryRun = await runScript();
    const unsafeProject = await runScript({
      env: { MYCHAMPIONS_GCP_PROJECT_ID: 'another-project' },
    });

    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).toContain('Dry run only. No Google Cloud or VM state will change.');
    expect(dryRun.stdout).toContain('Target project: mychampions-fb928');
    expect(unsafeProject.exitCode).toBe(1);
    expect(unsafeProject.stderr).toContain('MYCHAMPIONS_GCP_PROJECT_ID must be the approved project');
  });

  it('uses the billed MyChampions GCP project for a dedicated private bucket and VM credential', async () => {
    const script = await readFile(join(serverRoot, 'infra', 'scripts', 'provision-gcs.sh'), 'utf8');

    expect(script).toContain('mychampions-fb928');
    expect(script).toContain('mychampions-server-media-942354515358');
    expect(script).toContain('gcloud billing projects describe "$project_id"');
    expect(script).not.toContain('gcloud projects create');
    expect(script).not.toContain('gcloud billing projects link');
    expect(script).toContain('gcloud services enable storage.googleapis.com');
    expect(script).toContain('gcloud storage buckets create "gs://$bucket_name"');
    expect(script).toContain('--uniform-bucket-level-access');
    expect(script).toContain('--public-access-prevention');
    expect(script).toContain('--raw --format=json');
    expect(script).toContain('roles/storage.objectAdmin');
    expect(script).toContain('wait_for_service_account_key_api()');
    expect(script).toContain('gcloud iam service-accounts keys list');
    expect(script).toContain('gcloud iam service-accounts keys create "$temporary_key_file"');
    expect(script).toContain('/opt/mychampions-server/infra/secrets/mychampions-gcs-service-account.json');
    expect(script).toContain("install -d -m 700 '$remote_credentials_dir'");
    expect(script.indexOf("install -d -m 700 '$remote_credentials_dir'")).toBeLessThan(script.indexOf('scp -q -p'));
    const bucketBinding = script.slice(
      script.indexOf('gcloud storage buckets add-iam-policy-binding'),
      script.indexOf('temporary_key_file=')
    );
    const keyCreation = script.slice(
      script.indexOf('gcloud iam service-accounts keys create'),
      script.indexOf('created_key_id="$(jq')
    );
    expect(bucketBinding).toContain('--quiet >/dev/null');
    expect(keyCreation).toContain('--quiet >/dev/null');
    expect(script).not.toContain('allUsers');
  });
});
