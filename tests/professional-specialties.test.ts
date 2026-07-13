import { describe, expect, it } from 'bun:test';

import { createApp } from '../src/app';
import type { ConnectionRepository } from '../src/connections/repository';
import type { ProfileRepository } from '../src/profile/repository';
import {
  ProfessionalSpecialtyRepositoryError,
  type ProfessionalCredential,
  type ProfessionalSpecialtyRepository,
  type SpecialtyRecord,
} from '../src/professional/specialty-repository';
import type { SupportMessageRepository } from '../src/support/repository';

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

function makeSpecialty(input: Partial<SpecialtyRecord> = {}): SpecialtyRecord {
  const professionalAuthUid = input.professionalAuthUid ?? 'professional-1';
  const specialty = input.specialty ?? 'nutritionist';
  return {
    id: input.id ?? `${professionalAuthUid}_${specialty}`,
    professionalAuthUid,
    specialty,
    isActive: input.isActive ?? true,
    credential: input.credential ?? null,
  };
}

function makeSpecialtyRepository(): ProfessionalSpecialtyRepository & {
  listedFor: string[];
  added: Array<{ professionalAuthUid: string; specialty: 'nutritionist' | 'fitness_coach' }>;
  blockerCounts: Array<{ professionalAuthUid: string; specialty: 'nutritionist' | 'fitness_coach' }>;
  removals: Array<{ professionalAuthUid: string; specialtyId: string }>;
  credentialUpserts: Array<{
    professionalAuthUid: string;
    specialtyId: string;
    registryId: string;
    authority: string;
    country: string;
  }>;
} {
  const listedFor: string[] = [];
  const added: Array<{ professionalAuthUid: string; specialty: 'nutritionist' | 'fitness_coach' }> = [];
  const blockerCounts: Array<{ professionalAuthUid: string; specialty: 'nutritionist' | 'fitness_coach' }> = [];
  const removals: Array<{ professionalAuthUid: string; specialtyId: string }> = [];
  const credentialUpserts: Array<{
    professionalAuthUid: string;
    specialtyId: string;
    registryId: string;
    authority: string;
    country: string;
  }> = [];

  return {
    listedFor,
    added,
    blockerCounts,
    removals,
    credentialUpserts,
    async listForProfessional(professionalAuthUid) {
      listedFor.push(professionalAuthUid);
      return [
        makeSpecialty({
          professionalAuthUid,
          credential: {
            id: `${professionalAuthUid}_nutritionist`,
            specialty: 'nutritionist',
            credentialType: 'professional_registry',
            registryId: 'CRN-123',
            authority: 'CRN',
            country: 'BR',
          },
        }),
      ];
    },
    async addOrReactivate(input) {
      added.push(input);
      return makeSpecialty({
        id: `${input.professionalAuthUid}_${input.specialty}`,
        professionalAuthUid: input.professionalAuthUid,
        specialty: input.specialty,
        credential: null,
      });
    },
    async getBlockerCounts(input) {
      blockerCounts.push(input);
      return { activeCount: 1, pendingCount: 2 };
    },
    async removeForProfessional(input) {
      removals.push(input);
    },
    async upsertCredential(input): Promise<ProfessionalCredential> {
      credentialUpserts.push(input);
      return {
        id: input.specialtyId,
        specialty: 'nutritionist',
        credentialType: 'professional_registry',
        registryId: input.registryId,
        authority: input.authority,
        country: input.country,
      };
    },
  };
}

async function issueProfessionalSession(app: ReturnType<typeof createApp>) {
  const response = await app.handle(
    new Request('http://server.test/auth/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'Professional@Example.test',
        displayName: 'Professional User',
      }),
    })
  );
  return response.json() as Promise<{ accessToken: string; profile: { authUid: string } }>;
}

