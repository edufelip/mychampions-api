import { describe, expect, it } from 'bun:test';

import { createApp } from '../src/app';
import type { ConnectionRepository } from '../src/connections/repository';
import type {
  CreatePlanChangeRequestInput,
  ListPlanChangeRequestsForProfessionalInput,
  ListPlanChangeRequestsForStudentInput,
  PlanChangeRequestRepository,
  ReviewPlanChangeRequestInput,
} from '../src/plans/plan-change-request-repository';
import type { ProfessionalSpecialtyRepository } from '../src/professional/specialty-repository';
import type { Profile, ProfileRepository } from '../src/profile/repository';
import type { SupportMessageRepository } from '../src/support/repository';

function expectPresent<T>(value: T | null): T {
  expect(value).not.toBeNull();
  if (value === null) {
    throw new Error('Expected captured value to be present.');
  }
  return value;
}

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

const specialtyRepository: ProfessionalSpecialtyRepository = {
  async listForProfessional() {
    return [];
  },
  async addOrReactivate() {
    throw new Error('not implemented');
  },
  async getBlockerCounts() {
    return { activeCount: 0, pendingCount: 0 };
  },
  async removeForProfessional() {
    throw new Error('not implemented');
  },
  async upsertCredential() {
    throw new Error('not implemented');
  },
};

async function issueSession(app: ReturnType<typeof createApp>, email: string, displayName: string) {
  const sessionResponse = await app.handle(
    new Request('http://server.test/auth/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, displayName }),
    })
  );
  return sessionResponse.json() as Promise<{ accessToken: string; profile: { authUid: string } }>;
}

function makePlanChangeRequestRepository(
  overrides: Partial<PlanChangeRequestRepository>
): PlanChangeRequestRepository {
  return {
    async create() {
      throw new Error('not implemented');
    },
    async listForStudent() {
      throw new Error('not implemented');
    },
    async listForProfessional() {
      throw new Error('not implemented');
    },
    async review() {
      throw new Error('not implemented');
    },
    ...overrides,
  };
}

function makeApp(planChangeRequestRepository: PlanChangeRequestRepository) {
  return createApp({
    profileRepository: makeProfileRepository([
      makeProfile({ authUid: 'student-1', displayName: 'Student One' }),
      makeProfile({ authUid: authUidForEmail('professional@example.test'), displayName: 'Professional One' }),
    ]),
    supportMessageRepository,
    connectionRepository,
    specialtyRepository,
    planChangeRequestRepository,
  });
}

