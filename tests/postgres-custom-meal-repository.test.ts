import { afterAll, beforeEach, describe, expect, it } from 'bun:test';

import { createDatabase } from '../src/db/client';
import { PostgresCustomMealRepository } from '../src/nutrition/postgres-custom-meal-repository';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_server_local';

const database = createDatabase(databaseUrl);
const repository = new PostgresCustomMealRepository(database.db);

beforeEach(async () => {
  await database.client`truncate table meal_share_links, custom_meals`;
});

afterAll(async () => {
  await database.close();
});

describe('PostgresCustomMealRepository', () => {
  it('creates, lists, gets, updates, and deletes owner custom meals', async () => {
    const created = await repository.create({
      ownerAuthUid: 'student-1',
      name: 'Recovery Bowl',
      totalGrams: 300,
      calories: 480,
      carbs: 55,
      proteins: 35,
      fats: 14,
      ingredientCost: 8.5,
      imageUrl: 'https://example.test/meal.jpg',
    });
    await repository.create({
      ownerAuthUid: 'student-2',
      name: 'Other Meal',
      totalGrams: 100,
      calories: 200,
      carbs: 20,
      proteins: 10,
      fats: 6,
      ingredientCost: null,
      imageUrl: null,
    });

    expect(created).toMatchObject({
      ownerAuthUid: 'student-1',
      name: 'Recovery Bowl',
      totalGrams: 300,
      calories: 480,
      carbs: 55,
      proteins: 35,
      fats: 14,
      ingredientCost: 8.5,
      imageUrl: 'https://example.test/meal.jpg',
      importedFromShareToken: null,
    });

    await repository.updateForOwner({
      ownerAuthUid: 'student-1',
      mealId: created.id,
      name: 'Updated Bowl',
      totalGrams: 325,
      calories: 500,
      carbs: 57,
      proteins: 38,
      fats: 15,
      ingredientCost: null,
      imageUrl: null,
    });

    await expect(repository.getForOwner({ ownerAuthUid: 'student-2', mealId: created.id })).resolves.toBeNull();
    await expect(repository.getForOwner({ ownerAuthUid: 'student-1', mealId: created.id })).resolves.toMatchObject({
      id: created.id,
      ownerAuthUid: 'student-1',
      name: 'Updated Bowl',
      totalGrams: 325,
      calories: 500,
      carbs: 57,
      proteins: 38,
      fats: 15,
      ingredientCost: null,
      imageUrl: null,
    });
    await expect(repository.listForOwner({ ownerAuthUid: 'student-1' })).resolves.toEqual([
      expect.objectContaining({
        id: created.id,
        ownerAuthUid: 'student-1',
        name: 'Updated Bowl',
      }),
    ]);

    await expect(repository.deleteForOwner({ ownerAuthUid: 'student-2', mealId: created.id })).resolves.toBe(false);
    await expect(repository.deleteForOwner({ ownerAuthUid: 'student-1', mealId: created.id })).resolves.toBe(true);
    await expect(repository.listForOwner({ ownerAuthUid: 'student-1' })).resolves.toEqual([]);
  });

  it('creates share links, previews snapshots, and imports one copy per recipient', async () => {
    const sourceMeal = await repository.create({
      ownerAuthUid: 'student-1',
      name: 'Shareable Bowl',
      totalGrams: 300,
      calories: 480,
      carbs: 55,
      proteins: 35,
      fats: 14,
      ingredientCost: 8.5,
      imageUrl: 'https://example.test/source.jpg',
    });

    await expect(repository.createShareLink({
      ownerAuthUid: 'student-2',
      mealId: sourceMeal.id,
    })).resolves.toBeNull();

    const share = await repository.createShareLink({
      ownerAuthUid: 'student-1',
      mealId: sourceMeal.id,
    });
    expect(share).toMatchObject({
      ownerAuthUid: 'student-1',
      mealId: sourceMeal.id,
      snapshot: {
        name: 'Shareable Bowl',
        totalGrams: 300,
        calories: 480,
        carbs: 55,
        proteins: 35,
        fats: 14,
      },
    });
    expect(share?.id).toEqual(expect.any(String));

    await expect(repository.previewShare({ shareToken: share!.id })).resolves.toEqual({
      name: 'Shareable Bowl',
      totalGrams: 300,
      calories: 480,
      carbs: 55,
      proteins: 35,
      fats: 14,
    });
    await expect(repository.previewShare({ shareToken: 'missing-share' })).resolves.toBeNull();

    const imported = await repository.importShare({
      ownerAuthUid: 'student-2',
      shareToken: share!.id,
    });
    expect(imported).toMatchObject({
      ownerAuthUid: 'student-2',
      name: 'Shareable Bowl',
      totalGrams: 300,
      calories: 480,
      carbs: 55,
      proteins: 35,
      fats: 14,
      ingredientCost: null,
      imageUrl: null,
      importedFromShareToken: share!.id,
    });

    const importedAgain = await repository.importShare({
      ownerAuthUid: 'student-2',
      shareToken: share!.id,
    });
    expect(importedAgain?.id).toBe(imported?.id);

    await expect(repository.importShare({
      ownerAuthUid: 'student-2',
      shareToken: 'missing-share',
    })).resolves.toBeNull();
  });
});
