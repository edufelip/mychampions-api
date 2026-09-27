import type { JWK } from 'jose';

export type ServerConfig = {
  port: number;
  databaseUrl: string;
  foodCatalogDatabaseUrl: string | null;
  exerciseCatalogDatabaseUrl: string | null;
  jwtIssuer: string;
  jwtAudience: string;
  jwtPluginSecret: string;
  authJwtPrivateJwk: JWK | null;
  production: boolean;
  gcsBucket: string | null;
  gcsCredentialsPath: string | null;
  gcsUseAdc: boolean;
  googleClientIds: string[];
  appleClientIds: string[];
  allowedWebOrigins: string[];
  mealPhotoAnalyzer: 'unconfigured' | 'local_mock';
  localDevAuthEnabled: boolean;
  revenueCatSecretApiKey: string | null;
  revenueCatWebhookAuthorization: string | null;
  revenueCatWebhookSigningSecret: string | null;
  authRateLimitWindowMs: number;
  authRateLimitMax: number;
  exerciseSearchV2Enabled: boolean;
  exerciseSuggestionsEnabled: boolean;
  typesafeApiKey: string | null;
  typesafeModel: string;
  exerciseSuggestionTimeoutMs: number;
  exerciseSuggestionConfidence: number;
};

function isExplicitLocalDevVariant(appVariant: string | undefined): boolean {
  return appVariant === undefined || appVariant.trim() === '' || appVariant === 'dev';
}

function configuredValues(...values: Array<string | undefined>): string[] {
  return values.flatMap((value) =>
    value
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : []
  );
}

function readJwtPrivateJwk(value: string | undefined): JWK | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isPrivateRsaJwk(parsed)) {
      throw new Error('not_a_private_rsa_jwk');
    }
    return parsed as JWK;
  } catch {
    throw new Error('AUTH_JWT_PRIVATE_JWK must be a JSON private JWK.');
  }
}

function isPrivateRsaJwk(value: unknown): value is JWK {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const jwk = value as Record<string, unknown>;
  return (
    jwk.kty === 'RSA' &&
    typeof jwk.n === 'string' &&
    jwk.n.length > 0 &&
    typeof jwk.e === 'string' &&
    jwk.e.length > 0 &&
    typeof jwk.d === 'string' &&
    jwk.d.length > 0
  );
}

export function readConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const production = env.NODE_ENV === 'production';
  const exerciseSearchV2Enabled = readStrictBooleanEnv(
    env.EXERCISE_SEARCH_V2_ENABLED,
    false,
    'EXERCISE_SEARCH_V2_ENABLED',
  );
  const exerciseSuggestionsEnabled = readStrictBooleanEnv(
    env.EXERCISE_SUGGESTIONS_ENABLED,
    false,
    'EXERCISE_SUGGESTIONS_ENABLED',
  );
  return {
    port: Number.parseInt(env.PORT ?? '3400', 10),
    databaseUrl:
      env.DATABASE_URL ??
      'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_server_local',
    foodCatalogDatabaseUrl:
      env.FOOD_CATALOG_DATABASE_URL ??
      'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_food_catalog_local',
    exerciseCatalogDatabaseUrl:
      env.EXERCISE_CATALOG_DATABASE_URL ??
      'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_exercise_catalog_local',
    jwtIssuer: env.JWT_ISSUER ?? 'mychampions-local',
    jwtAudience: env.JWT_AUDIENCE ?? 'mychampions-mobile',
    jwtPluginSecret: env.JWT_PLUGIN_SECRET ?? 'mychampions-local-jwt-plugin-secret',
    authJwtPrivateJwk: readJwtPrivateJwk(env.AUTH_JWT_PRIVATE_JWK),
    production,
    gcsBucket: env.GCS_BUCKET?.trim() || null,
    gcsCredentialsPath: env.STORAGE_GCS_CREDENTIALS_PATH?.trim() || null,
    gcsUseAdc: env.STORAGE_GCS_USE_ADC !== 'false',
    googleClientIds: configuredValues(
      env.GOOGLE_ANDROID_CLIENT_ID,
      env.GOOGLE_IOS_CLIENT_ID,
      env.GOOGLE_WEB_CLIENT_ID
    ),
    appleClientIds: configuredValues(env.APPLE_CLIENT_ID, env.APPLE_WEB_CLIENT_ID),
    allowedWebOrigins: configuredValues(
      env.WEB_ALLOWED_ORIGINS ??
        (production ? undefined : 'http://localhost:8081,http://127.0.0.1:8081')
    ),
    mealPhotoAnalyzer: env.MEAL_PHOTO_ANALYZER === 'local_mock' ? 'local_mock' : 'unconfigured',
    localDevAuthEnabled:
      env.LOCAL_DEV_AUTH_ENABLED !== 'false' &&
      env.NODE_ENV !== 'production' &&
      isExplicitLocalDevVariant(env.APP_VARIANT),
    revenueCatSecretApiKey: env.REVENUECAT_SECRET_API_KEY?.trim() || null,
    revenueCatWebhookAuthorization: env.REVENUECAT_WEBHOOK_AUTHORIZATION?.trim() || null,
    revenueCatWebhookSigningSecret: env.REVENUECAT_WEBHOOK_SIGNING_SECRET?.trim() || null,
    authRateLimitWindowMs: readPositiveIntEnv(env.AUTH_RATE_LIMIT_WINDOW_MS, 60_000),
    authRateLimitMax: readPositiveIntEnv(env.AUTH_RATE_LIMIT_MAX, 20),
    exerciseSearchV2Enabled,
    exerciseSuggestionsEnabled,
    typesafeApiKey: env.TYPESAFE_API_KEY?.trim() || null,
    typesafeModel: env.TYPESAFE_MODEL?.trim() || 'jev-1.13.0',
    exerciseSuggestionTimeoutMs: readBoundedIntEnv(
      env.EXERCISE_SUGGESTION_TIMEOUT_MS,
      900,
      100,
      2_000,
      'EXERCISE_SUGGESTION_TIMEOUT_MS',
    ),
    exerciseSuggestionConfidence: readBoundedNumberEnv(
      env.EXERCISE_SUGGESTION_CONFIDENCE,
      0.9,
      0,
      1,
      'EXERCISE_SUGGESTION_CONFIDENCE',
    ),
  };
}

function readPositiveIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readStrictBooleanEnv(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be exactly true or false.`);
}

function readBoundedIntEnv(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/u.test(value.trim())) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  const parsed = Number.parseInt(value, 10);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function readBoundedNumberEnv(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a number between ${minimum} and ${maximum}.`);
  }
  return parsed;
}
