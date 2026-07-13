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
  mealPhotoAnalyzer: 'unconfigured' | 'local_mock';
  localDevAuthEnabled: boolean;
  revenueCatWebhookAuthorization: string | null;
  revenueCatWebhookSigningSecret: string | null;
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
    production: env.NODE_ENV === 'production',
    gcsBucket: env.GCS_BUCKET?.trim() || null,
    gcsCredentialsPath: env.STORAGE_GCS_CREDENTIALS_PATH?.trim() || null,
    gcsUseAdc: env.STORAGE_GCS_USE_ADC !== 'false',
    googleClientIds: configuredValues(
      env.GOOGLE_ANDROID_CLIENT_ID,
      env.GOOGLE_IOS_CLIENT_ID,
      env.GOOGLE_WEB_CLIENT_ID
    ),
    appleClientIds: configuredValues(env.APPLE_CLIENT_ID, env.APPLE_WEB_CLIENT_ID),
    mealPhotoAnalyzer: env.MEAL_PHOTO_ANALYZER === 'local_mock' ? 'local_mock' : 'unconfigured',
    localDevAuthEnabled:
      env.LOCAL_DEV_AUTH_ENABLED !== 'false' &&
      env.NODE_ENV !== 'production' &&
      isExplicitLocalDevVariant(env.APP_VARIANT),
    revenueCatWebhookAuthorization: env.REVENUECAT_WEBHOOK_AUTHORIZATION?.trim() || null,
    revenueCatWebhookSigningSecret: env.REVENUECAT_WEBHOOK_SIGNING_SECRET?.trim() || null,
  };
}
