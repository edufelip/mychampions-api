import { describe, expect, it } from 'bun:test';

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

  it.skipIf(isCI)('returns null for a missing exercise and fails closed without catalog configuration', async () => {
    const gateway = new PostgresExerciseSearchGateway(databaseUrl);
    const unconfigured = new PostgresExerciseSearchGateway(null);

    await expect(
      gateway.getById({
        authUid: 'coverage-user',
        id: '00000000-0000-0000-0000-000000000000',
        lang: 'en-US',
      })
    ).resolves.toBeNull();
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
