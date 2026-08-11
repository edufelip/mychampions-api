import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createApp } from '../src/app';

const packageJson = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as {
  packageManager?: string;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'app.ts'), 'utf8');
const emailAuthSource = readFileSync(join(import.meta.dir, '..', 'src', 'auth', 'email-auth.ts'), 'utf8');
const socialAuthSource = readFileSync(join(import.meta.dir, '..', 'src', 'auth', 'social-auth.ts'), 'utf8');
const passwordResetDeliverySource = readFileSync(
  join(import.meta.dir, '..', 'src', 'auth', 'password-reset-delivery.ts'),
  'utf8'
);
const mealImageStorageSource = readFileSync(
  join(import.meta.dir, '..', 'src', 'nutrition', 'meal-image-storage.ts'),
  'utf8'
);
const envExample = readFileSync(join(import.meta.dir, '..', '.env.example'), 'utf8');
const readme = readFileSync(join(import.meta.dir, '..', 'README.md'), 'utf8');
const bunVersionFile = readFileSync(join(import.meta.dir, '..', '.bun-version'), 'utf8').trim();

describe('local server stack contract', () => {
  it('reports the active Bun runtime version from /health', async () => {
    const app = createApp();
    const response = await app.handle(new Request('http://server.test/health'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      service: 'mychampions-server',
      runtime: {
        bunVersion: Bun.version,
      },
    });
  });

  it('pins the requested Bun/Elysia/Drizzle runtime lines', () => {
    expect(packageJson.packageManager).toBe('bun@1.3.14');
    expect(packageJson.engines?.bun).toBe('1.3.14');
    expect(bunVersionFile).toBe('1.3.14');
    expect(packageJson.dependencies?.elysia).toBe('~1.4.0');
    expect(packageJson.dependencies?.['@elysiajs/bearer']).toBe('~1.4.0');
    expect(packageJson.dependencies?.['@elysiajs/jwt']).toBe('~1.4.0');
    expect(packageJson.dependencies?.['@sinclair/typebox']).toMatch(/^~0\.34\./);
    expect(packageJson.dependencies?.['@supabase/supabase-js']).toBeUndefined();
    expect(packageJson.dependencies?.['drizzle-orm']).toBe('~0.45.0');
    expect(packageJson.dependencies?.jose).toMatch(/^~6\./);
    expect(packageJson.dependencies?.postgres).toMatch(/^~3\.4\./);
    expect(packageJson.devDependencies?.['drizzle-kit']).toMatch(/^~0\.31\./);
  });

  it('documents local server commands with Bun as the package manager', () => {
    const localSetupSection = readme.slice(
      readme.indexOf('## Local Setup'),
      readme.indexOf('## Current API Slice')
    );

    expect(localSetupSection).toContain('bun run local:db:up');
    expect(localSetupSection).toContain('bun run server:db:migrate');
    expect(localSetupSection).toContain('bun run server:test');
    expect(localSetupSection).toContain('bun run server:dev');
    expect(localSetupSection).not.toContain('npm run ');
  });

  it('derives protected route auth from the Elysia bearer plugin', () => {
    expect(appSource).toContain('.use(bearer())');
    expect(appSource).toContain('.derive(async ({ bearer, cookie, set }) =>');
    expect(appSource).not.toContain('function bearerToken');
    expect(appSource).not.toContain('bearerToken(request.headers)');
  });

  it('configures the Elysia JWT plugin from explicit local config', () => {
    expect(appSource).toContain("jwt({ name: 'jwt', secret: config.jwtPluginSecret })");
    expect(appSource).not.toContain('unused-local-secret');
  });

  it('uses the Elysia cookie jar as local access-token transport without minting a second token format', () => {
    expect(appSource).toContain("const LOCAL_ACCESS_TOKEN_COOKIE = 'mychampions_access_token';");
    expect(appSource).toContain('cookie[LOCAL_ACCESS_TOKEN_COOKIE]');
    expect(appSource).not.toContain('jwt.sign(');
    expect(appSource).not.toContain('jwt.verify(');
  });

  it('does not retain Supabase auth or storage runtime configuration', () => {
    expect(envExample).not.toContain('SUPABASE');
    expect(readme).not.toContain('Supabase');
    expect(emailAuthSource).not.toContain('@supabase');
    expect(socialAuthSource).not.toContain('@supabase');
    expect(passwordResetDeliverySource).not.toContain('@supabase');
    expect(mealImageStorageSource).not.toContain('@supabase');
  });

  it('documents the server-owned social auth provider exchange boundary', () => {
    expect(appSource).toContain("'/auth/social/sign-in'");
    expect(readme).toContain('POST /auth/social/sign-in');
    expect(readme).toContain('verifies the token directly');
    expect(readme).toContain('Google/Apple');
    expect(readme).toContain('native Google/Apple token capture');
    expect(readme).toContain('explicit provider-token configuration gaps');
    expect(readme).not.toContain('until native Google/Apple token capture is wired');
  });

  it('documents local email/password credentials as the default local auth path', () => {
    const emailAuthSection = readme.slice(
      readme.indexOf('`POST /auth/email/sign-in`'),
      readme.indexOf('`POST /auth/social/sign-in`')
    );

    expect(readme).toContain('Local email/password auth is enabled by default');
    expect(readme).toContain('local_email_auth_credentials');
    expect(readme).not.toContain('Supabase email auth overrides');
    expect(emailAuthSection).not.toContain('By default this boundary returns `configuration` with HTTP 503');
  });

  it('documents active email and password-reset auth without naming the retired mobile auth provider', () => {
    const emailAuthStart = readme.indexOf('`POST /auth/email/sign-in` and `POST /auth/email/create-account`');
    const socialAuthStart = readme.indexOf('`POST /auth/social/sign-in`', emailAuthStart);
    const emailAuthSection = readme.slice(emailAuthStart, socialAuthStart);

    const passwordResetStart = readme.indexOf('`POST /auth/password-reset` accepts a normalized email address');
    const passwordResetSection = readme.slice(passwordResetStart, passwordResetStart + 850);

    expect(emailAuthStart).toBeGreaterThanOrEqual(0);
    expect(socialAuthStart).toBeGreaterThan(emailAuthStart);
    expect(passwordResetStart).toBeGreaterThanOrEqual(0);
    expect(emailAuthSection).toContain('verifies Argon2id credentials in local Postgres');
    expect(emailAuthSection).toContain('creates the Argon2id credential row');
    expect(passwordResetSection).toContain('provider-neutral local password-reset request');
    expect(emailAuthSection).not.toContain('Firebase Auth');
    expect(passwordResetSection).not.toContain('Firebase Auth');
  });

  it('documents the server-side local dev-session gate', () => {
    const devSessionStart = readme.indexOf('`POST /auth/dev/session` is local-only scaffolding');
    const emailAuthStart = readme.indexOf('`POST /auth/email/sign-in`', devSessionStart);
    const devSessionSection = readme.slice(
      devSessionStart,
      emailAuthStart
    );

    expect(devSessionStart).toBeGreaterThanOrEqual(0);
    expect(emailAuthStart).toBeGreaterThan(devSessionStart);
    expect(appSource).toContain('config.localDevAuthEnabled');
    expect(envExample).toContain('LOCAL_DEV_AUTH_ENABLED=true');
    expect(devSessionSection).toContain('LOCAL_DEV_AUTH_ENABLED=false');
    expect(devSessionSection).toContain('NODE_ENV=production');
    expect(devSessionSection).toContain('APP_VARIANT');
    expect(devSessionSection).toContain('unset, blank, or `dev`');
  });

  it('keeps the mobile auth summary aligned with the explicit local-dev gate', () => {
    const mobileAuthSummaryStart = readme.indexOf(
      'The mobile app posts email/password sign-in and create-account attempts'
    );
    const mobileAuthSummary = readme.slice(mobileAuthSummaryStart, mobileAuthSummaryStart + 700);

    expect(mobileAuthSummaryStart).toBeGreaterThanOrEqual(0);
    expect(mobileAuthSummary).toContain('LOCAL_DEV_AUTH_ENABLED=false');
    expect(mobileAuthSummary).toContain('NODE_ENV=production');
    expect(mobileAuthSummary).toContain('APP_VARIANT');
    expect(mobileAuthSummary).toContain('unset, blank, or `dev`');
    expect(mobileAuthSummary).not.toContain('non-production local dev-session bridge');
    expect(mobileAuthSummary).not.toContain('blocked for `APP_VARIANT=prod`');
  });

  it('keeps dev-session body validation behind the server-side local gate', () => {
    const devSessionRouteStart = appSource.indexOf("'/auth/dev/session'");
    const emailSignInRouteStart = appSource.indexOf("'/auth/email/sign-in'", devSessionRouteStart);
    const devSessionRoutes = appSource.slice(devSessionRouteStart, emailSignInRouteStart);

    expect(devSessionRouteStart).toBeGreaterThanOrEqual(0);
    expect(emailSignInRouteStart).toBeGreaterThan(devSessionRouteStart);
    expect(devSessionRoutes).toContain('parseDevSessionBody(body)');
    expect(devSessionRoutes).toContain('parseDevRefreshBody(body)');
    expect(devSessionRoutes).toContain('local_dev_auth_disabled');
    expect(devSessionRoutes).not.toContain('body: t.Object');
  });

  it('documents the server-owned subscription entitlement snapshot boundary', () => {
    expect(appSource).toContain("'/subscription/entitlements/snapshot'");
    expect(appSource).toContain("'/webhooks/revenuecat'");
    expect(envExample).toContain('REVENUECAT_WEBHOOK_AUTHORIZATION=');
    expect(envExample).toContain('REVENUECAT_WEBHOOK_SIGNING_SECRET=');
    expect(readme).toContain('POST /subscription/entitlements/snapshot');
    expect(readme).toContain('POST /webhooks/revenuecat');
    expect(readme).toContain('REVENUECAT_WEBHOOK_AUTHORIZATION');
    expect(readme).toContain('X-RevenueCat-Webhook-Signature');
    expect(readme).toContain('subscription_entitlement_snapshots');
    expect(readme).toContain('RevenueCat');
  });

  it('documents tracking-review hydration goals as server-owned', () => {
    const trackingReviewStart = readme.indexOf(
      '`GET /professional/students/:studentUid/tracking-review?todayKey=<yyyy-mm-dd>'
    );
    const trackingReviewSection = readme.slice(trackingReviewStart, trackingReviewStart + 700);

    expect(trackingReviewSection).toContain('todayKey=<yyyy-mm-dd>');
    expect(trackingReviewSection).toContain('server resolves the effective hydration goal');
    expect(trackingReviewSection).toContain('returns `waterGoalMl`');
    expect(trackingReviewSection).not.toContain('waterGoalMl=<ml>');
  });

  it('documents invite submission without legacy function fallback wording', () => {
    const inviteStart = readme.indexOf('`POST /connections/invite-submissions` accepts a student invite code');
    const inviteSection = readme.slice(inviteStart, inviteStart + 650);

    expect(inviteStart).toBeGreaterThanOrEqual(0);
    expect(inviteSection).toContain('requires this endpoint plus local server bearer auth');
    expect(inviteSection).toContain('missing local server URL/auth fails closed');
    expect(inviteSection).not.toContain('legacy governed function');
    expect(inviteSection).not.toContain('legacy function');
    expect(inviteSection).not.toContain('Cloud Function');
    expect(inviteSection).not.toContain('Firebase');
  });
});
