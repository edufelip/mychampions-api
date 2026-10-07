import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export type ResourceManifest = {
  schemaVersion: 1;
  runId: string;
  composeProject: string;
  containerId: string | null;
  ownerTokenHash: string;
  port: number;
  targets: Record<
    | "DATABASE_URL"
    | "FOOD_CATALOG_DATABASE_URL"
    | "EXERCISE_CATALOG_DATABASE_URL",
    string
  >;
  repoRoot: string;
  runtimeRoot: string;
  artifactRoot: string;
  createdAt: string;
  repositories: Record<
    string,
    { sha: string; dirty: boolean; workingTreeHash: string }
  >;
  orchestratorPid: number;
  testChildPid: number | null;
  phase: "bootstrap" | "tests" | "cleanup";
  fixtureScopes: string[];
  processes: {
    role: "orchestrator" | "test" | "api";
    pid: number;
    started: string;
    script: string;
  }[];
};
export type ApiProcessRecord = {
  schemaVersion: 1;
  runId: string;
  ownerTokenHash: string;
  pid: number;
  started: string;
  script: string;
  attempt: string;
  origin: string;
};
const ajv = new Ajv({
  allErrors: true,
  strictTypes: false,
  strictRequired: false,
});
ajv.addFormat("utc-timestamp", (value: string) => {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value;
});
const directory = fileURLToPath(new URL("./schemas/", import.meta.url));
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
const names = new Set([
  "resource-manifest-v1",
  "api-process-v1",
  "session-request-v1",
  "session-event-v1",
  "application-fixtures-v1",
  "session-receipt-v1",
  "domain-snapshot-v1",
  "connection-snapshot-v1",
]);
export function assertTestDocument(name: string, value: unknown): void {
  if (!names.has(name)) throw new Error("Unknown test document schema");
  let validate = validators.get(name);
  if (!validate) {
    validate = ajv.compile(
      JSON.parse(
        readFileSync(path.join(directory, `${name}.schema.json`), "utf8"),
      ),
    );
    validators.set(name, validate);
  }
  if (!validate(value)) {
    // Paths/keywords only: validator diagnostics must never echo private values.
    const failures = validate.errors
      ?.map((error) => `${error.instancePath || "/"}:${error.keyword}`)
      .join(", ");
    throw new Error(`Invalid ${name} document (${failures})`);
  }
}
export function assertResourceManifest(
  value: unknown,
): asserts value is ResourceManifest {
  assertTestDocument("resource-manifest-v1", value);
  const manifest = value as ResourceManifest;
  const orchestrators = manifest.processes.filter(
    (record) => record.role === "orchestrator",
  );
  if (
    manifest.composeProject !== `mc_test_${manifest.runId}` ||
    manifest.targets.DATABASE_URL !== `mc_test_${manifest.runId}` ||
    manifest.targets.FOOD_CATALOG_DATABASE_URL !==
      `mc_test_${manifest.runId}_food` ||
    manifest.targets.EXERCISE_CATALOG_DATABASE_URL !==
      `mc_test_${manifest.runId}_exercise` ||
    orchestrators.length !== 1 ||
    orchestrators[0]!.pid !== manifest.orchestratorPid ||
    new Set(manifest.processes.map((record) => record.pid)).size !==
      manifest.processes.length
  )
    throw new Error("Resource manifest identity fields disagree");
}
/** Terminal audits need every acquired identity; history is not signal authority. */
export function retainManifestProcessHistory(
  manifest: ResourceManifest,
  current: ResourceManifest["processes"],
): ResourceManifest["processes"] {
  const retained = new Map<number, ResourceManifest["processes"][number]>();
  for (const record of [...manifest.processes, ...current]) {
    const previous = retained.get(record.pid);
    if (previous && !isDeepStrictEqual(previous, record))
      throw new Error(
        "Retained process identity changed; recovery ledger retained",
      );
    retained.set(record.pid, structuredClone(record));
  }
  const processes = [...retained.values()];
  assertResourceManifest({ ...manifest, processes });
  return processes;
}

export function assertApiProcessRecord(
  value: unknown,
): asserts value is ApiProcessRecord {
  assertTestDocument("api-process-v1", value);
  const url = new URL((value as ApiProcessRecord).origin);
  if (Number(url.port) < 1024 || Number(url.port) > 65535)
    throw new Error("Invalid owned API port");
}
