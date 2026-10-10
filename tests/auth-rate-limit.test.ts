import { describe, expect, it } from 'bun:test';

import { authRateLimitClientKey, createApp } from '../src/app';
import { InMemoryPasswordResetService } from '../src/auth/password-reset';
import { readConfig } from '../src/config';
import type { ProfileRepository } from '../src/profile/repository';

function rateLimitedConfig(overrides: Record<string, string | undefined> = {}) {
  return readConfig({
    AUTH_RATE_LIMIT_WINDOW_MS: '60000',
    AUTH_RATE_LIMIT_MAX: '3',
    LOCAL_DEV_AUTH_ENABLED: 'true',
    ...overrides,
  });
}

// Every route these tests flood (dev-session, password-reset) is reachable
// without real Postgres. Injecting in-memory doubles here — the same pattern
// every other test file in this suite already uses — keeps this file from
// opening its own real connection pool, which otherwise adds to the total
// concurrent-pool count the full 56-file suite accumulates in CI.
function makeProfileRepository(): ProfileRepository {
  return {
    async upsertFromSession(input) {
      return {
        authUid: input.authUid,
        displayName: input.displayName,
        emailNormalized: input.emailNormalized,
        lockedRole: 'student',
        acceptedTermsVersion: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
    },
    async findByAuthUid() {
      return null;
    },
    async lockRole() {
      throw new Error('not implemented');
    },
    async setAcceptedTermsVersion() {
      throw new Error('not implemented');
    },
    async deleteByAuthUid() {},
  };
}

function makeApp(overrides: Record<string, string | undefined> = {}) {
  return createApp({
    config: rateLimitedConfig(overrides),
    profileRepository: makeProfileRepository(),
    passwordResetService: new InMemoryPasswordResetService(),
  });
}

function devSessionRequest(email: string, headers: Record<string, string> = {}) {
  return new Request('http://server.test/auth/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ email, displayName: 'Rate Limit Test User' }),
  });
}

function passwordResetRequest(headers: Record<string, string> = {}) {
  return new Request('http://server.test/auth/password-reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ email: 'flood-target@example.test' }),
  });
}

function passwordResetConfirmRequest(headers: Record<string, string> = {}) {
  return new Request('http://server.test/auth/password-reset/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      email: 'flood-target@example.test',
      token: 'not-a-real-token',
      newPassword: 'Password1!',
    }),
  });
}

