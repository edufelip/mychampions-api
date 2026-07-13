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

    const rotated = await service.rotate(issued.refreshToken);

    expect(rotated.refreshToken).not.toBe(issued.refreshToken);
    expect(rotated.claims).toMatchObject({
      sub: 'auth-user-1',
      email: 'user@example.test',
      authProviderId: 'google',
    });
    await expect(service.rotate(issued.refreshToken)).rejects.toThrow('invalid_refresh_token');
  });
});
