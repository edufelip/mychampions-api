import { afterAll, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';

import { createDatabase } from '../src/db/client';
import { PostgresSupportMessageRepository } from '../src/support/postgres-repository';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_server_local';

const database = createDatabase(databaseUrl);
const repository = new PostgresSupportMessageRepository(database.db);

function supportInput(idempotencyKey: string) {
  return {
    authUid: 'uid-1',
    userEmail: 'user@example.test',
    userName: 'User One',
    userRole: 'student',
    subject: 'Login issue',
    body: 'I cannot sign in.',
    appVersion: '1.0.0',
    platform: 'ios' as const,
    idempotencyKey,
  };
}

async function supportMessageCount() {
  const [row] = await database.client<{ count: string }[]>`
    select count(*) as count from support_messages
  `;
  return Number(row.count);
}

beforeEach(async () => {
  await database.client`truncate table support_messages`;
});

afterAll(async () => {
  await database.close();
});

describe('PostgresSupportMessageRepository', () => {
  it('allows new submissions after expiry while replay remains exempt from a full quota', async () => {
    for (let index = 0; index < 3; index += 1)
      await repository.submit(supportInput(`expiry-${index}`));
    expect((await repository.submit(supportInput('expiry-0'))).kind).toBe('replayed');
    await database.client`update support_messages set created_at = clock_timestamp() - interval '16 minutes'`;
    expect((await repository.submit(supportInput('after-expiry'))).kind).toBe('created');
    expect(await supportMessageCount()).toBe(4);
  });

  it('uses the database clock even if an application worker clock is ahead', async () => {
    for (let index = 0; index < 3; index += 1)
      await repository.submit(supportInput(`clock-${index}`));
    try {
      setSystemTime(new Date(Date.now() + 60 * 60 * 1000));
      const result = await repository.submit(supportInput('clock-skew-overflow'));
      expect(result.kind).toBe('limited');
      expect(await supportMessageCount()).toBe(3);
    } finally {
      setSystemTime();
    }
  });

  it('waits until both active quota windows have capacity', async () => {
    for (let index = 0; index < 7; index += 1)
      await repository.create(supportInput(`older-${index}`));
    await database.client`update support_messages set created_at = now() - interval '1 hour'`;
    for (let index = 0; index < 3; index += 1)
      await repository.submit(supportInput(`recent-${index}`));
    const result = await repository.submit(supportInput('both-windows-full'));
    expect(result.kind).toBe('limited');
    if (result.kind === 'limited') expect(result.retryAfterSeconds).toBeGreaterThan(22 * 60 * 60);
    expect(await supportMessageCount()).toBe(10);
  });

  it('waits for enough historical rows to expire when legacy traffic exceeds a quota', async () => {
    for (let index = 0; index < 4; index += 1)
      await repository.create(supportInput(`legacy-${index}`));
    await database.client`update support_messages set created_at = now() - interval '1 minute'`;
    await database.client`update support_messages set created_at = now() - interval '14 minutes' where id = (select id from support_messages limit 1)`;
    const result = await repository.submit(supportInput('over-limit-history'));
    expect(result.kind).toBe('limited');
    if (result.kind === 'limited') expect(result.retryAfterSeconds).toBeGreaterThan(13 * 60);
    expect(await supportMessageCount()).toBe(4);
  });

  it('creates pending support messages with authenticated metadata', async () => {
    const message = await repository.create({
      authUid: 'uid-1',
      userEmail: 'user@example.test',
      userName: 'User One',
      userRole: 'student',
      subject: 'Login issue',
      body: 'I cannot sign in.',
      appVersion: '1.0.0',
      platform: 'ios',
    });

    expect(message.id).toBeString();
    expect(message).toMatchObject({
      authUid: 'uid-1',
      userEmail: 'user@example.test',
      userName: 'User One',
      userRole: 'student',
      subject: 'Login issue',
      body: 'I cannot sign in.',
      status: 'pending',
      appVersion: '1.0.0',
      platform: 'ios',
    });
    expect(new Date(message.createdAt).toString()).not.toBe('Invalid Date');
    expect(new Date(message.updatedAt).toString()).not.toBe('Invalid Date');
  });

  it('replays the original result without adding a row or consuming another quota slot', async () => {
    const input = supportInput('support-request-key-replay-0001');

    const first = await repository.submit(input);
    const replay = await repository.submit(input);

    expect(first.kind).toBe('created');
    expect(replay).toMatchObject({ kind: 'replayed' });
    if (first.kind === 'created' && replay.kind === 'replayed') {
      expect(replay.message.id).toBe(first.message.id);
    }
    expect(await supportMessageCount()).toBe(1);
  });

  it('atomically limits concurrent submissions to three accepted rows in fifteen minutes', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        repository.submit(supportInput(`support-request-key-concurrent-000${index}`)),
      ),
    );

    expect(results.filter((result) => result.kind === 'created')).toHaveLength(3);
    const limited = results.find((result) => result.kind === 'limited');
    expect(limited).toMatchObject({ kind: 'limited' });
    if (limited?.kind === 'limited') {
      expect(limited.retryAfterSeconds).toBeGreaterThan(0);
      expect(limited.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
    }
    expect(await supportMessageCount()).toBe(3);
  });

  it('enforces the daily limit after older messages no longer occupy the fifteen-minute window', async () => {
    for (let index = 0; index < 9; index += 1) {
      await repository.create({
        ...supportInput(`support-request-key-seed-000${index}`),
      });
    }
    await database.client`
      update support_messages
      set created_at = now() - interval '23 hours', updated_at = now() - interval '23 hours'
    `;

    expect((await repository.submit(supportInput('support-request-key-daily-0010'))).kind).toBe(
      'created',
    );
    const limited = await repository.submit(supportInput('support-request-key-daily-0011'));

    expect(limited).toMatchObject({ kind: 'limited' });
    if (limited.kind === 'limited') {
      expect(limited.retryAfterSeconds).toBeGreaterThan(0);
      expect(limited.retryAfterSeconds).toBeLessThanOrEqual(60 * 60);
    }
    expect(await supportMessageCount()).toBe(10);
  });
});
