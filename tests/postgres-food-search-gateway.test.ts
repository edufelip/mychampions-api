import { describe, expect, it } from 'bun:test';

import {
  FoodSearchGatewayError,
  PostgresFoodSearchGateway,
} from '../src/integrations/food-search-gateway';

const databaseUrl =
  process.env.FOOD_CATALOG_DATABASE_URL ??
  'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_food_catalog_local';

describe('PostgresFoodSearchGateway', () => {
  it('normalizes request locale and numeric catalog fields while respecting the result limit', async () => {
    const gateway = new PostgresFoodSearchGateway(databaseUrl);

    const results = await gateway.search({
      authUid: 'coverage-user',
      query: '',
      maxResults: 3,
      region: ' us ',
      language: ' EN ',
    });

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.id.length).toBeGreaterThan(0);
      expect(result.name.length).toBeGreaterThan(0);
      expect(Number.isFinite(result.carbohydrate)).toBeTrue();
      expect(Number.isFinite(result.protein)).toBeTrue();
      expect(Number.isFinite(result.fat)).toBeTrue();
      expect(result.serving).toBe(100);
    }
  });

  it('fails closed when the food catalog database is not configured', async () => {
    const gateway = new PostgresFoodSearchGateway(null);

    await expect(
      gateway.search({
        authUid: 'coverage-user',
        query: 'rice',
        maxResults: 3,
        region: 'us',
        language: 'en',
      })
    ).rejects.toMatchObject({
      name: 'FoodSearchGatewayError',
      code: 'configuration',
    } satisfies Partial<FoodSearchGatewayError>);
  });
});
