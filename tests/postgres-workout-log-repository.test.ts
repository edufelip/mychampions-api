import { afterAll, beforeEach, describe, expect, it } from 'bun:test';

import { createDatabase } from '../src/db/client';
import { PostgresWorkoutLogRepository } from '../src/training/postgres-workout-log-repository';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_server_local';

const database = createDatabase(databaseUrl);
const repository = new PostgresWorkoutLogRepository(database.db);

beforeEach(async () => {
  await database.client`truncate table workout_logs`;
});

afterAll(async () => {
  await database.close();
});

describe('PostgresWorkoutLogRepository', () => {
  it('creates workout logs for the authenticated owner', async () => {
    const log = await repository.create({
      ownerAuthUid: 'student-1',
      sessionId: 'session-1',
      sessionName: 'Chest Day',
    });

    expect(log).toMatchObject({
      ownerAuthUid: 'student-1',
      sessionId: 'session-1',
      sessionName: 'Chest Day',
    });
    expect(log.id).toEqual(expect.any(String));
    expect(log.createdAt).toEqual(expect.any(String));

    const rows = await database.client`
      select owner_auth_uid, session_id, session_name
      from workout_logs
      where id = ${log.id}
    `;
    expect(rows[0]).toEqual({
      owner_auth_uid: 'student-1',
      session_id: 'session-1',
      session_name: 'Chest Day',
    });
  });

  it('lists only the owner workout logs created since the requested timestamp', async () => {
    await database.client`
      insert into workout_logs (id, owner_auth_uid, session_id, session_name, created_at)
      values
        ('old-owner-log', 'student-1', 'old-session', 'Old Session', '2026-06-27T23:59:00.000Z'),
        ('today-owner-log', 'student-1', 'today-session', 'Today Session', '2026-06-28T08:00:00.000Z'),
        ('other-owner-log', 'student-2', 'other-session', 'Other Session', '2026-06-28T09:00:00.000Z')
    `;

    const logs = await repository.listSince({
      ownerAuthUid: 'student-1',
      fromIso: '2026-06-28T00:00:00.000Z',
    });

    expect(logs).toEqual([
      expect.objectContaining({
        id: 'today-owner-log',
        ownerAuthUid: 'student-1',
        sessionId: 'today-session',
        sessionName: 'Today Session',
      }),
    ]);
  });
});
