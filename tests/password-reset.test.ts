import { describe, expect, it, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';

import { EmailAuthGatewayError } from '../src/auth/email-auth';
import {
  InMemoryPasswordResetService,
  PasswordResetConfirmError,
} from '../src/auth/password-reset';
import { PostgresPasswordResetService } from '../src/auth/postgres-password-reset';

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
        status: 'pending',
        consumedAt: null,
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

  it('confirms a pending token and marks it consumed exactly once', async () => {
    const now = new Date('2026-07-03T12:00:00.000Z');
    const service = new InMemoryPasswordResetService({
      now: () => now,
      requestIdFactory: () => 'local_password_reset_test',
      tokenFactory: () => 'raw-reset-token',
      ttlMs: 15 * 60 * 1000,
    });
    await service.request({ emailNormalized: 'user@example.test' });

    const result = await service.confirm({
      emailNormalized: 'user@example.test',
      token: 'raw-reset-token',
    });

    expect(result).toEqual({ requestId: 'local_password_reset_test' });
    expect(service.listRequests()).toEqual([
      {
        requestId: 'local_password_reset_test',
        emailNormalized: 'user@example.test',
        tokenDigest: sha256Hex('raw-reset-token'),
        requestedAt: '2026-07-03T12:00:00.000Z',
        expiresAt: '2026-07-03T12:15:00.000Z',
        status: 'consumed',
        consumedAt: '2026-07-03T12:00:00.000Z',
      },
    ]);

    await expect(
      service.confirm({ emailNormalized: 'user@example.test', token: 'raw-reset-token' })
    ).rejects.toThrow(PasswordResetConfirmError);
  });

  it('rejects an expired token', async () => {
    let now = new Date('2026-07-03T12:00:00.000Z');
    const service = new InMemoryPasswordResetService({
      now: () => now,
      requestIdFactory: () => 'local_password_reset_test',
      tokenFactory: () => 'raw-reset-token',
      ttlMs: 15 * 60 * 1000,
    });
    await service.request({ emailNormalized: 'user@example.test' });

    now = new Date('2026-07-03T12:16:00.000Z');

    await expect(
      service.confirm({ emailNormalized: 'user@example.test', token: 'raw-reset-token' })
    ).rejects.toThrow(PasswordResetConfirmError);
  });

  it('rejects a token that does not match the requested email', async () => {
    const service = new InMemoryPasswordResetService({
      requestIdFactory: () => 'local_password_reset_test',
      tokenFactory: () => 'raw-reset-token',
      ttlMs: 15 * 60 * 1000,
    });
    await service.request({ emailNormalized: 'user@example.test' });

    await expect(
      service.confirm({ emailNormalized: 'other@example.test', token: 'raw-reset-token' })
    ).rejects.toThrow(PasswordResetConfirmError);
  });

  describe('confirmAndUpdatePassword', () => {
    const completionInput = {
      emailNormalized: 'user@example.test',
      token: 'raw-reset-token',
      newPassword: 'NewPassword1!',
    };

    it('consumes the token only when the password update succeeds', async () => {
      let failNextUpdate = true;
      const updates: unknown[] = [];
      const service = new InMemoryPasswordResetService({
        now: () => new Date('2026-07-03T12:00:00.000Z'),
        requestIdFactory: () => 'local_password_reset_test',
        tokenFactory: () => 'raw-reset-token',
        passwordUpdater: {
          async updatePassword(input) {
            updates.push(input);
            if (failNextUpdate) {
              failNextUpdate = false;
              throw new Error('injected_password_update_failure');
            }
            return { authUid: 'local_email_user_1' };
          },
        },
      });
      await service.request({ emailNormalized: 'user@example.test' });

      await expect(service.confirmAndUpdatePassword(completionInput)).rejects.toThrow(
        'injected_password_update_failure'
      );
      expect(service.listRequests()[0]).toMatchObject({ status: 'pending', consumedAt: null });

      await expect(service.confirmAndUpdatePassword(completionInput)).resolves.toEqual({
        requestId: 'local_password_reset_test',
        authUid: 'local_email_user_1',
      });
      expect(service.listRequests()[0]).toMatchObject({
        status: 'consumed',
        consumedAt: '2026-07-03T12:00:00.000Z',
      });
      expect(updates).toEqual([
        { email: 'user@example.test', newPassword: 'NewPassword1!' },
        { email: 'user@example.test', newPassword: 'NewPassword1!' },
      ]);

      await expect(service.confirmAndUpdatePassword(completionInput)).rejects.toMatchObject({
        code: 'invalid_or_expired_token',
      });
    });

    it('lets exactly one concurrent confirmation update the password', async () => {
      let updates = 0;
      const service = new InMemoryPasswordResetService({
        tokenFactory: () => 'raw-reset-token',
        passwordUpdater: {
          async updatePassword() {
            updates += 1;
            await Bun.sleep(5);
            return { authUid: 'local_email_user_1' };
          },
        },
      });
      await service.request({ emailNormalized: 'user@example.test' });

      const outcomes = await Promise.allSettled([
        service.confirmAndUpdatePassword(completionInput),
        service.confirmAndUpdatePassword(completionInput),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(PasswordResetConfirmError);
      expect(rejected[0].reason.code).toBe('invalid_or_expired_token');
      expect(updates).toBe(1);
    });

    it('reports a missing account as account_not_found and keeps the token pending', async () => {
      const service = new InMemoryPasswordResetService({
        tokenFactory: () => 'raw-reset-token',
        passwordUpdater: {
          async updatePassword() {
            throw new EmailAuthGatewayError(
              'account_not_found',
              'No local email/password account exists for this email.'
            );
          },
        },
      });
      await service.request({ emailNormalized: 'user@example.test' });

      const failure = service.confirmAndUpdatePassword(completionInput);
      await expect(failure).rejects.toBeInstanceOf(PasswordResetConfirmError);
      await expect(failure).rejects.toMatchObject({ code: 'account_not_found' });
      expect(service.listRequests()[0]).toMatchObject({ status: 'pending', consumedAt: null });
    });

    it('fails closed with a configuration error when no password provider is configured', async () => {
      const service = new InMemoryPasswordResetService({ tokenFactory: () => 'raw-reset-token' });
      await service.request({ emailNormalized: 'user@example.test' });

      await expect(service.confirmAndUpdatePassword(completionInput)).rejects.toMatchObject({
        code: 'configuration',
      });
      expect(service.listRequests()[0]).toMatchObject({ status: 'pending', consumedAt: null });
    });
  });
});

// No database here: a fake Drizzle handle records which steps run, so this stays in the
// unit lane. tests/postgres-password-reset-confirm.test.ts covers the real transaction.
describe('PostgresPasswordResetService.confirmAndUpdatePassword token pre-check', () => {
  const completionInput = {
    emailNormalized: 'user@example.test',
    token: 'raw-reset-token',
    newPassword: 'NewPassword1!',
  };

  function makeFakeDb(options: { redeemableRows: Array<{ id: string }> }) {
    const steps: string[] = [];
    const selectChain = {
      from: () => selectChain,
      where: () => selectChain,
      limit: async () => {
        steps.push('select');
        return options.redeemableRows;
      },
    };
    const db = {
      insert() {
        throw new Error('insert should not be called');
      },
      select() {
        return selectChain;
      },
      update() {
        throw new Error('update outside the transaction should not be called');
      },
      async transaction(run: (tx: unknown) => Promise<unknown>) {
        steps.push('transaction');
        // A concurrent confirm won the race: the conditional UPDATE matches no row.
        const updateChain = {
          set: () => updateChain,
          where: () => updateChain,
          returning: async () => {
            steps.push('consume-token');
            return [];
          },
        };
        return run({ update: () => updateChain });
      },
    };
    return { db, steps };
  }

  it('rejects an unknown, expired, or used token before hashing or opening a transaction', async () => {
    const { db, steps } = makeFakeDb({ redeemableRows: [] });
    const service = new PostgresPasswordResetService(db);
    const hashSpy = spyOn(Bun.password, 'hash');
    try {
      await expect(service.confirmAndUpdatePassword(completionInput)).rejects.toMatchObject({
        code: 'invalid_or_expired_token',
      });
      expect(hashSpy).not.toHaveBeenCalled();
      expect(steps).toEqual(['select']);
    } finally {
      hashSpy.mockRestore();
    }
  });

  it('still lets only the transactional update consume the token after the pre-check passes', async () => {
    const { db, steps } = makeFakeDb({ redeemableRows: [{ id: 'reset_1' }] });
    const service = new PostgresPasswordResetService(db);
    const hashSpy = spyOn(Bun.password, 'hash');
    try {
      await expect(service.confirmAndUpdatePassword(completionInput)).rejects.toMatchObject({
        code: 'invalid_or_expired_token',
      });
      expect(hashSpy).toHaveBeenCalledTimes(1);
      expect(steps).toEqual(['select', 'transaction', 'consume-token']);
    } finally {
      hashSpy.mockRestore();
    }
  });
});
