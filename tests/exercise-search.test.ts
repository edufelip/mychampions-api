import { describe, expect, it } from 'bun:test';

import { createApp } from '../src/app';
import type { ProfileRepository } from '../src/profile/repository';

function makeProfileRepository(): ProfileRepository {
  return {
    async upsertFromSession(input) {
      return {
        authUid: input.authUid,
        displayName: input.displayName,
        emailNormalized: input.emailNormalized,
        lockedRole: 'student',
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

async function issueSession(app: ReturnType<typeof createApp>) {
  const sessionResponse = await app.handle(
    new Request('http://server.test/auth/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'Student@Example.test',
        displayName: 'Student User',
      }),
    })
  );
  return sessionResponse.json() as Promise<{ accessToken: string; profile: { authUid: string } }>;
}

const pushUp = {
  id: 'ex-push-up',
  slug: 'push-up',
  title: 'Push-Up',
  muscleGroup: 'chest',
  equipment: 'bodyweight',
  hasVideo: true,
  hasVideoWhite: false,
  hasVideoGym: true,
};

describe('exercise search API', () => {
  it('searches exercises through an authenticated server-side gateway', async () => {
    const captured: unknown[] = [];
    const app = createApp({
      profileRepository: makeProfileRepository(),
      exerciseSearchGateway: {
        async search(input: unknown) {
          captured.push(input);
          return {
            page: 1,
            pageSize: 5,
            total: 1,
            exercises: [pushUp],
          };
        },
        async getById() {
          throw new Error('detail gateway should not be called for search');
        },
      },
    } as any);
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/integrations/exercise/search', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          query: 'push',
          pageSize: 5,
          lang: 'en-US',
        }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      page: 1,
      pageSize: 5,
      total: 1,
      results: [pushUp],
    });
    expect(captured).toEqual([
      {
        authUid: session.profile.authUid,
        query: 'push',
        pageSize: 5,
        lang: 'en-US',
      },
    ]);
  });

  it('loads one exercise detail through an authenticated server-side gateway', async () => {
    const captured: unknown[] = [];
    const app = createApp({
      profileRepository: makeProfileRepository(),
      exerciseSearchGateway: {
        async search() {
          throw new Error('search gateway should not be called for detail');
        },
        async getById(input: unknown) {
          captured.push(input);
          return pushUp;
        },
      },
    } as any);
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/integrations/exercise/exercises/ex-push-up?lang=pt-BR', {
        method: 'GET',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(pushUp);
    expect(captured).toEqual([
      {
        authUid: session.profile.authUid,
        id: 'ex-push-up',
        lang: 'pt-BR',
      },
    ]);
  });

  it('rejects unauthenticated exercise search before gateway execution', async () => {
    const app = createApp({
      profileRepository: makeProfileRepository(),
      exerciseSearchGateway: {
        async search() {
          throw new Error('gateway should not be called for rejected requests');
        },
        async getById() {
          throw new Error('gateway should not be called for rejected requests');
        },
      },
    } as any);

    const response = await app.handle(
      new Request('http://server.test/integrations/exercise/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: 'push',
          pageSize: 5,
          lang: 'en-US',
        }),
      })
    );

    expect(response.status).toBe(401);
  });
});
