import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { createApp } from '../src/app';
import {
  createEmailAuthGateway,
  EmailAuthGatewayError,
  LocalEmailAuthGateway,
  UnconfiguredEmailAuthGateway,
} from '../src/auth/email-auth';
import { readConfig } from '../src/config';
import type { ProfileRepository } from '../src/profile/repository';

function makeProfileRepository(): ProfileRepository {
  const rows = new Map<
    string,
    {
      authUid: string;
      displayName: string;
      emailNormalized: string;
      lockedRole: 'student' | 'professional' | null;
      acceptedTermsVersion: string | null;
      createdAt: string;
      updatedAt: string;
    }
  >();

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

describe('email auth API', () => {
  it('keeps Postgres email auth selected when retired provider flags are present', () => {
    const gateway = createEmailAuthGateway(
      readConfig({ SUPABASE_AUTH_ENABLED: 'true' }),
      {} as Parameters<typeof createEmailAuthGateway>[1]
    );

    expect(gateway).toBeInstanceOf(LocalEmailAuthGateway);
  });

  it('creates local email credentials without issuing a session, then allows sign-in', async () => {
    const app = createApp();
    const email = `local-${randomUUID()}@local-email-auth.test`;
    const password = 'Password1!';

    const createResponse = await app.handle(
      new Request('http://server.test/auth/email/create-account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          displayName: 'Local Email User',
        }),
      })
    );

    expect(createResponse.status).toBe(202);
    await expect(createResponse.json()).resolves.toEqual({ status: 'accepted' });
    expect(createResponse.headers.get('set-cookie')).toBeNull();

    const signInResponse = await app.handle(
      new Request('http://server.test/auth/email/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
    );

    expect(signInResponse.status).toBe(201);
    const signInSession = await signInResponse.json();
    expect(signInSession.profile).toMatchObject({
      emailNormalized: email,
      displayName: 'Local Email User',
    });
    expect(signInSession.profile.authUid).toStartWith('local_email_');

    const invalidPasswordResponse = await app.handle(
      new Request('http://server.test/auth/email/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'WrongPassword1!' }),
      })
    );

    expect(invalidPasswordResponse.status).toBe(401);
    await expect(invalidPasswordResponse.json()).resolves.toMatchObject({
      error: { code: 'invalid_credentials' },
    });
  });

  it('responds identically to create-account for a duplicate email as for a brand-new one (ET-75)', async () => {
    const app = createApp();
    const email = `dup-${randomUUID()}@local-email-auth.test`;
    const password = 'Password1!';
    const requestBody = (overrides: Partial<Record<string, string>> = {}) =>
      JSON.stringify({
        email,
        password,
        displayName: 'Local Email User',
        ...overrides,
      });

    const firstResponse = await app.handle(
      new Request('http://server.test/auth/email/create-account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: requestBody(),
      })
    );

    // A second signup attempt against the same email must be indistinguishable from
    // the first: same status code, same body shape, and no session/cookie leak that
    // would let a caller infer "this email already had an account".
    const secondResponse = await app.handle(
      new Request('http://server.test/auth/email/create-account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: requestBody({ password: 'SomeOtherPassword1!' }),
      })
    );

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);
    expect(secondResponse.status).toBe(firstResponse.status);

    const firstBody = await firstResponse.json();
    const secondBody = await secondResponse.json();
    expect(firstBody).toEqual({ status: 'accepted' });
    expect(secondBody).toEqual(firstBody);

    expect(firstResponse.headers.get('set-cookie')).toBeNull();
    expect(secondResponse.headers.get('set-cookie')).toBeNull();

    // The original account must still be reachable with its original credentials —
    // the duplicate attempt did not overwrite or otherwise disturb it.
    const signInResponse = await app.handle(
      new Request('http://server.test/auth/email/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
    );
    expect(signInResponse.status).toBe(201);

    // And the second (rejected) password must not work, proving no account takeover
    // happened via the duplicate submission.
    const impostorSignInResponse = await app.handle(
      new Request('http://server.test/auth/email/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'SomeOtherPassword1!' }),
      })
    );
    expect(impostorSignInResponse.status).toBe(401);
  });

  it('still returns the generic accepted response when the gateway reports duplicate_email directly', async () => {
    const app = createApp({
      profileRepository: makeProfileRepository(),
      emailAuthGateway: {
        async signIn() {
          throw new Error('signIn should not be called');
        },
        async createAccount() {
          throw new EmailAuthGatewayError('duplicate_email', 'Email is already registered.');
        },
      },
    } as Parameters<typeof createApp>[0] & { emailAuthGateway: unknown });

    const response = await app.handle(
      new Request('http://server.test/auth/email/create-account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'existing@example.test',
          password: 'Password1!',
          displayName: 'Existing User',
        }),
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: 'accepted' });
  });

  it('fails closed when the email auth provider is not configured', async () => {
    const app = createApp({
      profileRepository: makeProfileRepository(),
      emailAuthGateway: new UnconfiguredEmailAuthGateway(),
    });

    const response = await app.handle(
      new Request('http://server.test/auth/email/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.test', password: 'Password1!' }),
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'configuration',
        message: 'Email auth provider is not configured for this local server.',
      },
    });
  });

  it('issues a server session after provider-backed email sign-in succeeds', async () => {
    const profileRepository = makeProfileRepository();
    const app = createApp({
      profileRepository,
      emailAuthGateway: {
        async signIn(input) {
          expect(input).toEqual({ email: 'user@example.test', password: 'Password1!' });
          return {
            authUid: 'provider-user-1',
            email: 'user@example.test',
            displayName: 'Provider User',
            emailVerified: false,
          };
        },
        async createAccount() {
          throw new Error('createAccount should not be called');
        },
        async updatePassword() {
          throw new Error('updatePassword should not be called');
        },
      },
    } as Parameters<typeof createApp>[0] & { emailAuthGateway: unknown });

    const response = await app.handle(
      new Request('http://server.test/auth/email/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: ' USER@Example.test ', password: 'Password1!' }),
      })
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).toContain('mychampions_access_token=');
    const session = await response.json();
    expect(session.accessToken).toBeString();
    expect(session.refreshToken).toBeString();
    expect(session.authProviderIds).toEqual(['email_password']);
    expect(session.emailVerified).toBe(false);
    expect(session.profile).toMatchObject({
      authUid: 'provider-user-1',
      emailNormalized: 'user@example.test',
      displayName: 'Provider User',
    });
  });

  it('passes normalized email and trimmed display name to provider-backed account creation', async () => {
    const app = createApp({
      profileRepository: makeProfileRepository(),
      emailAuthGateway: {
        async signIn() {
          throw new Error('signIn should not be called');
        },
        async createAccount(input) {
          expect(input).toEqual({
            email: 'new@example.test',
            password: 'Password1!',
            displayName: 'New User',
          });
          return {
            authUid: 'provider-new-user',
            email: 'new@example.test',
            displayName: 'New User',
            emailVerified: false,
          };
        },
        async updatePassword() {
          throw new Error('updatePassword should not be called');
        },
      },
    } as Parameters<typeof createApp>[0] & { emailAuthGateway: unknown });

    const response = await app.handle(
      new Request('http://server.test/auth/email/create-account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: ' New@Example.test ',
          password: 'Password1!',
          displayName: ' New User ',
        }),
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: 'accepted' });
  });
});
