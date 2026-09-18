import { describe, expect, it } from 'bun:test';

import { createApp } from '../src/app';
import type { ProfileRepository } from '../src/profile/repository';
import type {
  CreateSupportMessageInput,
  SupportMessageRepository,
  SupportMessageSubmission,
  SubmitSupportMessageInput,
} from '../src/support/repository';

function makeProfileRepository(): ProfileRepository {
  return {
    async upsertFromSession(input) {
      return {
        authUid: input.authUid,
        displayName: input.displayName,
        emailNormalized: input.emailNormalized,
        lockedRole: null,
        acceptedTermsVersion: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
    },
    async findByAuthUid() {
      return null;
    },
    async lockRole() {
      throw new Error('not implemented');
    },
    async setAcceptedTermsVersion() {
      throw new Error('not implemented');
    },
    async deleteByAuthUid() {},
  };
}

function makeSupportRepository() {
  const saved: CreateSupportMessageInput[] = [];
  let nextSubmission: SupportMessageSubmission | null = null;
  const repository: SupportMessageRepository = {
    async create(input) {
      saved.push(input);
      return {
        id: `support-${saved.length}`,
        ...input,
        status: 'pending',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
    },
    async submit(input: SubmitSupportMessageInput) {
      if (nextSubmission) return nextSubmission;
      const { idempotencyKey: _idempotencyKey, ...createInput } = input;
      return { kind: 'created', message: await repository.create(createInput) };
    },
  };
  return {
    repository,
    saved,
    limitNextSubmission(retryAfterSeconds: number) {
      nextSubmission = { kind: 'limited', retryAfterSeconds };
    },
    replayNextSubmission() {
      nextSubmission = {
        kind: 'replayed',
        message: {
          id: 'support-1',
          authUid: 'uid-1',
          userEmail: 'support@example.test',
          userName: 'Support User',
          userRole: 'student',
          subject: 'Login issue',
          body: 'I cannot sign in.',
          appVersion: '1.0.0',
          platform: 'ios',
          status: 'pending',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      };
    },
  };
}

async function issueSession(app: ReturnType<typeof createApp>) {
  const sessionResponse = await app.handle(
    new Request('http://server.test/auth/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'Support@Example.test',
        displayName: 'Support User',
      }),
    })
  );
  return sessionResponse.json() as Promise<{ accessToken: string; profile: { authUid: string } }>;
}

describe('support messages API', () => {
  it('stores a trimmed authenticated support message with pending status metadata', async () => {
    const support = makeSupportRepository();
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository: support.repository,
    });
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/support/messages', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
          'idempotency-key': 'support-request-key-0001',
        },
        body: JSON.stringify({
          subject: '  Login issue  ',
          body: '  I cannot sign in.  ',
          userRole: 'student',
          appVersion: '1.0.0',
          platform: 'ios',
        }),
      })
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ id: 'support-1' });
    expect(support.saved).toEqual([
      {
        authUid: session.profile.authUid,
        userEmail: 'support@example.test',
        userName: 'Support User',
        userRole: 'student',
        subject: 'Login issue',
        body: 'I cannot sign in.',
        appVersion: '1.0.0',
        platform: 'ios',
      },
    ]);
  });

  it('returns the original response for an idempotent replay without another create', async () => {
    const support = makeSupportRepository();
    support.replayNextSubmission();
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository: support.repository,
    });
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/support/messages', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
          'idempotency-key': 'support-request-key-0002',
        },
        body: JSON.stringify({
          subject: 'Login issue',
          body: 'I cannot sign in.',
          appVersion: '1.0.0',
          platform: 'ios',
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: 'support-1' });
    expect(support.saved).toEqual([]);
  });

  it('returns a typed 429 with an accurate retry header and creates no support row', async () => {
    const support = makeSupportRepository();
    support.limitNextSubmission(873);
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository: support.repository,
    });
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/support/messages', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
          'idempotency-key': 'support-request-key-0003',
        },
        body: JSON.stringify({
          subject: 'Login issue',
          body: 'I cannot sign in.',
          appVersion: '1.0.0',
          platform: 'ios',
        }),
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('873');
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'support_rate_limited',
        message: 'Support message rate limit reached. Try again later.',
      },
    });
    expect(support.saved).toEqual([]);
  });

  it('rejects support messages without bearer auth', async () => {
    const support = makeSupportRepository();
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository: support.repository,
    });

    const response = await app.handle(
      new Request('http://server.test/support/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: 'Login issue',
          body: 'I cannot sign in.',
          appVersion: '1.0.0',
          platform: 'web',
        }),
      })
    );

    expect(response.status).toBe(401);
    expect(support.saved).toEqual([]);
  });
});
