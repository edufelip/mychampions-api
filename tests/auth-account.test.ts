import { describe, expect, it } from 'bun:test';

import { createApp } from '../src/app';
import type { EmailAuthGateway } from '../src/auth/email-auth';
import { EmailAuthGatewayError } from '../src/auth/email-auth';
import { PasswordResetDeliveryGatewayError } from '../src/auth/password-reset-delivery';
import {
  InMemoryPasswordResetService,
  PasswordResetConfirmError,
  type PasswordResetCompletionService,
  type PasswordResetService,
} from '../src/auth/password-reset';
import {
  InMemoryRefreshSessionRepository,
  RefreshSessionService,
} from '../src/auth/refresh-session-service';
import { createTokenService } from '../src/auth/tokens';
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

function makeRefreshSessionServiceSpy() {
  const service = new RefreshSessionService(
    createTokenService({ issuer: 'mychampions-test', audience: 'mychampions-mobile' }),
    new InMemoryRefreshSessionRepository()
  );
  const revokedAuthUids: string[] = [];
  service.revokeAllForAuthUid = async (authUid: string) => {
    revokedAuthUids.push(authUid);
  };
  return { service, revokedAuthUids };
}

function makePasswordUpdaterGateway(
  updatePassword: EmailAuthGateway['updatePassword']
): EmailAuthGateway {
  return {
    async signIn() {
      throw new Error('signIn should not be called');
    },
    async createAccount() {
      throw new Error('createAccount should not be called');
    },
    updatePassword,
  };
}

async function makeInMemoryResetWithPendingToken(
  updatePassword: EmailAuthGateway['updatePassword']
) {
  const passwordResetService = new InMemoryPasswordResetService({
    requestIdFactory: () => 'reset_1',
    tokenFactory: () => 'good-token',
    passwordUpdater: makePasswordUpdaterGateway(updatePassword),
  });
  await passwordResetService.request({ emailNormalized: 'user@example.test' });
  return passwordResetService;
}

function confirmRequest(body: { email: string; token: string; newPassword: string }) {
  return new Request('http://server.test/auth/password-reset/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const invalidOrExpiredTokenResponse = {
  error: {
    code: 'invalid_or_expired_token',
    message: 'Password reset token is invalid or expired.',
  },
};

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
    const passwordResetCompletionService: PasswordResetCompletionService = {
      async confirmAndUpdatePassword() {
        throw new Error('confirmAndUpdatePassword should not be called');
      },
    };
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      passwordResetService,
      passwordResetCompletionService,
    });

    const response = await app.handle(
      confirmRequest({ email: 'not-an-email', token: 'token', newPassword: 'NewPassword1!' })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'invalid_email', message: 'Email is invalid.' },
    });
  });

  it('rejects an invalid or expired token without touching the account password', async () => {
    const updatePasswordCalls: unknown[] = [];
    const passwordResetService = await makeInMemoryResetWithPendingToken(async (input) => {
      updatePasswordCalls.push(input);
      return { authUid: 'local_email_user_1' };
    });
    const { service: refreshSessionService, revokedAuthUids } = makeRefreshSessionServiceSpy();
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      passwordResetService,
      refreshSessionService,
    });

    const response = await app.handle(
      confirmRequest({ email: 'user@example.test', token: 'bad-token', newPassword: 'NewPassword1!' })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(invalidOrExpiredTokenResponse);
    expect(updatePasswordCalls).toEqual([]);
    expect(revokedAuthUids).toEqual([]);
    expect(passwordResetService.listRequests()[0]).toMatchObject({ status: 'pending' });
  });

  it('answers a missing account exactly like a bad token and keeps the token pending', async () => {
    const passwordResetService = await makeInMemoryResetWithPendingToken(async () => {
      throw new EmailAuthGatewayError(
        'account_not_found',
        'No local email/password account exists for this email.'
      );
    });
    const { service: refreshSessionService, revokedAuthUids } = makeRefreshSessionServiceSpy();
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      passwordResetService,
      refreshSessionService,
    });

    const response = await app.handle(
      confirmRequest({ email: 'user@example.test', token: 'good-token', newPassword: 'NewPassword1!' })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual(invalidOrExpiredTokenResponse);
    expect(JSON.stringify(body)).not.toContain('account');
    expect(revokedAuthUids).toEqual([]);
    expect(passwordResetService.listRequests()[0]).toMatchObject({
      status: 'pending',
      consumedAt: null,
    });
  });

  it('maps an account-not-found failure from an injected completion service to the generic response', async () => {
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
      confirmRequest({ email: 'user@example.test', token: 'good-token', newPassword: 'NewPassword1!' })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(invalidOrExpiredTokenResponse);
  });

  it('surfaces an unconfigured email auth provider without consuming the token', async () => {
    const passwordResetService = await makeInMemoryResetWithPendingToken(async () => {
      throw new EmailAuthGatewayError(
        'configuration',
        'Email auth provider is not configured for this local server.'
      );
    });
    const { service: refreshSessionService, revokedAuthUids } = makeRefreshSessionServiceSpy();
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      passwordResetService,
      refreshSessionService,
    });

    const response = await app.handle(
      confirmRequest({ email: ' USER@Example.test ', token: 'good-token', newPassword: 'NewPassword1!' })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'configuration',
        message: 'Email auth provider is not configured for this local server.',
      },
    });
    expect(revokedAuthUids).toEqual([]);
    expect(passwordResetService.listRequests()[0]).toMatchObject({
      status: 'pending',
      consumedAt: null,
    });
  });

  it('updates the password, consumes the token once, and revokes every existing session', async () => {
    const updatePasswordCalls: unknown[] = [];
    const passwordResetService = await makeInMemoryResetWithPendingToken(async (input) => {
      updatePasswordCalls.push(input);
      return { authUid: 'local_email_user_1' };
    });
    const { service: refreshSessionService, revokedAuthUids } = makeRefreshSessionServiceSpy();
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      passwordResetService,
      refreshSessionService,
    });

    const response = await app.handle(
      confirmRequest({ email: ' USER@Example.test ', token: 'good-token', newPassword: 'NewPassword1!' })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'reset' });
    expect(updatePasswordCalls).toEqual([
      { email: 'user@example.test', newPassword: 'NewPassword1!' },
    ]);
    expect(revokedAuthUids).toEqual(['local_email_user_1']);
    expect(passwordResetService.listRequests()[0]).toMatchObject({ status: 'consumed' });

    const replay = await app.handle(
      confirmRequest({
        email: 'user@example.test',
        token: 'good-token',
        newPassword: 'AnotherPassword1!',
      })
    );
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toEqual(invalidOrExpiredTokenResponse);
    expect(updatePasswordCalls).toHaveLength(1);
  });

  it('delegates to an injected atomic completion service and revokes the returned account sessions', async () => {
    const completionInputs: unknown[] = [];
    const passwordResetCompletionService: PasswordResetCompletionService = {
      async confirmAndUpdatePassword(input) {
        completionInputs.push(input);
        return { requestId: 'reset_1', authUid: 'local_email_user_1' };
      },
    };
    const { service: refreshSessionService, revokedAuthUids } = makeRefreshSessionServiceSpy();
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      passwordResetCompletionService,
      refreshSessionService,
    });

    const response = await app.handle(
      confirmRequest({ email: 'user@example.test', token: 'good-token', newPassword: 'NewPassword1!' })
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
    expect(revokedAuthUids).toEqual(['local_email_user_1']);
  });
});
