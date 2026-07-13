import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

import type { ServerConfig } from '../config';

export type SocialAuthProvider = 'google' | 'apple';

export type SocialAuthInput = {
  provider: SocialAuthProvider;
  idToken: string;
  accessToken?: string;
  nonce?: string;
};

export type SocialAuthIdentity = {
  provider: SocialAuthProvider;
  providerSubject: string;
  email: string | null;
  displayName: string | null;
  emailVerified: boolean;
};

export type SocialAuthGateway = {
  signInWithIdToken(input: SocialAuthInput): Promise<SocialAuthIdentity>;
};

export type SocialAuthGatewayErrorCode = 'configuration' | 'invalid_credentials' | 'provider_conflict';

export class SocialAuthGatewayError extends Error {
  readonly code: SocialAuthGatewayErrorCode;

  constructor(code: SocialAuthGatewayErrorCode, message: string) {
    super(message);
    this.name = 'SocialAuthGatewayError';
    this.code = code;
  }
}

export type VerifiedSocialToken = {
  subject: string;
  email: string | null;
  displayName: string | null;
  emailVerified: boolean;
};

export type VerifySocialIdToken = (input: {
  provider: SocialAuthProvider;
  idToken: string;
  audiences: string[];
  nonce?: string;
}) => Promise<VerifiedSocialToken>;

export class UnconfiguredSocialAuthGateway implements SocialAuthGateway {
  async signInWithIdToken(): Promise<SocialAuthIdentity> {
    throw new SocialAuthGatewayError(
      'configuration',
      'Social auth provider is not configured for this local server.'
    );
  }
}

export class DirectSocialAuthGateway implements SocialAuthGateway {
  constructor(
    private readonly audiences: Record<SocialAuthProvider, string[]>,
    private readonly verifyIdToken: VerifySocialIdToken
  ) {}

  async signInWithIdToken(input: SocialAuthInput): Promise<SocialAuthIdentity> {
    const audiences = this.audiences[input.provider];
    if (audiences.length === 0) {
      throw new SocialAuthGatewayError(
        'configuration',
        `${input.provider} sign-in is not configured for this server.`
      );
    }

    try {
      const token = await this.verifyIdToken({
        provider: input.provider,
        idToken: input.idToken,
        audiences,
        nonce: input.nonce,
      });
      return {
        provider: input.provider,
        providerSubject: token.subject,
        email: token.email,
        displayName: token.displayName,
        emailVerified: token.emailVerified,
      };
    } catch (error) {
      if (error instanceof SocialAuthGatewayError) {
        throw error;
      }
      throw new SocialAuthGatewayError('invalid_credentials', 'Invalid social auth token.');
    }
  }
}

export function createSocialAuthGateway(
  config: ServerConfig,
  options: { verifyIdToken?: VerifySocialIdToken } = {}
): SocialAuthGateway {
  const audiences = {
    google: config.googleClientIds,
    apple: config.appleClientIds,
  };
  if (audiences.google.length === 0 && audiences.apple.length === 0) {
    return new UnconfiguredSocialAuthGateway();
  }

  return new DirectSocialAuthGateway(audiences, options.verifyIdToken ?? verifySocialIdToken);
}

const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

const verifySocialIdToken = createSocialIdTokenVerifier({
  google: googleJwks,
  apple: appleJwks,
});

export function createSocialIdTokenVerifier(
  jwks: Record<SocialAuthProvider, JWTVerifyGetKey>
): VerifySocialIdToken {
  return async (input) => {
    const { payload } = await jwtVerify(input.idToken, jwks[input.provider], {
      issuer:
        input.provider === 'google'
          ? ['https://accounts.google.com', 'accounts.google.com']
          : 'https://appleid.apple.com',
      audience: input.audiences,
    });
    const subject = nonEmptyString(payload.sub);
    const email = nonEmptyString(payload.email);
    const emailVerified = isEmailVerified(payload.email_verified);
    const nonce = nonEmptyString(payload.nonce);
    if (
      !subject ||
      (input.provider === 'google' && (!email || !emailVerified)) ||
      (email !== null && !emailVerified)
    ) {
      throw new SocialAuthGatewayError('invalid_credentials', 'Invalid social auth token.');
    }
    if (input.nonce && nonce !== input.nonce) {
      throw new SocialAuthGatewayError('invalid_credentials', 'Invalid social auth token.');
    }

    return {
      subject,
      email,
      displayName: nonEmptyString(payload.name) ?? (email ? email.split('@')[0] : null),
      emailVerified: email !== null && emailVerified,
    };
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isEmailVerified(value: unknown): boolean {
  return value === true || value === 'true';
}
