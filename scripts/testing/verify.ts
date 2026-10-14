import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { requireOwnedTestDatabase } from '../../tests/helpers/test-database';

export async function verifyCatalogSeeds(env: NodeJS.ProcessEnv = process.env) {
  const food = postgres(
    await requireOwnedTestDatabase('FOOD_CATALOG_DATABASE_URL', env),
    { max: 1 }
  );
  const exercise = postgres(
    await requireOwnedTestDatabase('EXERCISE_CATALOG_DATABASE_URL', env),
    { max: 1 }
  );
  try {
    const foods =
      await food`select id, carbohydrate::text, protein::text, fat::text, serving::text, region from catalog_foods order by id`;
    const exercises =
      await exercise`select id, slug, muscle_group, equipment from catalog_exercises order by id`;
    if (foods.length !== 3 || exercises.length !== 3)
      throw new Error('Catalog fixture cardinality mismatch');
    return {
      foodCount: foods.length,
      exerciseCount: exercises.length,
      contentHash: createHash('sha256')
        .update(JSON.stringify([foods, exercises]))
        .digest('hex'),
    };
  } finally {
    await Promise.all([food.end(), exercise.end()]);
  }
}

if (import.meta.main) console.log(JSON.stringify(await verifyCatalogSeeds()));