describe('auth rate limiting', () => {
  it('returns 429 once a client exceeds the configured per-IP request budget', async () => {
    const app = makeApp();

    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await app.handle(devSessionRequest(`flood-${i}@example.test`));
      statuses.push(response.status);
    }

    // AUTH_RATE_LIMIT_MAX=3: the first 3 requests from the same client succeed,
    // the 4th is throttled.
    expect(statuses).toEqual([201, 201, 201, 429]);

    const throttledResponse = await app.handle(devSessionRequest('flood-4@example.test'));
    expect(throttledResponse.status).toBe(429);
    expect(throttledResponse.headers.get('ratelimit-limit')).toBe('3');
  });

  it('shares one per-IP budget across every credential-adjacent route', async () => {
    const app = makeApp();

    const first = await app.handle(devSessionRequest('shared-budget-1@example.test'));
    const second = await app.handle(devSessionRequest('shared-budget-2@example.test'));
    const third = await app.handle(passwordResetRequest());
    const fourth = await app.handle(passwordResetRequest());

    // The dev-session and password-reset routes are both in the sensitive-route
    // set, so they draw down the same per-IP counter rather than each getting
    // their own independent budget of 3.
    expect([first.status, second.status, third.status]).toEqual([201, 201, 202]);
    expect(fourth.status).toBe(429);
  });

  it('also rate-limits the password-reset confirm route', async () => {
    const app = makeApp();

    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await app.handle(passwordResetConfirmRequest());
      statuses.push(response.status);
    }

    // The first 3 confirm attempts reach the handler (and correctly fail with
    // invalid_or_expired_token, since the token is fake); the 4th is throttled
    // before ever reaching the handler.
    expect(statuses.slice(0, 3)).toEqual([400, 400, 400]);
    expect(statuses[3]).toBe(429);
  });

  it('does not throttle routes outside the sensitive-route set', async () => {
    const app = makeApp();

    for (let i = 0; i < 5; i += 1) {
      await app.handle(devSessionRequest(`exhaust-${i}@example.test`));
    }

    const exhausted = await app.handle(devSessionRequest('exhaust-check@example.test'));
    expect(exhausted.status).toBe(429);

    const healthResponse = await app.handle(new Request('http://server.test/health'));
    expect(healthResponse.status).toBe(200);
  });

  it('tracks separate budgets per client IP using the trusted X-Real-IP header', async () => {
    const app = makeApp({ TRUSTED_PROXY_HEADER: 'x-real-ip' });

    const clientAStatuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await app.handle(
        devSessionRequest(`client-a-${i}@example.test`, { 'x-real-ip': '203.0.113.10' })
      );
      clientAStatuses.push(response.status);
    }
    expect(clientAStatuses).toEqual([201, 201, 201]);

    const clientAFourth = await app.handle(
      devSessionRequest('client-a-3@example.test', { 'x-real-ip': '203.0.113.10' })
    );
    expect(clientAFourth.status).toBe(429);

    // A different client IP has its own, untouched budget.
    const clientBFirst = await app.handle(
      devSessionRequest('client-b-0@example.test', { 'x-real-ip': '203.0.113.20' })
    );
    expect(clientBFirst.status).toBe(201);
  });

  it('keys on the socket address so spoofed X-Real-IP cannot reset the budget', async () => {
    // No TRUSTED_PROXY_HEADER: a client reaching the server directly rotates the
    // forwarding headers on every request, but they are ignored.
    const app = makeApp().listen({ hostname: '127.0.0.1', port: 0 });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const response = await fetch(`http://127.0.0.1:${app.server!.port}/auth/password-reset`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-real-ip': `198.51.100.${i}`,
            'x-forwarded-for': `198.51.100.${i + 100}`,
          },
          body: JSON.stringify({ email: 'flood-target@example.test' }),
        });
        statuses.push(response.status);
      }
      expect(statuses).toEqual([202, 202, 202, 429]);
    } finally {
      await app.stop();
    }
  });

  it('never falls back to X-Forwarded-For when the trusted header is missing', async () => {
    const app = makeApp({ TRUSTED_PROXY_HEADER: 'x-real-ip' });

    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await app.handle(
        devSessionRequest(`xff-${i}@example.test`, { 'x-forwarded-for': `198.51.100.${i}` })
      );
      statuses.push(response.status);
    }
    expect(statuses).toEqual([201, 201, 201, 429]);
  });

  it('keys on the last trusted-header entry, the one the proxy added', async () => {
    const app = makeApp({ TRUSTED_PROXY_HEADER: 'x-real-ip' });

    // Railway and Nginx overwrite X-Real-IP. If a proxy appended to a client's
    // value instead, the client's spoofed part comes first and is ignored.
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await app.handle(
        devSessionRequest(`appended-${i}@example.test`, {
          'x-real-ip': `198.51.100.${i}, 203.0.113.10`,
        })
      );
      statuses.push(response.status);
    }
    expect(statuses).toEqual([201, 201, 201, 429]);

    // A different proxy-added address is a different client with its own budget.
    const otherClient = await app.handle(
      devSessionRequest('appended-other@example.test', {
        'x-real-ip': '198.51.100.9, 203.0.113.11',
      })
    );
    expect(otherClient.status).toBe(201);
  });
});

describe('auth rate-limit client key', () => {
  const serverWithAddress = (address: string) => ({ requestIP: () => ({ address }) });
  const keyRequest = (headers: Record<string, string> = {}) =>
    new Request('http://server.test/auth/email/sign-in', { headers });

  it('keys on the socket address and ignores forwarding headers when none is trusted', () => {
    const key = authRateLimitClientKey(null);
    const spoofed = keyRequest({ 'x-real-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.2' });

    expect(key(spoofed, serverWithAddress('192.0.2.10'))).toBe('192.0.2.10');
    expect(key(spoofed, serverWithAddress('192.0.2.20'))).toBe('192.0.2.20');
  });

  it('uses the last trusted-header entry and otherwise the socket address', () => {
    const key = authRateLimitClientKey('x-real-ip');
    const socket = serverWithAddress('192.0.2.10');

    expect(key(keyRequest({ 'x-real-ip': '198.51.100.1, 203.0.113.10' }), socket)).toBe(
      '203.0.113.10'
    );
    expect(key(keyRequest({ 'x-forwarded-for': '198.51.100.1' }), socket)).toBe('192.0.2.10');
    expect(key(keyRequest({ 'x-real-ip': '203.0.113.10, ' }), socket)).toBe('192.0.2.10');
  });
});
