import { describe, expect, it } from 'bun:test';

import { createApp } from '../src/app';
import type { ConnectionRepository } from '../src/connections/repository';
import type {
  CreateCustomMealInput,
  CustomMeal,
  CustomMealRepository,
  DeleteCustomMealInput,
  GetCustomMealInput,
  ListCustomMealsInput,
  UpdateCustomMealInput,
} from '../src/nutrition/custom-meal-repository';
import type { ProfileRepository } from '../src/profile/repository';
import type { SupportMessageRepository } from '../src/support/repository';

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

const supportMessageRepository: SupportMessageRepository = {
  async create() {
    throw new Error('not implemented');
  },
};

const connectionRepository: ConnectionRepository = {
  async listForAuthUid() {
    return [];
  },
  async getOrCreateActiveInviteCode() {
    throw new Error('not implemented');
  },
  async rotateInviteCode() {
    throw new Error('not implemented');
  },
  async submitInviteCode() {
    throw new Error('not implemented');
  },
  async confirmPendingConnection() {
    throw new Error('not implemented');
  },
  async endConnection() {
    throw new Error('not implemented');
  },
};

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

function meal(overrides: Partial<CustomMeal> = {}): CustomMeal {
  return {
    id: overrides.id ?? 'meal-1',
    ownerAuthUid: overrides.ownerAuthUid ?? 'student-1',
    name: overrides.name ?? 'Recovery Bowl',
    totalGrams: overrides.totalGrams ?? 300,
    calories: overrides.calories ?? 480,
    carbs: overrides.carbs ?? 55,
    proteins: overrides.proteins ?? 35,
    fats: overrides.fats ?? 14,
    ingredientCost: Object.prototype.hasOwnProperty.call(overrides, 'ingredientCost')
      ? overrides.ingredientCost!
      : 8.5,
    imageUrl: overrides.imageUrl ?? null,
    importedFromShareToken: overrides.importedFromShareToken ?? null,
    createdAt: overrides.createdAt ?? '2026-06-28T09:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-06-28T10:00:00.000Z',
  };
}

