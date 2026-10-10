import postgres from 'postgres';
import { requireOwnedTestDatabase } from '../../tests/helpers/test-database';
import { loadCatalogSchemas } from './catalog-schemas';

export async function seedCatalogs(env: NodeJS.ProcessEnv = process.env) {
  // Pinned copies of the food/exercise service schemas; checked against the
  // sibling checkouts whenever they exist (see catalog-schemas.ts).
  const { food: FOOD_CATALOG_SCHEMA_SQL, exercise: EXERCISE_CATALOG_SCHEMA_SQL } =
    await loadCatalogSchemas();
  const food = postgres(
    await requireOwnedTestDatabase('FOOD_CATALOG_DATABASE_URL', env),
    {
      max: 1,
      onnotice: (notice) =>
        console.error(`Test catalog notice: ${notice.code}`),
    }
  );
  const exercise = postgres(
    await requireOwnedTestDatabase('EXERCISE_CATALOG_DATABASE_URL', env),
    {
      max: 1,
      onnotice: (notice) =>
        console.error(`Test catalog notice: ${notice.code}`),
    }
  );
  try {
    await food.unsafe(FOOD_CATALOG_SCHEMA_SQL);
    await exercise.unsafe(EXERCISE_CATALOG_SCHEMA_SQL);
    await food`truncate catalog_food_localizations, catalog_foods cascade`;
    await exercise`truncate catalog_exercise_localizations, catalog_exercises`;
    for (let index = 1; index <= 3; index++) {
      const foodId = `qa-food-${index}`;
      await food`insert into catalog_foods (id, carbohydrate, protein, fat, serving, region, source, raw_document) values (${foodId}, 20, 5, 2, 100, 'US', 'qa-synthetic', '{}'::jsonb)`;
      const exerciseId = `00000000-0000-4000-8000-00000000000${index}`;
      await exercise`insert into catalog_exercises (id, version, slug, muscle_group, equipment, has_video, has_video_white, has_video_gym, exercise_type, raw_document) values (${exerciseId}, 'qa-v1', ${`qa-exercise-${index}`}, 'chest', 'bodyweight', false, false, false, '["strength"]'::jsonb, '{}'::jsonb)`;
      for (const lang of ['en', 'pt', 'es']) {
        await food`insert into catalog_food_localizations (food_id, lang, name, review_status, raw_localization) values (${foodId}, ${lang}, ${`${lang} QA Food ${index}`}, 'reviewed', '{}'::jsonb)`;
        await exercise`insert into catalog_exercise_localizations (exercise_id, version, lang, title, instructions, important_points, status, raw_localization) values (${exerciseId}, 'qa-v1', ${lang}, ${`${lang} QA Exercise ${index}`}, '["Controlled motion"]'::jsonb, '[]'::jsonb, 'reviewed', '{}'::jsonb)`;
      }
    }
  } finally {
    await Promise.all([food.end(), exercise.end()]);
  }
}

if (import.meta.main) await seedCatalogs();
