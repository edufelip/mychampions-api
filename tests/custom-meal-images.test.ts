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

describe('custom meal image API', () => {
  it('stores an authenticated custom meal image through the configured local storage adapter', async () => {
    const captured: unknown[] = [];
    const app = createApp({
      profileRepository: makeProfileRepository(),
      mealImageStorage: {
        async save(input: unknown) {
          captured.push(input);
          return {
            url: 'http://server.test/media/custom-meal-images/student-1/meal-1/photo.jpg',
            contentType: 'image/jpeg',
            sizeBytes: 10,
          };
        },
        async read() {
          throw new Error('not implemented');
        },
      },
    } as any);
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/nutrition/custom-meal-images/meal-1?filename=photo.jpg', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'image/jpeg',
        },
        body: new Blob(['jpeg-bytes'], { type: 'image/jpeg' }),
      })
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      url: 'http://server.test/media/custom-meal-images/student-1/meal-1/photo.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 10,
    });
    expect(captured).toEqual([
      expect.objectContaining({
        ownerAuthUid: session.profile.authUid,
        mealId: 'meal-1',
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
      }),
    ]);
  });

  it('rejects unauthenticated or non-JPEG image uploads before storage is called', async () => {
    const app = createApp({
      profileRepository: makeProfileRepository(),
      mealImageStorage: {
        async save() {
          throw new Error('storage should not be called for rejected uploads');
        },
        async read() {
          throw new Error('not implemented');
        },
      },
    } as any);
    const session = await issueSession(app);

    const unauthenticated = await app.handle(
      new Request('http://server.test/nutrition/custom-meal-images/meal-1?filename=photo.jpg', {
        method: 'POST',
        headers: { 'content-type': 'image/jpeg' },
        body: new Blob(['jpeg-bytes'], { type: 'image/jpeg' }),
      })
    );
    expect(unauthenticated.status).toBe(401);

    const invalidType = await app.handle(
      new Request('http://server.test/nutrition/custom-meal-images/meal-1?filename=photo.jpg', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'text/plain',
        },
        body: 'not-image',
      })
    );
    expect(invalidType.status).toBe(400);
  });
});
