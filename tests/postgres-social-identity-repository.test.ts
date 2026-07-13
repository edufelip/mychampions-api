import { afterAll, beforeEach, describe, expect, it } from 'bun:test';

import { createDatabase } from '../src/db/client';
import { PostgresSocialIdentityRepository } from '../src/auth/postgres-social-identity-repository';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_server_local';
const database = createDatabase(databaseUrl);
const repository = new PostgresSocialIdentityRepository(database.db);

beforeEach(async () => {
  await database.client`truncate table auth_identities`;
});

afterAll(async () => {
  await database.close();
});

describe('PostgresSocialIdentityRepository', () => {
  it('upserts by provider subject while preserving the original server auth UID', async () => {
    const first = await repository.upsert({
      provider: 'apple',
      providerSubject: 'apple-subject',
      authUid: 'social-original',
      emailNormalized: 'first@example.test',
      displayName: 'First Name',
      emailVerified: true,
    });
    const updated = await repository.upsert({
      provider: 'apple',
      providerSubject: 'apple-subject',
      authUid: 'social-replacement-attempt',
      emailNormalized: 'updated@example.test',
      displayName: 'Updated Name',
      emailVerified: true,
    });

    expect(first.authUid).toBe('social-original');
    expect(updated).toMatchObject({
      authUid: 'social-original',
      emailNormalized: 'updated@example.test',
      displayName: 'Updated Name',
      emailVerified: true,
    });
    await expect(repository.findByProviderSubject('apple', 'apple-subject')).resolves.toMatchObject(
      updated
    );

    const rows = await database.client`
      select provider, provider_subject, auth_uid, email_normalized
      from auth_identities
    `;
    expect(Array.from(rows)).toEqual([
      {
        provider: 'apple',
        provider_subject: 'apple-subject',
        auth_uid: 'social-original',
        email_normalized: 'updated@example.test',
      },
    ]);
  });
});
