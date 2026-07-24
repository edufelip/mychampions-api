import { describe, expect, it } from 'bun:test';

import {
  mapRevenueCatCustomerPrivileges,
  RevenueCatCustomerManagerError,
  RevenueCatRestCustomerManager,
} from '../src/subscription/revenuecat-customer-manager';

const NOW = new Date('2026-07-21T12:00:00.000Z');

function customerBody(overrides: Record<string, unknown> = {}) {
  return {
    request_date: '2026-07-21T11:59:30.000Z',
    subscriber: {
      entitlements: {},
      subscriptions: {},
      ...overrides,
    },
  };
}

describe('mapRevenueCatCustomerPrivileges', () => {
  it('maps both independent active entitlements from canonical customer state', () => {
    const privileges = mapRevenueCatCustomerPrivileges(
      customerBody({
        entitlements: {
          professional_pro: {
            expires_date: '2026-08-21T12:00:00.000Z',
            product_identifier: 'professional_monthly',
          },
          student_pro: {
            expires_date: '2026-08-21T12:00:00.000Z',
            product_identifier: 'student_monthly',
          },
        },
        subscriptions: {
          professional_monthly: {},
          student_monthly: {},
        },
      }),
      'user-1',
      NOW
    );

    expect(privileges).toEqual({
      appUserId: 'user-1',
      professionalEntitlementStatus: 'active',
      aiEntitlementStatus: 'active',
      professionalEntitlementExpiresAt: '2026-08-21T12:00:00.000Z',
      professionalEntitlementRenewalRisk: false,
      observedAt: '2026-07-21T11:59:30.000Z',
    });
  });

  it('uses a valid grace period and flags authoritative billing or cancellation risk', () => {
    const privileges = mapRevenueCatCustomerPrivileges(
      customerBody({
        entitlements: {
          professional_pro: {
            expires_date: '2026-07-20T12:00:00.000Z',
            grace_period_expires_date: '2026-07-23T12:00:00.000Z',
            product_identifier: 'professional_monthly',
          },
        },
        subscriptions: {
          professional_monthly: {
            billing_issues_detected_at: '2026-07-21T10:00:00.000Z',
          },
        },
      }),
      'user-1',
      NOW
    );

    expect(privileges.professionalEntitlementStatus).toBe('active');
    expect(privileges.professionalEntitlementExpiresAt).toBe('2026-07-23T12:00:00.000Z');
    expect(privileges.professionalEntitlementRenewalRisk).toBe(true);
  });

  it('does not grant expired, refunded, malformed, or missing entitlements', () => {
    const inactive = mapRevenueCatCustomerPrivileges(
      customerBody({
        entitlements: {
          professional_pro: {
            expires_date: '2026-08-20T12:00:00.000Z',
            product_identifier: 'professional_monthly',
          },
          student_pro: {
            expires_date: '2026-08-20T12:00:00.000Z',
            product_identifier: 'student_monthly',
          },
        },
        subscriptions: {
          professional_monthly: { refunded_at: '2026-07-20T11:00:00.000Z' },
          student_monthly: { refunded_at: '2026-07-20T11:00:00.000Z' },
        },
      }),
      'user-1',
      NOW
    );

    expect(inactive.professionalEntitlementStatus).toBe('lapsed');
    expect(inactive.aiEntitlementStatus).toBe('lapsed');
    expect(inactive.professionalEntitlementRenewalRisk).toBe(false);

    const expiredAndMalformed = mapRevenueCatCustomerPrivileges(
      customerBody({
        entitlements: {
          professional_pro: {
            expires_date: '2026-07-20T12:00:00.000Z',
            product_identifier: 'professional_monthly',
          },
          student_pro: { expires_date: 'not-a-date' },
        },
      }),
      'user-1',
      NOW
    );
    expect(expiredAndMalformed.professionalEntitlementStatus).toBe('lapsed');
    expect(expiredAndMalformed.aiEntitlementStatus).toBe('lapsed');

    const missing = mapRevenueCatCustomerPrivileges(customerBody(), 'user-1', NOW);
    expect(missing.professionalEntitlementStatus).toBe('lapsed');
    expect(missing.aiEntitlementStatus).toBe('lapsed');
  });

  it('supports lifetime entitlements and uses request_date_ms as the authoritative observation', () => {
    const privileges = mapRevenueCatCustomerPrivileges(
      {
        request_date: '2020-01-01T00:00:00.000Z',
        request_date_ms: Date.parse('2026-07-21T11:59:45.000Z'),
        subscriber: {
          entitlements: {
            professional_pro: {
              expires_date: null,
              product_identifier: 'professional_lifetime',
            },
            student_pro: {
              expires_date: null,
              product_identifier: 'student_lifetime',
            },
          },
          subscriptions: {},
        },
      },
      'user-1',
      NOW
    );

    expect(privileges.professionalEntitlementStatus).toBe('active');
    expect(privileges.aiEntitlementStatus).toBe('active');
    expect(privileges.professionalEntitlementExpiresAt).toBeNull();
    expect(privileges.observedAt).toBe('2026-07-21T11:59:45.000Z');
  });

  it('evaluates expiry against the provider observation time despite local clock skew', () => {
    const privileges = mapRevenueCatCustomerPrivileges(
      {
        request_date_ms: Date.parse('2026-07-21T11:59:45.000Z'),
        subscriber: {
          entitlements: {
            professional_pro: {
              expires_date: '2026-07-21T12:30:00.000Z',
              product_identifier: 'professional_monthly',
            },
            student_pro: {
              expires_date: '2026-07-21T12:30:00.000Z',
              product_identifier: 'student_monthly',
            },
          },
          subscriptions: {},
        },
      },
      'user-1',
      new Date('2026-07-21T13:00:00.000Z')
    );

    expect(privileges.professionalEntitlementStatus).toBe('active');
    expect(privileges.aiEntitlementStatus).toBe('active');
    expect(privileges.observedAt).toBe('2026-07-21T11:59:45.000Z');
  });

  it('falls back safely when request_date_ms is outside the JavaScript date range', () => {
    const privileges = mapRevenueCatCustomerPrivileges(
      {
        request_date: '2026-07-21T11:59:30.000Z',
        request_date_ms: Number.MAX_VALUE,
        subscriber: {
          entitlements: {},
          subscriptions: {},
        },
      },
      'user-1',
      NOW
    );

    expect(privileges.observedAt).toBe('2026-07-21T11:59:30.000Z');
    expect(privileges.professionalEntitlementStatus).toBe('lapsed');
    expect(privileges.aiEntitlementStatus).toBe('lapsed');
  });

  it('rejects a malformed customer response instead of inventing privileges', () => {
    expect(() => mapRevenueCatCustomerPrivileges({}, 'user-1', NOW)).toThrow(
      RevenueCatCustomerManagerError
    );
  });
});

