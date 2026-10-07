import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { createApp } from '../src/app';
import {
  createEmailAuthGateway,
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

  it('creates and signs in local email credentials by default', async () => {
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

    expect(createResponse.status).toBe(201);
    const createdSession = await createResponse.json();
    expect(createdSession.authProviderIds).toEqual(['email_password']);
    expect(createdSession.profile).toMatchObject({
      emailNormalized: email,
      displayName: 'Local Email User',
    });
    expect(createdSession.profile.authUid).toStartWith('local_email_');

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
      authUid: createdSession.profile.authUid,
      emailNormalized: email,
      displayName: 'Local Email User',
    });

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

  it('passes display name to provider-backed account creation before issuing a session', async () => {
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

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      authProviderIds: ['email_password'],
      emailVerified: false,
      profile: {
        authUid: 'provider-new-user',
        emailNormalized: 'new@example.test',
        displayName: 'New User',
      },
    });
  });
});
