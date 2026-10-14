import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createApp } from "../../src/app";
import { readConfig } from "../../src/config";
import { createLocalSigningKeyLoader } from "../../src/auth/local-signing-key";
import { createTokenService } from "../../src/auth/tokens";
import { LocalMealImageStorage } from "../../src/nutrition/meal-image-storage";
import {
  loadTestManifest,
  requireOwnedTestDatabase,
} from "../../tests/helpers/test-database";
import { assertApiProcessRecord } from "./document-validation";
import { queryOwnedProcess } from "./process-query";

const manifest = loadTestManifest();
const args = process.argv.slice(2);
if (
  args.length !== 4 ||
  args[0] !== "--run-id" ||
  args[1] !== manifest.runId ||
  args[2] !== "--attempt" ||
  !/^[a-z0-9-]{1,48}$/.test(args[3] ?? "")
)
  throw new Error("Invalid owned API server arguments");
for (const key of [
  "DATABASE_URL",
  "FOOD_CATALOG_DATABASE_URL",
  "EXERCISE_CATALOG_DATABASE_URL",
] as const)
  await requireOwnedTestDatabase(key);
const config = readConfig();
if (
  config.production ||
  config.gcsBucket ||
  config.googleClientIds.length ||
  config.appleClientIds.length ||
  config.revenueCatSecretApiKey ||
  !config.localDevAuthEnabled
)
  throw new Error(
    "Integration server must use local auth/storage without provider credentials",
  );
const runRoot = path.dirname(process.env.MC_TEST_MANIFEST!);
await mkdir(path.join(runRoot, "storage"), { mode: 0o700, recursive: true });
const app = createApp({
  config,
  tokenService: createTokenService({
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
    signingKeyLoader: createLocalSigningKeyLoader(
      path.join(runRoot, "storage/auth-signing-key.jwk.json"),
    ),
  }),
  mealImageStorage: new LocalMealImageStorage(
    path.join(runRoot, "storage/meal-images"),
  ),
}).listen({ hostname: "127.0.0.1", port: 0 });
const ledgerPath = path.join(runRoot, `api-${args[3]}.json`);
const started = await queryOwnedProcess(process.pid, "lstart");
if (!started) throw new Error("Cannot establish API process identity");
const record = {
  schemaVersion: 1,
  runId: manifest.runId,
  ownerTokenHash: manifest.ownerTokenHash,
  pid: process.pid,
  started,
  script: path.resolve(import.meta.path),
  attempt: args[3],
  origin: `http://127.0.0.1:${app.server!.port}`,
};
assertApiProcessRecord(record);
await writeFile(ledgerPath, JSON.stringify(record), { mode: 0o600 });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.stop(true);
  await rm(ledgerPath, { force: true });
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
