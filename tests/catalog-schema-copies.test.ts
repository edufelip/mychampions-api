import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";

import {
  CATALOG_SCHEMA_SOURCES,
  catalogSchemaDigest,
  loadCatalogSchemas,
  syncCatalogSchemas,
} from "../scripts/testing/catalog-schemas";

const pinnedRoot = path.resolve(
  import.meta.dir,
  "../scripts/testing/catalog-schemas",
);
const scratchRoots: string[] = [];

async function scratch(label: string) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), `catalog-schema-${label}-`),
  );
  scratchRoots.push(directory);
  return directory;
}

function git(directory: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

// A fake sibling checkout that exports the given schema the way the services do.
async function writeSibling(
  workspace: string,
  name: keyof typeof CATALOG_SCHEMA_SOURCES,
  sql: string,
  commit = false,
) {
  const source = CATALOG_SCHEMA_SOURCES[name];
  const checkout = path.join(workspace, source.checkout);
  const modulePath = path.join(checkout, source.modulePath);
  await mkdir(path.dirname(modulePath), { recursive: true });
  await writeFile(
    modulePath,
    `export const ${source.exportName} = ${JSON.stringify(sql)};\n`,
  );
  if (commit) {
    git(checkout, ["init", "-q"]);
    git(checkout, ["config", "user.email", "catalog-schema@example.test"]);
    git(checkout, ["config", "user.name", "Catalog Schema Test"]);
    git(checkout, ["add", "."]);
    git(checkout, ["commit", "-qm", "schema"]);
  }
  return modulePath;
}

async function pinned(name: keyof typeof CATALOG_SCHEMA_SOURCES) {
  return readFile(
    path.join(pinnedRoot, CATALOG_SCHEMA_SOURCES[name].file),
    "utf8",
  );
}

afterEach(async () => {
  await Promise.all(
    scratchRoots
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("pinned catalog schema copies", () => {
  it("seed the catalog tables the server gateways read without sibling checkouts", async () => {
    const result = await loadCatalogSchemas({
      workspace: await scratch("no-siblings"),
    });
    expect(result.sources).toEqual({
      food: "pinned-copy",
      exercise: "pinned-copy",
    });
    for (const table of ["catalog_foods", "catalog_food_localizations"])
      expect(result.food).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
    for (const table of [
      "catalog_exercises",
      "catalog_exercise_localizations",
    ])
      expect(result.exercise).toContain(
        `CREATE TABLE IF NOT EXISTS ${table} (`,
      );
  });

  it("match their recorded provenance digests", async () => {
    const provenance = JSON.parse(
      await readFile(path.join(pinnedRoot, "provenance.json"), "utf8"),
    ) as { copies: { name: "food" | "exercise"; sha256: string }[] };
    for (const copy of provenance.copies)
      expect(catalogSchemaDigest(await pinned(copy.name))).toBe(copy.sha256);
  });

  it("accept sibling checkouts that export the same schema", async () => {
    const workspace = await scratch("matching");
    await writeSibling(workspace, "food", await pinned("food"));
    await writeSibling(workspace, "exercise", await pinned("exercise"));
    const result = await loadCatalogSchemas({ workspace });
    expect(result.sources).toEqual({
      food: "pinned-copy-matches-checkout",
      exercise: "pinned-copy-matches-checkout",
    });
  });

  it("block seeding when a sibling checkout exports a different schema", async () => {
    const workspace = await scratch("drift");
    await writeSibling(workspace, "food", await pinned("food"));
    await writeSibling(
      workspace,
      "exercise",
      `${await pinned("exercise")}ALTER TABLE catalog_exercises ADD COLUMN drift text;\n`,
    );
    await expect(loadCatalogSchemas({ workspace })).rejects.toThrow(
      "Pinned exercise catalog schema differs from ../mychampionsapi-exercises",
    );
  });

  it("block seeding when a present sibling checkout lacks the schema module", async () => {
    const workspace = await scratch("missing-module");
    await mkdir(path.join(workspace, "mychampionsapi-food"));
    await expect(loadCatalogSchemas({ workspace })).rejects.toThrow();
  });

  it("block seeding when a pinned copy was edited without its provenance", async () => {
    const vendorRoot = await scratch("tampered");
    await cp(pinnedRoot, vendorRoot, { recursive: true });
    await writeFile(
      path.join(vendorRoot, CATALOG_SCHEMA_SOURCES.food.file),
      `${await pinned("food")}-- local edit\n`,
    );
    await expect(
      loadCatalogSchemas({ workspace: await scratch("none"), vendorRoot }),
    ).rejects.toThrow(
      "Pinned food catalog schema does not match its provenance digest",
    );
  });

  it("sync only from committed sibling schema modules", async () => {
    const workspace = await scratch("sync");
    const vendorRoot = await scratch("sync-vendor");
    await writeSibling(
      workspace,
      "food",
      "CREATE TABLE food_sync (id text);\n",
      true,
    );
    const exerciseModule = await writeSibling(
      workspace,
      "exercise",
      "CREATE TABLE exercise_sync (id text);\n",
      true,
    );
    const provenance = await syncCatalogSchemas({ workspace, vendorRoot });
    expect(provenance.copies.map((copy) => copy.sourceCommit)).toEqual([
      expect.stringMatching(/^[a-f0-9]{40}$/),
      expect.stringMatching(/^[a-f0-9]{40}$/),
    ]);
    expect((await loadCatalogSchemas({ workspace, vendorRoot })).food).toBe(
      "CREATE TABLE food_sync (id text);\n",
    );

    // A refused sync leaves the earlier copies and provenance untouched.
    const before = await readFile(path.join(vendorRoot, "provenance.json"));
    await writeFile(
      exerciseModule,
      "export const EXERCISE_CATALOG_SCHEMA_SQL = 'uncommitted';\n",
    );
    await expect(
      syncCatalogSchemas({ workspace, vendorRoot }),
    ).rejects.toThrow("Commit mychampionsapi-exercises/");
    expect(await readFile(path.join(vendorRoot, "provenance.json"))).toEqual(
      before,
    );
  });
});
