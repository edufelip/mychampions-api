import { describe, expect, it } from 'bun:test';

import { createApp } from '../src/app';
import type {
  Connection,
  ConnectionRepository,
  InviteCode,
  ProfessionalInviteCodeInput,
  SubmitInviteCodeInput,
  EndConnectionInput,
} from '../src/connections/repository';
import type { ProfileRepository } from '../src/profile/repository';
import type { SupportMessageRepository } from '../src/support/repository';

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

function makeConnectionRepository(overrides: Partial<ConnectionRepository>): ConnectionRepository {
  return {
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
    ...overrides,
  };
}

describe('connections API', () => {
  it('ends a connection for the authenticated participant', async () => {
    let captured: EndConnectionInput | null = null;
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository: makeConnectionRepository({
        async endConnection(input: EndConnectionInput): Promise<Connection> {
          captured = input;
          return {
            id: input.connectionId,
            status: 'ended',
            canceledReason: null,
            specialty: 'nutritionist',
            professionalAuthUid: 'professional-1',
            studentAuthUid: input.authUid,
            sourceInviteCodeId: 'nutritionist',
            sourceInviteCodeValue: 'NUT123',
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(1).toISOString(),
            endedAt: new Date(1).toISOString(),
          };
        },
      }),
    });
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/connections/connection-1/end', {
        method: 'POST',
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      connectionId: 'connection-1',
      status: 'ended',
    });
    const capturedInput = captured as EndConnectionInput | null;
    expect(capturedInput).toEqual({
      connectionId: 'connection-1',
      authUid: session.profile.authUid,
    });
  });

  it('confirms a pending connection for the authenticated professional', async () => {
    let captured: { connectionId: string; professionalAuthUid: string } | null = null;
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository: makeConnectionRepository({
        async confirmPendingConnection(input: { connectionId: string; professionalAuthUid: string }): Promise<Connection> {
          captured = input;
          return {
            id: input.connectionId,
            status: 'active',
            canceledReason: null,
            specialty: 'nutritionist',
            professionalAuthUid: input.professionalAuthUid,
            studentAuthUid: 'student-1',
            sourceInviteCodeId: 'nutritionist',
            sourceInviteCodeValue: 'NUT123',
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(1).toISOString(),
            endedAt: null,
          };
        },
      }),
    });
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/connections/connection-1/confirm', {
        method: 'POST',
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      connectionId: 'connection-1',
      status: 'active',
    });
    const capturedInput = captured as { connectionId: string; professionalAuthUid: string } | null;
    expect(capturedInput).toEqual({
      connectionId: 'connection-1',
      professionalAuthUid: session.profile.authUid,
    });
  });

  it('maps professional cap subscription failures during pending confirmation', async () => {
    const subscriptionRequired = new Error('Professional subscription required.');
    subscriptionRequired.name = 'ProfessionalSubscriptionRequiredError';
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository: makeConnectionRepository({
        async confirmPendingConnection(): Promise<Connection> {
          throw subscriptionRequired;
        },
      }),
    });
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/connections/connection-1/confirm', {
        method: 'POST',
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual({ error: 'professional_subscription_required' });
  });

  it('gets or creates the active invite code for the authenticated professional', async () => {
    let captured: ProfessionalInviteCodeInput | null = null;
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository: makeConnectionRepository({
        async getOrCreateActiveInviteCode(input: ProfessionalInviteCodeInput): Promise<InviteCode> {
          captured = input;
          return {
            id: 'professional-1_nutritionist',
            professionalAuthUid: input.professionalAuthUid,
            specialty: 'nutritionist',
            codeValue: 'NUT123',
            status: 'active',
            rotatedAt: null,
            expiresAt: null,
            createdAt: new Date(0).toISOString(),
          };
        },
      }),
    });
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/professional/invite-codes/nutritionist', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      inviteCode: {
        id: 'professional-1_nutritionist',
        codeValue: 'NUT123',
        specialty: 'nutritionist',
        status: 'active',
        rotatedAt: null,
        expiresAt: null,
        createdAt: new Date(0).toISOString(),
      },
    });
    const capturedInput = captured as ProfessionalInviteCodeInput | null;
    expect(capturedInput).toEqual({
      professionalAuthUid: session.profile.authUid,
      specialty: 'nutritionist',
    });
  });

  it('rotates the active invite code for the authenticated professional', async () => {
    let captured: ProfessionalInviteCodeInput | null = null;
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository: makeConnectionRepository({
        async rotateInviteCode(input: ProfessionalInviteCodeInput): Promise<InviteCode> {
          captured = input;
          return {
            id: 'professional-1_fitness_coach',
            professionalAuthUid: input.professionalAuthUid,
            specialty: 'fitness_coach',
            codeValue: 'FIT999',
            status: 'active',
            rotatedAt: '2026-06-28T00:00:00.000Z',
            expiresAt: null,
            createdAt: new Date(0).toISOString(),
          };
        },
      }),
    });
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/professional/invite-codes/fitness_coach/rotate', {
        method: 'POST',
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      inviteCode: {
        id: 'professional-1_fitness_coach',
        codeValue: 'FIT999',
        specialty: 'fitness_coach',
        status: 'active',
        rotatedAt: '2026-06-28T00:00:00.000Z',
        expiresAt: null,
        createdAt: new Date(0).toISOString(),
      },
    });
    const capturedInput = captured as ProfessionalInviteCodeInput | null;
    expect(capturedInput).toEqual({
      professionalAuthUid: session.profile.authUid,
      specialty: 'fitness_coach',
    });
  });

  it('lists connections for the authenticated user', async () => {
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository: makeConnectionRepository({
        async listForAuthUid(authUid: string): Promise<Connection[]> {
          return [
            {
              id: 'connection-1',
              status: 'active',
              canceledReason: null,
              specialty: 'nutritionist',
              professionalAuthUid: 'professional-1',
              studentAuthUid: authUid,
              sourceInviteCodeId: 'nutritionist',
              sourceInviteCodeValue: 'NUT123',
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date(0).toISOString(),
              endedAt: null,
            },
          ];
        },
      }),
    });
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/connections', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      connections: [
        {
          id: 'connection-1',
          status: 'active',
          canceledReason: null,
          specialty: 'nutritionist',
          professionalAuthUid: 'professional-1',
        },
      ],
    });
  });

  it('creates a pending connection from an invite code for the authenticated student', async () => {
    let submitted: { code: string; studentAuthUid: string } | null = null;
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository: makeConnectionRepository({
        async submitInviteCode(input: SubmitInviteCodeInput): Promise<Connection> {
          submitted = input;
          return {
            id: 'connection-2',
            status: 'pending_confirmation',
            canceledReason: null,
            specialty: 'fitness_coach',
            professionalAuthUid: 'professional-2',
            studentAuthUid: input.studentAuthUid,
            sourceInviteCodeId: 'fitness_coach',
            sourceInviteCodeValue: input.code,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            endedAt: null,
          };
        },
      }),
    });
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/connections/invite-submissions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ code: ' fit123 ' }),
      })
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      connectionId: 'connection-2',
      status: 'pending_confirmation',
    });
    const submittedInput = submitted as { code: string; studentAuthUid: string } | null;
    expect(submittedInput).toEqual({
      code: 'FIT123',
      studentAuthUid: session.profile.authUid,
    });
  });
});
