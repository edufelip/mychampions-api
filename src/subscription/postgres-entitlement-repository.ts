import { eq, lt } from 'drizzle-orm';

import { subscriptionEntitlementSnapshots, type SubscriptionEntitlementSnapshotRow } from '../db/schema';
import type {
  SubscriptionEntitlementRepository,
  SubscriptionEntitlementSnapshot,
  UpsertSubscriptionEntitlementSnapshotInput,
} from './entitlement-repository';

type Db = {
  insert: Function;
  select: Function;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapSnapshot(row: SubscriptionEntitlementSnapshotRow): SubscriptionEntitlementSnapshot {
  return {
    authUid: row.authUid,
    professionalEntitlementStatus: row.professionalEntitlementStatus,
    aiEntitlementStatus: row.aiEntitlementStatus,
    activeStudentCount: row.activeStudentCount,
    source: row.source,
    observedAt: toIso(row.observedAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export class PostgresSubscriptionEntitlementRepository implements SubscriptionEntitlementRepository {
  constructor(private readonly db: Db) {}

  async upsertSnapshot(
    input: UpsertSubscriptionEntitlementSnapshotInput
  ): Promise<SubscriptionEntitlementSnapshot> {
    const observedAt = new Date(input.observedAt);
    const [row] = await this.db
      .insert(subscriptionEntitlementSnapshots)
      .values({
        authUid: input.authUid,
        professionalEntitlementStatus: input.professionalEntitlementStatus,
        aiEntitlementStatus: input.aiEntitlementStatus,
        activeStudentCount: input.activeStudentCount,
        source: input.source,
        observedAt,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: subscriptionEntitlementSnapshots.authUid,
        set: {
          professionalEntitlementStatus: input.professionalEntitlementStatus,
          aiEntitlementStatus: input.aiEntitlementStatus,
          activeStudentCount: input.activeStudentCount,
          source: input.source,
          observedAt,
          updatedAt: new Date(),
        },
        // RevenueCat retries and delayed deliveries must not roll a user back to an older state.
        where: lt(subscriptionEntitlementSnapshots.observedAt, observedAt),
      })
      .returning();

    if (row) {
      return mapSnapshot(row);
    }

    const latest = await this.findLatestForAuthUid(input.authUid);
    if (!latest) {
      throw new Error('subscription_entitlement_snapshot_missing_after_conflict');
    }

    return latest;
  }

  async findLatestForAuthUid(authUid: string): Promise<SubscriptionEntitlementSnapshot | null> {
    const [row] = await this.db
      .select()
      .from(subscriptionEntitlementSnapshots)
      .where(eq(subscriptionEntitlementSnapshots.authUid, authUid))
      .limit(1);

    return row ? mapSnapshot(row) : null;
  }
}
