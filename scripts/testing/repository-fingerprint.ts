import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

export type OwnedRepositoryFingerprint = {
  sha: string;
  dirty: boolean;
  workingTreeHash: string;
};

const EXCLUDED_UNTRACKED_PREFIX =
  /^(?:artifacts|test-results|\.qa\/artifacts)\//;

function gitOutput(argv: string[]) {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error("Cannot record repository identity.");
  }
  return result.stdout;
}

/**
 * Fingerprint a repository without following untracked symlinks or treating
 * directories as file bytes. This deliberately preserves the existing hash
 * inputs for regular files so existing evidence remains comparable.
 */
export async function fingerprintOwnedRepository(
  directory: string,
): Promise<OwnedRepositoryFingerprint> {
  const repository = path.resolve(directory);
  const sha = gitOutput(["git", "-C", repository, "rev-parse", "HEAD"]);
  const status = gitOutput(["git", "-C", repository, "status", "--porcelain"]);
  const diff = Bun.spawnSync(
    ["git", "-C", repository, "diff", "--binary", "HEAD"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const untracked = Bun.spawnSync(
    ["git", "-C", repository, "ls-files", "--others", "--exclude-standard"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (diff.exitCode !== 0 || untracked.exitCode !== 0) {
    throw new Error("Cannot fingerprint tested worktree");
  }

  const fingerprint = createHash("sha256").update(sha).update(diff.stdout);
  for (const file of untracked.stdout
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort()) {
    if (EXCLUDED_UNTRACKED_PREFIX.test(file)) continue;
    const absolute = path.join(repository, file);
    let entry;
    try {
      entry = await lstat(absolute);
    } catch {
      throw new Error(`Cannot fingerprint untracked path: ${file}`);
    }
    if (!entry.isFile()) {
      throw new Error(`Cannot fingerprint non-regular untracked path: ${file}`);
    }
    try {
      fingerprint.update(file).update(await readFile(absolute));
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EISDIR"
      ) {
        throw new Error(
          `Cannot fingerprint non-regular untracked path: ${file}`,
        );
      }
      throw error;
    }
  }
  return {
    sha: sha.toString().trim(),
    dirty: Boolean(status.toString().trim()),
    workingTreeHash: fingerprint.digest("hex"),
  };
}

/**
 * Identity recorded for a client checkout that is absent from a server-only
 * run (hosted server CI checks out only the server repository). The
 * manifest schema, which the client vendors by content hash, still requires a
 * client identity. Git's null object ID and an all-zero working-tree hash are
 * values no real checkout produces, so any consumer that compares this
 * identity with a real client fails closed.
 */
export const ABSENT_REPOSITORY_FINGERPRINT: Readonly<OwnedRepositoryFingerprint> =
  Object.freeze({
    sha: "0".repeat(40),
    dirty: false,
    workingTreeHash: "0".repeat(64),
  });

export type ClientCheckoutRequirement = "required" | "optional";

/**
 * Fingerprint the server and client worktrees for an owned run. Only an
 * explicitly optional client checkout that does not exist at all is recorded
 * as absent; a present but unreadable client still fails the preflight.
 */
export async function fingerprintOwnedRepositories(input: {
  server: string;
  client: string;
  clientCheckout: ClientCheckoutRequirement;
}): Promise<{
  repositories: {
    server: OwnedRepositoryFingerprint;
    client: OwnedRepositoryFingerprint;
  };
  clientCheckout: "present" | "absent";
}> {
  const server = await fingerprintOwnedRepository(input.server);
  if (input.clientCheckout === "optional") {
    try {
      await lstat(input.client);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return {
          repositories: { server, client: { ...ABSENT_REPOSITORY_FINGERPRINT } },
          clientCheckout: "absent",
        };
      }
      throw new Error("Cannot inspect client checkout");
    }
  }
  const client = await fingerprintOwnedRepository(input.client);
  return { repositories: { server, client }, clientCheckout: "present" };
}
