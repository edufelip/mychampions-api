import { describe, expect, it } from 'bun:test';
import postgres from 'postgres';

import {
  ExerciseSearchGatewayError,
  PostgresExerciseSearchGateway,
} from '../src/integrations/exercise-search-gateway';

const databaseUrl =
  process.env.EXERCISE_CATALOG_DATABASE_URL ??
  'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_exercise_catalog_local';

// These assert against real catalog rows, which only exist when
// EXERCISE_CATALOG_DATABASE_URL points at a database mirrored from
// production (`bun run local:db:mirror`). Hosted CI provisions an empty
// Postgres, so it can't run these; skip there and rely on local dev runs.
const isCI = process.env.CI === 'true';
const rawSyntheticV2DatabaseUrl = process.env.EXERCISE_CATALOG_V2_TEST_DATABASE_URL;
function isAllowedSyntheticDatabaseUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.replace(/^\[|\]$/gu, '');
    return (
      parsed.protocol === 'postgres:' &&
      ['localhost', '127.0.0.1', '::1'].includes(hostname) &&
      /exercise[_-]v2/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}
if (rawSyntheticV2DatabaseUrl && !isAllowedSyntheticDatabaseUrl(rawSyntheticV2DatabaseUrl)) {
  throw new Error('EXERCISE_CATALOG_V2_TEST_DATABASE_URL must point to an isolated localhost exercise_v2 database.');
}
const syntheticV2DatabaseUrl = isAllowedSyntheticDatabaseUrl(rawSyntheticV2DatabaseUrl)
  ? rawSyntheticV2DatabaseUrl
  : undefined;

async function seedSyntheticV2Catalog(sql: postgres.Sql): Promise<void> {
  await sql`DROP TABLE IF EXISTS catalog_exercise_localizations`;
  await sql`DROP TABLE IF EXISTS catalog_exercises`;
  await sql`
    CREATE TABLE catalog_exercises (
      id text PRIMARY KEY,
      slug text NOT NULL,
      muscle_group text NOT NULL,
      secondary_muscles text,
      equipment text NOT NULL,
      category text,
      difficulty text,
      exercise_type jsonb,
      has_video boolean NOT NULL DEFAULT false,
      has_video_white boolean NOT NULL DEFAULT false,
      has_video_gym boolean NOT NULL DEFAULT false,
      videos jsonb,
      video_url text,
      video_hls_url text,
      thumbnail_url text,
      video_duration_secs numeric
    )
  `;
  await sql`
    CREATE TABLE catalog_exercise_localizations (
      exercise_id text NOT NULL,
      lang text NOT NULL,
      title text,
      description text,
      instructions jsonb,
      important_points jsonb,
      PRIMARY KEY (exercise_id, lang)
    )
  `;

  const exercises = [
    ['et229-barbell', 'supino-reto-barra', 'chest', 'barbell'],
    ['et229-dumbbell', 'supino-reto-halteres', 'chest', 'dumbbell'],
    ['et229-bodyweight', 'flexao-braco', 'chest', 'bodyweight'],
    ['et229-pullup', 'barra-fixa', 'back', 'pull_up_bar'],
  ] as const;
  for (const [id, slug, muscleGroup, equipment] of exercises) {
    await sql`
      INSERT INTO catalog_exercises (id, slug, muscle_group, equipment)
      VALUES (${id}, ${slug}, ${muscleGroup}, ${equipment})
    `;
  }

  const localizations = [
    ['et229-barbell', 'pt', 'Supino reto com barra'],
    ['et229-dumbbell', 'pt', 'Supino reto com halteres'],
    ['et229-bodyweight', 'pt', 'Flexão de braço'],
    ['et229-pullup', 'pt', 'Barra fixa'],
    ['et229-barbell', 'en', 'Barbell bench press'],
    ['et229-dumbbell', 'en', 'Dumbbell bench press'],
    ['et229-bodyweight', 'en', 'Push up'],
    ['et229-pullup', 'en', 'Pull up'],
  ] as const;
  for (const [exerciseId, lang, title] of localizations) {
    await sql`
      INSERT INTO catalog_exercise_localizations (exercise_id, lang, title)
      VALUES (${exerciseId}, ${lang}, ${title})
    `;
  }
}

