import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalSigningKeyLoader } from '../src/auth/local-signing-key';

describe('local signing key loader', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('persists and reuses a private RS256 JWK with owner-only permissions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mychampions-signing-key-'));
    temporaryDirectories.push(directory);
    const keyPath = join(directory, 'auth-signing-key.jwk.json');

    const first = await createLocalSigningKeyLoader(keyPath)();
    const second = await createLocalSigningKeyLoader(keyPath)();

    expect(first).toEqual(second);
    expect(first).toMatchObject({ kty: 'RSA' });
    expect(first.d).toBeString();
    expect(JSON.parse(await readFile(keyPath, 'utf8'))).toEqual(first);
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
  });

  it('fails closed when existing local signing material is invalid', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mychampions-signing-key-'));
    temporaryDirectories.push(directory);
    const keyPath = join(directory, 'auth-signing-key.jwk.json');
    await writeFile(keyPath, JSON.stringify({ kty: 'EC' }), { mode: 0o600 });

    await expect(createLocalSigningKeyLoader(keyPath)()).rejects.toThrow('local_auth_signing_key_invalid');
  });

  it('fails closed when existing local signing material is malformed JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mychampions-signing-key-'));
    temporaryDirectories.push(directory);
    const keyPath = join(directory, 'auth-signing-key.jwk.json');
    await writeFile(keyPath, '{not-json', { mode: 0o600 });

    await expect(createLocalSigningKeyLoader(keyPath)()).rejects.toThrow('local_auth_signing_key_invalid');
  });
});