describe('professional specialties API', () => {
  it('lists specialties for the authenticated professional', async () => {
    const specialtyRepository = makeSpecialtyRepository();
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository,
      specialtyRepository,
    });
    const session = await issueProfessionalSession(app);

    const response = await app.handle(
      new Request('http://server.test/professional/specialties', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      specialties: [
        {
          id: `${session.profile.authUid}_nutritionist`,
          specialty: 'nutritionist',
          isActive: true,
          credential: {
            id: `${session.profile.authUid}_nutritionist`,
            specialty: 'nutritionist',
            credentialType: 'professional_registry',
            registryId: 'CRN-123',
            authority: 'CRN',
            country: 'BR',
          },
        },
      ],
    });
    expect(specialtyRepository.listedFor).toEqual([session.profile.authUid]);
  });

  it('adds or reactivates a professional specialty for the authenticated professional', async () => {
    const specialtyRepository = makeSpecialtyRepository();
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository,
      specialtyRepository,
    });
    const session = await issueProfessionalSession(app);

    const response = await app.handle(
      new Request('http://server.test/professional/specialties', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ specialty: 'fitness_coach' }),
      })
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      specialty: {
        id: `${session.profile.authUid}_fitness_coach`,
        specialty: 'fitness_coach',
        isActive: true,
        credential: null,
      },
    });
    expect(specialtyRepository.added).toEqual([
      {
        professionalAuthUid: session.profile.authUid,
        specialty: 'fitness_coach',
      },
    ]);
  });

  it('returns blocker counts for the authenticated professional specialty', async () => {
    const specialtyRepository = makeSpecialtyRepository();
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository,
      specialtyRepository,
    });
    const session = await issueProfessionalSession(app);

    const response = await app.handle(
      new Request('http://server.test/professional/specialties/nutritionist/blockers', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ activeCount: 1, pendingCount: 2 });
    expect(specialtyRepository.blockerCounts).toEqual([
      {
        professionalAuthUid: session.profile.authUid,
        specialty: 'nutritionist',
      },
    ]);
  });

  it('removes a professional specialty for the authenticated owner', async () => {
    const specialtyRepository = makeSpecialtyRepository();
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository,
      specialtyRepository,
    });
    const session = await issueProfessionalSession(app);

    const response = await app.handle(
      new Request('http://server.test/professional/specialties/professional-1_nutritionist', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(204);
    expect(specialtyRepository.removals).toEqual([
      {
        professionalAuthUid: session.profile.authUid,
        specialtyId: 'professional-1_nutritionist',
      },
    ]);
  });

  it('maps specialty removal blockers to 409 responses', async () => {
    const specialtyRepository = makeSpecialtyRepository();
    specialtyRepository.removeForProfessional = async () => {
      throw new ProfessionalSpecialtyRepositoryError('removal_blocked', 'Specialty removal blocked by active/pending students.');
    };
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository,
      specialtyRepository,
    });
    const session = await issueProfessionalSession(app);

    const response = await app.handle(
      new Request('http://server.test/professional/specialties/professional-1_nutritionist', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'removal_blocked',
        message: 'Specialty removal blocked by active/pending students.',
      },
    });
  });

  it('upserts a professional credential for an owned specialty', async () => {
    const specialtyRepository = makeSpecialtyRepository();
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository,
      specialtyRepository,
    });
    const session = await issueProfessionalSession(app);

    const response = await app.handle(
      new Request('http://server.test/professional/specialties/professional-1_nutritionist/credential', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          registryId: 'CRN-456',
          authority: 'CRN',
          country: 'BR',
        }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      credential: {
        id: 'professional-1_nutritionist',
        specialty: 'nutritionist',
        credentialType: 'professional_registry',
        registryId: 'CRN-456',
        authority: 'CRN',
        country: 'BR',
      },
    });
    expect(specialtyRepository.credentialUpserts).toEqual([
      {
        professionalAuthUid: session.profile.authUid,
        specialtyId: 'professional-1_nutritionist',
        registryId: 'CRN-456',
        authority: 'CRN',
        country: 'BR',
      },
    ]);
  });
});
