import { afterAll, describe, expect, it } from 'bun:test';
import { createDatabase } from '../src/db/client';
import {
  loadTestManifest,
  requireOwnedTestDatabase,
} from './helpers/test-database';
import { seedCatalogs } from '../scripts/testing/seed';
import { verifyCatalogSeeds } from '../scripts/testing/verify';

const database = createDatabase(await requireOwnedTestDatabase());
afterAll(() => database.close());

describe('owned database safety and deterministic fixtures', () => {
  it('rejects a valid manifest/URL when the DB marker belongs to another run', async () => {
    const manifest = loadTestManifest();
    await database.client`update mc_test_ownership.marker set run_id = 'wrong-owner'`;
    try {
      await expect(requireOwnedTestDatabase()).rejects.toThrow(
        'ownership marker mismatch'
      );
    } finally {
      await database.client`update mc_test_ownership.marker set run_id = ${manifest.runId}`;
    }
    await expect(requireOwnedTestDatabase()).resolves.toBe(
      process.env.DATABASE_URL!
    );
  });
  it('rejects a missing DB marker', async () => {
    const manifest = loadTestManifest();
    await database.client`delete from mc_test_ownership.marker`;
    try {
      await expect(requireOwnedTestDatabase()).rejects.toThrow(
        'ownership marker mismatch'
      );
    } finally {
      await database.client`insert into mc_test_ownership.marker values (true, ${manifest.runId}, ${manifest.ownerTokenHash})`;
    }
  });
  it('repeated catalog seeds yield exactly the same persisted content', async () => {
    const before = await verifyCatalogSeeds();
    await seedCatalogs();
    expect(await verifyCatalogSeeds()).toEqual(before);
  });
});
