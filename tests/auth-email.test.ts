import { describe, expect, it } from 'bun:test';

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
