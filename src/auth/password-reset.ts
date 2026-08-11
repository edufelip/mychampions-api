import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { PasswordResetDeliveryGateway } from './password-reset-delivery';

export const DEFAULT_PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_PASSWORD_RESET_URL_BASE = 'mychampions://auth/password-reset';

export type PasswordResetRequestInput = {
  emailNormalized: string;
};

export type PasswordResetRequest = {
  requestId: string;
  emailNormalized: string;
  tokenDigest: string;
  requestedAt: string;
  expiresAt: string;
  status: 'pending' | 'consumed';
  consumedAt: string | null;
};

export type PasswordResetRequestResult = Pick<
  PasswordResetRequest,
  'requestId' | 'expiresAt'
> & {
  resetToken: string;
};

export type PasswordResetConfirmInput = {
  emailNormalized: string;
  token: string;
};

export type PasswordResetConfirmResult = {
  requestId: string;
};

export type PasswordResetConfirmErrorCode = 'invalid_or_expired_token';

export class PasswordResetConfirmError extends Error {
  readonly code: PasswordResetConfirmErrorCode;

  constructor(code: PasswordResetConfirmErrorCode, message: string) {
    super(message);
    this.name = 'PasswordResetConfirmError';
    this.code = code;
  }
}

export type PasswordResetDeliveryArtifact = {
  requestId: string;
  emailNormalized: string;
  channel: 'local_debug_outbox';
  resetToken: string;
  resetUrl: string;
  expiresAt: string;
  createdAt: string;
};

export interface PasswordResetService {
  request(input: PasswordResetRequestInput): Promise<PasswordResetRequestResult>;
  confirm(input: PasswordResetConfirmInput): Promise<PasswordResetConfirmResult>;
}

export type PasswordResetServiceOptions = {
  now?: () => Date;
  requestIdFactory?: () => string;
  tokenFactory?: () => string;
  ttlMs?: number;
  resetUrlBase?: string;
  deliveryGateway?: PasswordResetDeliveryGateway;
};

export function createPasswordResetToken(): string {
  return randomBytes(32).toString('base64url');
}

export function digestPasswordResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createPasswordResetDeliveryArtifact(input: {
  requestId: string;
  emailNormalized: string;
  resetToken: string;
  expiresAt: string;
  createdAt: string;
  resetUrlBase?: string;
}): PasswordResetDeliveryArtifact {
  const resetUrlBase = input.resetUrlBase ?? DEFAULT_PASSWORD_RESET_URL_BASE;
  const separator = resetUrlBase.includes('?') ? '&' : '?';
  const resetUrl = `${resetUrlBase}${separator}token=${encodeURIComponent(
    input.resetToken
  )}&email=${encodeURIComponent(input.emailNormalized)}`;

  return {
    requestId: input.requestId,
    emailNormalized: input.emailNormalized,
    channel: 'local_debug_outbox',
    resetToken: input.resetToken,
    resetUrl,
    expiresAt: input.expiresAt,
    createdAt: input.createdAt,
  };
}

export class InMemoryPasswordResetService implements PasswordResetService {
  private readonly requests: PasswordResetRequest[] = [];
  private readonly deliveryArtifacts: PasswordResetDeliveryArtifact[] = [];

  constructor(private readonly options: PasswordResetServiceOptions = {}) {}

  async request(input: PasswordResetRequestInput): Promise<PasswordResetRequestResult> {
    const requestedAt = this.options.now?.() ?? new Date();
    const ttlMs = this.options.ttlMs ?? DEFAULT_PASSWORD_RESET_TTL_MS;
    const expiresAt = new Date(requestedAt.getTime() + ttlMs);
    const resetToken = this.options.tokenFactory?.() ?? createPasswordResetToken();
    const request: PasswordResetRequest = {
      requestId: this.options.requestIdFactory?.() ?? `local_password_reset_${randomUUID()}`,
      emailNormalized: input.emailNormalized,
      tokenDigest: digestPasswordResetToken(resetToken),
      requestedAt: requestedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'pending',
      consumedAt: null,
    };
    this.requests.push(request);
    const deliveryArtifact = createPasswordResetDeliveryArtifact({
      requestId: request.requestId,
      emailNormalized: request.emailNormalized,
      resetToken,
      expiresAt: request.expiresAt,
      createdAt: request.requestedAt,
      resetUrlBase: this.options.resetUrlBase,
    });
    this.deliveryArtifacts.push(deliveryArtifact);
    await this.options.deliveryGateway?.send({
      requestId: deliveryArtifact.requestId,
      emailNormalized: deliveryArtifact.emailNormalized,
      resetUrl: deliveryArtifact.resetUrl,
      expiresAt: deliveryArtifact.expiresAt,
    });
    return {
      requestId: request.requestId,
      resetToken,
      expiresAt: request.expiresAt,
    };
  }

  async confirm(input: PasswordResetConfirmInput): Promise<PasswordResetConfirmResult> {
    const now = this.options.now?.() ?? new Date();
    const tokenDigest = digestPasswordResetToken(input.token);
    const request = this.requests.find(
      (candidate) =>
        candidate.emailNormalized === input.emailNormalized &&
        candidate.tokenDigest === tokenDigest &&
        candidate.status === 'pending' &&
        new Date(candidate.expiresAt) > now
    );

    if (!request) {
      throw new PasswordResetConfirmError(
        'invalid_or_expired_token',
        'Password reset token is invalid or expired.'
      );
    }

    request.status = 'consumed';
    request.consumedAt = now.toISOString();

    return { requestId: request.requestId };
  }

  listRequests(): PasswordResetRequest[] {
    return [...this.requests];
  }

  listDeliveryArtifacts(): PasswordResetDeliveryArtifact[] {
    return [...this.deliveryArtifacts];
  }
}
