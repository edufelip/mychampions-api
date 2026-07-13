import { describe, expect, it } from 'bun:test';

import { createApp } from '../src/app';
import { PasswordResetDeliveryGatewayError } from '../src/auth/password-reset-delivery';
import type { PasswordResetService } from '../src/auth/password-reset';
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