describe('RevenueCatRestCustomerManager', () => {
  it('fetches one encoded App User ID with a server-only secret key', async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const manager = new RevenueCatRestCustomerManager('sk_test_secret', {
      apiBaseUrl: 'https://revenuecat.test/v1/',
      now: () => NOW,
      fetchFn: async (input, init) => {
        requests.push({ input: String(input), init });
        return Response.json(customerBody(), { status: 200 });
      },
    });

    await expect(manager.getCustomerPrivileges(' user/with space ')).resolves.toMatchObject({
      appUserId: 'user/with space',
      professionalEntitlementStatus: 'lapsed',
      aiEntitlementStatus: 'lapsed',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].input).toBe(
      'https://revenuecat.test/v1/subscribers/user%2Fwith%20space'
    );
    expect(requests[0].init?.headers).toEqual({
      authorization: 'Bearer sk_test_secret',
      accept: 'application/json',
    });
  });

  it('rejects blank IDs and public SDK keys before making a request', async () => {
    let requestCount = 0;
    const manager = new RevenueCatRestCustomerManager('appl_public', {
      fetchFn: async () => {
        requestCount += 1;
        return Response.json(customerBody());
      },
    });

    await expect(manager.getCustomerPrivileges('user-1')).rejects.toMatchObject({
      code: 'configuration',
    });
    await expect(manager.getCustomerPrivileges('   ')).rejects.toMatchObject({
      code: 'configuration',
    });
    expect(requestCount).toBe(0);
  });

  it('normalizes network, upstream, and invalid JSON failures', async () => {
    const networkManager = new RevenueCatRestCustomerManager('sk_test_secret', {
      fetchFn: async () => {
        throw new Error('offline');
      },
    });
    await expect(networkManager.getCustomerPrivileges('user-1')).rejects.toMatchObject({
      code: 'network',
    });

    const upstreamManager = new RevenueCatRestCustomerManager('sk_test_secret', {
      fetchFn: async () => new Response(null, { status: 503 }),
    });
    await expect(upstreamManager.getCustomerPrivileges('user-1')).rejects.toMatchObject({
      code: 'upstream',
    });

    const malformedManager = new RevenueCatRestCustomerManager('sk_test_secret', {
      fetchFn: async () => new Response('{', { status: 200 }),
    });
    await expect(malformedManager.getCustomerPrivileges('user-1')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});
