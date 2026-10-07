import { describe, expect, it } from 'bun:test';

import {
  InMemoryRefreshSessionRepository,
  RefreshSessionService,
} from '../src/auth/refresh-session-service';
import { createTokenService } from '../src/auth/tokens';

describe('RefreshSessionService', () => {
  it('rotates a refresh token once and rejects replay of the consumed token', async () => {
    const service = new RefreshSessionService(
      createTokenService({ issuer: 'mychampions-test', audience: 'mychampions-mobile' }),
      new InMemoryRefreshSessionRepository()
    );
    const issued = await service.issue({
      sub: 'auth-user-1',
      email: 'user@example.test',
      displayName: 'User',
      emailVerified: true,
      authProviderId: 'google',
    });

    const verified = await service.verify(issued.refreshToken);
    const rotated = await service.rotate(issued.refreshToken, {
      email: 'current@example.test',
      displayName: 'Current User',
      emailVerified: false,
    });

    expect(verified).toMatchObject({
      sub: 'auth-user-1',
      email: 'user@example.test',
      displayName: 'User',
    });
    expect(rotated.refreshToken).not.toBe(issued.refreshToken);
    expect(rotated.claims).toMatchObject({
      sub: 'auth-user-1',
      email: 'current@example.test',
      displayName: 'Current User',
      emailVerified: false,
      authProviderId: 'google',
    });
    await expect(service.rotate(issued.refreshToken)).rejects.toThrow('invalid_refresh_token');
  });

  it('revokes every active session for an auth uid, leaving other users untouched', async () => {
    const tokenService = createTokenService({ issuer: 'mychampions-test', audience: 'mychampions-mobile' });
    const service = new RefreshSessionService(tokenService, new InMemoryRefreshSessionRepository());

    const first = await service.issue({
      sub: 'auth-user-1',
      email: 'user@example.test',
      displayName: 'User',
      emailVerified: true,
      authProviderId: 'email_password',
    });
    const second = await service.issue({
      sub: 'auth-user-1',
      email: 'user@example.test',
      displayName: 'User',
      emailVerified: true,
      authProviderId: 'email_password',
    });
    const other = await service.issue({
      sub: 'auth-user-2',
      email: 'other@example.test',
      displayName: 'Other User',
      emailVerified: true,
      authProviderId: 'email_password',
    });

    await service.revokeAllForAuthUid('auth-user-1');

    await expect(service.rotate(first.refreshToken)).rejects.toThrow('invalid_refresh_token');
    await expect(service.rotate(second.refreshToken)).rejects.toThrow('invalid_refresh_token');
    await expect(service.rotate(other.refreshToken)).resolves.toBeDefined();
  });
});
