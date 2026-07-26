import { describe, expect, it } from 'bun:test';

import { createApp } from '../src/app';
import { readConfig } from '../src/config';
import { createTokenService } from '../src/auth/tokens';
import {
  InMemoryRefreshSessionRepository,
  RefreshSessionService,
} from '../src/auth/refresh-session-service';
import type { ProfileRepository } from '../src/profile/repository';

const ALLOWED_ORIGIN = 'http://localhost:8081';

function makeProfileRepository(): ProfileRepository {
  const rows = new Map<string, any>();
  return {
    async upsertFromSession(input) {
      const existing = rows.get(input.authUid);
      const row = {
        authUid: input.authUid,
        displayName: input.displayName,
        emailNormalized: input.emailNormalized,
        lockedRole: existing?.lockedRole ?? null,
        acceptedTermsVersion: existing?.acceptedTermsVersion ?? null,
        createdAt: existing?.createdAt ?? new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
      rows.set(input.authUid, row);
      return row;
    },
    async findByAuthUid(authUid) {
      return rows.get(authUid) ?? null;
    },
    async lockRole() {
      throw new Error('not implemented');
    },
    async setAcceptedTermsVersion() {
      throw new Error('not implemented');
    },
    async deleteByAuthUid(authUid) {
      rows.delete(authUid);
    },
  };
}

function makeApp(
  options: {
    production?: boolean;
    refreshRevokeFails?: boolean;
    profileRepository?: ProfileRepository;
    allowedOrigin?: string;
  } = {}
) {
  const config = readConfig({ WEB_ALLOWED_ORIGINS: options.allowedOrigin ?? ALLOWED_ORIGIN });
  const refreshTokenService = createTokenService({
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
  });
  const refreshSessionService = new RefreshSessionService(
    refreshTokenService,
    new InMemoryRefreshSessionRepository()
  );
  if (options.refreshRevokeFails) {
    refreshSessionService.revoke = async () => {
      throw new Error('database unavailable');
    };
  }
  return createApp({
    config: options.production ? { ...config, production: true } : config,
    refreshSessionService,
    ...(options.production
      ? {
          tokenService: createTokenService({
            issuer: config.jwtIssuer,
            audience: config.jwtAudience,
          }),
        }
      : {}),
    profileRepository: options.profileRepository ?? makeProfileRepository(),
    emailAuthGateway: {
      async signIn() {
        return {
          authUid: 'web-user-1',
          email: 'web@example.test',
          displayName: 'Web User',
          emailVerified: true,
        };
      },
      async createAccount() {
        throw new Error('not implemented');
      },
    },
  });
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
}

function cookiePair(response: Response, name: string): string {
  const matching = setCookies(response).find((value) => value.startsWith(`${name}=`));
  if (!matching) throw new Error(`Missing ${name} cookie`);
  return matching.split(';')[0];
}

async function signInCookieMode(
  app: ReturnType<typeof makeApp>,
  origin: string = ALLOWED_ORIGIN
) {
  return app.handle(
    new Request('http://server.test/auth/email/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({
        email: 'web@example.test',
        password: 'Password1!',
        sessionMode: 'cookie',
      }),
    })
  );
}

