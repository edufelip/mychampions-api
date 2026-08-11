import { describe, expect, it } from 'bun:test';

import { createApp } from '../src/app';
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

  it('tracks separate budgets per client IP using the X-Real-IP header set by Nginx', async () => {
    const app = makeApp();

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
});