async function clearSyntheticV2Catalog(sql: postgres.Sql): Promise<void> {
  await sql`DROP TABLE IF EXISTS catalog_exercise_localizations`;
  await sql`DROP TABLE IF EXISTS catalog_exercises`;
}

describe('PostgresExerciseSearchGateway', () => {
  it.skipIf(isCI)('normalizes localized catalog rows and loads the same exercise by id', async () => {
    const gateway = new PostgresExerciseSearchGateway(databaseUrl);

    const search = await gateway.search({
      authUid: 'coverage-user',
      query: '',
      pageSize: 3,
      lang: 'pt-BR',
    });

    expect(search.page).toBe(1);
    expect(search.pageSize).toBe(3);
    expect(search.total).toBe(3);
    expect(search.exercises).toHaveLength(3);

    const first = search.exercises[0];
    expect(first?.id.length).toBeGreaterThan(0);
    expect(first?.title.length).toBeGreaterThan(0);
    expect(first?.muscleGroup.length).toBeGreaterThan(0);
    expect(first?.equipment.length).toBeGreaterThan(0);

    const detail = await gateway.getById({
      authUid: 'coverage-user',
      id: first!.id,
      lang: 'es-ES',
    });
    expect(detail?.id).toBe(first?.id);
    expect(detail?.title.length).toBeGreaterThan(0);
  });

  it.skipIf(isCI)('returns null for a missing exercise', async () => {
    const gateway = new PostgresExerciseSearchGateway(databaseUrl);

    await expect(
      gateway.getById({
        authUid: 'coverage-user',
        id: '00000000-0000-0000-0000-000000000000',
        lang: 'en-US',
      })
    ).resolves.toBeNull();
  });

  // Unlike the two tests above, this never touches the catalog database (the
  // gateway is unconfigured), so it runs in hosted CI same as the food
  // gateway's equivalent check in tests/postgres-food-search-gateway.test.ts.
  it('fails closed without catalog configuration', async () => {
    const unconfigured = new PostgresExerciseSearchGateway(null);

    await expect(
      unconfigured.search({
        authUid: 'coverage-user',
        query: 'push',
        pageSize: 3,
        lang: 'en-US',
      })
    ).rejects.toMatchObject({
      name: 'ExerciseSearchGatewayError',
      code: 'configuration',
    } satisfies Partial<ExerciseSearchGatewayError>);
    await expect(
      unconfigured.getById({
        authUid: 'coverage-user',
        id: 'exercise-id',
        lang: 'en-US',
      })
    ).rejects.toMatchObject({
      name: 'ExerciseSearchGatewayError',
      code: 'configuration',
    } satisfies Partial<ExerciseSearchGatewayError>);
  });

  it.skipIf(!syntheticV2DatabaseUrl)(
    'retrieves deterministic Unicode and equipment-ranked rows from an isolated V2 catalog',
    async () => {
      const setup = postgres(syntheticV2DatabaseUrl!, { max: 3 });
      await seedSyntheticV2Catalog(setup);
      try {
        const gateway = new PostgresExerciseSearchGateway(syntheticV2DatabaseUrl!, { v2Enabled: true });

        const supino = await gateway.search({
          authUid: 'synthetic-et229-user',
          query: 'supino',
          pageSize: 10,
          lang: 'pt-BR',
        });
        expect(supino.exercises.map((exercise) => exercise.id)).toEqual([
          'et229-barbell',
          'et229-dumbbell',
        ]);

        const accented = await gateway.search({
          authUid: 'synthetic-et229-user',
          query: 'flexão',
          pageSize: 10,
          lang: 'pt-BR',
        });
        expect(accented.exercises.map((exercise) => exercise.title)).toEqual(['Flexão de braço']);

        const equipmentConstrained = await gateway.search({
          authUid: 'synthetic-et229-user',
          query: 'supino com halteres',
          pageSize: 10,
          lang: 'pt-BR',
        });
        expect(equipmentConstrained.exercises.map((exercise) => exercise.id)).toEqual([
          'et229-dumbbell',
          'et229-barbell',
        ]);
      } finally {
        await clearSyntheticV2Catalog(setup);
        await setup.end({ timeout: 1 });
      }
    },
  );
});
