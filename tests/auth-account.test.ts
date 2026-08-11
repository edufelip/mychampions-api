import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { createApp } from '../src/app';
import type { EmailAuthGateway } from '../src/auth/email-auth';
import { EmailAuthGatewayError } from '../src/auth/email-auth';
import { PasswordResetDeliveryGatewayError } from '../src/auth/password-reset-delivery';
import {
  PasswordResetConfirmError,
  type PasswordResetService,
} from '../src/auth/password-reset';
import {
  InMemoryRefreshSessionRepository,
  RefreshSessionService,
} from '../src/auth/refresh-session-service';
import { createTokenService } from '../src/auth/tokens';
import { createDatabase } from '../src/db/client';
import type { ProfileRepository } from '../src/profile/repository';
import type { SupportMessageRepository } from '../src/support/repository';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_server_local';

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
    const emailAuthGateway: EmailAuthGateway = {
      async signIn() {
        throw new Error('signIn should not be called');
      },
      async createAccount() {
        throw new Error('createAccount should not be called');
      },
      async updatePassword() {
        throw new Error('updatePassword should not have been called for an invalid token');
      },
    };
    const passwordResetService: PasswordResetService = {
      async request() {
        throw new Error('request should not be called');
      },
      async confirm() {
        throw new PasswordResetConfirmError(
          'invalid_or_expired_token',
          'Password reset token is invalid or expired.'
        );
      },
    };
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      passwordResetService,
      emailAuthGateway,
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

  it('surfaces an unconfigured email auth provider after a valid token is consumed', async () => {
    const confirmedTokens: unknown[] = [];
    const passwordResetService: PasswordResetService = {
      async request() {
        throw new Error('request should not be called');
      },
      async confirm(input) {
        confirmedTokens.push(input);
        return { requestId: 'reset_1' };
      },
    };
    const emailAuthGateway: EmailAuthGateway = {
      async signIn() {
        throw new Error('signIn should not be called');
      },
      async createAccount() {
        throw new Error('createAccount should not be called');
      },
      async updatePassword() {
        throw new EmailAuthGatewayError(
          'configuration',
          'Email auth provider is not configured for this local server.'
        );
      },
    };
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      passwordResetService,
      emailAuthGateway,
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

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'configuration',
        message: 'Email auth provider is not configured for this local server.',
      },
    });
    expect(confirmedTokens).toEqual([{ emailNormalized: 'user@example.test', token: 'good-token' }]);
  });

  it('updates the password and revokes every existing session after a valid confirm', async () => {
    const passwordResetService: PasswordResetService = {
      async request() {
        throw new Error('request should not be called');
      },
      async confirm() {
        return { requestId: 'reset_1' };
      },
    };
    const updatePasswordCalls: unknown[] = [];
    const emailAuthGateway: EmailAuthGateway = {
      async signIn() {
        throw new Error('signIn should not be called');
      },
      async createAccount() {
        throw new Error('createAccount should not be called');
      },
      async updatePassword(input) {
        updatePasswordCalls.push(input);
        return { authUid: 'local_email_user_1' };
      },
    };
    const { service: refreshSessionService, revokedAuthUids } = makeRefreshSessionServiceSpy();
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      passwordResetService,
      emailAuthGateway,
      refreshSessionService,
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
    expect(updatePasswordCalls).toEqual([
      { email: 'user@example.test', newPassword: 'NewPassword1!' },
    ]);
    expect(revokedAuthUids).toEqual(['local_email_user_1']);
  });

  it('completes a real request-to-confirm reset against local Postgres and revokes the prior session', async () => {
    const database = createDatabase(databaseUrl);
    try {
      const app = createApp();
      const email = `reset-${randomUUID()}@local-password-reset.test`;
      const oldPassword = 'OldPassword1!';
      const newPassword = 'NewPassword1!';

      const createResponse = await app.handle(
        new Request('http://server.test/auth/email/create-account', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: oldPassword, displayName: 'Reset User' }),
        })
      );
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json();
      const oldRefreshToken = created.refreshToken as string;

      const requestResponse = await app.handle(
        new Request('http://server.test/auth/password-reset', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email }),
        })
      );
      expect(requestResponse.status).toBe(202);

      const [artifact] = await database.client`
        select reset_token
        from password_reset_delivery_artifacts
        where email_normalized = ${email}
        order by created_at desc
        limit 1
      `;
      expect(artifact).toBeDefined();
      const resetToken = artifact.reset_token as string;

      const confirmResponse = await app.handle(
        new Request('http://server.test/auth/password-reset/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, token: resetToken, newPassword }),
        })
      );
      expect(confirmResponse.status).toBe(200);
      await expect(confirmResponse.json()).resolves.toEqual({ status: 'reset' });

      const oldPasswordSignIn = await app.handle(
        new Request('http://server.test/auth/email/sign-in', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: oldPassword }),
        })
      );
      expect(oldPasswordSignIn.status).toBe(401);

      const newPasswordSignIn = await app.handle(
        new Request('http://server.test/auth/email/sign-in', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: newPassword }),
        })
      );
      expect(newPasswordSignIn.status).toBe(201);

      const replayResetToken = await app.handle(
        new Request('http://server.test/auth/password-reset/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, token: resetToken, newPassword: 'AnotherPassword1!' }),
        })
      );
      expect(replayResetToken.status).toBe(400);

      const refreshResponse = await app.handle(
        new Request('http://server.test/auth/session/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: oldRefreshToken }),
        })
      );
      expect(refreshResponse.status).toBe(401);
    } finally {
      await database.close();
    }
  });
});