describe('custom meals API', () => {
  it('lists custom meals for the authenticated owner', async () => {
    const captured: ListCustomMealsInput[] = [];
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository,
      customMealRepository: {
        async listForOwner(input) {
          captured.push(input);
          return [meal({ ownerAuthUid: input.ownerAuthUid })];
        },
        async getForOwner() {
          throw new Error('not implemented');
        },
        async create() {
          throw new Error('not implemented');
        },
        async updateForOwner() {
          throw new Error('not implemented');
        },
        async deleteForOwner() {
          throw new Error('not implemented');
        },
        async createShareLink() {
          throw new Error('not implemented');
        },
        async previewShare() {
          throw new Error('not implemented');
        },
        async importShare() {
          throw new Error('not implemented');
        },
      },
    });
    const session = await issueSession(app);

    const response = await app.handle(
      new Request('http://server.test/nutrition/custom-meals', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      meals: [
        {
          id: 'meal-1',
          ownerUid: session.profile.authUid,
          name: 'Recovery Bowl',
          totalGrams: 300,
          calories: 480,
          carbs: 55,
          proteins: 35,
          fats: 14,
          ingredientCost: 8.5,
          imageUrl: null,
          createdAt: '2026-06-28T09:00:00.000Z',
          updatedAt: '2026-06-28T10:00:00.000Z',
        },
      ],
    });
    expect(captured).toEqual([{ ownerAuthUid: session.profile.authUid }]);
  });

  it('creates, reads, updates, and deletes an authenticated owner custom meal', async () => {
    const captured: Array<
      CreateCustomMealInput | GetCustomMealInput | UpdateCustomMealInput | DeleteCustomMealInput
    > = [];
    const customMealRepository: CustomMealRepository = {
      async listForOwner() {
        throw new Error('not implemented');
      },
      async getForOwner(input) {
        captured.push(input);
        return meal({ id: input.mealId, ownerAuthUid: input.ownerAuthUid });
      },
      async create(input) {
        captured.push(input);
        return meal({ id: 'created-meal', ...input });
      },
      async updateForOwner(input) {
        captured.push(input);
        return meal({
          id: input.mealId,
          ownerAuthUid: input.ownerAuthUid,
          name: input.name,
          totalGrams: input.totalGrams,
          calories: input.calories,
          carbs: input.carbs,
          proteins: input.proteins,
          fats: input.fats,
          ingredientCost: input.ingredientCost ?? null,
          imageUrl: input.imageUrl ?? null,
          importedFromShareToken: input.importedFromShareToken ?? null,
        });
      },
      async deleteForOwner(input) {
        captured.push(input);
        return true;
      },
      async createShareLink() {
        throw new Error('not implemented');
      },
      async previewShare() {
        throw new Error('not implemented');
      },
      async importShare() {
        throw new Error('not implemented');
      },
    };
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository,
      customMealRepository,
    });
    const session = await issueSession(app);

    const createResponse = await app.handle(
      new Request('http://server.test/nutrition/custom-meals', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Created Meal',
          totalGrams: 250,
          calories: 400,
          carbs: 42,
          proteins: 30,
          fats: 12,
          ingredientCost: 7.5,
          imageUrl: 'https://example.test/meal.jpg',
        }),
      })
    );
    expect(createResponse.status).toBe(201);
    await expect(createResponse.json()).resolves.toEqual({
      meal: expect.objectContaining({
        id: 'created-meal',
        ownerUid: session.profile.authUid,
        name: 'Created Meal',
        imageUrl: 'https://example.test/meal.jpg',
      }),
    });

    const getResponse = await app.handle(
      new Request('http://server.test/nutrition/custom-meals/created-meal', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toEqual({
      meal: expect.objectContaining({
        id: 'created-meal',
        ownerUid: session.profile.authUid,
      }),
    });

    const updateResponse = await app.handle(
      new Request('http://server.test/nutrition/custom-meals/created-meal', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Updated Meal',
          totalGrams: 275,
          calories: 420,
          carbs: 44,
          proteins: 32,
          fats: 13,
          ingredientCost: null,
          imageUrl: null,
        }),
      })
    );
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toEqual({
      meal: expect.objectContaining({
        id: 'created-meal',
        ownerUid: session.profile.authUid,
        name: 'Updated Meal',
        ingredientCost: null,
      }),
    });

    const deleteResponse = await app.handle(
      new Request('http://server.test/nutrition/custom-meals/created-meal', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(deleteResponse.status).toBe(204);
    expect(captured).toEqual([
      expect.objectContaining({ ownerAuthUid: session.profile.authUid, name: 'Created Meal' }),
      { ownerAuthUid: session.profile.authUid, mealId: 'created-meal' },
      expect.objectContaining({ ownerAuthUid: session.profile.authUid, mealId: 'created-meal', name: 'Updated Meal' }),
      { ownerAuthUid: session.profile.authUid, mealId: 'created-meal' },
    ]);
  });

  it('creates, previews, and imports custom meal share links', async () => {
    const captured: unknown[] = [];
    const customMealRepository = {
      async listForOwner() {
        throw new Error('not implemented');
      },
      async getForOwner() {
        throw new Error('not implemented');
      },
      async create() {
        throw new Error('not implemented');
      },
      async updateForOwner() {
        throw new Error('not implemented');
      },
      async deleteForOwner() {
        throw new Error('not implemented');
      },
      async createShareLink(input: { ownerAuthUid: string; mealId: string }) {
        captured.push(input);
        return {
          id: 'share-1',
          ownerAuthUid: input.ownerAuthUid,
          mealId: input.mealId,
          snapshot: {
            name: 'Recovery Bowl',
            totalGrams: 300,
            calories: 480,
            carbs: 55,
            proteins: 35,
            fats: 14,
          },
          createdAt: '2026-06-29T09:00:00.000Z',
        };
      },
      async previewShare(input: { shareToken: string }) {
        captured.push(input);
        return {
          name: 'Recovery Bowl',
          totalGrams: 300,
          calories: 480,
          carbs: 55,
          proteins: 35,
          fats: 14,
        };
      },
      async importShare(input: { ownerAuthUid: string; shareToken: string }) {
        captured.push(input);
        return meal({
          id: 'imported-meal-1',
          ownerAuthUid: input.ownerAuthUid,
          name: 'Recovery Bowl',
          totalGrams: 300,
          calories: 480,
          carbs: 55,
          proteins: 35,
          fats: 14,
          ingredientCost: null,
          imageUrl: null,
          importedFromShareToken: input.shareToken,
        });
      },
    } as unknown as CustomMealRepository;
    const app = createApp({
      profileRepository: makeProfileRepository(),
      supportMessageRepository,
      connectionRepository,
      customMealRepository,
    });
    const session = await issueSession(app);

    const createShareResponse = await app.handle(
      new Request('http://server.test/nutrition/custom-meals/created-meal/share-links', {
        method: 'POST',
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );
    expect(createShareResponse.status).toBe(201);
    await expect(createShareResponse.json()).resolves.toEqual({ shareLinkId: 'share-1' });

    const previewResponse = await app.handle(
      new Request('http://server.test/nutrition/custom-meal-shares/share-1')
    );
    expect(previewResponse.status).toBe(200);
    await expect(previewResponse.json()).resolves.toEqual({
      snapshot: {
        name: 'Recovery Bowl',
        totalGrams: 300,
        calories: 480,
        carbs: 55,
        proteins: 35,
        fats: 14,
      },
    });

    const importResponse = await app.handle(
      new Request('http://server.test/nutrition/custom-meal-shares/share-1/import', {
        method: 'POST',
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );
    expect(importResponse.status).toBe(201);
    await expect(importResponse.json()).resolves.toEqual({
      meal: expect.objectContaining({
        id: 'imported-meal-1',
        ownerUid: session.profile.authUid,
        name: 'Recovery Bowl',
        ingredientCost: null,
        imageUrl: null,
      }),
    });

    expect(captured).toEqual([
      { ownerAuthUid: session.profile.authUid, mealId: 'created-meal' },
      { shareToken: 'share-1' },
      { ownerAuthUid: session.profile.authUid, shareToken: 'share-1' },
    ]);
  });
});
