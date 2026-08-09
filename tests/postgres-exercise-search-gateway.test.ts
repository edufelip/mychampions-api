import { describe, expect, it } from 'bun:test';

import {
  ExerciseSearchGatewayError,
  PostgresExerciseSearchGateway,
} from '../src/integrations/exercise-search-gateway';

const databaseUrl =
  process.env.EXERCISE_CATALOG_DATABASE_URL ??
  'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_exercise_catalog_local';

// Local runs use a production mirror when available. Hosted quality runs set
// CATALOG_TEST_FIXTURES=true after seeding deterministic rows into the CI DB.
const runCatalogRowTests = process.env.CI !== 'true' || process.env.CATALOG_TEST_FIXTURES === 'true';

describe('PostgresExerciseSearchGateway', () => {
  it.skipIf(!runCatalogRowTests)('normalizes localized catalog rows and loads the same exercise by id', async () => {
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

  it.skipIf(!runCatalogRowTests)('returns null for a missing exercise', async () => {
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
  // gateway is unconfigured), so it remains useful even when the fixture
  // switch is disabled for a local diagnostic run.
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
});
