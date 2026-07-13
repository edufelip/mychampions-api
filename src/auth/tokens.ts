import { exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT, type JWK } from 'jose';

export type AuthClaims = {
  sub: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  authProviderId?: 'email_password' | 'google' | 'apple';
  sessionId?: string;
};

export const LOCAL_ACCESS_TOKEN_EXPIRES_IN_SECONDS = 60 * 60;
export const LOCAL_REFRESH_TOKEN_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60;

export type TokenService = {
  issue(input: AuthClaims): Promise<string>;
  issueRefresh(input: AuthClaims): Promise<string>;
  verify(token: string): Promise<AuthClaims>;
  verifyRefresh(token: string): Promise<AuthClaims>;
  jwks(): Promise<{ keys: JWK[] }>;
};

export function createTokenService(options: {
  issuer: string;
  audience: string;
  keyId?: string;
  signingKey?: JWK;
  signingKeyLoader?: () => Promise<JWK>;
  requireConfiguredSigningKey?: boolean;
}): TokenService {
  if (options.requireConfiguredSigningKey && !options.signingKey) {
    throw new Error('AUTH_JWT_PRIVATE_JWK is required');
  }
  const keyId = options.keyId ?? 'local-dev-key';
  const configuredSigningKeyPromise = options.signingKey
    ? Promise.resolve(options.signingKey)
    : options.signingKeyLoader
      ? options.signingKeyLoader()
      : null;
  const keyPairPromise = configuredSigningKeyPromise
    ? null
    : generateKeyPair('RS256', { extractable: true });
  const configuredPrivateKeyPromise = configuredSigningKeyPromise
    ? configuredSigningKeyPromise.then((signingKey) => importJWK(signingKey, 'RS256'))
    : null;

  async function publicJwk(): Promise<JWK> {
    if (configuredSigningKeyPromise) {
      const { d, p, q, dp, dq, qi, ...publicKey } = await configuredSigningKeyPromise;
      return {
        ...publicKey,
        alg: 'RS256',
        kid: keyId,
        use: 'sig',
      };
    }

    if (!keyPairPromise) {
      throw new Error('token_signing_key_unavailable');
    }
    const { publicKey } = await keyPairPromise;
    return {
      ...(await exportJWK(publicKey)),
      alg: 'RS256',
      kid: keyId,
      use: 'sig',
    };
  }

  return {
    async issue(input) {
      const privateKey = configuredPrivateKeyPromise
        ? await configuredPrivateKeyPromise
        : (await keyPairPromise!).privateKey;
      return new SignJWT({
        email: input.email,
        displayName: input.displayName,
        emailVerified: input.emailVerified,
        tokenUse: 'access',
      })
        .setProtectedHeader({ alg: 'RS256', kid: keyId })
        .setSubject(input.sub)
        .setIssuer(options.issuer)
        .setAudience(options.audience)
        .setIssuedAt()
        .setExpirationTime(`${LOCAL_ACCESS_TOKEN_EXPIRES_IN_SECONDS}s`)
        .sign(privateKey);
    },
    async issueRefresh(input) {
      const privateKey = configuredPrivateKeyPromise
        ? await configuredPrivateKeyPromise
        : (await keyPairPromise!).privateKey;
      return new SignJWT({
        email: input.email,
        displayName: input.displayName,
        emailVerified: input.emailVerified,
        authProviderId: input.authProviderId ?? 'email_password',
        sid: input.sessionId,
        tokenUse: 'refresh',
      })
        .setProtectedHeader({ alg: 'RS256', kid: keyId })
        .setSubject(input.sub)
        .setIssuer(options.issuer)
        .setAudience(options.audience)
        .setIssuedAt()
        .setExpirationTime(`${LOCAL_REFRESH_TOKEN_EXPIRES_IN_SECONDS}s`)
        .sign(privateKey);
    },
    async verify(token) {
      const jwk = await publicJwk();
      const key = await importJWK(jwk, 'RS256');
      const result = await jwtVerify(token, key, {
        issuer: options.issuer,
        audience: options.audience,
      });
      if (result.payload.tokenUse !== 'access') {
        throw new Error('invalid_access_token');
      }
      return {
        sub: result.payload.sub ?? '',
        email: String(result.payload.email ?? ''),
        displayName: String(result.payload.displayName ?? ''),
        emailVerified: result.payload.emailVerified === true,
      };
    },
    async verifyRefresh(token) {
      const jwk = await publicJwk();
      const key = await importJWK(jwk, 'RS256');
      const result = await jwtVerify(token, key, {
        issuer: options.issuer,
        audience: options.audience,
      });
      if (result.payload.tokenUse !== 'refresh') {
        throw new Error('invalid_refresh_token');
      }
      const authProviderId =
        result.payload.authProviderId === 'google' || result.payload.authProviderId === 'apple'
          ? result.payload.authProviderId
          : 'email_password';
      return {
        sub: result.payload.sub ?? '',
        email: String(result.payload.email ?? ''),
        displayName: String(result.payload.displayName ?? ''),
        emailVerified: result.payload.emailVerified === true,
        authProviderId,
        sessionId: typeof result.payload.sid === 'string' ? result.payload.sid : undefined,
      };
    },
    async jwks() {
      return { keys: [await publicJwk()] };
    },
  };
}
