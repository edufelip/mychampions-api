import postgres from 'postgres';

export type FoodSearchInput = {
  authUid: string;
  query: string;
  maxResults: number;
  region: string;
  language: string;
};

export type FoodSearchResult = {
  id: string;
  name: string;
  carbohydrate: number;
  protein: number;
  fat: number;
  serving: number;
};

export type FoodSearchGateway = {
  search(input: FoodSearchInput): Promise<FoodSearchResult[]>;
};

export class FoodSearchGatewayError extends Error {
  code: 'configuration' | 'upstream';

  constructor(code: 'configuration' | 'upstream', message: string) {
    super(message);
    this.code = code;
    this.name = 'FoodSearchGatewayError';
  }
}

type FoodCatalogRow = {
  id: string;
  name: string;
  carbohydrate: string | number;
  protein: string | number;
  fat: string | number;
  serving: string | number;
};

function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

export class PostgresFoodSearchGateway implements FoodSearchGateway {
  private readonly sql: postgres.Sql | null;

  constructor(databaseUrl: string | null) {
    this.sql = databaseUrl ? postgres(databaseUrl, { max: 3 }) : null;
  }

  async search(input: FoodSearchInput): Promise<FoodSearchResult[]> {
    if (!this.sql) {
      throw new FoodSearchGatewayError('configuration', 'Food catalog database is not configured.');
    }

    const query = input.query.trim();
    const pattern = `%${query}%`;
    const prefixPattern = `${query}%`;
    const region = input.region.trim().toUpperCase();
    const language = input.language.trim().toLowerCase();

    try {
      const rows = await this.sql<FoodCatalogRow[]>`
        SELECT
          f.id,
          COALESCE(l.name, f.id) AS name,
          f.carbohydrate,
          f.protein,
          f.fat,
          f.serving
        FROM catalog_foods f
        LEFT JOIN catalog_food_localizations l
          ON l.food_id = f.id
          AND l.lang = ${language}
        WHERE
          UPPER(f.region) = ${region}
          AND f.serving = 100
          AND (
            l.name ILIKE ${pattern}
            OR f.id ILIKE ${pattern}
          )
        ORDER BY
          CASE
            WHEN lower(l.name) = lower(${query}) THEN 0
            WHEN l.name ILIKE ${prefixPattern} THEN 1
            ELSE 2
          END,
          l.name ASC NULLS LAST,
          f.id ASC
        LIMIT ${input.maxResults}
      `;

      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        carbohydrate: toNumber(row.carbohydrate),
        protein: toNumber(row.protein),
        fat: toNumber(row.fat),
        serving: toNumber(row.serving),
      }));
    } catch (error) {
      throw new FoodSearchGatewayError(
        'upstream',
        error instanceof Error ? error.message : 'Food catalog search failed.'
      );
    }
  }
}
