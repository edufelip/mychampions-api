import { describe, expect, it } from 'bun:test';

import { createApp } from '../src/app';
import type { ConnectionRepository } from '../src/connections/repository';
import type { ProfileRepository } from '../src/profile/repository';
import type { SupportMessageRepository } from '../src/support/repository';

type CapturedCreatePortionLogInput = {
  ownerAuthUid: string;
  mealId: string;
  consumedGrams: number;
  snapshot: {
    calories: number;
    carbs: number;
    proteins: number;
    fats: number;
  };
  planId?: string | null;
  planType?: 'nutrition' | null;
  sourceKind?: 'assigned' | 'predefined' | 'self_managed' | null;
  ownerProfessionalUid?: string | null;
  connectionId?: string | null;
};

type CapturedListPortionLogsInput = {
  ownerAuthUid: string;
  fromIso: string;
};

function expectPresent<T>(value: T | null): T {
  expect(value).not.toBeNull();
  if (value === null) {
    throw new Error('Expected captured value to be present.');
  }
  return value;
}

function makeProfileRepository(): ProfileRepository {
  return {
    async upsertFromSession(input) {
      return {
        authUid: input.authUid,
        displayName: input.displayName,
        emailNormalized: input.emailNormalized,
        lockedRole: 'student',
        acceptedTermsVersion: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
    },
    async findByAuthUid() {
      return null;
    },
    async lockRole() {
      throw new Error('not implemented');
    },
    async setAcceptedTermsVersion() {
      throw new Error('not implemented');
    },
    async deleteByAuthUid() {},
  };
}

const supportMessageRepository: SupportMessageRepository = {
  async create() {
    throw new Error('not implemented');
  },
};

const connectionRepository: ConnectionRepository = {
  async listForAuthUid() {
    return [];
  },
  async getOrCreateActiveInviteCode() {
    throw new Error('not implemented');
  },
  async rotateInviteCode() {
    throw new Error('not implemented');
  },
  async submitInviteCode() {
    throw new Error('not implemented');
  },
  async confirmPendingConnection() {
    throw new Error('not implemented');
  },
  async endConnection() {
    throw new Error('not implemented');
  },
};

async function issueSession(app: ReturnType<typeof createApp>) {
  const sessionResponse = await app.handle(
    new Request('http://server.test/auth/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'Student@Example.test',
        displayName: 'Student User',
      }),
    })
  );
  return sessionResponse.json() as Promise<{ accessToken: string; profile: { authUid: string } }>;
}

describe('portion logs API', () => {
  it('creates a portion log for the authenticated student', async () => {
    let captured: CapturedCreatePortionLogInput | null = null;
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository,
      portionLogRepository: {
        async create(input: CapturedCreatePortionLogInput) {
          captured = input;
          return {
            id: 'portion-log-1',
            ownerAuthUid: input.ownerAuthUid,
            mealId: input.mealId,
            consumedGrams: input.consumedGrams,
            snapshot: input.snapshot,
            loggedAt: new Date(0).toISOString(),
            planId: input.planId ?? null,
            planType: input.planType ?? null,
            sourceKind: input.sourceKind ?? null,
            ownerProfessionalUid: input.ownerProfessionalUid ?? null,
            connectionId: input.connectionId ?? null,
          };
        },
        async listSince() {
          throw new Error('not implemented');
        },
      },
    });
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/nutrition/portion-logs', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          mealId: 'meal-1',
          consumedGrams: 150,
          snapshot: { calories: 240, carbs: 27.5, proteins: 17.5, fats: 7 },
          planId: 'nutrition-plan-1',
          planType: 'nutrition',
          sourceKind: 'assigned',
          ownerProfessionalUid: 'nutritionist-1',
          connectionId: 'connection-1',
        }),
      })
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      log: {
        id: 'portion-log-1',
        ownerUid: session.profile.authUid,
        mealId: 'meal-1',
        consumedGrams: 150,
        snapshot: { calories: 240, carbs: 27.5, proteins: 17.5, fats: 7 },
        loggedAt: new Date(0).toISOString(),
        planId: 'nutrition-plan-1',
        planType: 'nutrition',
        sourceKind: 'assigned',
        ownerProfessionalUid: 'nutritionist-1',
        connectionId: 'connection-1',
      },
    });
    expect(expectPresent<CapturedCreatePortionLogInput>(captured)).toEqual({
      ownerAuthUid: session.profile.authUid,
      mealId: 'meal-1',
      consumedGrams: 150,
      snapshot: { calories: 240, carbs: 27.5, proteins: 17.5, fats: 7 },
      planId: 'nutrition-plan-1',
      planType: 'nutrition',
      sourceKind: 'assigned',
      ownerProfessionalUid: 'nutritionist-1',
      connectionId: 'connection-1',
    });
  });

  it('lists portion logs for the authenticated student since a timestamp', async () => {
    let captured: CapturedListPortionLogsInput | null = null;
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository,
      portionLogRepository: {
        async create() {
          throw new Error('not implemented');
        },
        async listSince(input: CapturedListPortionLogsInput) {
          captured = input;
          return [
            {
              id: 'portion-log-1',
              ownerAuthUid: input.ownerAuthUid,
              mealId: 'meal-1',
              consumedGrams: 150,
              snapshot: { calories: 240, carbs: 27.5, proteins: 17.5, fats: 7 },
              loggedAt: '2026-06-28T10:00:00.000Z',
              planId: null,
              planType: null,
              sourceKind: null,
              ownerProfessionalUid: null,
              connectionId: null,
            },
          ];
        },
      },
    });
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/nutrition/portion-logs?from=2026-06-28T00:00:00.000Z', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      logs: [
        {
          id: 'portion-log-1',
          ownerUid: session.profile.authUid,
          mealId: 'meal-1',
          consumedGrams: 150,
          snapshot: { calories: 240, carbs: 27.5, proteins: 17.5, fats: 7 },
          loggedAt: '2026-06-28T10:00:00.000Z',
          planId: null,
          planType: null,
          sourceKind: null,
          ownerProfessionalUid: null,
          connectionId: null,
        },
      ],
    });
    expect(expectPresent<CapturedListPortionLogsInput>(captured)).toEqual({
      ownerAuthUid: session.profile.authUid,
      fromIso: '2026-06-28T00:00:00.000Z',
    });
  });
});
