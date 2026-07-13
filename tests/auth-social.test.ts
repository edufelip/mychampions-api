import { describe, expect, it } from 'bun:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';

import { createApp } from '../src/app';
import {
  createSocialIdTokenVerifier,
  createSocialAuthGateway,
  DirectSocialAuthGateway,
  UnconfiguredSocialAuthGateway,
  type SocialAuthProvider,
} from '../src/auth/social-auth';
import { InMemorySocialIdentityRepository } from '../src/auth/social-identity';
import { readConfig } from '../src/config';
import type { ProfileRepository } from '../src/profile/repository';

type SigningKey = Parameters<SignJWT['sign']>[0];

async function createVerifier() {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'test-social-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  const jwks = createLocalJWKSet({ keys: [publicJwk] });

  return {
    privateKey,
    verifyIdToken: createSocialIdTokenVerifier({ google: jwks, apple: jwks }),
  };
}

async function issueSocialToken(
  privateKey: SigningKey,
  options: {
    provider: SocialAuthProvider;
    subject?: string;
    email?: string;
    emailVerified?: boolean;
    issuer?: string;
    audience?: string;
    nonce?: string;
    expiresAt?: string | number;
  }
) {
  const token = new SignJWT({
    ...(options.email === undefined ? {} : { email: options.email }),
    ...(options.emailVerified === undefined ? {} : { email_verified: options.emailVerified }),
    ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
    name: 'Provider User',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-social-key' })
    .setIssuer(
      options.issuer ??
        (options.provider === 'google' ? 'https://accounts.google.com' : 'https://appleid.apple.com')
    )
    .setAudience(options.audience ?? `${options.provider}-client-id`)
    .setIssuedAt()
    .setExpirationTime(options.expiresAt ?? '1h');

  if (options.subject !== undefined) {
    token.setSubject(options.subject);
  }

  return token.sign(privateKey);
}

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

describe('social auth API', () => {
  it('verifies signed Google and Apple ID tokens against their issuer and audience', async () => {
    const { privateKey, verifyIdToken } = await createVerifier();
    const googleToken = await issueSocialToken(privateKey, {
      provider: 'google',
      subject: 'google-subject',
      email: 'google@example.test',
      emailVerified: true,
    });
    const appleToken = await issueSocialToken(privateKey, {
      provider: 'apple',
      subject: 'apple-subject',
      email: 'apple@example.test',
      emailVerified: true,
      nonce: 'nonce-1',
    });

    await expect(
      verifyIdToken({
        provider: 'google',
        idToken: googleToken,
        audiences: ['google-client-id'],
      })
    ).resolves.toMatchObject({
      subject: 'google-subject',
      email: 'google@example.test',
      emailVerified: true,
    });
    await expect(
      verifyIdToken({
        provider: 'apple',
        idToken: appleToken,
        audiences: ['apple-client-id'],
        nonce: 'nonce-1',
      })
    ).resolves.toMatchObject({
      subject: 'apple-subject',
      email: 'apple@example.test',
      emailVerified: true,
    });
  });

  it('permits a returning Apple token without email while still requiring a subject', async () => {
    const { privateKey, verifyIdToken } = await createVerifier();
    const token = await issueSocialToken(privateKey, {
      provider: 'apple',
      subject: 'apple-subject',
    });

    await expect(
      verifyIdToken({ provider: 'apple', idToken: token, audiences: ['apple-client-id'] })
    ).resolves.toMatchObject({
      subject: 'apple-subject',
      email: null,
      emailVerified: false,
    });
  });

  it('rejects social tokens with an invalid issuer, audience, or expiry', async () => {
    const { privateKey, verifyIdToken } = await createVerifier();
    const invalidIssuer = await issueSocialToken(privateKey, {
      provider: 'google',
      subject: 'subject',
      email: 'user@example.test',
      emailVerified: true,
      issuer: 'https://issuer.invalid',
    });
    const invalidAudience = await issueSocialToken(privateKey, {
      provider: 'google',
      subject: 'subject',
      email: 'user@example.test',
      emailVerified: true,
      audience: 'another-client-id',
    });
    const expired = await issueSocialToken(privateKey, {
      provider: 'google',
      subject: 'subject',
      email: 'user@example.test',
      emailVerified: true,
      expiresAt: 0,
    });

    await expect(
      verifyIdToken({ provider: 'google', idToken: invalidIssuer, audiences: ['google-client-id'] })
    ).rejects.toThrow();
    await expect(
      verifyIdToken({ provider: 'google', idToken: invalidAudience, audiences: ['google-client-id'] })
    ).rejects.toThrow();
    await expect(
      verifyIdToken({ provider: 'google', idToken: expired, audiences: ['google-client-id'] })
    ).rejects.toThrow();
  });

  it('rejects a social token signed by an unknown key and maps it to invalid credentials', async () => {
    const { verifyIdToken } = await createVerifier();
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const token = await issueSocialToken(privateKey, {
      provider: 'google',
      subject: 'subject',
      email: 'user@example.test',
      emailVerified: true,
    });
    const gateway = new DirectSocialAuthGateway(
      { google: ['google-client-id'], apple: [] },
      verifyIdToken
    );

    await expect(
      verifyIdToken({ provider: 'google', idToken: token, audiences: ['google-client-id'] })
    ).rejects.toThrow();
    await expect(
      gateway.signInWithIdToken({ provider: 'google', idToken: token })
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('rejects social tokens that lack verified identity claims or a matching nonce', async () => {
    const { privateKey, verifyIdToken } = await createVerifier();
    const missingSubject = await issueSocialToken(privateKey, {
      provider: 'apple',
      email: 'user@example.test',
      emailVerified: true,
    });
    const unverifiedEmail = await issueSocialToken(privateKey, {
      provider: 'apple',
      subject: 'subject',
      email: 'user@example.test',
      emailVerified: false,
    });
    const nonceMismatch = await issueSocialToken(privateKey, {
      provider: 'apple',
      subject: 'subject',
      email: 'user@example.test',
      emailVerified: true,
      nonce: 'actual-nonce',
    });

    await expect(
      verifyIdToken({ provider: 'apple', idToken: missingSubject, audiences: ['apple-client-id'] })
    ).rejects.toThrow('Invalid social auth token.');
    await expect(
      verifyIdToken({ provider: 'apple', idToken: unverifiedEmail, audiences: ['apple-client-id'] })
    ).rejects.toThrow('Invalid social auth token.');
    await expect(
      verifyIdToken({
        provider: 'apple',
        idToken: nonceMismatch,
        audiences: ['apple-client-id'],
        nonce: 'expected-nonce',
      })
    ).rejects.toThrow('Invalid social auth token.');
  });

  it('selects direct Google token verification with configured native audiences', async () => {
    const gateway = createSocialAuthGateway(
      readConfig({ GOOGLE_ANDROID_CLIENT_ID: 'android-client-id' }),
      {
        async verifyIdToken(input) {
          expect(input).toEqual({
            provider: 'google',
            idToken: 'google-id-token',
            audiences: ['android-client-id'],
            nonce: undefined,
          });
          return {
            subject: 'google-subject',
            email: 'google-user@example.test',
            displayName: 'Google User',
            emailVerified: true,
          };
        },
      }
    );

    expect(gateway).toBeInstanceOf(DirectSocialAuthGateway);
    await expect(
      gateway.signInWithIdToken({ provider: 'google', idToken: 'google-id-token' })
    ).resolves.toEqual({
      provider: 'google',
      providerSubject: 'google-subject',
      email: 'google-user@example.test',
      displayName: 'Google User',
      emailVerified: true,
    });
  });

  it('fails closed when the social auth provider is not configured', async () => {
    const app = createApp({
      profileRepository: makeProfileRepository(),
      socialAuthGateway: new UnconfiguredSocialAuthGateway(),
    });

    const response = await app.handle(
      new Request('http://server.test/auth/social/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'google', idToken: 'provider-id-token' }),
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'configuration',
        message: 'Social auth provider is not configured for this local server.',
      },
    });
  });

  it('reuses a persisted Apple identity when a returning token omits email', async () => {
    const socialIdentityRepository = new InMemorySocialIdentityRepository();
    const app = createApp({
      profileRepository: makeProfileRepository(),
      socialIdentityRepository,
      socialAuthGateway: {
        async signInWithIdToken(input) {
          if (input.idToken === 'initial-apple-id-token') {
            return {
              provider: 'apple',
              providerSubject: 'apple-subject',
              email: 'apple-user@example.test',
              displayName: 'Apple User',
              emailVerified: true,
            };
          }
          return {
            provider: 'apple',
            providerSubject: 'apple-subject',
            email: null,
            displayName: null,
            emailVerified: false,
          };
        },
      },
    } as Parameters<typeof createApp>[0] & {
      socialIdentityRepository: InMemorySocialIdentityRepository;
    });

    const initialResponse = await app.handle(
      new Request('http://server.test/auth/social/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'apple',
          idToken: 'initial-apple-id-token',
          nonce: 'nonce-1',
        }),
      })
    );
    expect(initialResponse.status).toBe(201);
    const initial = await initialResponse.json();

    const returningResponse = await app.handle(
      new Request('http://server.test/auth/social/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'apple',
          idToken: 'returning-apple-id-token',
          nonce: 'nonce-2',
        }),
      })
    );
    expect(returningResponse.status).toBe(201);
    expect(returningResponse.headers.get('set-cookie')).toContain('mychampions_access_token=');
    await expect(returningResponse.json()).resolves.toMatchObject({
      authProviderIds: ['apple'],
      emailVerified: true,
      profile: {
        authUid: initial.profile.authUid,
        emailNormalized: 'apple-user@example.test',
        displayName: 'Apple User',
      },
    });
  });
});
