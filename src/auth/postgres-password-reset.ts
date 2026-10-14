import { and, eq, gt, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import {
  authSessions,
  localEmailAuthCredentials,
  passwordResetDeliveryArtifacts,
  passwordResetRequests,
} from '../db/schema';
import {
  DEFAULT_PASSWORD_RESET_TTL_MS,
  PasswordResetConfirmError,
  type PasswordResetCompletionInput,
  type PasswordResetCompletionResult,
  type PasswordResetCompletionService,
  createPasswordResetDeliveryArtifact,
  createPasswordResetToken,
  digestPasswordResetToken,
  type PasswordResetConfirmInput,
  type PasswordResetConfirmResult,
  type PasswordResetRequestInput,
  type PasswordResetRequestResult,
  type PasswordResetService,
  type PasswordResetServiceOptions,
} from './password-reset';
import { hashLocalEmailPassword } from './email-auth';

type Db = {
  insert: Function;
  select: Function;
  update: Function;
  transaction: Function;
};

function invalidOrExpiredToken(): PasswordResetConfirmError {
  return new PasswordResetConfirmError(
    'invalid_or_expired_token',
    'Password reset token is invalid or expired.'
  );
}

/** The one definition of a redeemable token: this email, this digest, still pending, unexpired. */
function redeemableRequest(emailNormalized: string, tokenDigest: string, now: Date) {
  return and(
    eq(passwordResetRequests.emailNormalized, emailNormalized),
    eq(passwordResetRequests.tokenDigest, tokenDigest),
    eq(passwordResetRequests.status, 'pending'),
    gt(passwordResetRequests.expiresAt, now)
  );
}

export type PostgresPasswordResetServiceHooks = {
  afterTokenConsumption?: () => void | Promise<void>;
  afterSessionRevocation?: () => void | Promise<void>;
};

export class PostgresPasswordResetService
  implements PasswordResetService, PasswordResetCompletionService
{
  constructor(
    private readonly db: Db,
    private readonly options: PasswordResetServiceOptions = {},
    private readonly hooks: PostgresPasswordResetServiceHooks = {}
  ) {}

  async request(input: PasswordResetRequestInput): Promise<PasswordResetRequestResult> {
    const requestedAt = this.options.now?.() ?? new Date();
    const ttlMs = this.options.ttlMs ?? DEFAULT_PASSWORD_RESET_TTL_MS;
    const expiresAt = new Date(requestedAt.getTime() + ttlMs);
    const resetToken = this.options.tokenFactory?.() ?? createPasswordResetToken();
    const expiresAtIso = expiresAt.toISOString();
    const [row] = await this.db
      .insert(passwordResetRequests)
      .values({
        id: this.options.requestIdFactory?.() ?? randomUUID(),
        emailNormalized: input.emailNormalized,
        status: 'pending',
        tokenDigest: digestPasswordResetToken(resetToken),
        requestedAt,
        expiresAt,
      })
      .returning({ id: passwordResetRequests.id });
    const deliveryArtifact = createPasswordResetDeliveryArtifact({
      requestId: row.id,
      emailNormalized: input.emailNormalized,
      resetToken,
      expiresAt: expiresAtIso,
      createdAt: requestedAt.toISOString(),
      resetUrlBase: this.options.resetUrlBase,
    });

    await this.db.insert(passwordResetDeliveryArtifacts).values({
      requestId: deliveryArtifact.requestId,
      emailNormalized: deliveryArtifact.emailNormalized,
      channel: deliveryArtifact.channel,
      resetToken: deliveryArtifact.resetToken,
      resetUrl: deliveryArtifact.resetUrl,
      expiresAt,
      createdAt: requestedAt,
    });
    await this.options.deliveryGateway?.send({
      requestId: deliveryArtifact.requestId,
      emailNormalized: deliveryArtifact.emailNormalized,
      resetUrl: deliveryArtifact.resetUrl,
      expiresAt: deliveryArtifact.expiresAt,
    });

    return {
      requestId: row.id,
      resetToken,
      expiresAt: expiresAtIso,
    };
  }

  async confirm(input: PasswordResetConfirmInput): Promise<PasswordResetConfirmResult> {
    const now = this.options.now?.() ?? new Date();
    const tokenDigest = digestPasswordResetToken(input.token);

    const [row] = await this.db
      .update(passwordResetRequests)
      .set({ status: 'consumed', consumedAt: now })
      .where(redeemableRequest(input.emailNormalized, tokenDigest, now))
      .returning({ id: passwordResetRequests.id });

    if (!row) {
      throw invalidOrExpiredToken();
    }

    return { requestId: row.id };
  }

  async confirmAndUpdatePassword(
    input: PasswordResetCompletionInput
  ): Promise<PasswordResetCompletionResult> {
    const tokenDigest = digestPasswordResetToken(input.token);
    const now = this.options.now?.() ?? new Date();

    // Argon2id is deliberately expensive (64 MiB, tens of ms), so a request with an
    // unknown, expired or used token is turned away by this cheap read before any
    // hashing. The read decides nothing: the conditional UPDATE inside the transaction
    // below is still the only step that consumes a token.
    const [redeemable] = await this.db
      .select({ id: passwordResetRequests.id })
      .from(passwordResetRequests)
      .where(redeemableRequest(input.emailNormalized, tokenDigest, now))
      .limit(1);
    if (!redeemable) {
      throw invalidOrExpiredToken();
    }

    // Hash outside the transaction so the row lock is held only for the three updates.
    const passwordHash = await hashLocalEmailPassword(input.newPassword);

    return this.db.transaction(async (tx: Db) => {
      const [request] = await tx
        .update(passwordResetRequests)
        .set({ status: 'consumed', consumedAt: now })
        .where(redeemableRequest(input.emailNormalized, tokenDigest, now))
        .returning({ id: passwordResetRequests.id });

      if (!request) {
        throw invalidOrExpiredToken();
      }

      await this.hooks.afterTokenConsumption?.();

      const [credential] = await tx
        .update(localEmailAuthCredentials)
        .set({ passwordHash, updatedAt: now })
        .where(eq(localEmailAuthCredentials.emailNormalized, input.emailNormalized))
        .returning({ authUid: localEmailAuthCredentials.authUid });

      if (!credential) {
        throw new PasswordResetConfirmError(
          'account_not_found',
          'No local email/password account exists for this email.'
        );
      }

      await tx
        .update(authSessions)
        .set({ revokedAt: now })
        .where(and(eq(authSessions.authUid, credential.authUid), isNull(authSessions.revokedAt)));

      await this.hooks.afterSessionRevocation?.();

      return { requestId: request.id, authUid: credential.authUid };
    });
  }
}
