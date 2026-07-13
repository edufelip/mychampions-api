import { afterAll, beforeEach, describe, expect, it } from 'bun:test';

import { createDatabase } from '../src/db/client';
import { PostgresSupportMessageRepository } from '../src/support/postgres-repository';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_server_local';

const database = createDatabase(databaseUrl);
const repository = new PostgresSupportMessageRepository(database.db);

beforeEach(async () => {
  await database.client`truncate table support_messages`;
});

afterAll(async () => {
  await database.close();
});

describe('PostgresSupportMessageRepository', () => {
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
});
