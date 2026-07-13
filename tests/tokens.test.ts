import { describe, expect, it } from 'bun:test';
import { exportJWK, generateKeyPair } from 'jose';

import { createTokenService } from '../src/auth/tokens';

describe('TokenService', () => {
  it('refuses to start without configured signing material when required', () => {
    expect(() =>
      createTokenService({
        issuer: 'mychampions-test',
        audience: 'mychampions-mobile',
        requireConfiguredSigningKey: true,
      })
    ).toThrow('AUTH_JWT_PRIVATE_JWK is required');
  });

  it('verifies tokens from a new service instance when both use configured signing material', async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const signingKey = await exportJWK(privateKey);
    const first = createTokenService({
      issuer: 'mychampions-test',
      audience: 'mychampions-mobile',
      signingKey,
    });
    const second = createTokenService({
      issuer: 'mychampions-test',
      audience: 'mychampions-mobile',
      signingKey,
    });

    const token = await first.issue({
      sub: 'auth-user-1',
      email: 'user@example.test',
      displayName: 'User',
      emailVerified: true,
    });

    await expect(second.verify(token)).resolves.toMatchObject({
      sub: 'auth-user-1',
      email: 'user@example.test',
      displayName: 'User',
      emailVerified: true,
    });
  });

  it('uses an asynchronously loaded signing key across service instances', async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const signingKey = await exportJWK(privateKey);
    const first = createTokenService({
      issuer: 'mychampions-test',
      audience: 'mychampions-mobile',
      signingKeyLoader: async () => signingKey,
    });
    const second = createTokenService({
      issuer: 'mychampions-test',
      audience: 'mychampions-mobile',
      signingKeyLoader: async () => signingKey,
    });

    const token = await first.issue({
      sub: 'auth-user-1',
      email: 'user@example.test',
      displayName: 'User',
      emailVerified: true,
    });

    await expect(second.verify(token)).resolves.toMatchObject({ sub: 'auth-user-1' });
  });
});
