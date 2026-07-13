import { randomUUID } from 'node:crypto';

import { passwordResetDeliveryArtifacts, passwordResetRequests } from '../db/schema';
import {
  DEFAULT_PASSWORD_RESET_TTL_MS,
  createPasswordResetDeliveryArtifact,
  createPasswordResetToken,
  digestPasswordResetToken,
  type PasswordResetRequestInput,
  type PasswordResetRequestResult,
  type PasswordResetService,
  type PasswordResetServiceOptions,
} from './password-reset';

type Db = {
  insert: Function;
};

export class PostgresPasswordResetService implements PasswordResetService {
  constructor(
    private readonly db: Db,
    private readonly options: PasswordResetServiceOptions = {}
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
}
