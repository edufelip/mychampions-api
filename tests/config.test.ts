import { describe, expect, it } from 'bun:test';
import { exportJWK, generateKeyPair } from 'jose';

import { readConfig } from '../src/config';

describe('server configuration', () => {
  it('rejects a public JWK where a private signing JWK is required', () => {
    expect(() =>
      readConfig({
        AUTH_JWT_PRIVATE_JWK: JSON.stringify({
          kty: 'RSA',
          n: 'public-modulus',
          e: 'AQAB',
        }),
      })
    ).toThrow('AUTH_JWT_PRIVATE_JWK must be a JSON private JWK.');
  });

  it('accepts an RSA private JWK for server token signing', async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const privateJwk = await exportJWK(privateKey);

    expect(
      readConfig({ AUTH_JWT_PRIVATE_JWK: JSON.stringify(privateJwk) }).authJwtPrivateJwk
    ).toMatchObject({ kty: 'RSA', d: expect.any(String) });
  });
});
