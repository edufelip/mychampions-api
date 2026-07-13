import { describe, expect, it } from 'bun:test';

import { createApp } from '../src/app';
import type { ProfileRepository } from '../src/profile/repository';

function makeRepository(): ProfileRepository {
  const rows = new Map<string, {
    authUid: string;
    displayName: string;
    emailNormalized: string;
    lockedRole: 'student' | 'professional' | null;
    acceptedTermsVersion: string | null;
    createdAt: string;
    updatedAt: string;
  }>();

  return {
    async upsertFromSession(input) {
      const existing = rows.get(input.authUid);
      const now = new Date(0).toISOString();
      const row = {
        authUid: input.authUid,
        displayName: input.displayName,
        emailNormalized: input.emailNormalized,
        lockedRole: existing?.lockedRole ?? null,
        acceptedTermsVersion: existing?.acceptedTermsVersion ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      rows.set(input.authUid, row);
      return row;
    },
    async findByAuthUid(authUid) {
      return rows.get(authUid) ?? null;
    },
    async lockRole(authUid, role) {
      const row = rows.get(authUid);
      if (!row) throw new Error('profile_not_found');
      if (row.lockedRole && row.lockedRole !== role) throw new Error('role_already_locked');
      const next = { ...row, lockedRole: role, updatedAt: new Date(0).toISOString() };
      rows.set(authUid, next);
      return next;
    },
    async setAcceptedTermsVersion(authUid, version) {
      const row = rows.get(authUid);
      if (!row) throw new Error('profile_not_found');
      const next = { ...row, acceptedTermsVersion: version, updatedAt: new Date(0).toISOString() };
      rows.set(authUid, next);
      return next;
    },
    async deleteByAuthUid(authUid) {
      rows.delete(authUid);
    },
  };
}

describe('auth/profile API', () => {
  it('does not expose local dev-session routes for non-dev app variants', async () => {
    const previousAppVariant = process.env.APP_VARIANT;
    process.env.APP_VARIANT = 'production';
    try {
      const repository = makeRepository();
      const app = createApp({ profileRepository: repository });

      const sessionResponse = await app.handle(
        new Request('http://server.test/auth/dev/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'ProdVariant@Example.test',
            displayName: 'Prod Variant User',
          }),
        })
      );
      const refreshResponse = await app.handle(
        new Request('http://server.test/auth/dev/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: 'not-a-token' }),
        })
      );
      const malformedSessionResponse = await app.handle(
        new Request('http://server.test/auth/dev/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'not-an-email' }),
        })
      );
      const malformedRefreshResponse = await app.handle(
        new Request('http://server.test/auth/dev/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
      );

      expect(sessionResponse.status).toBe(404);
      expect(refreshResponse.status).toBe(404);
      expect(malformedSessionResponse.status).toBe(404);
      expect(malformedRefreshResponse.status).toBe(404);
      expect(await repository.findByAuthUid('local_cHJvZHZhcmlhbnRAZXhhbXBsZS50ZXN0')).toBeNull();
    } finally {
      if (previousAppVariant === undefined) {
        delete process.env.APP_VARIANT;
      } else {
        process.env.APP_VARIANT = previousAppVariant;
      }
    }
  });

  it('sets an http-only local access token cookie when issuing a dev session', async () => {
    const app = createApp({ profileRepository: makeRepository() });

    const sessionResponse = await app.handle(
      new Request('http://server.test/auth/dev/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'Cookie@Example.test',
          displayName: 'Cookie User',
        }),
      })
    );

    expect(sessionResponse.status).toBe(201);
    const setCookie = sessionResponse.headers.get('set-cookie');
    expect(setCookie).toContain('mychampions_access_token=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=3600');
  });

  it('hydrates the current profile from the local access token cookie when bearer auth is absent', async () => {
    const app = createApp({ profileRepository: makeRepository() });

    const sessionResponse = await app.handle(
      new Request('http://server.test/auth/dev/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'CookieMe@Example.test',
          displayName: 'Cookie Me User',
        }),
      })
    );
    const session = await sessionResponse.json();
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toStartWith('mychampions_access_token=');

    const meResponse = await app.handle(
      new Request('http://server.test/me', {
        headers: { cookie: cookie ?? '' },
      })
    );

    expect(meResponse.status).toBe(200);
    await expect(meResponse.json()).resolves.toMatchObject({
      profile: {
        authUid: session.profile.authUid,
        emailNormalized: 'cookieme@example.test',
      },
    });
  });

  it('issues a local dev session and hydrates the current profile', async () => {
    const app = createApp({ profileRepository: makeRepository() });

    const sessionResponse = await app.handle(
      new Request('http://server.test/auth/dev/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'Student@Example.test',
          displayName: 'Student One',
        }),
      })
    );
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json();
    expect(session.profile.emailNormalized).toBe('student@example.test');
    expect(session.emailVerified).toBe(false);
    expect(session.accessToken).toBeString();
    expect(session.refreshToken).toBeString();
    expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const meResponse = await app.handle(
      new Request('http://server.test/me', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );
    expect(meResponse.status).toBe(200);
    await expect(meResponse.json()).resolves.toMatchObject({
      profile: {
        authUid: session.profile.authUid,
        lockedRole: null,
        acceptedTermsVersion: null,
      },
    });
  });

  it('validates a local access token after a new app instance starts', async () => {
    const repository = makeRepository();
    const firstApp = createApp({ profileRepository: repository });
    const sessionResponse = await firstApp.handle(
      new Request('http://server.test/auth/dev/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'Restart@Example.test',
          displayName: 'Restart User',
        }),
      })
    );
    const session = await sessionResponse.json();

    const restartedApp = createApp({ profileRepository: repository });
    const meResponse = await restartedApp.handle(
      new Request('http://server.test/me', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(meResponse.status).toBe(200);
    await expect(meResponse.json()).resolves.toMatchObject({
      profile: { emailNormalized: 'restart@example.test' },
    });
  });

  it('refreshes a local dev session without requiring the expired access token', async () => {
    const app = createApp({ profileRepository: makeRepository() });

    const sessionResponse = await app.handle(
      new Request('http://server.test/auth/dev/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'Refresh@Example.test',
          displayName: 'Refresh User',
          authProviderId: 'apple',
        }),
      })
    );
    const session = await sessionResponse.json();

    const refreshResponse = await app.handle(
      new Request('http://server.test/auth/dev/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      })
    );

    expect(refreshResponse.status).toBe(200);
    const refreshed = await refreshResponse.json();
    expect(refreshed.accessToken).toBeString();
    expect(refreshed.refreshToken).toBeString();
    expect(refreshed.authProviderIds).toEqual(['apple']);
    expect(refreshed.emailVerified).toBe(false);
    expect(refreshed.profile.emailNormalized).toBe('refresh@example.test');
    expect(new Date(refreshed.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects replay of a consumed local refresh token', async () => {
    const app = createApp({ profileRepository: makeRepository() });
    const sessionResponse = await app.handle(
      new Request('http://server.test/auth/dev/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'Replay@Example.test',
          displayName: 'Replay User',
        }),
      })
    );
    const session = await sessionResponse.json();

    const firstRefresh = await app.handle(
      new Request('http://server.test/auth/dev/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      })
    );
    const replayRefresh = await app.handle(
      new Request('http://server.test/auth/dev/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      })
    );

    expect(firstRefresh.status).toBe(200);
    expect(replayRefresh.status).toBe(401);
    await expect(replayRefresh.json()).resolves.toEqual({
      error: { code: 'invalid_refresh_token' },
    });
  });

  it('rejects a refresh token used as a bearer access token', async () => {
    const app = createApp({ profileRepository: makeRepository() });

    const sessionResponse = await app.handle(
      new Request('http://server.test/auth/dev/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'RefreshBearer@Example.test',
          displayName: 'Refresh Bearer User',
        }),
      })
    );
    const session = await sessionResponse.json();

    const meResponse = await app.handle(
      new Request('http://server.test/me', {
        headers: { authorization: `Bearer ${session.refreshToken}` },
      })
    );

    expect(meResponse.status).toBe(401);
  });

  it('issues a local social dev session with provider-neutral auth provider ids', async () => {
    const app = createApp({ profileRepository: makeRepository() });

    const sessionResponse = await app.handle(
      new Request('http://server.test/auth/dev/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'Google.Local@Example.test',
          displayName: 'Local Google User',
          authProviderId: 'google',
        }),
      })
    );

    expect(sessionResponse.status).toBe(201);
    await expect(sessionResponse.json()).resolves.toMatchObject({
      authProviderIds: ['google'],
      profile: {
        emailNormalized: 'google.local@example.test',
        displayName: 'Local Google User',
      },
    });
  });

  it('locks role once and rejects changing to another role', async () => {
    const app = createApp({ profileRepository: makeRepository() });
    const sessionResponse = await app.handle(
      new Request('http://server.test/auth/dev/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'pro@example.test', displayName: 'Pro One' }),
      })
    );
    const session = await sessionResponse.json();

    const lockResponse = await app.handle(
      new Request('http://server.test/me/role', {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ role: 'professional' }),
      })
    );
    expect(lockResponse.status).toBe(200);
    await expect(lockResponse.json()).resolves.toMatchObject({
      profile: { lockedRole: 'professional' },
    });

    const relockResponse = await app.handle(
      new Request('http://server.test/me/role', {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ role: 'student' }),
      })
    );
    expect(relockResponse.status).toBe(409);
  });

  it('persists accepted terms version for the current profile', async () => {
    const app = createApp({ profileRepository: makeRepository() });
    const sessionResponse = await app.handle(
      new Request('http://server.test/auth/dev/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'terms@example.test', displayName: 'Terms User' }),
      })
    );
    const session = await sessionResponse.json();

    const termsResponse = await app.handle(
      new Request('http://server.test/me/terms', {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ acceptedTermsVersion: 'v2' }),
      })
    );

    expect(termsResponse.status).toBe(200);
    await expect(termsResponse.json()).resolves.toMatchObject({
      profile: { acceptedTermsVersion: 'v2' },
    });
  });

  it('hydrates the current profile from bearer claims without a dev-session call', async () => {
    const repository = makeRepository();
    const app = createApp({ profileRepository: repository });
    const sessionResponse = await app.handle(
      new Request('http://server.test/auth/dev/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'hydrate@example.test', displayName: 'Hydrate User' }),
      })
    );
    const session = await sessionResponse.json();
    await repository.deleteByAuthUid(session.profile.authUid);

    const hydrateResponse = await app.handle(
      new Request('http://server.test/me/hydrate', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ displayName: 'Hydrate User', email: 'hydrate@example.test' }),
      })
    );

    expect(hydrateResponse.status).toBe(200);
    await expect(hydrateResponse.json()).resolves.toMatchObject({
      profile: {
        emailNormalized: 'hydrate@example.test',
        lockedRole: null,
        acceptedTermsVersion: null,
      },
    });
  });

  it('deletes the current profile', async () => {
    const app = createApp({ profileRepository: makeRepository() });
    const sessionResponse = await app.handle(
      new Request('http://server.test/auth/dev/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'delete@example.test', displayName: 'Delete User' }),
      })
    );
    const session = await sessionResponse.json();

    const deleteResponse = await app.handle(
      new Request('http://server.test/me', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );
    expect(deleteResponse.status).toBe(204);

    const meResponse = await app.handle(
      new Request('http://server.test/me', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );
    expect(meResponse.status).toBe(404);
  });
});
