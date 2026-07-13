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

describe('food search API', () => {
  it('searches foods through an authenticated server-side gateway', async () => {
    const captured: unknown[] = [];
    const app = createApp({
      profileRepository: makeProfileRepository(),
      foodSearchGateway: {
        async search(input: unknown) {
          captured.push(input);
          return [
            {
              id: '39727',
              name: 'White Rice',
              carbohydrate: 28.73,
              protein: 2.36,
              fat: 0.19,
              serving: 100,
            },
          ];
        },
      },
    } as any);
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/integrations/food/search', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          query: 'rice',
          maxResults: 7,
          region: 'br',
          language: 'pt',
        }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      results: [
        {
          id: '39727',
          name: 'White Rice',
          carbohydrate: 28.73,
          protein: 2.36,
          fat: 0.19,
          serving: 100,
        },
      ],
    });
    expect(captured).toEqual([
      {
        authUid: session.profile.authUid,
        query: 'rice',
        maxResults: 7,
        region: 'br',
        language: 'pt',
      },
    ]);
  });

  it('rejects unauthenticated food search before gateway execution', async () => {
    const app = createApp({
      profileRepository: makeProfileRepository(),
      foodSearchGateway: {
        async search() {
          throw new Error('gateway should not be called for rejected requests');
        },
      },
    } as any);

    const response = await app.handle(
      new Request('http://server.test/integrations/food/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: 'rice',
          maxResults: 7,
          region: 'br',
          language: 'pt',
        }),
      })
    );

    expect(response.status).toBe(401);
  });
});
