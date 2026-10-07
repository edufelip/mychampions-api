import { describe, expect, it } from 'bun:test';

import { createApp } from '../src/app';
import { PasswordResetDeliveryGatewayError } from '../src/auth/password-reset-delivery';
import {
  PasswordResetConfirmError,
  type PasswordResetCompletionService,
  type PasswordResetService,
} from '../src/auth/password-reset';
import type { ProfileRepository } from '../src/profile/repository';
import type { SupportMessageRepository } from '../src/support/repository';

function makeProfileRepository(): ProfileRepository {
  return {
    async upsertFromSession(input) {
      return {
        authUid: input.authUid,
        displayName: input.displayName,
        emailNormalized: input.emailNormalized,
        lockedRole: null,
        acceptedTermsVersion: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
    },
    async findByAuthUid() {
      return null;
    },
    async lockRole() {
      throw new Error('not implemented');
    },
    async setAcceptedTermsVersion() {
      throw new Error('not implemented');
    },
    async deleteByAuthUid() {},
  };
}

const supportMessageRepository: SupportMessageRepository = {
  async create() {
    throw new Error('not implemented');
  },
};

describe('auth account API', () => {
  it('records local password reset requests without exposing provider details', async () => {
    const requestedEmails: string[] = [];
    const passwordResetService: PasswordResetService = {
      async request(input) {
        requestedEmails.push(input.emailNormalized);
        return {
          requestId: 'reset_1',
          resetToken: 'raw-reset-token-that-must-not-be-in-http-response',
          expiresAt: '2026-07-03T12:15:00.000Z',
        };
      },
      async confirm() {
        throw new Error('confirm should not be called');
      },
    };
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      passwordResetService,
    });

    const response = await app.handle(
      new Request('http://server.test/auth/password-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: ' USER@Example.test ' }),
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: 'accepted' });
    expect(requestedEmails).toEqual(['user@example.test']);
  });

  it('rejects invalid password reset email without recording a request', async () => {
    const requestedEmails: string[] = [];
    const passwordResetService: PasswordResetService = {
      async request(input) {
        requestedEmails.push(input.emailNormalized);
        return {
          requestId: 'reset_1',
          resetToken: 'raw-reset-token-that-must-not-be-used',
          expiresAt: '2026-07-03T12:15:00.000Z',
        };
      },
      async confirm() {
        throw new Error('confirm should not be called');
      },
    };
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      passwordResetService,
    });

    const response = await app.handle(
      new Request('http://server.test/auth/password-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email' }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'invalid_email', message: 'Email is invalid.' },
    });
    expect(requestedEmails).toEqual([]);
  });

  it('maps configured password reset delivery provider failures without exposing tokens', async () => {
    const passwordResetService: PasswordResetService = {
      async request() {
        throw new PasswordResetDeliveryGatewayError(
          'provider_error',
          'SMTP provider rejected the request'
        );
      },
      async confirm() {
        throw new Error('confirm should not be called');
      },
    };
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      passwordResetService,
    });

    const response = await app.handle(
      new Request('http://server.test/auth/password-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.test' }),
      })
    );

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: 'provider_error',
        message: 'SMTP provider rejected the request',
      },
    });
    expect(JSON.stringify(body)).not.toContain('raw-reset-token');
  });
});

describe('POST /auth/password-reset/confirm', () => {
  it('rejects an invalid email before consulting the reset service', async () => {
    const passwordResetService: PasswordResetService = {
      async request() {
        throw new Error('request should not be called');
      },
      async confirm() {
        throw new Error('confirm should not be called');
      },
    };
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      passwordResetService,
    });

    const response = await app.handle(
      new Request('http://server.test/auth/password-reset/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email', token: 'token', newPassword: 'NewPassword1!' }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'invalid_email', message: 'Email is invalid.' },
    });
  });

  it('rejects an invalid or expired token without touching the account password', async () => {
    const passwordResetCompletionService: PasswordResetCompletionService = {
      async confirmAndUpdatePassword() {
        throw new PasswordResetConfirmError(
          'invalid_or_expired_token',
          'Password reset token is invalid or expired.'
        );
      },
    };
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      passwordResetCompletionService,
    });

    const response = await app.handle(
      new Request('http://server.test/auth/password-reset/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'user@example.test',
          token: 'bad-token',
          newPassword: 'NewPassword1!',
        }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_or_expired_token',
        message: 'Password reset token is invalid or expired.',
      },
    });
  });

  it('maps an account-not-found failure from the atomic completion service', async () => {
    const passwordResetCompletionService: PasswordResetCompletionService = {
      async confirmAndUpdatePassword() {
        throw new PasswordResetConfirmError(
          'account_not_found',
          'No local email/password account exists for this email.'
        );
      },
    };
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      passwordResetCompletionService,
    });

    const response = await app.handle(
      new Request('http://server.test/auth/password-reset/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: ' USER@Example.test ',
          token: 'good-token',
          newPassword: 'NewPassword1!',
        }),
      })
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'account_not_found',
        message: 'No local email/password account exists for this email.',
      },
    });
  });

  it('delegates password update and session revocation to one atomic completion operation', async () => {
    const completionInputs: unknown[] = [];
    const passwordResetCompletionService: PasswordResetCompletionService = {
      async confirmAndUpdatePassword(input) {
        completionInputs.push(input);
        return { requestId: 'reset_1', authUid: 'local_email_user_1' };
      },
    };
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      passwordResetCompletionService,
    });

    const response = await app.handle(
      new Request('http://server.test/auth/password-reset/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'user@example.test',
          token: 'good-token',
          newPassword: 'NewPassword1!',
        }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'reset' });
    expect(completionInputs).toEqual([
      {
        emailNormalized: 'user@example.test',
        token: 'good-token',
        newPassword: 'NewPassword1!',
      },
    ]);
  });
});