describe('plan change request API', () => {
  it('lets the authenticated student submit a plan change request', async () => {
    const captured: { value: CreatePlanChangeRequestInput | null } = { value: null };
    const app = makeApp(makePlanChangeRequestRepository({
      async create(input) {
        captured.value = input;
        return {
          id: 'request-1',
          planId: input.planId,
          planType: input.planType,
          studentUid: input.studentAuthUid,
          requestText: input.requestText,
          status: 'pending',
          createdAt: '2026-06-29T10:00:00.000Z',
        };
      },
    }));
    const session = await issueSession(app, 'student@example.test', 'Student One');

    const response = await app.handle(
      new Request('http://server.test/plans/change-requests', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          planId: 'nutrition-plan-1',
          planType: 'nutrition',
          requestText: 'Please add one more protein option.',
        }),
      })
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      request: {
        id: 'request-1',
        planId: 'nutrition-plan-1',
        planType: 'nutrition',
        studentUid: session.profile.authUid,
        requestText: 'Please add one more protein option.',
        status: 'pending',
        createdAt: '2026-06-29T10:00:00.000Z',
      },
    });
    expect(expectPresent(captured.value)).toEqual({
      studentAuthUid: session.profile.authUid,
      planId: 'nutrition-plan-1',
      planType: 'nutrition',
      requestText: 'Please add one more protein option.',
    });
  });

  it('lets the authenticated professional list one student plan change requests', async () => {
    const captured: { value: ListPlanChangeRequestsForStudentInput | null } = { value: null };
    const app = makeApp(makePlanChangeRequestRepository({
      async listForStudent(input) {
        captured.value = input;
        return [
          {
            id: 'request-1',
            planId: 'training-plan-1',
            planType: 'training',
            studentUid: input.studentAuthUid,
            requestText: 'Please swap squats for leg press.',
            status: 'pending',
            createdAt: '2026-06-29T10:00:00.000Z',
          },
        ];
      },
    }));
    const session = await issueSession(app, 'professional@example.test', 'Professional One');

    const response = await app.handle(
      new Request('http://server.test/professional/students/student-1/plan-change-requests', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      requests: [
        {
          id: 'request-1',
          planId: 'training-plan-1',
          planType: 'training',
          studentUid: 'student-1',
          requestText: 'Please swap squats for leg press.',
          status: 'pending',
          createdAt: '2026-06-29T10:00:00.000Z',
        },
      ],
    });
    expect(expectPresent(captured.value)).toEqual({
      professionalAuthUid: session.profile.authUid,
      studentAuthUid: 'student-1',
    });
  });

  it('lets the authenticated professional list pending plan change requests across their students', async () => {
    const captured: { value: ListPlanChangeRequestsForProfessionalInput | null } = { value: null };
    const app = makeApp(makePlanChangeRequestRepository({
      async listForProfessional(input) {
        captured.value = input;
        return [
          {
            id: 'request-2',
            planId: 'nutrition-plan-2',
            planType: 'nutrition',
            studentUid: 'student-2',
            requestText: 'Please adjust dinner carbs.',
            status: 'pending',
            createdAt: '2026-06-29T11:00:00.000Z',
          },
          {
            id: 'request-1',
            planId: 'training-plan-1',
            planType: 'training',
            studentUid: 'student-1',
            requestText: 'Please swap squats for leg press.',
            status: 'pending',
            createdAt: '2026-06-29T10:00:00.000Z',
          },
        ];
      },
    }));
    const session = await issueSession(app, 'professional@example.test', 'Professional One');

    const response = await app.handle(
      new Request('http://server.test/professional/plan-change-requests?status=pending', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      requests: [
        {
          id: 'request-2',
          planId: 'nutrition-plan-2',
          planType: 'nutrition',
          studentUid: 'student-2',
          requestText: 'Please adjust dinner carbs.',
          status: 'pending',
          createdAt: '2026-06-29T11:00:00.000Z',
        },
        {
          id: 'request-1',
          planId: 'training-plan-1',
          planType: 'training',
          studentUid: 'student-1',
          requestText: 'Please swap squats for leg press.',
          status: 'pending',
          createdAt: '2026-06-29T10:00:00.000Z',
        },
      ],
    });
    expect(expectPresent(captured.value)).toEqual({
      professionalAuthUid: session.profile.authUid,
      status: 'pending',
    });
  });

  it('lets the authenticated professional review a plan change request', async () => {
    const captured: { value: ReviewPlanChangeRequestInput | null } = { value: null };
    const app = makeApp(makePlanChangeRequestRepository({
      async review(input) {
        captured.value = input;
        return { id: input.requestId, status: input.status };
      },
    }));
    const session = await issueSession(app, 'professional@example.test', 'Professional One');

    const response = await app.handle(
      new Request('http://server.test/plans/change-requests/request-1/review', {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ status: 'reviewed' }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: 'request-1', status: 'reviewed' });
    expect(expectPresent(captured.value)).toEqual({
      professionalAuthUid: session.profile.authUid,
      requestId: 'request-1',
      status: 'reviewed',
    });
  });

  it('rejects unauthenticated plan change request submissions', async () => {
    const app = makeApp(makePlanChangeRequestRepository({
      async create() {
        throw new Error('repository should not be called without auth');
      },
    }));

    const response = await app.handle(
      new Request('http://server.test/plans/change-requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          planId: 'nutrition-plan-1',
          planType: 'nutrition',
          requestText: 'Please add more breakfast options.',
        }),
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' },
    });
  });
});
