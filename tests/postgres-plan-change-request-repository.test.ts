import { afterAll, beforeEach, describe, expect, it } from 'bun:test';

import { createDatabase } from '../src/db/client';
import { PostgresPlanChangeRequestRepository } from '../src/plans/postgres-plan-change-request-repository';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_server_local';

const database = createDatabase(databaseUrl);
const repository = new PostgresPlanChangeRequestRepository(database.db);

beforeEach(async () => {
  await database.client`truncate table plan_change_requests, nutrition_plans, training_plans`;
});

afterAll(async () => {
  await database.close();
});

describe('PostgresPlanChangeRequestRepository', () => {
  it('lists pending requests across plans owned by the professional newest first', async () => {
    await database.client`
      insert into nutrition_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        created_at,
        updated_at
      ) values
        (
          'nutrition-owned',
          'student-1',
          'professional-1',
          'assigned',
          false,
          false,
          'Owned Nutrition',
          '2026-06-28T10:00:00.000Z',
          '2026-06-28T10:00:00.000Z'
        ),
        (
          'nutrition-other',
          'student-2',
          'professional-2',
          'assigned',
          false,
          false,
          'Other Nutrition',
          '2026-06-28T10:00:00.000Z',
          '2026-06-28T10:00:00.000Z'
        )
    `;
    await database.client`
      insert into training_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        created_at,
        updated_at
      ) values (
        'training-owned',
        'student-3',
        'professional-1',
        'assigned',
        false,
        false,
        'Owned Training',
        '2026-06-28T10:00:00.000Z',
        '2026-06-28T10:00:00.000Z'
      )
    `;
    await database.client`
      insert into plan_change_requests (
        id,
        plan_id,
        plan_type,
        student_auth_uid,
        request_text,
        status,
        created_at,
        updated_at
      ) values
        (
          'request-old-owned',
          'nutrition-owned',
          'nutrition',
          'student-1',
          'Please adjust dinner.',
          'pending',
          '2026-06-29T10:00:00.000Z',
          '2026-06-29T10:00:00.000Z'
        ),
        (
          'request-new-owned',
          'training-owned',
          'training',
          'student-3',
          'Please swap squats.',
          'pending',
          '2026-06-29T11:00:00.000Z',
          '2026-06-29T11:00:00.000Z'
        ),
        (
          'request-reviewed-owned',
          'nutrition-owned',
          'nutrition',
          'student-1',
          'Already reviewed.',
          'reviewed',
          '2026-06-29T12:00:00.000Z',
          '2026-06-29T12:00:00.000Z'
        ),
        (
          'request-other-professional',
          'nutrition-other',
          'nutrition',
          'student-2',
          'Should not leak.',
          'pending',
          '2026-06-29T13:00:00.000Z',
          '2026-06-29T13:00:00.000Z'
        )
    `;

    const requests = await repository.listForProfessional({
      professionalAuthUid: 'professional-1',
      status: 'pending',
    });

    expect(requests.map((request) => request.id)).toEqual(['request-new-owned', 'request-old-owned']);
    expect(requests.map((request) => request.studentUid)).toEqual(['student-3', 'student-1']);
  });
});
