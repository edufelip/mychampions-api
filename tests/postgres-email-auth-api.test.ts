import { requireOwnedTestDatabase } from './helpers/test-database';
import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { createApp } from '../src/app';

// These cases exercise the Postgres-backed local email gateway through the HTTP app, so they
// run in the owned integration lane: createApp() reads the owned DATABASE_URL, never a
// developer database.
await requireOwnedTestDatabase('DATABASE_URL');

describe('email auth API (Postgres)', () => {
  it('creates local email credentials without issuing a session, then allows sign-in', async () => {
    const app = createApp();
    const email = `local-${randomUUID()}@local-email-auth.test`;
    const password = 'Password1!';

    const createResponse = await app.handle(
      new Request('http://server.test/auth/email/create-account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          displayName: 'Local Email User',
        }),
      })
    );

    expect(createResponse.status).toBe(202);
    await expect(createResponse.json()).resolves.toEqual({ status: 'accepted' });
    expect(createResponse.headers.get('set-cookie')).toBeNull();

    const signInResponse = await app.handle(
      new Request('http://server.test/auth/email/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
    );

    expect(signInResponse.status).toBe(201);
    const signInSession = await signInResponse.json();
    expect(signInSession.profile).toMatchObject({
      emailNormalized: email,
      displayName: 'Local Email User',
    });
    expect(signInSession.profile.authUid).toStartWith('local_email_');

    const invalidPasswordResponse = await app.handle(
      new Request('http://server.test/auth/email/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'WrongPassword1!' }),
      })
    );

    expect(invalidPasswordResponse.status).toBe(401);
    await expect(invalidPasswordResponse.json()).resolves.toMatchObject({
      error: { code: 'invalid_credentials' },
    });
  });

  it('responds identically to create-account for a duplicate email as for a brand-new one (ET-75)', async () => {
    const app = createApp();
    const email = `dup-${randomUUID()}@local-email-auth.test`;
    const password = 'Password1!';
    const requestBody = (overrides: Partial<Record<string, string>> = {}) =>
      JSON.stringify({
        email,
        password,
        displayName: 'Local Email User',
        ...overrides,
      });

    const firstResponse = await app.handle(
      new Request('http://server.test/auth/email/create-account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: requestBody(),
      })
    );

    // A second signup attempt against the same email must be indistinguishable from
    // the first: same status code, same body shape, and no session/cookie leak that
    // would let a caller infer "this email already had an account".
    const secondResponse = await app.handle(
      new Request('http://server.test/auth/email/create-account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: requestBody({ password: 'SomeOtherPassword1!' }),
      })
    );

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);
    expect(secondResponse.status).toBe(firstResponse.status);

    const firstBody = await firstResponse.json();
    const secondBody = await secondResponse.json();
    expect(firstBody).toEqual({ status: 'accepted' });
    expect(secondBody).toEqual(firstBody);

    expect(firstResponse.headers.get('set-cookie')).toBeNull();
    expect(secondResponse.headers.get('set-cookie')).toBeNull();

    // The original account must still be reachable with its original credentials —
    // the duplicate attempt did not overwrite or otherwise disturb it.
    const signInResponse = await app.handle(
      new Request('http://server.test/auth/email/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
    );
    expect(signInResponse.status).toBe(201);

    // And the second (rejected) password must not work, proving no account takeover
    // happened via the duplicate submission.
    const impostorSignInResponse = await app.handle(
      new Request('http://server.test/auth/email/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'SomeOtherPassword1!' }),
      })
    );
    expect(impostorSignInResponse.status).toBe(401);
  });
});
