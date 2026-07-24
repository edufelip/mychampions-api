import { afterAll, beforeEach, describe, expect, it } from 'bun:test';

import { createDatabase } from '../src/db/client';
import { PostgresSubscriptionEntitlementRepository } from '../src/subscription/postgres-entitlement-repository';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_server_local';

const database = createDatabase(databaseUrl);
const repository = new PostgresSubscriptionEntitlementRepository(database.db);

beforeEach(async () => {
  await database.client`truncate table subscription_entitlement_snapshots`;
});

afterAll(async () => {
  await database.close();
});

describe('PostgresSubscriptionEntitlementRepository', () => {
  it('upserts the latest RevenueCat entitlement snapshot per auth user', async () => {
    await repository.upsertSnapshot({
      authUid: 'auth-1',
      professionalEntitlementStatus: 'lapsed',
      aiEntitlementStatus: 'lapsed',
      activeStudentCount: 10,
      source: 'revenuecat',
      observedAt: '2026-07-03T16:45:00.000Z',
    });

    const updated = await repository.upsertSnapshot({
      authUid: 'auth-1',
      professionalEntitlementStatus: 'active',
      aiEntitlementStatus: 'lapsed',
      professionalEntitlementExpiresAt: '2026-08-03T16:50:00.000Z',
      professionalEntitlementRenewalRisk: true,
      activeStudentCount: 11,
      source: 'revenuecat',
      observedAt: '2026-07-03T16:50:00.000Z',
    });

    expect(updated).toMatchObject({
      authUid: 'auth-1',
      professionalEntitlementStatus: 'active',
      aiEntitlementStatus: 'lapsed',
      professionalEntitlementExpiresAt: '2026-08-03T16:50:00.000Z',
      professionalEntitlementRenewalRisk: true,
      activeStudentCount: 11,
      source: 'revenuecat',
      observedAt: '2026-07-03T16:50:00.000Z',
    });
    expect(new Date(updated.updatedAt).toString()).not.toBe('Invalid Date');

    const [{ count }] = await database.client`select count(*)::int as count from subscription_entitlement_snapshots`;
    expect(count).toBe(1);
  });

  it('keeps a newer entitlement snapshot when a delayed older delivery arrives afterwards', async () => {
    await repository.upsertSnapshot({
      authUid: 'auth-1',
      professionalEntitlementStatus: 'active',
      aiEntitlementStatus: 'active',
      activeStudentCount: 12,
      source: 'revenuecat',
      observedAt: '2026-07-03T17:00:00.000Z',
    });

    const returned = await repository.upsertSnapshot({
      authUid: 'auth-1',
      professionalEntitlementStatus: 'lapsed',
      aiEntitlementStatus: 'lapsed',
      activeStudentCount: 0,
      source: 'revenuecat',
      observedAt: '2026-07-03T16:45:00.000Z',
    });

    expect(returned).toMatchObject({
      authUid: 'auth-1',
      professionalEntitlementStatus: 'active',
      aiEntitlementStatus: 'active',
      activeStudentCount: 12,
      observedAt: '2026-07-03T17:00:00.000Z',
    });
    await expect(repository.findLatestForAuthUid('auth-1')).resolves.toMatchObject({
      authUid: 'auth-1',
      professionalEntitlementStatus: 'active',
      aiEntitlementStatus: 'active',
      activeStudentCount: 12,
      observedAt: '2026-07-03T17:00:00.000Z',
    });
  });

  it('finds the latest RevenueCat entitlement snapshot for one auth user', async () => {
    await repository.upsertSnapshot({
      authUid: 'auth-1',
      professionalEntitlementStatus: 'active',
      aiEntitlementStatus: 'lapsed',
      activeStudentCount: 7,
      source: 'revenuecat',
      observedAt: '2026-07-03T16:45:00.000Z',
    });
    await repository.upsertSnapshot({
      authUid: 'auth-2',
      professionalEntitlementStatus: 'lapsed',
      aiEntitlementStatus: 'active',
      activeStudentCount: 3,
      source: 'revenuecat',
      observedAt: '2026-07-03T16:50:00.000Z',
    });

    await expect(repository.findLatestForAuthUid('auth-1')).resolves.toMatchObject({
      authUid: 'auth-1',
      professionalEntitlementStatus: 'active',
      aiEntitlementStatus: 'lapsed',
      activeStudentCount: 7,
      source: 'revenuecat',
      observedAt: '2026-07-03T16:45:00.000Z',
    });
    await expect(repository.findLatestForAuthUid('missing-auth')).resolves.toBeNull();
  });
});
