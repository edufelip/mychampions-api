import { afterAll, beforeEach, describe, expect, it } from 'bun:test';

import { createDatabase } from '../src/db/client';
import { PostgresProfessionalSpecialtyRepository } from '../src/professional/postgres-specialty-repository';
import { ProfessionalSpecialtyRepositoryError } from '../src/professional/specialty-repository';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_server_local';

const database = createDatabase(databaseUrl);
const repository = new PostgresProfessionalSpecialtyRepository(database.db);

beforeEach(async () => {
  await database.client`truncate table connections, invite_codes, professional_credentials, professional_specialties`;
});

afterAll(async () => {
  await database.close();
});

describe('PostgresProfessionalSpecialtyRepository', () => {
  it('lists professional specialties with credentials', async () => {
    await database.client`
      insert into professional_specialties (
        id,
        professional_auth_uid,
        specialty,
        is_active,
        created_at,
        updated_at
      ) values
        (
          'professional-1_nutritionist',
          'professional-1',
          'nutritionist',
          true,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        ),
        (
          'professional-1_fitness_coach',
          'professional-1',
          'fitness_coach',
          false,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        ),
        (
          'professional-2_nutritionist',
          'professional-2',
          'nutritionist',
          true,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
    `;
    await database.client`
      insert into professional_credentials (
        id,
        specialty_id,
        professional_auth_uid,
        specialty,
        credential_type,
        registry_id,
        authority,
        country,
        created_at,
        updated_at
      ) values (
        'professional-1_nutritionist',
        'professional-1_nutritionist',
        'professional-1',
        'nutritionist',
        'professional_registry',
        'CRN-123',
        'CRN',
        'BR',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      )
    `;

    const rows = await repository.listForProfessional('professional-1');

    expect(rows).toEqual([
      {
        id: 'professional-1_fitness_coach',
        professionalAuthUid: 'professional-1',
        specialty: 'fitness_coach',
        isActive: false,
        credential: null,
      },
      {
        id: 'professional-1_nutritionist',
        professionalAuthUid: 'professional-1',
        specialty: 'nutritionist',
        isActive: true,
        credential: {
          id: 'professional-1_nutritionist',
          specialty: 'nutritionist',
          credentialType: 'professional_registry',
          registryId: 'CRN-123',
          authority: 'CRN',
          country: 'BR',
        },
      },
    ]);
  });

  it('creates or reactivates a professional specialty', async () => {
    const created = await repository.addOrReactivate({
      professionalAuthUid: 'professional-1',
      specialty: 'nutritionist',
    });

    expect(created).toMatchObject({
      id: 'professional-1_nutritionist',
      professionalAuthUid: 'professional-1',
      specialty: 'nutritionist',
      isActive: true,
      credential: null,
    });

    await database.client`
      update professional_specialties
      set is_active = false
      where id = 'professional-1_nutritionist'
    `;

    const reactivated = await repository.addOrReactivate({
      professionalAuthUid: 'professional-1',
      specialty: 'nutritionist',
    });

    expect(reactivated).toMatchObject({
      id: 'professional-1_nutritionist',
      professionalAuthUid: 'professional-1',
      specialty: 'nutritionist',
      isActive: true,
      credential: null,
    });
  });

  it('counts active and pending blockers for one professional specialty', async () => {
    await database.client`
      insert into connections (
        id,
        status,
        specialty,
        professional_auth_uid,
        student_auth_uid,
        created_at,
        updated_at
      ) values
        ('active-1', 'active', 'nutritionist', 'professional-1', 'student-1', now(), now()),
        ('pending-1', 'pending_confirmation', 'nutritionist', 'professional-1', 'student-2', now(), now()),
        ('ended-1', 'ended', 'nutritionist', 'professional-1', 'student-3', now(), now()),
        ('other-specialty', 'active', 'fitness_coach', 'professional-1', 'student-4', now(), now()),
        ('other-owner', 'active', 'nutritionist', 'professional-2', 'student-5', now(), now())
    `;

    const counts = await repository.getBlockerCounts({
      professionalAuthUid: 'professional-1',
      specialty: 'nutritionist',
    });

    expect(counts).toEqual({ activeCount: 1, pendingCount: 1 });
  });

  it('deactivates a removable specialty and revokes its active invite code', async () => {
    await database.client`
      insert into professional_specialties (
        id,
        professional_auth_uid,
        specialty,
        is_active,
        created_at,
        updated_at
      ) values
        ('professional-1_nutritionist', 'professional-1', 'nutritionist', true, now(), now()),
        ('professional-1_fitness_coach', 'professional-1', 'fitness_coach', true, now(), now())
    `;
    await database.client`
      insert into invite_codes (
        id,
        professional_auth_uid,
        specialty,
        code_value,
        status,
        created_at,
        updated_at
      ) values
        ('professional-1_nutritionist', 'professional-1', 'nutritionist', 'NUT123', 'active', now(), now()),
        ('professional-1_fitness_coach', 'professional-1', 'fitness_coach', 'FIT123', 'active', now(), now())
    `;

    await repository.removeForProfessional({
      professionalAuthUid: 'professional-1',
      specialtyId: 'professional-1_nutritionist',
    });

    const [specialty] = await database.client`
      select is_active from professional_specialties where id = 'professional-1_nutritionist'
    `;
    const [removedInvite] = await database.client`
      select status from invite_codes where id = 'professional-1_nutritionist'
    `;
    const [keptInvite] = await database.client`
      select status from invite_codes where id = 'professional-1_fitness_coach'
    `;

    expect(specialty.is_active).toBe(false);
    expect(removedInvite.status).toBe('revoked');
    expect(keptInvite.status).toBe('active');
  });

  it('rejects removal of the last active specialty', async () => {
    await database.client`
      insert into professional_specialties (
        id,
        professional_auth_uid,
        specialty,
        is_active,
        created_at,
        updated_at
      ) values (
        'professional-1_nutritionist',
        'professional-1',
        'nutritionist',
        true,
        now(),
        now()
      )
    `;

    await expect(repository.removeForProfessional({
      professionalAuthUid: 'professional-1',
      specialtyId: 'professional-1_nutritionist',
    })).rejects.toMatchObject({
      code: 'last_specialty',
    } satisfies Partial<ProfessionalSpecialtyRepositoryError>);
  });

  it('rejects removal when active or pending connections exist', async () => {
    await database.client`
      insert into professional_specialties (
        id,
        professional_auth_uid,
        specialty,
        is_active,
        created_at,
        updated_at
      ) values
        ('professional-1_nutritionist', 'professional-1', 'nutritionist', true, now(), now()),
        ('professional-1_fitness_coach', 'professional-1', 'fitness_coach', true, now(), now())
    `;
    await database.client`
      insert into connections (
        id,
        status,
        specialty,
        professional_auth_uid,
        student_auth_uid,
        created_at,
        updated_at
      ) values (
        'pending-1',
        'pending_confirmation',
        'nutritionist',
        'professional-1',
        'student-1',
        now(),
        now()
      )
    `;

    await expect(repository.removeForProfessional({
      professionalAuthUid: 'professional-1',
      specialtyId: 'professional-1_nutritionist',
    })).rejects.toMatchObject({
      code: 'removal_blocked',
    } satisfies Partial<ProfessionalSpecialtyRepositoryError>);
  });

  it('upserts a credential for an owned specialty', async () => {
    await database.client`
      insert into professional_specialties (
        id,
        professional_auth_uid,
        specialty,
        is_active,
        created_at,
        updated_at
      ) values (
        'professional-1_nutritionist',
        'professional-1',
        'nutritionist',
        true,
        now(),
        now()
      )
    `;

    const created = await repository.upsertCredential({
      professionalAuthUid: 'professional-1',
      specialtyId: 'professional-1_nutritionist',
      registryId: 'CRN-123',
      authority: 'CRN',
      country: 'BR',
    });
    const updated = await repository.upsertCredential({
      professionalAuthUid: 'professional-1',
      specialtyId: 'professional-1_nutritionist',
      registryId: 'CRN-456',
      authority: 'CRN',
      country: 'BR',
    });

    expect(created).toMatchObject({
      id: 'professional-1_nutritionist',
      specialty: 'nutritionist',
      registryId: 'CRN-123',
    });
    expect(updated).toMatchObject({
      id: 'professional-1_nutritionist',
      specialty: 'nutritionist',
      registryId: 'CRN-456',
    });

    const [row] = await database.client`
      select registry_id from professional_credentials where id = 'professional-1_nutritionist'
    `;
    expect(row.registry_id).toBe('CRN-456');
  });
});
