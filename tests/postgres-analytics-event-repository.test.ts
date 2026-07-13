import { afterAll, beforeEach, describe, expect, it } from 'bun:test';

import { createDatabase } from '../src/db/client';
import { PostgresAnalyticsEventRepository } from '../src/analytics/postgres-repository';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_server_local';

const database = createDatabase(databaseUrl);
const repository = new PostgresAnalyticsEventRepository(database.db);

beforeEach(async () => {
  await database.client`truncate table analytics_events`;
});

afterAll(async () => {
  await database.close();
});

describe('PostgresAnalyticsEventRepository', () => {
  it('creates provider-neutral analytics events with JSON properties', async () => {
    const event = await repository.create({
      name: 'invite.submit.requested',
      properties: {
        surface: 'relationship_management',
        step: 'submit',
        result: 'success',
        channel: 'manual',
      },
    });

    expect(event.id).toBeString();
    expect(event).toMatchObject({
      name: 'invite.submit.requested',
      properties: {
        surface: 'relationship_management',
        step: 'submit',
        result: 'success',
        channel: 'manual',
      },
    });
    expect(new Date(event.createdAt).toString()).not.toBe('Invalid Date');
  });
});
