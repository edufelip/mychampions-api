import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';

import { createDatabase } from '../src/db/client';
import { PostgresRefreshSessionRepository } from '../src/auth/postgres-refresh-session-repository';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_server_local';
const database = createDatabase(databaseUrl);
const repository = new PostgresRefreshSessionRepository(database.db);

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

beforeEach(async () => {
  await database.client`truncate table auth_sessions`;
});

afterAll(async () => {
  await database.close();
});

describe('PostgresRefreshSessionRepository', () => {
  it('atomically consumes a refresh session and stores only token digests', async () => {
    const createdAt = new Date('2026-07-11T12:00:00.000Z');
    const expiresAt = new Date('2026-08-10T12:00:00.000Z');
    await repository.create({
      id: 'session-1',
      authUid: 'auth-user-1',
      refreshTokenDigest: digest('raw-refresh-token'),
      authProviderId: 'email_password',
      expiresAt,
      createdAt,
    });

    const rotated = await repository.replace({
      sessionId: 'session-1',
      refreshTokenDigest: digest('raw-refresh-token'),
      replacement: {
        id: 'session-2',
        authUid: 'auth-user-1',
        refreshTokenDigest: digest('rotated-refresh-token'),
        authProviderId: 'email_password',
        expiresAt,
        createdAt,
      },
      now: new Date('2026-07-11T12:05:00.000Z'),
    });

    expect(rotated).toBe(true);
    await expect(
      repository.replace({
        sessionId: 'session-1',
        refreshTokenDigest: digest('raw-refresh-token'),
        replacement: {
          id: 'session-3',
          authUid: 'auth-user-1',
          refreshTokenDigest: digest('another-token'),
          authProviderId: 'email_password',
          expiresAt,
          createdAt,
        },
        now: new Date('2026-07-11T12:06:00.000Z'),
      })
    ).resolves.toBe(false);

    const rows = await database.client`
      select id, refresh_token_digest, revoked_at, replaced_by_session_id
      from auth_sessions
      order by id
    `;
    expect(rows).toHaveLength(2);
    expect(rows).toMatchObject([
      {
        id: 'session-1',
        refresh_token_digest: digest('raw-refresh-token'),
        replaced_by_session_id: 'session-2',
      },
      {
        id: 'session-2',
        refresh_token_digest: digest('rotated-refresh-token'),
        revoked_at: null,
        replaced_by_session_id: null,
      },
    ]);
    expect(new Date(rows[0].revoked_at).toISOString()).toBe('2026-07-11T12:05:00.000Z');
    expect(JSON.stringify(rows)).not.toContain('raw-refresh-token');
  });
});
