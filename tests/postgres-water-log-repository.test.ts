import { afterAll, beforeEach, describe, expect, it } from 'bun:test';

import { createDatabase } from '../src/db/client';
import { PostgresWaterLogRepository } from '../src/nutrition/postgres-water-log-repository';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_server_local';

const database = createDatabase(databaseUrl);
const repository = new PostgresWaterLogRepository(database.db);

beforeEach(async () => {
  await database.client`truncate table connections, nutrition_plans, water_logs`;
});

afterAll(async () => {
  await database.close();
});

describe('PostgresWaterLogRepository', () => {
  it('creates and increments owner water logs for a date', async () => {
    const first = await repository.logIntake({
      ownerAuthUid: 'student-1',
      amountMl: 250,
      dateKey: '2026-06-28',
    });
    const second = await repository.logIntake({
      ownerAuthUid: 'student-1',
      amountMl: 500,
      dateKey: '2026-06-28',
    });

    expect(first).toMatchObject({
      id: 'student-1_2026-06-28',
      ownerAuthUid: 'student-1',
      dateKey: '2026-06-28',
      totalMl: 250,
    });
    expect(second).toMatchObject({
      id: 'student-1_2026-06-28',
      ownerAuthUid: 'student-1',
      dateKey: '2026-06-28',
      totalMl: 750,
    });

    const rows = await database.client`
      select owner_auth_uid, date_key, total_ml
      from water_logs
      where id = 'student-1_2026-06-28'
    `;
    expect(rows[0]).toEqual({
      owner_auth_uid: 'student-1',
      date_key: '2026-06-28',
      total_ml: 750,
    });
  });

  it('lists only the owner water logs newest date first', async () => {
    await database.client`
      insert into water_logs (id, owner_auth_uid, date_key, total_ml, logged_at)
      values
        ('student-1_2026-06-27', 'student-1', '2026-06-27', 500, '2026-06-27T08:00:00.000Z'),
        ('student-1_2026-06-28', 'student-1', '2026-06-28', 750, '2026-06-28T08:00:00.000Z'),
        ('student-2_2026-06-28', 'student-2', '2026-06-28', 999, '2026-06-28T09:00:00.000Z')
    `;

    const logs = await repository.listForOwner({ ownerAuthUid: 'student-1' });

    expect(logs).toEqual([
      expect.objectContaining({
        id: 'student-1_2026-06-28',
        ownerAuthUid: 'student-1',
        dateKey: '2026-06-28',
        totalMl: 750,
      }),
      expect.objectContaining({
        id: 'student-1_2026-06-27',
        ownerAuthUid: 'student-1',
        dateKey: '2026-06-27',
        totalMl: 500,
      }),
    ]);
  });

  it('resolves hydration goal context from active nutrition assignments and local nutrition plans', async () => {
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
        ('nutrition-active', 'active', 'nutritionist', 'nutritionist-1', 'student-1', now(), now()),
        ('nutrition-ended', 'ended', 'nutritionist', 'nutritionist-2', 'student-1', now(), now())
    `;
    await database.client`
      insert into nutrition_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        hydration_goal_ml,
        created_at,
        updated_at
      ) values
        ('self-current', 'student-1', null, 'self_managed', false, 2400, now(), '2026-06-28T08:00:00.000Z'),
        ('assigned-active', 'student-1', 'nutritionist-1', 'assigned', false, 2800, now(), '2026-06-28T09:00:00.000Z'),
        ('assigned-ended', 'student-1', 'nutritionist-2', 'assigned', false, 3200, now(), '2026-06-28T10:00:00.000Z'),
        ('archived-active', 'student-1', 'nutritionist-1', 'assigned', true, 3500, now(), '2026-06-28T11:00:00.000Z'),
        ('other-student', 'student-2', null, 'self_managed', false, 9999, now(), '2026-06-28T12:00:00.000Z')
    `;

    const context = await repository.getGoalContext({ ownerAuthUid: 'student-1' });

    expect(context).toEqual({
      studentGoalMl: 2400,
      nutritionistGoalMl: 2800,
      hasActiveNutritionistAssignment: true,
    });
  });
});
