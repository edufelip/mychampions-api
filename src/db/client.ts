import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema';

export function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 10 });
  const db = drizzle(client, { schema });

  return {
    client,
    db,
    async close() {
      await client.end();
    },
  };
}
