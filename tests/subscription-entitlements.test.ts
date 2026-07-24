import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'bun:test';

import { createApp } from '../src/app';
import { createTokenService } from '../src/auth/tokens';
import type { ProfileRepository } from '../src/profile/repository';
import type {
  RevenueCatCustomerManager,
  RevenueCatCustomerPrivileges,
} from '../src/subscription/revenuecat-customer-manager';

function makeProfileRepository(): ProfileRepository {
  const rows = new Map<string, {
    authUid: string;
    displayName: string;
    emailNormalized: string;
    lockedRole: 'student' | 'professional' | null;
    acceptedTermsVersion: string | null;
    createdAt: string;
    updatedAt: string;
  }>();

  return {
    async upsertFromSession(input) {
      const row = {
        authUid: input.authUid,
        displayName: input.displayName,
        emailNormalized: input.emailNormalized,
        lockedRole: null,
        acceptedTermsVersion: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
      rows.set(input.authUid, row);
      return row;
    },
    async findByAuthUid(authUid) {
      return rows.get(authUid) ?? null;
    },
    async lockRole(authUid, role) {
      const row = rows.get(authUid);
      if (!row) throw new Error('profile_not_found');
      const next = { ...row, lockedRole: role };
      rows.set(authUid, next);
      return next;
    },
    async setAcceptedTermsVersion(authUid, version) {
      const row = rows.get(authUid);
      if (!row) throw new Error('profile_not_found');
      const next = { ...row, acceptedTermsVersion: version };
      rows.set(authUid, next);
      return next;
    },
    async deleteByAuthUid(authUid) {
      rows.delete(authUid);
    },
  };
}

function makeSubscriptionRepository() {
  const saved: unknown[] = [];
  return {
    saved,
    repository: {
      async upsertSnapshot(input: {
        authUid: string;
        professionalEntitlementStatus: 'active' | 'lapsed' | 'unknown';
        aiEntitlementStatus: 'active' | 'lapsed' | 'unknown';
        professionalEntitlementExpiresAt?: string | null;
        professionalEntitlementRenewalRisk?: boolean;
        activeStudentCount: number | null;
        source: 'revenuecat';
        observedAt: string;
      }) {
        saved.push(input);
        return {
          ...input,
          updatedAt: new Date(0).toISOString(),
        };
      },
      async findLatestForAuthUid(authUid: string) {
        const latest = saved
          .filter((row): row is {
            authUid: string;
            professionalEntitlementStatus: 'active' | 'lapsed' | 'unknown';
            aiEntitlementStatus: 'active' | 'lapsed' | 'unknown';
            professionalEntitlementExpiresAt?: string | null;
            professionalEntitlementRenewalRisk?: boolean;
            activeStudentCount: number | null;
            source: 'revenuecat';
            observedAt: string;
          } => row !== null && typeof row === 'object' && 'authUid' in row && row.authUid === authUid)
          .at(-1);

        return latest
          ? {
              ...latest,
              updatedAt: new Date(0).toISOString(),
            }
          : null;
      },
    },
  };
}

function makeRevenueCatCustomerManager(
  byAppUserId: Record<string, Partial<RevenueCatCustomerPrivileges>> = {}
) {
  const requestedAppUserIds: string[] = [];
  const manager: RevenueCatCustomerManager = {
    async getCustomerPrivileges(appUserId) {
      requestedAppUserIds.push(appUserId);
      return {
        appUserId,
        professionalEntitlementStatus: 'lapsed',
        aiEntitlementStatus: 'lapsed',
        professionalEntitlementExpiresAt: null,
        professionalEntitlementRenewalRisk: false,
        observedAt: '2026-07-03T16:45:30.000Z',
        ...byAppUserId[appUserId],
      };
    },
  };
  return { manager, requestedAppUserIds };
}

const environmentKeys = [
  'NODE_ENV',
  'REVENUECAT_SECRET_API_KEY',
  'REVENUECAT_WEBHOOK_AUTHORIZATION',
  'REVENUECAT_WEBHOOK_SIGNING_SECRET',
] as const;

const originalRevenueCatEnv = new Map(
  environmentKeys.map((key) => [key, process.env[key]])
);

afterEach(() => {
  for (const key of environmentKeys) {
    const original = originalRevenueCatEnv.get(key);
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
});

function signRevenueCatPayload(payload: string, timestamp: number, secret: string): string {
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

describe('subscription entitlement snapshot API', () => {
  it('stores the authenticated user RevenueCat entitlement snapshot', async () => {
    const subscriptions = makeSubscriptionRepository();
    const app = createApp({
      profileRepository: makeProfileRepository(),
      subscriptionEntitlementRepository: subscriptions.repository,
    } as Parameters<typeof createApp>[0] & { subscriptionEntitlementRepository: unknown });

    const sessionResponse = await app.handle(
      new Request('http://server.test/auth/dev/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'Pro@Example.test',
          displayName: 'Pro User',
        }),
      })
    );
    const session = await sessionResponse.json();

    const response = await app.handle(
      new Request('http://server.test/subscription/entitlements/snapshot', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          professionalEntitlementStatus: 'active',
          aiEntitlementStatus: 'lapsed',
          professionalEntitlementExpiresAt: '2026-08-03T16:45:00.000Z',
          professionalEntitlementRenewalRisk: true,
          activeStudentCount: 7,
          observedAt: '2026-07-03T16:45:00.000Z',
        }),
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      snapshot: {
        authUid: session.profile.authUid,
        professionalEntitlementStatus: 'active',
        aiEntitlementStatus: 'lapsed',
        professionalEntitlementExpiresAt: '2026-08-03T16:45:00.000Z',
        professionalEntitlementRenewalRisk: true,
        activeStudentCount: 7,
        source: 'revenuecat',
        observedAt: '2026-07-03T16:45:00.000Z',
        updatedAt: new Date(0).toISOString(),
      },
    });
    expect(subscriptions.saved).toEqual([
      {
        authUid: session.profile.authUid,
        professionalEntitlementStatus: 'active',
        aiEntitlementStatus: 'lapsed',
        professionalEntitlementExpiresAt: '2026-08-03T16:45:00.000Z',
        professionalEntitlementRenewalRisk: true,
        activeStudentCount: 7,
        source: 'revenuecat',
        observedAt: '2026-07-03T16:45:00.000Z',
      },
    ]);
  });

  it('returns the authenticated user latest local entitlement snapshot', async () => {
    const subscriptions = makeSubscriptionRepository();
    const app = createApp({
      profileRepository: makeProfileRepository(),
      subscriptionEntitlementRepository: subscriptions.repository,
    } as Parameters<typeof createApp>[0] & { subscriptionEntitlementRepository: unknown });

    const sessionResponse = await app.handle(
      new Request('http://server.test/auth/dev/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'Pro@Example.test',
          displayName: 'Pro User',
        }),
      })
    );
    const session = await sessionResponse.json();

    await app.handle(
      new Request('http://server.test/subscription/entitlements/snapshot', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          professionalEntitlementStatus: 'lapsed',
          aiEntitlementStatus: 'active',
          activeStudentCount: 9,
          observedAt: '2026-07-03T17:45:00.000Z',
        }),
      })
    );

    const response = await app.handle(
      new Request('http://server.test/subscription/entitlements/snapshot', {
        method: 'GET',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      snapshot: {
        authUid: session.profile.authUid,
        professionalEntitlementStatus: 'lapsed',
        aiEntitlementStatus: 'active',
        professionalEntitlementExpiresAt: null,
        professionalEntitlementRenewalRisk: false,
        activeStudentCount: 9,
        source: 'revenuecat',
        observedAt: '2026-07-03T17:45:00.000Z',
        updatedAt: new Date(0).toISOString(),
      },
    });
  });

  it('rejects malformed client entitlement expiry without storing a snapshot', async () => {
    const subscriptions = makeSubscriptionRepository();
    const app = createApp({
      profileRepository: makeProfileRepository(),
      subscriptionEntitlementRepository: subscriptions.repository,
    } as Parameters<typeof createApp>[0] & { subscriptionEntitlementRepository: unknown });
    const sessionResponse = await app.handle(
      new Request('http://server.test/auth/dev/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'Pro@Example.test', displayName: 'Pro User' }),
      })
    );
    const session = await sessionResponse.json();

    const response = await app.handle(
      new Request('http://server.test/subscription/entitlements/snapshot', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          professionalEntitlementStatus: 'active',
          aiEntitlementStatus: 'lapsed',
          professionalEntitlementExpiresAt: 'not-a-date',
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(subscriptions.saved).toEqual([]);
  });

  it('returns null when the authenticated user has no local entitlement snapshot', async () => {
    const subscriptions = makeSubscriptionRepository();
    const app = createApp({
      profileRepository: makeProfileRepository(),
      subscriptionEntitlementRepository: subscriptions.repository,
    } as Parameters<typeof createApp>[0] & { subscriptionEntitlementRepository: unknown });

    const sessionResponse = await app.handle(
      new Request('http://server.test/auth/dev/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'Empty@Example.test',
          displayName: 'Empty User',
        }),
      })
    );
    const session = await sessionResponse.json();

    const response = await app.handle(
      new Request('http://server.test/subscription/entitlements/snapshot', {
        method: 'GET',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ snapshot: null });
  });

  it('requires local server auth before accepting entitlement snapshots', async () => {
    const subscriptions = makeSubscriptionRepository();
    const app = createApp({
      subscriptionEntitlementRepository: subscriptions.repository,
    } as Parameters<typeof createApp>[0] & { subscriptionEntitlementRepository: unknown });

    const response = await app.handle(
      new Request('http://server.test/subscription/entitlements/snapshot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          professionalEntitlementStatus: 'active',
          aiEntitlementStatus: 'active',
          observedAt: '2026-07-03T16:45:00.000Z',
        }),
      })
    );

    expect(response.status).toBe(401);
    expect(subscriptions.saved).toEqual([]);
  });

  it('refuses authenticated client entitlement writes in production', async () => {
    process.env.NODE_ENV = 'production';
    const subscriptions = makeSubscriptionRepository();
    const tokenService = createTokenService({
      issuer: 'mychampions-local',
      audience: 'mychampions-mobile',
    });
    const accessToken = await tokenService.issue({
      sub: 'auth-1',
      email: 'pro@example.test',
      displayName: 'Pro User',
      emailVerified: true,
    });
    const app = createApp({
      subscriptionEntitlementRepository: subscriptions.repository,
      tokenService,
    } as Parameters<typeof createApp>[0] & { subscriptionEntitlementRepository: unknown });

    const response = await app.handle(
      new Request('http://server.test/subscription/entitlements/snapshot', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          professionalEntitlementStatus: 'active',
          aiEntitlementStatus: 'active',
          observedAt: '2026-07-03T16:45:00.000Z',
        }),
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'client_subscription_snapshot_sync_disabled',
        message: 'Client entitlement snapshots are disabled in production.',
      },
    });
    expect(subscriptions.saved).toEqual([]);
  });

  it('refuses RevenueCat webhooks until webhook authorization is configured', async () => {
    delete process.env.REVENUECAT_WEBHOOK_AUTHORIZATION;
    delete process.env.REVENUECAT_WEBHOOK_SIGNING_SECRET;
    const subscriptions = makeSubscriptionRepository();
    const app = createApp({
      subscriptionEntitlementRepository: subscriptions.repository,
    } as Parameters<typeof createApp>[0] & { subscriptionEntitlementRepository: unknown });

    const response = await app.handle(
      new Request('http://server.test/webhooks/revenuecat', {
        method: 'POST',
        headers: {
          authorization: 'Bearer webhook-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ event: { app_user_id: 'auth-1', type: 'TEST' } }),
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'revenuecat_webhook_not_configured',
        message: 'RevenueCat webhook authorization is not configured.',
      },
    });
    expect(subscriptions.saved).toEqual([]);
  });

  it('requires a webhook signing secret before accepting RevenueCat events in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.REVENUECAT_WEBHOOK_AUTHORIZATION = 'Bearer webhook-secret';
    delete process.env.REVENUECAT_WEBHOOK_SIGNING_SECRET;
    const subscriptions = makeSubscriptionRepository();
    const app = createApp({
      subscriptionEntitlementRepository: subscriptions.repository,
      tokenService: createTokenService({
        issuer: 'mychampions-local',
        audience: 'mychampions-mobile',
      }),
    } as Parameters<typeof createApp>[0] & { subscriptionEntitlementRepository: unknown });

    const response = await app.handle(
      new Request('http://server.test/webhooks/revenuecat', {
        method: 'POST',
        headers: {
          authorization: 'Bearer webhook-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          event: {
            app_user_id: 'auth-1',
            entitlement_ids: ['professional_pro'],
            event_timestamp_ms: Date.now(),
            type: 'INITIAL_PURCHASE',
          },
        }),
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'revenuecat_webhook_signing_not_configured',
        message: 'RevenueCat webhook signing is required in production.',
      },
    });
    expect(subscriptions.saved).toEqual([]);
  });

  it('refuses RevenueCat webhooks until canonical customer lookup is configured', async () => {
    process.env.REVENUECAT_WEBHOOK_AUTHORIZATION = 'Bearer webhook-secret';
    delete process.env.REVENUECAT_WEBHOOK_SIGNING_SECRET;
    delete process.env.REVENUECAT_SECRET_API_KEY;
    const subscriptions = makeSubscriptionRepository();
    const app = createApp({
      subscriptionEntitlementRepository: subscriptions.repository,
    } as Parameters<typeof createApp>[0] & { subscriptionEntitlementRepository: unknown });

    const response = await app.handle(
      new Request('http://server.test/webhooks/revenuecat', {
        method: 'POST',
        headers: {
          authorization: 'Bearer webhook-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ event: { app_user_id: 'auth-1', type: 'RENEWAL' } }),
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'revenuecat_customer_api_not_configured' },
    });
    expect(subscriptions.saved).toEqual([]);
  });

  it('stores a RevenueCat webhook entitlement snapshot for the event app user id', async () => {
    process.env.REVENUECAT_WEBHOOK_AUTHORIZATION = 'Bearer webhook-secret';
    delete process.env.REVENUECAT_WEBHOOK_SIGNING_SECRET;
    const subscriptions = makeSubscriptionRepository();
    const customers = makeRevenueCatCustomerManager({
      'auth-1': {
        professionalEntitlementStatus: 'active',
        aiEntitlementStatus: 'active',
        professionalEntitlementExpiresAt: '2026-08-03T16:45:00.000Z',
        professionalEntitlementRenewalRisk: false,
        observedAt: '2026-07-03T16:45:30.000Z',
      },
    });
    const app = createApp({
      subscriptionEntitlementRepository: subscriptions.repository,
      revenueCatCustomerManager: customers.manager,
    } as Parameters<typeof createApp>[0] & { subscriptionEntitlementRepository: unknown });

    const response = await app.handle(
      new Request('http://server.test/webhooks/revenuecat', {
        method: 'POST',
        headers: {
          authorization: 'Bearer webhook-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          event: {
            id: 'event-1',
            type: 'INITIAL_PURCHASE',
            event_timestamp_ms: 1783097100000,
            app_user_id: 'auth-1',
            entitlement_ids: ['professional_pro'],
            expiration_at_ms: 4102444800000,
          },
          api_version: '1.0',
        }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'accepted',
      reconciledCustomers: 1,
    });
    expect(customers.requestedAppUserIds).toEqual(['auth-1']);
    expect(subscriptions.saved).toEqual([
      {
        authUid: 'auth-1',
        professionalEntitlementStatus: 'active',
        aiEntitlementStatus: 'active',
        professionalEntitlementExpiresAt: '2026-08-03T16:45:00.000Z',
        professionalEntitlementRenewalRisk: false,
        activeStudentCount: null,
        source: 'revenuecat',
        observedAt: '2026-07-03T16:45:30.000Z',
      },
    ]);
  });

  it('verifies RevenueCat HMAC signatures when a signing secret is configured', async () => {
    process.env.REVENUECAT_WEBHOOK_AUTHORIZATION = 'Bearer webhook-secret';
    process.env.REVENUECAT_WEBHOOK_SIGNING_SECRET = 'local-signing-secret';
    const subscriptions = makeSubscriptionRepository();
    const customers = makeRevenueCatCustomerManager();
    const app = createApp({
      subscriptionEntitlementRepository: subscriptions.repository,
      revenueCatCustomerManager: customers.manager,
    } as Parameters<typeof createApp>[0] & { subscriptionEntitlementRepository: unknown });
    const payload = JSON.stringify({
      event: {
        id: 'event-2',
        type: 'EXPIRATION',
        event_timestamp_ms: Date.now(),
        app_user_id: 'auth-2',
        entitlement_ids: ['student_pro'],
      },
      api_version: '1.0',
    });
    const timestamp = Math.floor(Date.now() / 1000);

    const response = await app.handle(
      new Request('http://server.test/webhooks/revenuecat', {
        method: 'POST',
        headers: {
          authorization: 'Bearer webhook-secret',
          'content-type': 'application/json',
          'x-revenuecat-webhook-signature': signRevenueCatPayload(
            payload,
            timestamp,
            'local-signing-secret'
          ),
        },
        body: payload,
      })
    );

    expect(response.status).toBe(200);
    expect(subscriptions.saved).toHaveLength(1);
    expect(subscriptions.saved[0]).toMatchObject({
      authUid: 'auth-2',
      professionalEntitlementStatus: 'lapsed',
      aiEntitlementStatus: 'lapsed',
      activeStudentCount: null,
      source: 'revenuecat',
    });
  });

  it('reconciles both sides of a RevenueCat transfer from canonical customer state', async () => {
    process.env.REVENUECAT_WEBHOOK_AUTHORIZATION = 'Bearer webhook-secret';
    delete process.env.REVENUECAT_WEBHOOK_SIGNING_SECRET;
    const subscriptions = makeSubscriptionRepository();
    const customers = makeRevenueCatCustomerManager({
      'auth-from': { professionalEntitlementStatus: 'lapsed' },
      'auth-to': { professionalEntitlementStatus: 'active' },
    });
    const app = createApp({
      subscriptionEntitlementRepository: subscriptions.repository,
      revenueCatCustomerManager: customers.manager,
    } as Parameters<typeof createApp>[0] & { subscriptionEntitlementRepository: unknown });

    const response = await app.handle(
      new Request('http://server.test/webhooks/revenuecat', {
        method: 'POST',
        headers: {
          authorization: 'Bearer webhook-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          event: {
            id: 'transfer-1',
            type: 'TRANSFER',
            event_timestamp_ms: 1783097100000,
            transferred_from: ['auth-from'],
            transferred_to: ['auth-to'],
          },
          api_version: '1.0',
        }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'accepted',
      reconciledCustomers: 2,
    });
    expect(customers.requestedAppUserIds).toEqual(['auth-from', 'auth-to']);
    expect(subscriptions.saved).toHaveLength(2);
    expect(subscriptions.saved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ authUid: 'auth-from', professionalEntitlementStatus: 'lapsed' }),
        expect.objectContaining({ authUid: 'auth-to', professionalEntitlementStatus: 'active' }),
      ])
    );
  });

  it('retries later when canonical RevenueCat customer reconciliation fails', async () => {
    process.env.REVENUECAT_WEBHOOK_AUTHORIZATION = 'Bearer webhook-secret';
    delete process.env.REVENUECAT_WEBHOOK_SIGNING_SECRET;
    const subscriptions = makeSubscriptionRepository();
    const app = createApp({
      subscriptionEntitlementRepository: subscriptions.repository,
      revenueCatCustomerManager: {
        async getCustomerPrivileges() {
          throw new Error('RevenueCat unavailable');
        },
      },
    } as Parameters<typeof createApp>[0] & { subscriptionEntitlementRepository: unknown });

    const response = await app.handle(
      new Request('http://server.test/webhooks/revenuecat', {
        method: 'POST',
        headers: {
          authorization: 'Bearer webhook-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ event: { app_user_id: 'auth-1', type: 'RENEWAL' } }),
      })
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'revenuecat_customer_reconciliation_failed' },
    });
    expect(subscriptions.saved).toEqual([]);
  });

  it('returns a retryable failure when canonical privileges cannot be persisted', async () => {
    process.env.REVENUECAT_WEBHOOK_AUTHORIZATION = 'Bearer webhook-secret';
    delete process.env.REVENUECAT_WEBHOOK_SIGNING_SECRET;
    const app = createApp({
      subscriptionEntitlementRepository: {
        async upsertSnapshot() {
          throw new Error('database unavailable');
        },
        async findLatestForAuthUid() {
          return null;
        },
      },
      revenueCatCustomerManager: makeRevenueCatCustomerManager().manager,
    });

    const response = await app.handle(
      new Request('http://server.test/webhooks/revenuecat', {
        method: 'POST',
        headers: {
          authorization: 'Bearer webhook-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ event: { app_user_id: 'auth-1', type: 'RENEWAL' } }),
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'revenuecat_snapshot_persistence_failed',
        message: 'RevenueCat customer state could not be persisted; retry the delivery.',
      },
    });
  });

  it('rejects malformed RevenueCat payloads before customer lookup', async () => {
    process.env.REVENUECAT_WEBHOOK_AUTHORIZATION = 'Bearer webhook-secret';
    delete process.env.REVENUECAT_WEBHOOK_SIGNING_SECRET;
    const subscriptions = makeSubscriptionRepository();
    const customers = makeRevenueCatCustomerManager();
    const app = createApp({
      subscriptionEntitlementRepository: subscriptions.repository,
      revenueCatCustomerManager: customers.manager,
    } as Parameters<typeof createApp>[0] & { subscriptionEntitlementRepository: unknown });

    for (const body of [
      'not-json',
      JSON.stringify({}),
      JSON.stringify({ event: { type: 'RENEWAL' } }),
      JSON.stringify({
        event: {
          type: 'TRANSFER',
          transferred_from: ['', null],
          transferred_to: [false],
        },
      }),
    ]) {
      const response = await app.handle(
        new Request('http://server.test/webhooks/revenuecat', {
          method: 'POST',
          headers: {
            authorization: 'Bearer webhook-secret',
            'content-type': 'application/json',
          },
          body,
        })
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'invalid_revenuecat_webhook_payload' },
      });
    }
    expect(customers.requestedAppUserIds).toEqual([]);
    expect(subscriptions.saved).toEqual([]);
  });

  it('deduplicates and trims every customer in a transfer event', async () => {
    process.env.REVENUECAT_WEBHOOK_AUTHORIZATION = 'Bearer webhook-secret';
    delete process.env.REVENUECAT_WEBHOOK_SIGNING_SECRET;
    const subscriptions = makeSubscriptionRepository();
    const customers = makeRevenueCatCustomerManager();
    const app = createApp({
      subscriptionEntitlementRepository: subscriptions.repository,
      revenueCatCustomerManager: customers.manager,
    } as Parameters<typeof createApp>[0] & { subscriptionEntitlementRepository: unknown });

    const response = await app.handle(
      new Request('http://server.test/webhooks/revenuecat', {
        method: 'POST',
        headers: {
          authorization: 'Bearer webhook-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          event: {
            app_user_id: ' auth-shared ',
            type: 'TRANSFER',
            transferred_from: ['auth-shared', ' auth-from ', 'auth-from'],
            transferred_to: ['auth-to', ' auth-to ', null],
          },
        }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'accepted',
      reconciledCustomers: 3,
    });
    expect(customers.requestedAppUserIds).toEqual([
      'auth-shared',
      'auth-from',
      'auth-to',
    ]);
    expect(subscriptions.saved).toHaveLength(3);
  });

  it('rejects RevenueCat webhooks with invalid authorization', async () => {
    process.env.REVENUECAT_WEBHOOK_AUTHORIZATION = 'Bearer webhook-secret';
    process.env.REVENUECAT_WEBHOOK_SIGNING_SECRET = 'local-signing-secret';
    const subscriptions = makeSubscriptionRepository();
    const app = createApp({
      subscriptionEntitlementRepository: subscriptions.repository,
    } as Parameters<typeof createApp>[0] & { subscriptionEntitlementRepository: unknown });

    const response = await app.handle(
      new Request('http://server.test/webhooks/revenuecat', {
        method: 'POST',
        headers: {
          authorization: 'Bearer wrong-secret',
          'content-type': 'application/json',
          'x-revenuecat-webhook-signature': 't=1783097100,v1=bad',
        },
        body: JSON.stringify({
          event: {
            type: 'INITIAL_PURCHASE',
            event_timestamp_ms: 1783097100000,
            app_user_id: 'auth-1',
            entitlement_ids: ['professional_pro'],
          },
        }),
      })
    );

    expect(response.status).toBe(401);
    expect(subscriptions.saved).toEqual([]);
  });

  it('rejects missing, malformed, incorrect, and stale RevenueCat signatures', async () => {
    process.env.REVENUECAT_WEBHOOK_AUTHORIZATION = 'Bearer webhook-secret';
    process.env.REVENUECAT_WEBHOOK_SIGNING_SECRET = 'local-signing-secret';
    const subscriptions = makeSubscriptionRepository();
    const customers = makeRevenueCatCustomerManager();
    const app = createApp({
      subscriptionEntitlementRepository: subscriptions.repository,
      revenueCatCustomerManager: customers.manager,
    } as Parameters<typeof createApp>[0] & { subscriptionEntitlementRepository: unknown });
    const payload = JSON.stringify({
      event: {
        type: 'RENEWAL',
        app_user_id: 'auth-1',
      },
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const signatures = [
      undefined,
      'not-a-signature',
      `t=${nowSeconds},v1=${'0'.repeat(64)}`,
      signRevenueCatPayload(payload, nowSeconds - 301, 'local-signing-secret'),
    ];

    for (const signature of signatures) {
      const headers: Record<string, string> = {
        authorization: 'Bearer webhook-secret',
        'content-type': 'application/json',
      };
      if (signature) {
        headers['x-revenuecat-webhook-signature'] = signature;
      }
      const response = await app.handle(
        new Request('http://server.test/webhooks/revenuecat', {
          method: 'POST',
          headers,
          body: payload,
        })
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'invalid_revenuecat_webhook_signature' },
      });
    }
    expect(customers.requestedAppUserIds).toEqual([]);
    expect(subscriptions.saved).toEqual([]);
  });
});
