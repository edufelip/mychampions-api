import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'bun:test';

import { createApp } from '../src/app';
import { createTokenService } from '../src/auth/tokens';
import type { ProfileRepository } from '../src/profile/repository';

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

const environmentKeys = [
  'NODE_ENV',
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
        activeStudentCount: 9,
        source: 'revenuecat',
        observedAt: '2026-07-03T17:45:00.000Z',
        updatedAt: new Date(0).toISOString(),
      },
    });
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

  it('stores a RevenueCat webhook entitlement snapshot for the event app user id', async () => {
    process.env.REVENUECAT_WEBHOOK_AUTHORIZATION = 'Bearer webhook-secret';
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
    await expect(response.json()).resolves.toEqual({ status: 'accepted' });
    expect(subscriptions.saved).toEqual([
      {
        authUid: 'auth-1',
        professionalEntitlementStatus: 'active',
        aiEntitlementStatus: 'lapsed',
        activeStudentCount: null,
        source: 'revenuecat',
        observedAt: '2026-07-03T16:45:00.000Z',
      },
    ]);
  });

  it('verifies RevenueCat HMAC signatures when a signing secret is configured', async () => {
    process.env.REVENUECAT_WEBHOOK_AUTHORIZATION = 'Bearer webhook-secret';
    process.env.REVENUECAT_WEBHOOK_SIGNING_SECRET = 'local-signing-secret';
    const subscriptions = makeSubscriptionRepository();
    const app = createApp({
      subscriptionEntitlementRepository: subscriptions.repository,
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

  it('rejects RevenueCat webhooks with invalid authorization or signature', async () => {
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
});
