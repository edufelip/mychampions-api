import { describe, expect, it } from 'bun:test';

import { createApp } from '../src/app';
import type { Connection, ConnectionRepository } from '../src/connections/repository';
import type { Profile, ProfileRepository } from '../src/profile/repository';
import type { SupportMessageRepository } from '../src/support/repository';

function authUidForEmail(email: string): string {
  return `local_${Buffer.from(email.trim().toLowerCase()).toString('base64url')}`;
}

function makeProfile(input: Partial<Profile> & Pick<Profile, 'authUid' | 'displayName'>): Profile {
  return {
    emailNormalized: `${input.authUid}@example.test`,
    lockedRole: null,
    acceptedTermsVersion: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...input,
  };
}

function makeProfileRepository(seed: Profile[] = []): ProfileRepository {
  const profiles = new Map(seed.map((profile) => [profile.authUid, profile]));

  return {
    async upsertFromSession(input) {
      const profile = makeProfile({
        authUid: input.authUid,
        displayName: input.displayName,
        emailNormalized: input.emailNormalized,
      });
      profiles.set(profile.authUid, profile);
      return profile;
    },
    async findByAuthUid(authUid) {
      return profiles.get(authUid) ?? null;
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

function makeConnection(input: Partial<Connection> & Pick<Connection, 'id' | 'professionalAuthUid' | 'studentAuthUid' | 'specialty' | 'status'>): Connection {
  return {
    canceledReason: null,
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
        email: 'Professional@Example.test',
        displayName: 'Professional User',
      }),
    })
  );
  return sessionResponse.json() as Promise<{ accessToken: string; profile: { authUid: string } }>;
}

describe('professional students API', () => {
  it('returns grouped roster rows for the authenticated professional', async () => {
    const professionalAuthUid = authUidForEmail('professional@example.test');
    const app = createApp({
      profileRepository: makeProfileRepository([
        makeProfile({ authUid: 'student-a', displayName: 'Ada Active' }),
        makeProfile({ authUid: 'student-b', displayName: 'Ben Both' }),
      ]),
      supportMessageRepository,
      connectionRepository: makeConnectionRepository([
        makeConnection({
          id: 'connection-a-nutrition',
          professionalAuthUid,
          studentAuthUid: 'student-a',
          specialty: 'nutritionist',
          status: 'active',
        }),
        makeConnection({
          id: 'connection-b-training',
          professionalAuthUid,
          studentAuthUid: 'student-b',
          specialty: 'fitness_coach',
          status: 'pending_confirmation',
        }),
        makeConnection({
          id: 'connection-b-nutrition',
          professionalAuthUid,
          studentAuthUid: 'student-b',
          specialty: 'nutritionist',
          status: 'active',
        }),
        makeConnection({
          id: 'connection-ended',
          professionalAuthUid,
          studentAuthUid: 'student-ended',
          specialty: 'nutritionist',
          status: 'ended',
        }),
      ]),
    });
    const session = await issueProfessionalSession(app);
    expect(session.profile.authUid).toBe(professionalAuthUid);

    const response = await app.handle(
      new Request('http://server.test/professional/students', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      students: [
        {
          studentAuthUid: 'student-a',
          displayName: 'Ada Active',
          specialty: 'nutritionist',
          assignmentStatus: 'active',
          nutritionStatus: 'active',
          trainingStatus: 'none',
        },
        {
          studentAuthUid: 'student-b',
          displayName: 'Ben Both',
          specialty: 'nutritionist',
          assignmentStatus: 'active',
          nutritionStatus: 'active',
          trainingStatus: 'pending',
        },
      ],
    });
  });

  it('returns one student assignment snapshot for the authenticated professional', async () => {
    const professionalAuthUid = authUidForEmail('professional@example.test');
    const app = createApp({
      profileRepository: makeProfileRepository([
        makeProfile({ authUid: 'student-b', displayName: 'Ben Both' }),
      ]),
      supportMessageRepository,
      connectionRepository: makeConnectionRepository([
        makeConnection({
          id: 'connection-b-training',
          professionalAuthUid,
          studentAuthUid: 'student-b',
          specialty: 'fitness_coach',
          status: 'pending_confirmation',
        }),
        makeConnection({
          id: 'connection-b-nutrition',
          professionalAuthUid,
          studentAuthUid: 'student-b',
          specialty: 'nutritionist',
          status: 'active',
        }),
        makeConnection({
          id: 'connection-other-student',
          professionalAuthUid,
          studentAuthUid: 'student-c',
          specialty: 'nutritionist',
          status: 'active',
        }),
      ]),
    });
    const session = await issueProfessionalSession(app);

    const response = await app.handle(
      new Request('http://server.test/professional/students/student-b/assignment-snapshot', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      snapshot: {
        studentAuthUid: 'student-b',
        displayName: 'Ben Both',
        nutritionStatus: 'active',
        trainingStatus: 'pending',
        activeConnectionIds: ['connection-b-nutrition'],
      },
    });
  });
});
