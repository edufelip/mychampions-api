import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Catalog schemas for the owned test databases. The food and exercise services
// own these schemas; the server only reads their tables. Hosted server CI
// checks out only this repository, so the owned runner seeds from pinned
// copies kept here. Whenever a sibling checkout is present (local runs), the
// copy must equal the sibling's exported schema, so local and CI seeds cannot
// silently diverge from the service that owns the schema.

export type CatalogSchemaName = "food" | "exercise";

export const CATALOG_SCHEMA_SOURCES = {
  food: {
    file: "food-catalog-schema.sql",
    exportName: "FOOD_CATALOG_SCHEMA_SQL",
    repository: "edufelip/MyChampions_Food_Microservice",
    checkout: "mychampionsapi-food",
    modulePath:
      "src/catalog/infrastructure/postgres/catalog-persistence-schema.ts",
  },
  exercise: {
    file: "exercise-catalog-schema.sql",
    exportName: "EXERCISE_CATALOG_SCHEMA_SQL",
    repository: "edufelip/MyChampions_Exercise_Microservice",
    checkout: "mychampionsapi-exercises",
    modulePath: "src/infrastructure/postgres/catalog-persistence-schema.ts",
  },
} as const;

type ProvenanceCopy = {
  name: CatalogSchemaName;
  path: string;
  export: string;
  repository: string;
  source: string;
  sourceCommit: string;
  sha256: string;
};
type Provenance = { schemaVersion: 1; copies: ProvenanceCopy[] };

const NAMES = Object.keys(CATALOG_SCHEMA_SOURCES) as CatalogSchemaName[];
const DEFAULT_WORKSPACE = path.resolve(import.meta.dir, "../../..");
const DEFAULT_VENDOR_ROOT = path.join(import.meta.dir, "catalog-schemas");
const SYNC_COMMAND =
  "bun --no-env-file scripts/testing/catalog-schemas.ts --sync";

export function catalogSchemaDigest(sql: string) {
  return createHash("sha256").update(sql).digest("hex");
}

async function exists(target: string) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readSiblingSchema(workspace: string, name: CatalogSchemaName) {
  const source = CATALOG_SCHEMA_SOURCES[name];
  const module: Record<string, unknown> = await import(
    path.join(workspace, source.checkout, source.modulePath)
  );
  const sql = module[source.exportName];
  if (typeof sql !== "string" || !sql.trim())
    throw new Error(
      `${source.checkout}/${source.modulePath} does not export ${source.exportName}`,
    );
  return sql;
}

async function readProvenance(vendorRoot: string): Promise<Provenance> {
  const value = JSON.parse(
    await readFile(path.join(vendorRoot, "provenance.json"), "utf8"),
  ) as Provenance;
  if (
    value?.schemaVersion !== 1 ||
    !Array.isArray(value.copies) ||
    value.copies.length !== NAMES.length ||
    NAMES.some((name) => !value.copies.some((copy) => copy.name === name))
  )
    throw new Error("Catalog schema provenance is malformed");
  return value;
}

/**
 * Returns the pinned catalog schema SQL after checking each copy against its
 * recorded digest and, when the owning sibling checkout exists, against the
 * sibling's exported schema. Any mismatch blocks seeding.
 */
export async function loadCatalogSchemas(
  options: { workspace?: string; vendorRoot?: string } = {},
) {
  const workspace = options.workspace ?? DEFAULT_WORKSPACE;
  const vendorRoot = options.vendorRoot ?? DEFAULT_VENDOR_ROOT;
  const provenance = await readProvenance(vendorRoot);
  const schemas = {} as Record<CatalogSchemaName, string>;
  const sources = {} as Record<
    CatalogSchemaName,
    "pinned-copy" | "pinned-copy-matches-checkout"
  >;
  for (const name of NAMES) {
    const source = CATALOG_SCHEMA_SOURCES[name];
    const copy = provenance.copies.find((row) => row.name === name)!;
    if (
      copy.path !== source.file ||
      copy.export !== source.exportName ||
      copy.source !== source.modulePath
    )
      throw new Error(`Catalog schema provenance for ${name} is malformed`);
    const sql = await readFile(path.join(vendorRoot, source.file), "utf8");
    if (catalogSchemaDigest(sql) !== copy.sha256)
      throw new Error(
        `Pinned ${name} catalog schema does not match its provenance digest. Run ${SYNC_COMMAND}.`,
      );
    sources[name] = "pinned-copy";
    if (await exists(path.join(workspace, source.checkout))) {
      if ((await readSiblingSchema(workspace, name)) !== sql)
        throw new Error(
          `Pinned ${name} catalog schema differs from ../${source.checkout}. Confirm that checkout holds the intended schema, then run ${SYNC_COMMAND}.`,
        );
      sources[name] = "pinned-copy-matches-checkout";
    }
    schemas[name] = sql;
  }
  return { ...schemas, sources };
}

function git(checkout: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-C", checkout, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString().trim() };
}

/** Rewrites the pinned copies from committed sibling schema modules. */
export async function syncCatalogSchemas(
  options: { workspace?: string; vendorRoot?: string } = {},
) {
  const workspace = options.workspace ?? DEFAULT_WORKSPACE;
  const vendorRoot = options.vendorRoot ?? DEFAULT_VENDOR_ROOT;
  const copies: ProvenanceCopy[] = [];
  const sqlByName = {} as Record<CatalogSchemaName, string>;
  // Read and validate every source before writing, so a refused sync leaves
  // the existing copies and provenance untouched.
  for (const name of NAMES) {
    const source = CATALOG_SCHEMA_SOURCES[name];
    const checkout = path.join(workspace, source.checkout);
    const clean = git(checkout, [
      "diff",
      "--quiet",
      "HEAD",
      "--",
      source.modulePath,
    ]).exitCode;
    if (clean === 1)
      throw new Error(
        `Commit ${source.checkout}/${source.modulePath} before syncing its catalog schema`,
      );
    if (clean !== 0)
      throw new Error(`Cannot inspect the ${source.checkout} checkout`);
    const sourceCommit = git(checkout, [
      "log",
      "-1",
      "--format=%H",
      "--",
      source.modulePath,
    ]).stdout;
    if (!/^[a-f0-9]{40}$/.test(sourceCommit))
      throw new Error(
        `Cannot resolve the commit of ${source.checkout}/${source.modulePath}`,
      );
    const sql = await readSiblingSchema(workspace, name);
    sqlByName[name] = sql;
    copies.push({
      name,
      path: source.file,
      export: source.exportName,
      repository: source.repository,
      source: source.modulePath,
      sourceCommit,
      sha256: catalogSchemaDigest(sql),
    });
  }
  for (const name of NAMES)
    await writeFile(
      path.join(vendorRoot, CATALOG_SCHEMA_SOURCES[name].file),
      sqlByName[name],
    );
  const provenance: Provenance = { schemaVersion: 1, copies };
  await writeFile(
    path.join(vendorRoot, "provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  return provenance;
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !["--check", "--sync"].includes(mode!)) {
    console.error(
      "Usage: bun scripts/testing/catalog-schemas.ts --check|--sync",
    );
    process.exit(2);
  }
  try {
    if (mode === "--sync") {
      const provenance = await syncCatalogSchemas();
      for (const copy of provenance.copies)
        console.log(`${copy.path}: ${copy.repository}@${copy.sourceCommit}`);
    } else {
      const { sources } = await loadCatalogSchemas();
      console.log(JSON.stringify(sources));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
