import { and, eq, gt, isNull } from 'drizzle-orm';

import { authSessions } from '../db/schema';
import type { NewRefreshSession, RefreshSessionRepository } from './refresh-session-service';

type Db = {
  insert: Function;
  update: Function;
  transaction: Function;
};

export class PostgresRefreshSessionRepository implements RefreshSessionRepository {
  constructor(private readonly db: Db) {}

  async create(session: NewRefreshSession): Promise<void> {
    await this.db.insert(authSessions).values(session);
  }

  async replace(input: {
    sessionId: string;
    refreshTokenDigest: string;
    replacement: NewRefreshSession;
    now: Date;
  }): Promise<boolean> {
    return this.db.transaction(async (tx: Db) => {
      const [consumed] = await tx
        .update(authSessions)
        .set({
          revokedAt: input.now,
          replacedBySessionId: input.replacement.id,
        })
        .where(
          and(
            eq(authSessions.id, input.sessionId),
            eq(authSessions.refreshTokenDigest, input.refreshTokenDigest),
            isNull(authSessions.revokedAt),
            gt(authSessions.expiresAt, input.now)
          )
        )
        .returning({ id: authSessions.id });

      if (!consumed) {
        return false;
      }

      await tx.insert(authSessions).values(input.replacement);
      return true;
    });
  }

  async revoke(input: {
    sessionId: string;
    refreshTokenDigest: string;
    now: Date;
  }): Promise<boolean> {
    const [revoked] = await this.db
      .update(authSessions)
      .set({ revokedAt: input.now })
      .where(
        and(
          eq(authSessions.id, input.sessionId),
          eq(authSessions.refreshTokenDigest, input.refreshTokenDigest),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, input.now)
        )
      )
      .returning({ id: authSessions.id });
    return Boolean(revoked);
  }
}
