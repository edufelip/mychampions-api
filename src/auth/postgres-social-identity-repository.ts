import { and, eq } from 'drizzle-orm';

import { authIdentities, type AuthIdentityRow } from '../db/schema';
import type {
  NewSocialIdentity,
  PersistedSocialIdentity,
  SocialIdentityRepository,
} from './social-identity';
import type { SocialAuthProvider } from './social-auth';

type Db = {
  select: Function;
  insert: Function;
};

export class PostgresSocialIdentityRepository implements SocialIdentityRepository {
  constructor(private readonly db: Db) {}

  async findByProviderSubject(
    provider: SocialAuthProvider,
    providerSubject: string
  ): Promise<PersistedSocialIdentity | null> {
    const [row] = await this.db
      .select()
      .from(authIdentities)
      .where(
        and(
          eq(authIdentities.provider, provider),
          eq(authIdentities.providerSubject, providerSubject)
        )
      )
      .limit(1);
    return row ? mapIdentity(row) : null;
  }

  async upsert(identity: NewSocialIdentity): Promise<PersistedSocialIdentity> {
    const [row] = await this.db
      .insert(authIdentities)
      .values(identity)
      .onConflictDoUpdate({
        target: [authIdentities.provider, authIdentities.providerSubject],
        set: {
          emailNormalized: identity.emailNormalized,
          displayName: identity.displayName,
          emailVerified: identity.emailVerified,
          updatedAt: new Date(),
        },
      })
      .returning();
    return mapIdentity(row);
  }
}

function mapIdentity(row: AuthIdentityRow): PersistedSocialIdentity {
  return {
    provider: row.provider,
    providerSubject: row.providerSubject,
    authUid: row.authUid,
    emailNormalized: row.emailNormalized,
    displayName: row.displayName,
    emailVerified: row.emailVerified,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
