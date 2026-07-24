import { createHash, randomUUID } from 'node:crypto';

import {
  LOCAL_REFRESH_TOKEN_EXPIRES_IN_SECONDS,
  type AuthClaims,
  type TokenService,
} from './tokens';

export type RefreshSession = {
  id: string;
  authUid: string;
  refreshTokenDigest: string;
  authProviderId: NonNullable<AuthClaims['authProviderId']>;
  expiresAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
  replacedBySessionId: string | null;
};

export type NewRefreshSession = Omit<RefreshSession, 'revokedAt' | 'replacedBySessionId'>;

export interface RefreshSessionRepository {
  create(session: NewRefreshSession): Promise<void>;
  replace(input: {
    sessionId: string;
    refreshTokenDigest: string;
    replacement: NewRefreshSession;
    now: Date;
  }): Promise<boolean>;
  revoke(input: {
    sessionId: string;
    refreshTokenDigest: string;
    now: Date;
  }): Promise<boolean>;
}

export class InMemoryRefreshSessionRepository implements RefreshSessionRepository {
  private readonly sessions = new Map<string, RefreshSession>();

  async create(session: NewRefreshSession): Promise<void> {
    this.sessions.set(session.id, {
      ...session,
      revokedAt: null,
      replacedBySessionId: null,
    });
  }

  async replace(input: {
    sessionId: string;
    refreshTokenDigest: string;
    replacement: NewRefreshSession;
    now: Date;
  }): Promise<boolean> {
    const current = this.sessions.get(input.sessionId);
    if (
      !current ||
      current.revokedAt ||
      current.expiresAt <= input.now ||
      current.refreshTokenDigest !== input.refreshTokenDigest
    ) {
      return false;
    }

    this.sessions.set(current.id, {
      ...current,
      revokedAt: input.now,
      replacedBySessionId: input.replacement.id,
    });
    this.sessions.set(input.replacement.id, {
      ...input.replacement,
      revokedAt: null,
      replacedBySessionId: null,
    });
    return true;
  }

  async revoke(input: {
    sessionId: string;
    refreshTokenDigest: string;
    now: Date;
  }): Promise<boolean> {
    const current = this.sessions.get(input.sessionId);
    if (
      !current ||
      current.revokedAt ||
      current.expiresAt <= input.now ||
      current.refreshTokenDigest !== input.refreshTokenDigest
    ) {
      return false;
    }
    this.sessions.set(current.id, { ...current, revokedAt: input.now });
    return true;
  }
}

export class RefreshSessionService {
  constructor(
    private readonly tokenService: TokenService,
    private readonly repository: RefreshSessionRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  async issue(claims: AuthClaims): Promise<{ refreshToken: string; claims: AuthClaims }> {
    const issued = await this.createRefreshSession(claims);
    await this.repository.create(issued.session);
    return { refreshToken: issued.refreshToken, claims: issued.claims };
  }

  async rotate(refreshToken: string): Promise<{ refreshToken: string; claims: AuthClaims }> {
    let claims: AuthClaims;
    try {
      claims = await this.tokenService.verifyRefresh(refreshToken);
    } catch {
      throw new Error('invalid_refresh_token');
    }
    if (!claims.sessionId) {
      throw new Error('invalid_refresh_token');
    }

    const replacement = await this.createRefreshSession(claims);
    const replaced = await this.repository.replace({
      sessionId: claims.sessionId,
      refreshTokenDigest: digestRefreshToken(refreshToken),
      replacement: replacement.session,
      now: this.now(),
    });
    if (!replaced) {
      throw new Error('invalid_refresh_token');
    }
    return { refreshToken: replacement.refreshToken, claims: replacement.claims };
  }

  async revoke(refreshToken: string): Promise<boolean> {
    let claims: AuthClaims;
    try {
      claims = await this.tokenService.verifyRefresh(refreshToken);
    } catch {
      return false;
    }
    if (!claims.sessionId) {
      return false;
    }
    return this.repository.revoke({
      sessionId: claims.sessionId,
      refreshTokenDigest: digestRefreshToken(refreshToken),
      now: this.now(),
    });
  }

  private async createRefreshSession(claims: AuthClaims): Promise<{
    refreshToken: string;
    claims: AuthClaims;
    session: NewRefreshSession;
  }> {
    const now = this.now();
    const sessionId = randomUUID();
    const authProviderId = claims.authProviderId ?? 'email_password';
    const normalizedClaims: AuthClaims = {
      ...claims,
      authProviderId,
      sessionId,
    };
    const refreshToken = await this.tokenService.issueRefresh(normalizedClaims);
    return {
      refreshToken,
      claims: normalizedClaims,
      session: {
        id: sessionId,
        authUid: normalizedClaims.sub,
        refreshTokenDigest: digestRefreshToken(refreshToken),
        authProviderId,
        expiresAt: new Date(now.getTime() + LOCAL_REFRESH_TOKEN_EXPIRES_IN_SECONDS * 1000),
        createdAt: now,
      },
    };
  }
}

export function digestRefreshToken(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex');
}
