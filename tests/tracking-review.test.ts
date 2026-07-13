import { describe, expect, it } from 'bun:test';

import { createApp } from '../src/app';
import type { Connection, ConnectionRepository } from '../src/connections/repository';
import type { PortionLog } from '../src/nutrition/portion-log-repository';
import type { WaterLog } from '../src/nutrition/water-log-repository';
import type { ProfileRepository } from '../src/profile/repository';
import type { SupportMessageRepository } from '../src/support/repository';

type CapturedListWaterLogsInput = {
  ownerAuthUid: string;
};

type CapturedListPortionLogsInput = {
  ownerAuthUid: string;
  fromIso: string;
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
        authUid: `local_${Buffer.from(input.emailNormalized).toString('base64url')}`,
        displayName: input.displayName,
        emailNormalized: input.emailNormalized,
        lockedRole: 'professional',
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

function makeConnection(input: Partial<Connection> & Pick<Connection, 'professionalAuthUid' | 'studentAuthUid'>): Connection {
  return {
    id: 'connection-1',
    status: 'active',
    canceledReason: null,
    specialty: 'nutritionist',
    sourceInviteCodeId: null,
    sourceInviteCodeValue: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    endedAt: null,
    ...input,
  };
}

function makeConnectionRepository(connections: Connection[]): ConnectionRepository {
  return {
    async listForAuthUid(authUid) {
      return connections.filter(
        (connection) =>
          connection.professionalAuthUid === authUid || connection.studentAuthUid === authUid
      );
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
}

async function issueProfessionalSession(app: ReturnType<typeof createApp>) {
  const sessionResponse = await app.handle(
    new Request('http://server.test/auth/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'Nutritionist@Example.test',
        displayName: 'Nutritionist User',
      }),
    })
  );
  return sessionResponse.json() as Promise<{ accessToken: string; profile: { authUid: string } }>;
}

describe('professional student tracking review API', () => {
  it('returns student water and portion logs for an active nutritionist connection', async () => {
    let capturedWater: CapturedListWaterLogsInput | null = null;
    let capturedPortions: CapturedListPortionLogsInput | null = null;
    let capturedGoalContext: CapturedWaterGoalContextInput | null = null;
    const studentAuthUid = 'student-1';
    const professionalAuthUid = `local_${Buffer.from('nutritionist@example.test').toString('base64url')}`;
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository: makeConnectionRepository([
        makeConnection({ professionalAuthUid, studentAuthUid }),
      ]),
      waterLogRepository: {
        async logIntake() {
          throw new Error('not implemented');
        },
        async listForOwner(input: CapturedListWaterLogsInput): Promise<WaterLog[]> {
          capturedWater = input;
          return [
            {
              id: 'water-in-range',
              ownerAuthUid: studentAuthUid,
              dateKey: '2026-06-28',
              totalMl: 1500,
              loggedAt: '2026-06-28T12:00:00.000Z',
            },
            {
              id: 'water-old',
              ownerAuthUid: studentAuthUid,
              dateKey: '2026-06-20',
              totalMl: 2200,
              loggedAt: '2026-06-20T12:00:00.000Z',
            },
          ];
        },
        async getGoalContext(input: CapturedWaterGoalContextInput) {
          capturedGoalContext = input;
          return {
            studentGoalMl: 1800,
            nutritionistGoalMl: 2000,
            hasActiveNutritionistAssignment: true,
          };
        },
      },
      portionLogRepository: {
        async create() {
          throw new Error('not implemented');
        },
        async listSince(input: CapturedListPortionLogsInput): Promise<PortionLog[]> {
          capturedPortions = input;
          return [
            {
              id: 'portion-today',
              ownerAuthUid: studentAuthUid,
              mealId: 'meal-1',
              consumedGrams: 150,
              snapshot: { calories: 240, carbs: 27.5, proteins: 17.5, fats: 7 },
              loggedAt: '2026-06-28T08:00:00.000Z',
              planId: 'plan-1',
              planType: 'nutrition',
              sourceKind: 'assigned',
              ownerProfessionalUid: 'nutritionist-1',
              connectionId: 'connection-1',
            },
          ];
        },
      },
    });
    const session = await issueProfessionalSession(app);
    expect(session.profile.authUid).toBe(professionalAuthUid);

    const response = await app.handle(
      new Request(
        'http://server.test/professional/students/student-1/tracking-review?todayKey=2026-06-28',
        { headers: { authorization: `Bearer ${session.accessToken}` } }
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      waterLogs: [
        {
          id: 'water-in-range',
          dateKey: '2026-06-28',
          totalMl: 1500,
          loggedAt: '2026-06-28T12:00:00.000Z',
        },
      ],
      waterGoalMl: 2000,
      portionLogs: [
        {
          id: 'portion-today',
          ownerUid: studentAuthUid,
          mealId: 'meal-1',
          consumedGrams: 150,
          snapshot: { calories: 240, carbs: 27.5, proteins: 17.5, fats: 7 },
          loggedAt: '2026-06-28T08:00:00.000Z',
          planId: 'plan-1',
          planType: 'nutrition',
          sourceKind: 'assigned',
          ownerProfessionalUid: 'nutritionist-1',
          connectionId: 'connection-1',
        },
      ],
    });
    expect(expectPresent<CapturedListWaterLogsInput>(capturedWater)).toEqual({
      ownerAuthUid: studentAuthUid,
    });
    expect(expectPresent<CapturedListPortionLogsInput>(capturedPortions)).toEqual({
      ownerAuthUid: studentAuthUid,
      fromIso: '2026-06-22T00:00:00.000Z',
    });
    expect(expectPresent<CapturedWaterGoalContextInput>(capturedGoalContext)).toEqual({
      ownerAuthUid: studentAuthUid,
    });
  });

  it('forbids tracking review reads without an active nutritionist connection', async () => {
    let waterCalled = false;
    let portionsCalled = false;
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository: makeConnectionRepository([]),
      waterLogRepository: {
        async logIntake() {
          throw new Error('not implemented');
        },
        async listForOwner() {
          waterCalled = true;
          return [];
        },
        async getGoalContext() {
          throw new Error('not implemented');
        },
      },
      portionLogRepository: {
        async create() {
          throw new Error('not implemented');
        },
        async listSince() {
          portionsCalled = true;
          return [];
        },
      },
    });
    const session = await issueProfessionalSession(app);

    const response = await app.handle(
      new Request('http://server.test/professional/students/student-1/tracking-review?todayKey=2026-06-28', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'tracking_review_forbidden',
        message: 'Active nutritionist connection is required to read student tracking review.',
      },
    });
    expect(waterCalled).toBe(false);
    expect(portionsCalled).toBe(false);
  });
});
