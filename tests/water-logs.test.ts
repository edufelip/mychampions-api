import { describe, expect, it } from 'bun:test';

import { createApp } from '../src/app';
import type { ConnectionRepository } from '../src/connections/repository';
import type { ProfileRepository } from '../src/profile/repository';
import type { SupportMessageRepository } from '../src/support/repository';

type CapturedLogWaterInput = {
  ownerAuthUid: string;
  amountMl: number;
  dateKey: string;
};

type CapturedListWaterLogsInput = {
  ownerAuthUid: string;
};

type CapturedWaterGoalContextInput = {
  ownerAuthUid: string;
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

describe('water logs API', () => {
  it('logs water intake for the authenticated student', async () => {
    let captured: CapturedLogWaterInput | null = null;
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository,
      waterLogRepository: {
        async logIntake(input: CapturedLogWaterInput) {
          captured = input;
          return {
            id: `${input.ownerAuthUid}_${input.dateKey}`,
            ownerAuthUid: input.ownerAuthUid,
            dateKey: input.dateKey,
            totalMl: 750,
            loggedAt: new Date(0).toISOString(),
          };
        },
        async listForOwner() {
          throw new Error('not implemented');
        },
        async getGoalContext() {
          throw new Error('not implemented');
        },
      },
    });
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/nutrition/water-logs', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          amountMl: 250,
          dateKey: '2026-06-28',
        }),
      })
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      log: {
        id: `${session.profile.authUid}_2026-06-28`,
        dateKey: '2026-06-28',
        totalMl: 750,
        loggedAt: new Date(0).toISOString(),
      },
    });
    expect(expectPresent<CapturedLogWaterInput>(captured)).toEqual({
      ownerAuthUid: session.profile.authUid,
      amountMl: 250,
      dateKey: '2026-06-28',
    });
  });

  it('lists water logs for the authenticated student', async () => {
    let captured: CapturedListWaterLogsInput | null = null;
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository,
      waterLogRepository: {
        async logIntake() {
          throw new Error('not implemented');
        },
        async listForOwner(input: CapturedListWaterLogsInput) {
          captured = input;
          return [
            {
              id: `${input.ownerAuthUid}_2026-06-28`,
              ownerAuthUid: input.ownerAuthUid,
              dateKey: '2026-06-28',
              totalMl: 750,
              loggedAt: '2026-06-28T10:00:00.000Z',
            },
          ];
        },
        async getGoalContext() {
          throw new Error('not implemented');
        },
      },
    });
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/nutrition/water-logs', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      logs: [
        {
          id: `${session.profile.authUid}_2026-06-28`,
          dateKey: '2026-06-28',
          totalMl: 750,
          loggedAt: '2026-06-28T10:00:00.000Z',
        },
      ],
    });
    expect(expectPresent<CapturedListWaterLogsInput>(captured)).toEqual({
      ownerAuthUid: session.profile.authUid,
    });
  });

  it('returns hydration goal context for the authenticated student', async () => {
    let captured: CapturedWaterGoalContextInput | null = null;
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository,
      waterLogRepository: {
        async logIntake() {
          throw new Error('not implemented');
        },
        async listForOwner() {
          throw new Error('not implemented');
        },
        async getGoalContext(input: CapturedWaterGoalContextInput) {
          captured = input;
          return {
            studentGoalMl: 2500,
            nutritionistGoalMl: 2800,
            hasActiveNutritionistAssignment: true,
          };
        },
      },
    });
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/nutrition/water-goal-context', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      studentGoalMl: 2500,
      nutritionistGoalMl: 2800,
      hasActiveNutritionistAssignment: true,
    });
    expect(expectPresent<CapturedWaterGoalContextInput>(captured)).toEqual({
      ownerAuthUid: session.profile.authUid,
    });
  });
});
