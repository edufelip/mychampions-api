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

describe('meal photo analysis API', () => {
  it('uses the opt-in local mock analyzer when configured for local development', async () => {
    const previousAnalyzer = process.env.MEAL_PHOTO_ANALYZER;
    process.env.MEAL_PHOTO_ANALYZER = 'local_mock';
    try {
      const app = createApp({
        profileRepository: makeProfileRepository(),
      } as any);
      const session = await issueSession(app);

      const response = await app.handle(
        new Request('http://server.test/nutrition/meal-photo-analysis', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${session.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            image: 'local-dev-base64-jpeg==',
            mimeType: 'image/jpeg',
          }),
        })
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        calories: 420,
        carbs: 48,
        proteins: 24,
        fats: 14,
        totalGrams: 300,
        confidence: 'low',
      });
    } finally {
      if (previousAnalyzer === undefined) {
        delete process.env.MEAL_PHOTO_ANALYZER;
      } else {
        process.env.MEAL_PHOTO_ANALYZER = previousAnalyzer;
      }
    }
  });

  it('analyzes an authenticated meal photo through the configured analyzer', async () => {
    const captured: unknown[] = [];
    const app = createApp({
      profileRepository: makeProfileRepository(),
      mealPhotoAnalyzer: {
        async analyze(input: unknown) {
          captured.push(input);
          return {
            calories: 520,
            carbs: 60,
            proteins: 25,
            fats: 18,
            totalGrams: 350,
            confidence: 'high',
          };
        },
      },
    } as any);
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/nutrition/meal-photo-analysis', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          image: 'base64-jpeg==',
          mimeType: 'image/jpeg',
        }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      calories: 520,
      carbs: 60,
      proteins: 25,
      fats: 18,
      totalGrams: 350,
      confidence: 'high',
    });
    expect(captured).toEqual([
      {
        base64Image: 'base64-jpeg==',
        mimeType: 'image/jpeg',
      },
    ]);
  });

  it('rejects unauthenticated meal photo analysis before analyzer execution', async () => {
    const app = createApp({
      profileRepository: makeProfileRepository(),
      mealPhotoAnalyzer: {
        async analyze() {
          throw new Error('analyzer should not be called for rejected requests');
        },
      },
    } as any);

    const response = await app.handle(
      new Request('http://server.test/nutrition/meal-photo-analysis', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          image: 'base64-jpeg==',
          mimeType: 'image/jpeg',
        }),
      })
    );

    expect(response.status).toBe(401);
  });

  it('rejects oversized meal photo payloads before analyzer execution', async () => {
    const app = createApp({
      profileRepository: makeProfileRepository(),
      mealPhotoAnalyzer: {
        async analyze() {
          throw new Error('analyzer should not be called for oversized requests');
        },
      },
    } as any);
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/nutrition/meal-photo-analysis', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          image: 'a'.repeat(6_000_001),
          mimeType: 'image/jpeg',
        }),
      })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'file_too_large',
        message: 'Meal photo analysis image must be 6000000 base64 characters or fewer.',
      },
    });
  });

  it('rejects blank meal photo payloads before analyzer execution', async () => {
    const app = createApp({
      profileRepository: makeProfileRepository(),
      mealPhotoAnalyzer: {
        async analyze() {
          throw new Error('analyzer should not be called for blank requests');
        },
      },
    } as any);
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/nutrition/meal-photo-analysis', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          image: '   ',
          mimeType: 'image/jpeg',
        }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_image',
        message: 'Meal photo analysis image must be a non-empty base64 JPEG string.',
      },
    });
  });
});
