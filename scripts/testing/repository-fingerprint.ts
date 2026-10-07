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
