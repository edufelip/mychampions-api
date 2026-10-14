import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  EmailAuthGatewayError,
  UnconfiguredEmailAuthGateway,
  type EmailAuthGateway,
} from './email-auth';
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

export type PasswordResetCompletionInput = PasswordResetConfirmInput & {
  newPassword: string;
};

export type PasswordResetCompletionResult = PasswordResetConfirmResult & {
  authUid: string;
};

/**
 * The only operation behind POST /auth/password-reset/confirm: a token is consumed if
 * and only if the password update succeeds. Every implementation must leave the token
 * pending when the update fails, and report a missing account as `account_not_found`
 * (the route answers that exactly like an invalid token).
 */
export interface PasswordResetCompletionService {
  confirmAndUpdatePassword(
    input: PasswordResetCompletionInput
  ): Promise<PasswordResetCompletionResult>;
}

export function isPasswordResetCompletionService(
  value: unknown
): value is PasswordResetCompletionService {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<PasswordResetCompletionService>).confirmAndUpdatePassword ===
      'function'
  );
}

export type PasswordResetConfirmErrorCode = 'invalid_or_expired_token' | 'account_not_found';

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

export type InMemoryPasswordResetServiceOptions = PasswordResetServiceOptions & {
  /** Stores the new password. Defaults to an unconfigured provider (503 at the route). */
  passwordUpdater?: Pick<EmailAuthGateway, 'updatePassword'>;
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

export class InMemoryPasswordResetService
  implements PasswordResetService, PasswordResetCompletionService
{
  private readonly requests: PasswordResetRequest[] = [];
  private readonly deliveryArtifacts: PasswordResetDeliveryArtifact[] = [];
  private readonly passwordUpdater: Pick<EmailAuthGateway, 'updatePassword'>;

  constructor(private readonly options: InMemoryPasswordResetServiceOptions = {}) {
    this.passwordUpdater = options.passwordUpdater ?? new UnconfiguredEmailAuthGateway();
  }

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
    const request = this.claimPendingRequest(input, this.options.now?.() ?? new Date());
    return { requestId: request.requestId };
  }

  async confirmAndUpdatePassword(
    input: PasswordResetCompletionInput
  ): Promise<PasswordResetCompletionResult> {
    // Claim synchronously so a concurrent confirm cannot reuse the token while the
    // password update is in flight, then release it if the update fails. This mirrors
    // the Postgres transaction, which rolls the token back to pending on any failure.
    const request = this.claimPendingRequest(input, this.options.now?.() ?? new Date());
    try {
      const { authUid } = await this.passwordUpdater.updatePassword({
        email: input.emailNormalized,
        newPassword: input.newPassword,
      });
      return { requestId: request.requestId, authUid };
    } catch (error) {
      request.status = 'pending';
      request.consumedAt = null;
      if (error instanceof EmailAuthGatewayError && error.code === 'account_not_found') {
        throw new PasswordResetConfirmError(
          'account_not_found',
          'No local email/password account exists for this email.'
        );
      }
      throw error;
    }
  }

  private claimPendingRequest(input: PasswordResetConfirmInput, now: Date): PasswordResetRequest {
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
    return request;
  }

  listRequests(): PasswordResetRequest[] {
    return [...this.requests];
  }

  listDeliveryArtifacts(): PasswordResetDeliveryArtifact[] {
    return [...this.deliveryArtifacts];
  }
}