describe('web auth sessions and CORS', () => {
  it('allows credentialed preflight for an exact configured origin', async () => {
    const response = await makeApp().handle(
      new Request('http://server.test/auth/email/sign-in', {
        method: 'OPTIONS',
        headers: {
          origin: ALLOWED_ORIGIN,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,authorization,x-request-id',
        },
      })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'x-request-id'
    );
  });

  it('rejects requests and preflights from an unapproved origin', async () => {
    const response = await makeApp().handle(
      new Request('http://server.test/auth/email/sign-in', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://attacker.example',
          'access-control-request-method': 'POST',
        },
      })
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: { code: 'origin_not_allowed' } });
  });

  it('issues an in-memory access token and HttpOnly refresh cookie in cookie mode', async () => {
    const response = await signInCookieMode(makeApp());
    const session = await response.json();
    const refreshCookie = setCookies(response).find((value) =>
      value.startsWith('mychampions_refresh_token=')
    );

    expect(response.status).toBe(201);
    expect(session.accessToken).toBeString();
    expect(session.refreshToken).toBeUndefined();
    expect(refreshCookie).toContain('HttpOnly');
    expect(refreshCookie).toContain('SameSite=Lax');
    expect(refreshCookie).toContain('Path=/auth/session');
    expect(refreshCookie).toContain('Max-Age=2592000');
    expect(
      setCookies(response).find((value) => value.startsWith('mychampions_access_token='))
    ).toContain(
      'Max-Age=0'
    );
  });

  it('forces approved browser origins into cookie mode even when bearer mode is requested', async () => {
    const response = await makeApp().handle(
      new Request('http://server.test/auth/email/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
        body: JSON.stringify({
          email: 'web@example.test',
          password: 'Password1!',
          sessionMode: 'bearer',
        }),
      })
    );
    const session = await response.json();

    expect(response.status).toBe(201);
    expect(session.refreshToken).toBeUndefined();
    expect(setCookies(response).join('\n')).toContain('mychampions_refresh_token=');
    expect(
      setCookies(response).find((value) => value.startsWith('mychampions_access_token='))
    ).toContain('Max-Age=0');
  });

  it('uses Secure SameSite=None for an explicitly allowed cross-origin production website', async () => {
    const response = await signInCookieMode(makeApp({ production: true }));
    const refreshCookie = setCookies(response).find((value) =>
      value.startsWith('mychampions_refresh_token=')
    );

    expect(response.status).toBe(201);
    expect(refreshCookie).toContain('Secure');
    expect(refreshCookie).toContain('HttpOnly');
    expect(refreshCookie).toContain('SameSite=None');
  });

  it('retains SameSite=Lax for same-origin production sessions', async () => {
    const sameOrigin = 'http://server.test';
    const response = await signInCookieMode(
      makeApp({ production: true, allowedOrigin: sameOrigin }),
      sameOrigin
    );
    const refreshCookie = setCookies(response).find((value) =>
      value.startsWith('mychampions_refresh_token=')
    );

    expect(response.status).toBe(201);
    expect(refreshCookie).toContain('Secure');
    expect(refreshCookie).toContain('SameSite=Lax');
    expect(refreshCookie).not.toContain('SameSite=None');
  });

  it('preserves Secure SameSite=None while rotating a cross-origin production session', async () => {
    const app = makeApp({ production: true });
    const signInResponse = await signInCookieMode(app);
    const originalCookie = cookiePair(signInResponse, 'mychampions_refresh_token');
    const refreshResponse = await app.handle(
      new Request('http://server.test/auth/session/refresh', {
        method: 'POST',
        headers: {
          cookie: originalCookie,
          'content-type': 'application/json',
          origin: ALLOWED_ORIGIN,
        },
        body: JSON.stringify({ sessionMode: 'cookie' }),
      })
    );
    const rotatedCookie = setCookies(refreshResponse).find((value) =>
      value.startsWith('mychampions_refresh_token=')
    );

    expect(refreshResponse.status).toBe(200);
    expect(rotatedCookie).toContain('Secure');
    expect(rotatedCookie).toContain('SameSite=None');
    expect(
      setCookies(refreshResponse).find((value) => value.startsWith('mychampions_access_token='))
    ).toContain('Max-Age=0');
  });

  it('rotates cookie refresh sessions and rejects replay', async () => {
    const app = makeApp();
    const signInResponse = await signInCookieMode(app);
    const originalCookie = cookiePair(signInResponse, 'mychampions_refresh_token');

    const firstRefresh = await app.handle(
      new Request('http://server.test/auth/session/refresh', {
        method: 'POST',
        headers: {
          cookie: originalCookie,
          'content-type': 'application/json',
          origin: ALLOWED_ORIGIN,
        },
        body: JSON.stringify({ sessionMode: 'cookie' }),
      })
    );
    const refreshed = await firstRefresh.json();
    const rotatedCookie = cookiePair(firstRefresh, 'mychampions_refresh_token');

    expect(firstRefresh.status).toBe(200);
    expect(refreshed.accessToken).toBeString();
    expect(refreshed.refreshToken).toBeUndefined();
    expect(rotatedCookie).not.toBe(originalCookie);

    const replay = await app.handle(
      new Request('http://server.test/auth/session/refresh', {
        method: 'POST',
        headers: {
          cookie: originalCookie,
          'content-type': 'application/json',
          origin: ALLOWED_ORIGIN,
        },
        body: JSON.stringify({ sessionMode: 'cookie' }),
      })
    );
    expect(replay.status).toBe(401);
  });

  it('refreshes from the current profile without restoring stale identity claims', async () => {
    const app = makeApp();
    const signInResponse = await signInCookieMode(app);
    const signedIn = await signInResponse.json();
    const originalCookie = cookiePair(signInResponse, 'mychampions_refresh_token');

    const hydrate = await app.handle(
      new Request('http://server.test/me/hydrate', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${signedIn.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          email: 'current@example.test',
          displayName: 'Current User',
        }),
      })
    );
    expect(hydrate.status).toBe(200);

    const refresh = await app.handle(
      new Request('http://server.test/auth/session/refresh', {
        method: 'POST',
        headers: {
          cookie: originalCookie,
          'content-type': 'application/json',
          origin: ALLOWED_ORIGIN,
        },
        body: JSON.stringify({ sessionMode: 'cookie' }),
      })
    );

    expect(refresh.status).toBe(200);
    await expect(refresh.json()).resolves.toMatchObject({
      emailVerified: false,
      profile: {
        emailNormalized: 'current@example.test',
        displayName: 'Current User',
      },
    });
  });

  it('keeps the original refresh token retryable when profile loading fails', async () => {
    const repository = makeProfileRepository();
    const findByAuthUid = repository.findByAuthUid.bind(repository);
    let failNextProfileLoad = true;
    repository.findByAuthUid = async (authUid) => {
      if (failNextProfileLoad) {
        failNextProfileLoad = false;
        throw new Error('database unavailable');
      }
      return findByAuthUid(authUid);
    };
    const app = makeApp({ profileRepository: repository });
    const signInResponse = await signInCookieMode(app);
    const originalCookie = cookiePair(signInResponse, 'mychampions_refresh_token');
    const refreshRequest = () =>
      new Request('http://server.test/auth/session/refresh', {
        method: 'POST',
        headers: {
          cookie: originalCookie,
          'content-type': 'application/json',
          origin: ALLOWED_ORIGIN,
        },
        body: JSON.stringify({ sessionMode: 'cookie' }),
      });

    const failedRefresh = await app.handle(refreshRequest());
    expect(failedRefresh.status).toBe(500);

    const retriedRefresh = await app.handle(refreshRequest());
    expect(retriedRefresh.status).toBe(200);
    expect(cookiePair(retriedRefresh, 'mychampions_refresh_token')).not.toBe(originalCookie);
  });

  it('revokes the current refresh session and clears browser cookies on sign-out', async () => {
    const app = makeApp();
    const signInResponse = await signInCookieMode(app);
    const refreshCookie = cookiePair(signInResponse, 'mychampions_refresh_token');

    const signOut = await app.handle(
      new Request('http://server.test/auth/session/sign-out', {
        method: 'POST',
        headers: { cookie: refreshCookie, origin: ALLOWED_ORIGIN },
      })
    );
    expect(signOut.status).toBe(204);
    expect(setCookies(signOut).join('\n')).toContain('mychampions_refresh_token=;');
    expect(setCookies(signOut).join('\n')).toContain('Max-Age=0');

    const refresh = await app.handle(
      new Request('http://server.test/auth/session/refresh', {
        method: 'POST',
        headers: {
          cookie: refreshCookie,
          'content-type': 'application/json',
          origin: ALLOWED_ORIGIN,
        },
        body: JSON.stringify({ sessionMode: 'cookie' }),
      })
    );
    expect(refresh.status).toBe(401);
  });

  it('revokes distinct cookie and body refresh sessions presented together on sign-out', async () => {
    const app = makeApp();
    const cookieSignIn = await signInCookieMode(app);
    const refreshCookie = cookiePair(cookieSignIn, 'mychampions_refresh_token');
    const cookieRefreshToken = refreshCookie.slice(refreshCookie.indexOf('=') + 1);
    const bearerSignIn = await app.handle(
      new Request('http://server.test/auth/email/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'web@example.test', password: 'Password1!' }),
      })
    );
    const bearerSession = await bearerSignIn.json();
    expect(bearerSession.refreshToken).toBeString();
    expect(bearerSession.refreshToken).not.toBe(cookieRefreshToken);

    const signOut = await app.handle(
      new Request('http://server.test/auth/session/sign-out', {
        method: 'POST',
        headers: {
          cookie: refreshCookie,
          'content-type': 'application/json',
          origin: ALLOWED_ORIGIN,
        },
        body: JSON.stringify({ refreshToken: bearerSession.refreshToken }),
      })
    );
    expect(signOut.status).toBe(204);

    const [cookieRefresh, bearerRefresh] = await Promise.all([
      app.handle(
        new Request('http://server.test/auth/session/refresh', {
          method: 'POST',
          headers: {
            cookie: refreshCookie,
            'content-type': 'application/json',
            origin: ALLOWED_ORIGIN,
          },
          body: JSON.stringify({ sessionMode: 'cookie' }),
        })
      ),
      app.handle(
        new Request('http://server.test/auth/session/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            refreshToken: bearerSession.refreshToken,
            sessionMode: 'bearer',
          }),
        })
      ),
    ]);

    expect(cookieRefresh.status).toBe(401);
    expect(bearerRefresh.status).toBe(401);
  });

  it('still clears browser cookies when durable refresh-session revocation fails', async () => {
    const app = makeApp({ refreshRevokeFails: true });
    const signInResponse = await signInCookieMode(app);
    const refreshCookie = cookiePair(signInResponse, 'mychampions_refresh_token');

    const signOut = await app.handle(
      new Request('http://server.test/auth/session/sign-out', {
        method: 'POST',
        headers: { cookie: refreshCookie, origin: ALLOWED_ORIGIN },
      })
    );

    expect(signOut.status).toBe(503);
    await expect(signOut.json()).resolves.toEqual({
      error: {
        code: 'refresh_session_revocation_failed',
        message: 'The local session was cleared, but server revocation must be retried.',
      },
    });
    expect(setCookies(signOut).join('\n')).toContain('mychampions_refresh_token=;');
    expect(setCookies(signOut).join('\n')).toContain('Max-Age=0');
  });

  it('preserves native bearer refresh responses when session mode is omitted', async () => {
    const response = await makeApp().handle(
      new Request('http://server.test/auth/email/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'web@example.test', password: 'Password1!' }),
      })
    );
    const session = await response.json();

    expect(response.status).toBe(201);
    expect(session.accessToken).toBeString();
    expect(session.refreshToken).toBeString();
    expect(setCookies(response).join('\n')).toContain('mychampions_access_token=');
  });
});
