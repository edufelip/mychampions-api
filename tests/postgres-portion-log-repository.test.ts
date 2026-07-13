import { afterAll, beforeEach, describe, expect, it } from 'bun:test';

import { createDatabase } from '../src/db/client';
import { PostgresPortionLogRepository } from '../src/nutrition/postgres-portion-log-repository';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_server_local';

const database = createDatabase(databaseUrl);
const repository = new PostgresPortionLogRepository(database.db);

beforeEach(async () => {
  await database.client`truncate table portion_logs`;
});

afterAll(async () => {
  await database.close();
});

describe('PostgresPortionLogRepository', () => {
  it('creates portion logs for the authenticated owner with optional provenance', async () => {
    const log = await repository.create({
      ownerAuthUid: 'student-1',
      mealId: 'meal-1',
      consumedGrams: 150,
      snapshot: { calories: 240, carbs: 27.5, proteins: 17.5, fats: 7 },
      planId: 'nutrition-plan-1',
      planType: 'nutrition',
      sourceKind: 'assigned',
      ownerProfessionalUid: 'nutritionist-1',
      connectionId: 'connection-1',
    });

    expect(log).toMatchObject({
      ownerAuthUid: 'student-1',
      mealId: 'meal-1',
      consumedGrams: 150,
      snapshot: { calories: 240, carbs: 27.5, proteins: 17.5, fats: 7 },
      planId: 'nutrition-plan-1',
      planType: 'nutrition',
      sourceKind: 'assigned',
      ownerProfessionalUid: 'nutritionist-1',
      connectionId: 'connection-1',
    });
    expect(log.id).toEqual(expect.any(String));
    expect(log.loggedAt).toEqual(expect.any(String));

    const rows = await database.client`
      select owner_auth_uid, meal_id, consumed_grams, snapshot_calories, plan_id, source_kind
      from portion_logs
      where id = ${log.id}
    `;
    expect(rows[0]).toEqual({
      owner_auth_uid: 'student-1',
      meal_id: 'meal-1',
      consumed_grams: '150',
      snapshot_calories: '240',
      plan_id: 'nutrition-plan-1',
      source_kind: 'assigned',
    });
  });

  it('lists only the owner portion logs created since the requested timestamp', async () => {
    await database.client`
      insert into portion_logs (
        id, owner_auth_uid, meal_id, consumed_grams, snapshot_calories,
        snapshot_carbs, snapshot_proteins, snapshot_fats, logged_at
      )
      values
        ('old-owner-log', 'student-1', 'old-meal', 100, 100, 10, 5, 2, '2026-06-27T23:59:00.000Z'),
        ('today-owner-log', 'student-1', 'today-meal', 150, 240, 27.5, 17.5, 7, '2026-06-28T08:00:00.000Z'),
        ('other-owner-log', 'student-2', 'other-meal', 200, 300, 30, 20, 8, '2026-06-28T09:00:00.000Z')
    `;

    const logs = await repository.listSince({
      ownerAuthUid: 'student-1',
      fromIso: '2026-06-28T00:00:00.000Z',
    });

    expect(logs).toEqual([
      expect.objectContaining({
        id: 'today-owner-log',
        ownerAuthUid: 'student-1',
        mealId: 'today-meal',
        consumedGrams: 150,
        snapshot: { calories: 240, carbs: 27.5, proteins: 17.5, fats: 7 },
      }),
    ]);
  });
});
