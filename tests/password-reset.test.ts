import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';

import { InMemoryPasswordResetService } from '../src/auth/password-reset';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('InMemoryPasswordResetService', () => {
  it('stores local password reset requests with token digest and expiry only', async () => {
    const now = new Date('2026-07-03T12:00:00.000Z');
    const service = new InMemoryPasswordResetService({
      now: () => now,
      requestIdFactory: () => 'local_password_reset_test',
      tokenFactory: () => 'raw-reset-token',
      ttlMs: 15 * 60 * 1000,
    });

    const result = await service.request({ emailNormalized: 'user@example.test' });

    expect(result).toEqual({
      requestId: 'local_password_reset_test',
      resetToken: 'raw-reset-token',
      expiresAt: '2026-07-03T12:15:00.000Z',
    });
    expect(service.listRequests()).toEqual([
      {
        requestId: 'local_password_reset_test',
        emailNormalized: 'user@example.test',
        tokenDigest: sha256Hex('raw-reset-token'),
        requestedAt: '2026-07-03T12:00:00.000Z',
        expiresAt: '2026-07-03T12:15:00.000Z',
      },
    ]);
    expect(JSON.stringify(service.listRequests())).not.toContain('raw-reset-token');
  });

  it('returns defensive copies of recorded requests', async () => {
    const service = new InMemoryPasswordResetService();
    await service.request({ emailNormalized: 'user@example.test' });

    service.listRequests().pop();

    expect(service.listRequests()).toHaveLength(1);
  });

  it('records a local debug delivery artifact with the raw token outside the request row', async () => {
    const now = new Date('2026-07-03T12:00:00.000Z');
    const service = new InMemoryPasswordResetService({
      now: () => now,
      requestIdFactory: () => 'local_password_reset_test',
      tokenFactory: () => 'raw-reset-token',
      ttlMs: 15 * 60 * 1000,
      resetUrlBase: 'mychampions://auth/password-reset',
    });

    await service.request({ emailNormalized: 'user@example.test' });

    expect(service.listDeliveryArtifacts()).toEqual([
      {
        requestId: 'local_password_reset_test',
        emailNormalized: 'user@example.test',
        channel: 'local_debug_outbox',
        resetToken: 'raw-reset-token',
        resetUrl:
          'mychampions://auth/password-reset?token=raw-reset-token&email=user%40example.test',
        expiresAt: '2026-07-03T12:15:00.000Z',
        createdAt: '2026-07-03T12:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(service.listRequests())).not.toContain('raw-reset-token');
  });

  it('sends local debug reset URLs through an injected delivery gateway', async () => {
    const delivered: unknown[] = [];
    const now = new Date('2026-07-03T12:00:00.000Z');
    const service = new InMemoryPasswordResetService({
      now: () => now,
      requestIdFactory: () => 'local_password_reset_test',
      tokenFactory: () => 'raw-reset-token',
      ttlMs: 15 * 60 * 1000,
      resetUrlBase: 'mychampions://auth/password-reset',
      deliveryGateway: {
        async send(input) {
          delivered.push(input);
        },
      },
    });

    await service.request({ emailNormalized: 'user@example.test' });

    expect(delivered).toEqual([
      {
        requestId: 'local_password_reset_test',
        emailNormalized: 'user@example.test',
        resetUrl:
          'mychampions://auth/password-reset?token=raw-reset-token&email=user%40example.test',
        expiresAt: '2026-07-03T12:15:00.000Z',
      },
    ]);
  });
});
