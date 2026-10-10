import { requireOwnedTestDatabase } from './helpers/test-database';
import { afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { createApp } from '../src/app';
import { hashLocalEmailPassword } from '../src/auth/email-auth';
import { PasswordResetConfirmError } from '../src/auth/password-reset';
import {
  PostgresPasswordResetService,
  type PostgresPasswordResetServiceHooks,
} from '../src/auth/postgres-password-reset';
import { createDatabase } from '../src/db/client';

const resetSessionCreatedAtIso = '2026-07-03T12:00:00.000Z';
const resetSessionExpiresAtIso = '2030-07-03T12:00:00.000Z';

const databaseUrl = await requireOwnedTestDatabase('DATABASE_URL');
const database = createDatabase(databaseUrl);

afterAll(async () => {
  await database.close();
});

async function seedResetScenario(hooks: PostgresPasswordResetServiceHooks = {}) {
  const id = randomUUID();
  const email = `reset-${id}@local-password-reset.test`;
  const authUid = `local_email_${id}`;
  const foreignAuthUid = `foreign_email_${id}`;
  const oldPassword = 'OldPassword1!';
  const newPassword = 'NewPassword1!';
  const oldPasswordHash = await hashLocalEmailPassword(oldPassword);
  const now = new Date(resetSessionCreatedAtIso);
  const expiresAt = new Date(resetSessionExpiresAtIso);

  await database.client`
    insert into local_email_auth_credentials
      (auth_uid, email_normalized, password_hash, display_name)
    values
      (${authUid}, ${email}, ${oldPasswordHash}, 'Reset User')
  `;
  await database.client`
    insert into auth_sessions
      (id, auth_uid, refresh_token_digest, auth_provider_id, expires_at, created_at)
    values
      (${`owned-session-${id}`}, ${authUid}, ${`owned-digest-${id}`}, 'email_password', ${expiresAt.toISOString()}, ${now.toISOString()})
  `;
  await database.client`
    insert into auth_sessions
      (id, auth_uid, refresh_token_digest, auth_provider_id, expires_at, created_at)
    values
      (${`foreign-session-${id}`}, ${foreignAuthUid}, ${`foreign-digest-${id}`}, 'email_password', ${expiresAt.toISOString()}, ${now.toISOString()})
  `;

  const resetToken = `raw-reset-token-${id}`;
  const service = new PostgresPasswordResetService(
    database.db,
    {
      now: () => now,
      tokenFactory: () => resetToken,
    },
    hooks
  );
  await service.request({ emailNormalized: email });

  return {
    authUid,
    email,
    foreignAuthUid,
    newPassword,
    oldPassword,
    oldPasswordHash,
    resetToken,
    service,
  };
}

describe('Postgres password-reset confirm flow', () => {
  it('consumes once, hashes Argon2id credentials, revokes the prior session, and preserves foreign sessions', async () => {
    const app = createApp();
    const email = `reset-${randomUUID()}@local-password-reset.test`;
    const foreignAuthUid = `foreign_email_${randomUUID()}`;
    const oldPassword = 'OldPassword1!';
    const newPassword = 'NewPassword1!';

    const createResponse = await app.handle(
      new Request('http://server.test/auth/email/create-account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: oldPassword, displayName: 'Reset User' }),
      })
    );
    expect(createResponse.status).toBe(202);

    // Create-account no longer issues a session (ET-75); sign in to obtain the
    // prior session this test later proves is revoked by the reset.
    const initialSignIn = await app.handle(
      new Request('http://server.test/auth/email/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: oldPassword }),
      })
    );
    expect(initialSignIn.status).toBe(201);
    const signedIn = await initialSignIn.json();
    const oldRefreshToken = signedIn.refreshToken as string;
    const authUid = signedIn.profile.authUid as string;

    await database.client`
      insert into auth_sessions
        (id, auth_uid, refresh_token_digest, auth_provider_id, expires_at, created_at)
      values
        (${`foreign-session-${randomUUID()}`}, ${foreignAuthUid}, ${`foreign-digest-${randomUUID()}`}, 'email_password', ${resetSessionExpiresAtIso}, ${resetSessionCreatedAtIso})
    `;

    const requestResponse = await app.handle(
      new Request('http://server.test/auth/password-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      })
    );
    expect(requestResponse.status).toBe(202);

    const [artifact] = await database.client`
      select reset_token
      from password_reset_delivery_artifacts
      where email_normalized = ${email}
      order by created_at desc
      limit 1
    `;
    expect(artifact).toBeDefined();
    const resetToken = artifact.reset_token as string;

    const confirmResponse = await app.handle(
      new Request('http://server.test/auth/password-reset/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, token: resetToken, newPassword }),
      })
    );
    expect(confirmResponse.status).toBe(200);
    await expect(confirmResponse.json()).resolves.toEqual({ status: 'reset' });

    const sessions = await database.client`
      select auth_uid, revoked_at
      from auth_sessions
      where auth_uid in (${authUid}, ${foreignAuthUid})
      order by auth_uid
    `;
    const ownedSessions = sessions.filter((session) => session.auth_uid === authUid);
    const foreignSessions = sessions.filter((session) => session.auth_uid === foreignAuthUid);
    expect(ownedSessions.length).toBeGreaterThan(0);
    expect(ownedSessions.every((session) => session.revoked_at !== null)).toBe(true);
    expect(foreignSessions.length).toBe(1);
    expect(foreignSessions[0].revoked_at).toBeNull();

    const [resetRequest] = await database.client`
      select status, consumed_at
      from password_reset_requests
      where email_normalized = ${email}
      order by requested_at desc
      limit 1
    `;
    expect(resetRequest.status).toBe('consumed');
    expect(resetRequest.consumed_at).not.toBeNull();

    const [credential] = await database.client`
      select password_hash
      from local_email_auth_credentials
      where auth_uid = ${authUid}
    `;
    expect(credential.password_hash).toMatch(/^\$argon2id\$/);

    const oldPasswordSignIn = await app.handle(
      new Request('http://server.test/auth/email/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: oldPassword }),
      })
    );
    expect(oldPasswordSignIn.status).toBe(401);

    const newPasswordSignIn = await app.handle(
      new Request('http://server.test/auth/email/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: newPassword }),
      })
    );
    expect(newPasswordSignIn.status).toBe(201);

    const replayResetToken = await app.handle(
      new Request('http://server.test/auth/password-reset/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, token: resetToken, newPassword: 'AnotherPassword1!' }),
      })
    );
    expect(replayResetToken.status).toBe(400);

    const refreshResponse = await app.handle(
      new Request('http://server.test/auth/session/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: oldRefreshToken }),
      })
    );
    expect(refreshResponse.status).toBe(401);
  });

  it('rolls back token consumption when failure is injected immediately after the token CAS', async () => {
    const injectedFailure = new Error('injected_after_token_consumption');
    const scenario = await seedResetScenario({
      afterTokenConsumption: () => {
        throw injectedFailure;
      },
    });

    await expect(
      scenario.service.confirmAndUpdatePassword({
        emailNormalized: scenario.email,
        token: scenario.resetToken,
        newPassword: scenario.newPassword,
      })
    ).rejects.toBe(injectedFailure);

    const [resetRequest] = await database.client`
      select status, consumed_at
      from password_reset_requests
      where email_normalized = ${scenario.email}
    `;
    expect(resetRequest).toMatchObject({ status: 'pending', consumed_at: null });

    const [credential] = await database.client`
      select password_hash
      from local_email_auth_credentials
      where auth_uid = ${scenario.authUid}
    `;
    expect(credential.password_hash).toBe(scenario.oldPasswordHash);
    expect(await Bun.password.verify(scenario.oldPassword, credential.password_hash)).toBe(true);
    expect(await Bun.password.verify(scenario.newPassword, credential.password_hash)).toBe(false);

    const sessions = await database.client`
      select auth_uid, revoked_at
      from auth_sessions
      where auth_uid in (${scenario.authUid}, ${scenario.foreignAuthUid})
      order by auth_uid
    `;
    expect(sessions.every((session) => session.revoked_at === null)).toBe(true);
  });

  it('rolls back token, password, and sessions when failure is injected before commit', async () => {
    const injectedFailure = new Error('injected_before_commit');
    const scenario = await seedResetScenario({
      afterSessionRevocation: () => {
        throw injectedFailure;
      },
    });

    await expect(
      scenario.service.confirmAndUpdatePassword({
        emailNormalized: scenario.email,
        token: scenario.resetToken,
        newPassword: scenario.newPassword,
      })
    ).rejects.toBe(injectedFailure);

    const [resetRequest] = await database.client`
      select status, consumed_at
      from password_reset_requests
      where email_normalized = ${scenario.email}
    `;
    expect(resetRequest).toMatchObject({ status: 'pending', consumed_at: null });

    const [credential] = await database.client`
      select password_hash
      from local_email_auth_credentials
      where auth_uid = ${scenario.authUid}
    `;
    expect(credential.password_hash).toBe(scenario.oldPasswordHash);
    expect(await Bun.password.verify(scenario.oldPassword, credential.password_hash)).toBe(true);
    expect(await Bun.password.verify(scenario.newPassword, credential.password_hash)).toBe(false);

    const sessions = await database.client`
      select auth_uid, revoked_at
      from auth_sessions
      where auth_uid in (${scenario.authUid}, ${scenario.foreignAuthUid})
      order by auth_uid
    `;
    expect(sessions.every((session) => session.revoked_at === null)).toBe(true);
  });

  it('rolls back token consumption when the matching local account is absent', async () => {
    const email = `missing-${randomUUID()}@local-password-reset.test`;
    const resetToken = `raw-reset-token-${randomUUID()}`;
    const service = new PostgresPasswordResetService(database.db, {
      now: () => new Date('2026-07-03T12:00:00.000Z'),
      tokenFactory: () => resetToken,
    });
    await service.request({ emailNormalized: email });

    await expect(
      service.confirmAndUpdatePassword({
        emailNormalized: email,
        token: resetToken,
        newPassword: 'NewPassword1!',
      })
    ).rejects.toMatchObject({ code: 'account_not_found' });

    const [resetRequest] = await database.client`
      select status, consumed_at
      from password_reset_requests
      where email_normalized = ${email}
    `;
    expect(resetRequest).toMatchObject({ status: 'pending', consumed_at: null });
  });

  it('answers a valid token for an email without an account exactly like a bad token over HTTP', async () => {
    const app = createApp();
    const email = `missing-http-${randomUUID()}@local-password-reset.test`;

    const requestResponse = await app.handle(
      new Request('http://server.test/auth/password-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      })
    );
    expect(requestResponse.status).toBe(202);

    const [artifact] = await database.client`
      select reset_token
      from password_reset_delivery_artifacts
      where email_normalized = ${email}
      order by created_at desc
      limit 1
    `;
    expect(artifact).toBeDefined();

    const confirmResponse = await app.handle(
      new Request('http://server.test/auth/password-reset/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          token: artifact.reset_token as string,
          newPassword: 'NewPassword1!',
        }),
      })
    );
    expect(confirmResponse.status).toBe(400);
    await expect(confirmResponse.json()).resolves.toEqual({
      error: {
        code: 'invalid_or_expired_token',
        message: 'Password reset token is invalid or expired.',
      },
    });

    const [resetRequest] = await database.client`
      select status, consumed_at
      from password_reset_requests
      where email_normalized = ${email}
    `;
    expect(resetRequest).toMatchObject({ status: 'pending', consumed_at: null });
  });

  it('allows exactly one concurrent confirmation and commits one password update', async () => {
    const scenario = await seedResetScenario();
    const input = {
      emailNormalized: scenario.email,
      token: scenario.resetToken,
      newPassword: scenario.newPassword,
    };

    const outcomes = await Promise.allSettled([
      scenario.service.confirmAndUpdatePassword(input),
      scenario.service.confirmAndUpdatePassword(input),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(PasswordResetConfirmError);
    expect(rejected[0].reason.code).toBe('invalid_or_expired_token');

    const [resetRequest] = await database.client`
      select status, consumed_at
      from password_reset_requests
      where email_normalized = ${scenario.email}
    `;
    expect(resetRequest.status).toBe('consumed');
    expect(resetRequest.consumed_at).not.toBeNull();

    const [credential] = await database.client`
      select password_hash
      from local_email_auth_credentials
      where auth_uid = ${scenario.authUid}
    `;
    expect(credential.password_hash).toMatch(/^\$argon2id\$/);
    expect(await Bun.password.verify(scenario.newPassword, credential.password_hash)).toBe(true);

    const sessions = await database.client`
      select auth_uid, revoked_at
      from auth_sessions
      where auth_uid in (${scenario.authUid}, ${scenario.foreignAuthUid})
      order by auth_uid
    `;
    const ownedSessions = sessions.filter((session) => session.auth_uid === scenario.authUid);
    const foreignSessions = sessions.filter((session) => session.auth_uid === scenario.foreignAuthUid);
    expect(ownedSessions.every((session) => session.revoked_at !== null)).toBe(true);
    expect(foreignSessions.every((session) => session.revoked_at === null)).toBe(true);
  });

  it('accepts exactly one of two simultaneous HTTP confirms of the same token', async () => {
    // Seeds the account and one active session; the scenario's own reset request is
    // ignored because the route below runs on the real clock.
    const scenario = await seedResetScenario();
    const app = createApp();

    const requestResponse = await app.handle(
      new Request('http://server.test/auth/password-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: scenario.email }),
      })
    );
    expect(requestResponse.status).toBe(202);
    const [artifact] = await database.client`
      select request_id, reset_token
      from password_reset_delivery_artifacts
      where email_normalized = ${scenario.email}
      order by created_at desc
      limit 1
    `;
    expect(artifact).toBeDefined();

    const confirm = (newPassword: string) =>
      app.handle(
        new Request('http://server.test/auth/password-reset/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: scenario.email,
            token: artifact.reset_token as string,
            newPassword,
          }),
        })
      );
    const responses = await Promise.all([confirm('FirstPassword1!'), confirm('SecondPassword1!')]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 400]);
    const loser = responses.find((response) => response.status === 400)!;
    await expect(loser.json()).resolves.toEqual({
      error: {
        code: 'invalid_or_expired_token',
        message: 'Password reset token is invalid or expired.',
      },
    });

    const [resetRequest] = await database.client`
      select status
      from password_reset_requests
      where id = ${artifact.request_id as string}
    `;
    expect(resetRequest.status).toBe('consumed');

    const [credential] = await database.client`
      select password_hash
      from local_email_auth_credentials
      where auth_uid = ${scenario.authUid}
    `;
    const firstWon = await Bun.password.verify('FirstPassword1!', credential.password_hash);
    const secondWon = await Bun.password.verify('SecondPassword1!', credential.password_hash);
    expect([firstWon, secondWon].filter(Boolean)).toHaveLength(1);

    const sessions = await database.client`
      select auth_uid, revoked_at
      from auth_sessions
      where auth_uid in (${scenario.authUid}, ${scenario.foreignAuthUid})
    `;
    const ownedSessions = sessions.filter((session) => session.auth_uid === scenario.authUid);
    const foreignSessions = sessions.filter((session) => session.auth_uid === scenario.foreignAuthUid);
    expect(ownedSessions.length).toBeGreaterThan(0);
    expect(ownedSessions.every((session) => session.revoked_at !== null)).toBe(true);
    expect(foreignSessions.every((session) => session.revoked_at === null)).toBe(true);
  });
});
