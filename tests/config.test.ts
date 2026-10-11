import { describe, expect, it } from 'bun:test';
import { exportJWK, generateKeyPair } from 'jose';

import { readConfig } from '../src/config';

describe('server configuration', () => {
  it('uses exact localhost web origins in development', () => {
    expect(readConfig({}).allowedWebOrigins).toEqual([
      'http://localhost:8081',
      'http://127.0.0.1:8081',
    ]);
  });

  it('uses configured web origins without wildcard expansion', () => {
    expect(
      readConfig({ WEB_ALLOWED_ORIGINS: 'https://app.example.test, https://admin.example.test' })
        .allowedWebOrigins
    ).toEqual(['https://app.example.test', 'https://admin.example.test']);
  });

  it('fails closed when production web origins are not configured', () => {
    expect(
      readConfig({ NODE_ENV: 'production', TRUSTED_PROXY_HEADER: 'x-real-ip' }).allowedWebOrigins
    ).toEqual([]);
  });

  it('trusts no client-address header unless one is configured', () => {
    expect(readConfig({}).trustedProxyHeader).toBeNull();
    expect(readConfig({ TRUSTED_PROXY_HEADER: 'none' }).trustedProxyHeader).toBeNull();
    expect(readConfig({ TRUSTED_PROXY_HEADER: ' X-Real-IP ' }).trustedProxyHeader).toBe(
      'x-real-ip'
    );
    expect(readConfig({ TRUSTED_PROXY_HEADER: 'x_client.ip' }).trustedProxyHeader).toBe(
      'x_client.ip'
    );
  });

  it('requires production to choose the trusted proxy header explicitly', () => {
    expect(() => readConfig({ NODE_ENV: 'production' })).toThrow(
      'TRUSTED_PROXY_HEADER must be set in production'
    );
    expect(
      readConfig({ NODE_ENV: 'production', TRUSTED_PROXY_HEADER: 'none' }).trustedProxyHeader
    ).toBeNull();
  });

  it('rejects a trusted proxy header that is not a single header name', () => {
    expect(() => readConfig({ TRUSTED_PROXY_HEADER: 'x-real-ip, x-forwarded-for' })).toThrow(
      'TRUSTED_PROXY_HEADER must be a request header name or none.'
    );
  });

  it('trims server-only RevenueCat customer and webhook credentials', () => {
    const config = readConfig({
      REVENUECAT_SECRET_API_KEY: ' sk_test_customer ',
      REVENUECAT_WEBHOOK_AUTHORIZATION: ' Bearer webhook-secret ',
      REVENUECAT_WEBHOOK_SIGNING_SECRET: ' signing-secret ',
    });

    expect(config.revenueCatSecretApiKey).toBe('sk_test_customer');
    expect(config.revenueCatWebhookAuthorization).toBe('Bearer webhook-secret');
    expect(config.revenueCatWebhookSigningSecret).toBe('signing-secret');
  });

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
