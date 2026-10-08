import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'bun:test';

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const startScript = join(serverRoot, 'infra', 'railway', 'start.sh');

let workDir: string | null = null;

afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = null;
});

async function runStart(env: Record<string, string | undefined>, command: string[]) {
  const child = Bun.spawn(['sh', startScript, ...command], {
    cwd: serverRoot,
    env: { PATH: process.env.PATH, ...env },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  return {
    exitCode: await child.exited,
    stdout: await new Response(child.stdout).text(),
  };
}

describe('Railway start script', () => {
  it('writes the base64 GCS key to a private file and points the app at it', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'railway-start-'));
    const keyFile = join(workDir, 'gcs.json');
    const key = JSON.stringify({ type: 'service_account', project_id: 'test' });

    const result = await runStart(
      {
        GCS_SERVICE_ACCOUNT_JSON_B64: Buffer.from(key).toString('base64'),
        GCS_SERVICE_ACCOUNT_KEY_FILE: keyFile,
      },
      ['sh', '-c', 'printf "%s" "$STORAGE_GCS_CREDENTIALS_PATH"']
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(keyFile);
    expect(await readFile(keyFile, 'utf8')).toBe(key);
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
  });

  it('leaves the environment unchanged without a GCS key', async () => {
    const result = await runStart(
      { STORAGE_GCS_CREDENTIALS_PATH: '/run/secrets/existing.json' },
      ['sh', '-c', 'printf "%s" "$STORAGE_GCS_CREDENTIALS_PATH"']
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/run/secrets/existing.json');
  });
});
