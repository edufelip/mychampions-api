import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';

import type { ServerConfig } from '../config';
import { localEmailAuthCredentials } from '../db/schema';
import type * as schema from '../db/schema';

export type EmailAuthInput = {
  email: string;
  password: string;
};

export type EmailCreateAccountInput = EmailAuthInput & {
  displayName: string;
};

export type EmailAuthIdentity = {
  authUid: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
};

export type EmailAuthUpdatePasswordInput = {
  email: string;
  newPassword: string;
};

export type EmailAuthUpdatePasswordResult = {
  authUid: string;
};

export type EmailAuthGateway = {
  signIn(input: EmailAuthInput): Promise<EmailAuthIdentity>;
  createAccount(input: EmailCreateAccountInput): Promise<EmailAuthIdentity>;
  updatePassword(input: EmailAuthUpdatePasswordInput): Promise<EmailAuthUpdatePasswordResult>;
};

export type EmailAuthGatewayErrorCode =
  | 'configuration'
  | 'invalid_credentials'
  | 'duplicate_email'
  | 'provider_conflict'
  | 'account_not_found';

export class EmailAuthGatewayError extends Error {
  readonly code: EmailAuthGatewayErrorCode;

  constructor(code: EmailAuthGatewayErrorCode, message: string) {
    super(message);
    this.name = 'EmailAuthGatewayError';
    this.code = code;
  }
}

export class UnconfiguredEmailAuthGateway implements EmailAuthGateway {
  async signIn(): Promise<EmailAuthIdentity> {
    throw new EmailAuthGatewayError(
      'configuration',
      'Email auth provider is not configured for this local server.'
    );
  }

  async createAccount(): Promise<EmailAuthIdentity> {
    throw new EmailAuthGatewayError(
      'configuration',
      'Email auth provider is not configured for this local server.'
    );
  }

  async updatePassword(): Promise<EmailAuthUpdatePasswordResult> {
    throw new EmailAuthGatewayError(
      'configuration',
      'Email auth provider is not configured for this local server.'
    );
  }
}

export class LocalEmailAuthGateway implements EmailAuthGateway {
  constructor(private readonly db: PostgresJsDatabase<typeof schema>) {}

  async signIn(input: EmailAuthInput): Promise<EmailAuthIdentity> {
    const credential = await this.findByEmail(input.email);
    if (!credential) {
      throw new EmailAuthGatewayError('invalid_credentials', 'Invalid email or password.');
    }

    const passwordMatches = await Bun.password.verify(input.password, credential.passwordHash);
    if (!passwordMatches) {
      throw new EmailAuthGatewayError('invalid_credentials', 'Invalid email or password.');
    }

    return {
      authUid: credential.authUid,
      email: credential.emailNormalized,
      displayName: credential.displayName,
      emailVerified: false,
    };
  }

  async createAccount(input: EmailCreateAccountInput): Promise<EmailAuthIdentity> {
    const existing = await this.findByEmail(input.email);
    if (existing) {
      throw new EmailAuthGatewayError('duplicate_email', 'Email is already registered.');
    }

    const authUid = `local_email_${randomUUID()}`;
    const passwordHash = await Bun.password.hash(input.password, { algorithm: 'argon2id' });
    const [credential] = await this.db
      .insert(localEmailAuthCredentials)
      .values({
        authUid,
        emailNormalized: input.email,
        passwordHash,
        displayName: input.displayName,
      })
      .returning();

    return {
      authUid: credential.authUid,
      email: credential.emailNormalized,
      displayName: credential.displayName,
      emailVerified: false,
    };
  }

  async updatePassword(input: EmailAuthUpdatePasswordInput): Promise<EmailAuthUpdatePasswordResult> {
    const passwordHash = await Bun.password.hash(input.newPassword, { algorithm: 'argon2id' });
    const [credential] = await this.db
      .update(localEmailAuthCredentials)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(localEmailAuthCredentials.emailNormalized, input.email))
      .returning();

    if (!credential) {
      throw new EmailAuthGatewayError(
        'account_not_found',
        'No local email/password account exists for this email.'
      );
    }

    return { authUid: credential.authUid };
  }

  private async findByEmail(emailNormalized: string) {
    const [credential] = await this.db
      .select()
      .from(localEmailAuthCredentials)
      .where(eq(localEmailAuthCredentials.emailNormalized, emailNormalized))
      .limit(1);

    return credential ?? null;
  }
}

export function createEmailAuthGateway(
  _config: ServerConfig,
  db?: PostgresJsDatabase<typeof schema>
): EmailAuthGateway {
  if (db) {
    return new LocalEmailAuthGateway(db);
  }

  return new UnconfiguredEmailAuthGateway();
}
