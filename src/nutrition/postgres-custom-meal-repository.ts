import { randomUUID } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';

import { customMeals, mealShareLinks, type CustomMealRow, type MealShareLinkRow } from '../db/schema';
import type {
  CreateCustomMealInput,
  CreateMealShareLinkInput,
  CustomMeal,
  CustomMealRepository,
  DeleteCustomMealInput,
  GetCustomMealInput,
  ImportMealShareInput,
  ListCustomMealsInput,
  MealShareLink,
  PreviewMealShareInput,
  SharedMealSnapshot,
  UpdateCustomMealInput,
} from './custom-meal-repository';

type Db = {
  select: Function;
  insert: Function;
  update: Function;
  delete: Function;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapCustomMeal(row: CustomMealRow): CustomMeal {
  return {
    id: row.id,
    ownerAuthUid: row.ownerAuthUid,
    name: row.name,
    totalGrams: row.totalGrams,
    calories: row.calories,
    carbs: row.carbs,
    proteins: row.proteins,
    fats: row.fats,
    ingredientCost: row.ingredientCost,
    imageUrl: row.imageUrl,
    importedFromShareToken: row.importedFromShareToken,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function mapShareLink(row: MealShareLinkRow): MealShareLink {
  return {
    id: row.id,
    ownerAuthUid: row.ownerAuthUid,
    mealId: row.mealId,
    snapshot: {
      name: row.snapshotName,
      totalGrams: row.snapshotTotalGrams,
      calories: row.snapshotCalories,
      carbs: row.snapshotCarbs,
      proteins: row.snapshotProteins,
      fats: row.snapshotFats,
    },
    createdAt: toIso(row.createdAt),
  };
}

export class PostgresCustomMealRepository implements CustomMealRepository {
  constructor(private readonly db: Db) {}

  async listForOwner(input: ListCustomMealsInput): Promise<CustomMeal[]> {
    const rows = await this.db
      .select()
      .from(customMeals)
      .where(eq(customMeals.ownerAuthUid, input.ownerAuthUid))
      .orderBy(desc(customMeals.updatedAt));

    return rows.map(mapCustomMeal);
  }

  async getForOwner(input: GetCustomMealInput): Promise<CustomMeal | null> {
    const [row] = await this.db
      .select()
      .from(customMeals)
      .where(
        and(
          eq(customMeals.id, input.mealId),
          eq(customMeals.ownerAuthUid, input.ownerAuthUid)
        )
      )
      .limit(1);

    return row ? mapCustomMeal(row) : null;
  }

  async create(input: CreateCustomMealInput): Promise<CustomMeal> {
    const now = new Date();
    const [row] = await this.db
      .insert(customMeals)
      .values({
        id: randomUUID(),
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
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return mapCustomMeal(row);
  }

  async updateForOwner(input: UpdateCustomMealInput): Promise<CustomMeal | null> {
    const [row] = await this.db
      .update(customMeals)
      .set({
        name: input.name,
        totalGrams: input.totalGrams,
        calories: input.calories,
        carbs: input.carbs,
        proteins: input.proteins,
        fats: input.fats,
        ingredientCost: input.ingredientCost ?? null,
        imageUrl: input.imageUrl ?? null,
        importedFromShareToken: input.importedFromShareToken ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(customMeals.id, input.mealId),
          eq(customMeals.ownerAuthUid, input.ownerAuthUid)
        )
      )
      .returning();

    return row ? mapCustomMeal(row) : null;
  }

  async deleteForOwner(input: DeleteCustomMealInput): Promise<boolean> {
    const [row] = await this.db
      .delete(customMeals)
      .where(
        and(
          eq(customMeals.id, input.mealId),
          eq(customMeals.ownerAuthUid, input.ownerAuthUid)
        )
      )
      .returning({ id: customMeals.id });

    return Boolean(row);
  }

  async createShareLink(input: CreateMealShareLinkInput): Promise<MealShareLink | null> {
    const [meal] = await this.db
      .select()
      .from(customMeals)
      .where(
        and(
          eq(customMeals.id, input.mealId),
          eq(customMeals.ownerAuthUid, input.ownerAuthUid)
        )
      )
      .limit(1);

    if (!meal) return null;

    const [row] = await this.db
      .insert(mealShareLinks)
      .values({
        id: randomUUID(),
        ownerAuthUid: input.ownerAuthUid,
        mealId: input.mealId,
        snapshotName: meal.name,
        snapshotTotalGrams: meal.totalGrams,
        snapshotCalories: meal.calories,
        snapshotCarbs: meal.carbs,
        snapshotProteins: meal.proteins,
        snapshotFats: meal.fats,
        createdAt: new Date(),
      })
      .returning();

    return mapShareLink(row);
  }

  async previewShare(input: PreviewMealShareInput): Promise<SharedMealSnapshot | null> {
    const [row] = await this.db
      .select()
      .from(mealShareLinks)
      .where(eq(mealShareLinks.id, input.shareToken))
      .limit(1);

    return row ? mapShareLink(row).snapshot : null;
  }

  async importShare(input: ImportMealShareInput): Promise<CustomMeal | null> {
    const [existing] = await this.db
      .select()
      .from(customMeals)
      .where(
        and(
          eq(customMeals.ownerAuthUid, input.ownerAuthUid),
          eq(customMeals.importedFromShareToken, input.shareToken)
        )
      )
      .limit(1);

    if (existing) return mapCustomMeal(existing);

    const [share] = await this.db
      .select()
      .from(mealShareLinks)
      .where(eq(mealShareLinks.id, input.shareToken))
      .limit(1);

    if (!share) return null;

    const snapshot = mapShareLink(share).snapshot;
    const now = new Date();
    const [row] = await this.db
      .insert(customMeals)
      .values({
        id: randomUUID(),
        ownerAuthUid: input.ownerAuthUid,
        name: snapshot.name,
        totalGrams: snapshot.totalGrams,
        calories: snapshot.calories,
        carbs: snapshot.carbs,
        proteins: snapshot.proteins,
        fats: snapshot.fats,
        ingredientCost: null,
        imageUrl: null,
        importedFromShareToken: input.shareToken,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return mapCustomMeal(row);
  }
}
