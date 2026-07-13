import { randomUUID } from 'node:crypto';

import { SocialAuthGatewayError, type SocialAuthIdentity, type SocialAuthProvider } from './social-auth';

export type PersistedSocialIdentity = {
  provider: SocialAuthProvider;
  providerSubject: string;
  authUid: string;
  emailNormalized: string;
  displayName: string;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type NewSocialIdentity = Omit<PersistedSocialIdentity, 'createdAt' | 'updatedAt'>;

export type ResolvedSocialIdentity = {
  authUid: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  provider: SocialAuthProvider;
};

export interface SocialIdentityRepository {
  findByProviderSubject(
    provider: SocialAuthProvider,
    providerSubject: string
  ): Promise<PersistedSocialIdentity | null>;
  upsert(identity: NewSocialIdentity): Promise<PersistedSocialIdentity>;
}

export class InMemorySocialIdentityRepository implements SocialIdentityRepository {
  private readonly identities = new Map<string, PersistedSocialIdentity>();

  async findByProviderSubject(
    provider: SocialAuthProvider,
    providerSubject: string
  ): Promise<PersistedSocialIdentity | null> {
    const identity = this.identities.get(identityKey(provider, providerSubject));
    return identity ? { ...identity } : null;
  }

  async upsert(identity: NewSocialIdentity): Promise<PersistedSocialIdentity> {
    const key = identityKey(identity.provider, identity.providerSubject);
    const existing = this.identities.get(key);
    const now = new Date();
    const next: PersistedSocialIdentity = {
      ...identity,
      authUid: existing?.authUid ?? identity.authUid,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.identities.set(key, next);
    return { ...next };
  }
}

export class SocialIdentityService {
  constructor(private readonly repository: SocialIdentityRepository) {}

  async resolve(identity: SocialAuthIdentity): Promise<ResolvedSocialIdentity> {
    const existing = await this.repository.findByProviderSubject(
      identity.provider,
      identity.providerSubject
    );

    if (!identity.email || !identity.emailVerified) {
      if (!existing) {
        throw new SocialAuthGatewayError(
          'invalid_credentials',
          'A verified email is required for a new social identity.'
        );
      }
      return toResolvedIdentity(existing);
    }

    const emailNormalized = identity.email.trim().toLowerCase();
    if (!emailNormalized) {
      throw new SocialAuthGatewayError('invalid_credentials', 'Invalid social auth token.');
    }
    const displayName = identity.displayName?.trim() || existing?.displayName || emailNormalized.split('@')[0];
    const persisted = await this.repository.upsert({
      provider: identity.provider,
      providerSubject: identity.providerSubject,
      authUid: existing?.authUid ?? `social_${randomUUID()}`,
      emailNormalized,
      displayName,
      emailVerified: true,
    });
    return toResolvedIdentity(persisted);
  }
}

function identityKey(provider: SocialAuthProvider, providerSubject: string): string {
  return `${provider}:${providerSubject}`;
}

function toResolvedIdentity(identity: PersistedSocialIdentity): ResolvedSocialIdentity {
  return {
    authUid: identity.authUid,
    email: identity.emailNormalized,
    displayName: identity.displayName,
    emailVerified: identity.emailVerified,
    provider: identity.provider,
  };
}
