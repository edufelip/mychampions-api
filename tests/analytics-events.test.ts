import { describe, expect, it } from 'bun:test';

import { createApp } from '../src/app';
import type { AnalyticsEventRepository, CreateAnalyticsEventInput } from '../src/analytics/repository';

function makeAnalyticsRepository() {
  const saved: CreateAnalyticsEventInput[] = [];
  const repository: AnalyticsEventRepository = {
    async create(input) {
      saved.push(input);
      return {
        id: `analytics-${saved.length}`,
        ...input,
        createdAt: new Date(0).toISOString(),
      };
    },
  };
  return { repository, saved };
}

describe('analytics events API', () => {
  it('stores provider-neutral analytics events without requiring auth', async () => {
    const analytics = makeAnalyticsRepository();
    const app = createApp({ analyticsEventRepository: analytics.repository });

    const response = await app.handle(
      new Request('http://server.test/analytics/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'auth.entry.viewed',
          properties: {
            surface: 'auth_sign_in',
            step: 'view',
            result: 'success',
          },
        }),
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ id: 'analytics-1' });
    expect(analytics.saved).toEqual([
      {
        name: 'auth.entry.viewed',
        properties: {
          surface: 'auth_sign_in',
          step: 'view',
          result: 'success',
        },
      },
    ]);
  });

  it('rejects analytics events containing sensitive property keys', async () => {
    const analytics = makeAnalyticsRepository();
    const app = createApp({ analyticsEventRepository: analytics.repository });

    const response = await app.handle(
      new Request('http://server.test/analytics/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'auth.sign_in.failed',
          properties: {
            surface: 'auth_sign_in',
            step: 'submit',
            result: 'failure',
            email: 'person@example.test',
          },
        }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'sensitive_analytics_property',
        message: 'Analytics events must not include sensitive property keys.',
      },
    });
    expect(analytics.saved).toEqual([]);
  });

  it('accepts professional pending queue analytics event names', async () => {
    const analytics = makeAnalyticsRepository();
    const app = createApp({ analyticsEventRepository: analytics.repository });

    const response = await app.handle(
      new Request('http://server.test/analytics/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'invite.pending.bulk_denied',
          properties: {
            surface: 'relationship_management',
            step: 'bulk_deny',
            result: 'success',
            role_context: 'professional',
            pending_count: 3,
          },
        }),
      })
    );

    expect(response.status).toBe(202);
    expect(analytics.saved).toEqual([
      {
        name: 'invite.pending.bulk_denied',
        properties: {
          surface: 'relationship_management',
          step: 'bulk_deny',
          result: 'success',
          role_context: 'professional',
          pending_count: 3,
        },
      },
    ]);
  });
});
