import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportJWK, generateKeyPair, type JWK } from 'jose';

export const LOCAL_SIGNING_KEY_PATH = fileURLToPath(
  new URL('../../.local-storage/auth-signing-key.jwk.json', import.meta.url)
);

export function createLocalSigningKeyLoader(keyPath = LOCAL_SIGNING_KEY_PATH): () => Promise<JWK> {
  let signingKeyPromise: Promise<JWK> | undefined;

  return () => {
    signingKeyPromise ??= loadOrCreateLocalSigningKey(keyPath);
    return signingKeyPromise;
  };
}

async function loadOrCreateLocalSigningKey(keyPath: string): Promise<JWK> {
  try {
    return await readLocalSigningKey(keyPath);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) {
      throw error;
    }
  }

  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });

  try {
    return await readLocalSigningKey(keyPath);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) {
      throw error;
    }
  }

  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const generatedKey = requirePrivateRsaJwk(await exportJWK(privateKey));
  const temporaryPath = `${keyPath}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, JSON.stringify(generatedKey), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await chmod(temporaryPath, 0o600);

    try {
      await link(temporaryPath, keyPath);
      await chmod(keyPath, 0o600);
      return generatedKey;
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) {
        throw error;
      }
      return readLocalSigningKey(keyPath);
    }
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!hasCode(error, 'ENOENT')) {
        throw error;
      }
    });
  }
}

async function readLocalSigningKey(keyPath: string): Promise<JWK> {
  const entry = await lstat(keyPath);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error('local_auth_signing_key_invalid');
  }
  await chmod(keyPath, 0o600);
  try {
    return requirePrivateRsaJwk(JSON.parse(await readFile(keyPath, 'utf8')));
  } catch {
    throw new Error('local_auth_signing_key_invalid');
  }
}

function requirePrivateRsaJwk(value: unknown): JWK {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { kty?: unknown }).kty !== 'RSA' ||
    !hasNonEmptyString(value, 'n') ||
    !hasNonEmptyString(value, 'e') ||
    !hasNonEmptyString(value, 'd')
  ) {
    throw new Error('local_auth_signing_key_invalid');
  }
  return value as JWK;
}

function hasNonEmptyString(value: object, key: string): boolean {
  return typeof (value as Record<string, unknown>)[key] === 'string' && (value as Record<string, string>)[key].length > 0;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}
