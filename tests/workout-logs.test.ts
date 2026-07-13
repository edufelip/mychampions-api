import { describe, expect, it } from 'bun:test';

import { createApp } from '../src/app';
import type { ConnectionRepository } from '../src/connections/repository';
import type { ProfileRepository } from '../src/profile/repository';
import type { SupportMessageRepository } from '../src/support/repository';

type CapturedCreateWorkoutLogInput = {
  ownerAuthUid: string;
  sessionId: string;
  sessionName: string;
};

type CapturedListWorkoutLogsInput = {
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

describe('workout logs API', () => {
  it('creates a workout log for the authenticated student', async () => {
    let captured: CapturedCreateWorkoutLogInput | null = null;
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository,
      workoutLogRepository: {
        async create(input: CapturedCreateWorkoutLogInput) {
          captured = input;
          return {
            id: 'workout-log-1',
            ownerAuthUid: input.ownerAuthUid,
            sessionId: input.sessionId,
            sessionName: input.sessionName,
            createdAt: new Date(0).toISOString(),
          };
        },
        async listSince() {
          throw new Error('not implemented');
        },
      },
    });
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/training/workout-logs', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: 'session-1',
          sessionName: 'Chest Day',
        }),
      })
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      log: {
        id: 'workout-log-1',
        ownerUid: session.profile.authUid,
        sessionId: 'session-1',
        sessionName: 'Chest Day',
        createdAt: new Date(0).toISOString(),
      },
    });
    const capturedCreateInput = expectPresent<CapturedCreateWorkoutLogInput>(captured);
    expect(capturedCreateInput).toEqual({
      ownerAuthUid: session.profile.authUid,
      sessionId: 'session-1',
      sessionName: 'Chest Day',
    });
  });

  it('lists workout logs for the authenticated student since a client-provided timestamp', async () => {
    let captured: CapturedListWorkoutLogsInput | null = null;
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository,
      workoutLogRepository: {
        async create() {
          throw new Error('not implemented');
        },
        async listSince(input: CapturedListWorkoutLogsInput) {
          captured = input;
          return [
            {
              id: 'workout-log-1',
              ownerAuthUid: input.ownerAuthUid,
              sessionId: 'session-1',
              sessionName: 'Chest Day',
              createdAt: '2026-06-28T10:00:00.000Z',
            },
          ];
        },
      },
    });
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/training/workout-logs?from=2026-06-28T00%3A00%3A00.000Z', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      logs: [
        {
          id: 'workout-log-1',
          ownerUid: session.profile.authUid,
          sessionId: 'session-1',
          sessionName: 'Chest Day',
          createdAt: '2026-06-28T10:00:00.000Z',
        },
      ],
    });
    const capturedListInput = expectPresent<CapturedListWorkoutLogsInput>(captured);
    expect(capturedListInput).toEqual({
      ownerAuthUid: session.profile.authUid,
      fromIso: '2026-06-28T00:00:00.000Z',
    });
  });
});
