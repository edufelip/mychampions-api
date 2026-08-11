import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';

import { PasswordResetConfirmError } from '../src/auth/password-reset';
import { PostgresPasswordResetService } from '../src/auth/postgres-password-reset';
import { createDatabase } from '../src/db/client';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_server_local';

const database = createDatabase(databaseUrl);

beforeEach(async () => {
  await database.client`
    truncate table password_reset_delivery_artifacts, password_reset_requests
  `;
});

afterAll(async () => {
  await database.close();
});

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('PostgresPasswordResetService', () => {
  it('persists provider-neutral password reset token digest and expiry', async () => {
    const service = new PostgresPasswordResetService(database.db, {
      now: () => new Date('2026-07-03T12:00:00.000Z'),
      tokenFactory: () => 'raw-reset-token',
      ttlMs: 15 * 60 * 1000,
    });

    const result = await service.request({ emailNormalized: 'user@example.test' });
    const requestId = result.requestId;

    expect(result).toMatchObject({
      requestId: expect.any(String),
      resetToken: 'raw-reset-token',
      expiresAt: '2026-07-03T12:15:00.000Z',
    });

    const rows = await database.client`
      select id, email_normalized, status, token_digest, requested_at, expires_at
      from password_reset_requests
      where id = ${requestId}
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.requestId,
      email_normalized: 'user@example.test',
      status: 'pending',
      token_digest: sha256Hex('raw-reset-token'),
    });
    expect(new Date(rows[0].requested_at).toISOString()).toBe('2026-07-03T12:00:00.000Z');
    expect(new Date(rows[0].expires_at).toISOString()).toBe('2026-07-03T12:15:00.000Z');
    expect(JSON.stringify(rows[0])).not.toContain('raw-reset-token');
  });

  it('persists a local debug delivery artifact with the raw reset token', async () => {
    const service = new PostgresPasswordResetService(database.db, {
      now: () => new Date('2026-07-03T12:00:00.000Z'),
      tokenFactory: () => 'raw-reset-token',
      ttlMs: 15 * 60 * 1000,
      resetUrlBase: 'mychampions://auth/password-reset',
    });

    const result = await service.request({ emailNormalized: 'user@example.test' });

    const rows = await database.client`
      select request_id, email_normalized, channel, reset_token, reset_url, expires_at, created_at
      from password_reset_delivery_artifacts
      where request_id = ${result.requestId}
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      request_id: result.requestId,
      email_normalized: 'user@example.test',
      channel: 'local_debug_outbox',
      reset_token: 'raw-reset-token',
      reset_url:
        'mychampions://auth/password-reset?token=raw-reset-token&email=user%40example.test',
    });
    expect(new Date(rows[0].expires_at).toISOString()).toBe('2026-07-03T12:15:00.000Z');
    expect(new Date(rows[0].created_at).toISOString()).toBe('2026-07-03T12:00:00.000Z');
  });

  it('atomically consumes a pending token exactly once and rejects replay', async () => {
    const service = new PostgresPasswordResetService(database.db, {
      now: () => new Date('2026-07-03T12:00:00.000Z'),
      tokenFactory: () => 'raw-reset-token',
      ttlMs: 15 * 60 * 1000,
    });
    const requested = await service.request({ emailNormalized: 'user@example.test' });

    const confirmed = await service.confirm({
      emailNormalized: 'user@example.test',
      token: 'raw-reset-token',
    });

    expect(confirmed).toEqual({ requestId: requested.requestId });

    const rows = await database.client`
      select id, status, consumed_at
      from password_reset_requests
      where id = ${requested.requestId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('consumed');
    expect(new Date(rows[0].consumed_at).toISOString()).toBe('2026-07-03T12:00:00.000Z');

    await expect(
      service.confirm({ emailNormalized: 'user@example.test', token: 'raw-reset-token' })
    ).rejects.toThrow(PasswordResetConfirmError);
  });

  it('rejects an expired token without consuming it', async () => {
    const service = new PostgresPasswordResetService(database.db, {
      now: () => new Date('2026-07-03T12:00:00.000Z'),
      tokenFactory: () => 'raw-reset-token',
      ttlMs: 15 * 60 * 1000,
    });
    const requested = await service.request({ emailNormalized: 'user@example.test' });

    const lateService = new PostgresPasswordResetService(database.db, {
      now: () => new Date('2026-07-03T12:16:00.000Z'),
    });

    await expect(
      lateService.confirm({ emailNormalized: 'user@example.test', token: 'raw-reset-token' })
    ).rejects.toThrow(PasswordResetConfirmError);

    const rows = await database.client`
      select status from password_reset_requests where id = ${requested.requestId}
    `;
    expect(rows[0].status).toBe('pending');
  });
});
