import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { fingerprintOwnedRepository } from "../scripts/testing/repository-fingerprint";

const scratchRoots: string[] = [];

async function makeGitRepository(label: string) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), `owned-fingerprint-${label}-`),
  );
  scratchRoots.push(directory);
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", directory, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed: ${result.stderr.toString()}`,
      );
    }
  };
  git(["init", "-q"]);
  git(["config", "user.email", "owned-fingerprint@example.test"]);
  git(["config", "user.name", "Owned Fingerprint Test"]);
  await writeFile(path.join(directory, "tracked.txt"), "tracked\n");
  git(["add", "tracked.txt"]);
  git(["commit", "-qm", "base"]);
  return { directory, git };
}

function expectedExistingHash(directory: string) {
  const run = (args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", directory, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
    return result.stdout;
  };
  const sha = run(["rev-parse", "HEAD"]);
  const diff = run(["diff", "--binary", "HEAD"]);
  const untracked = run(["ls-files", "--others", "--exclude-standard"]);
  const fingerprint = createHash("sha256").update(sha).update(diff);
  return (async () => {
    for (const file of untracked
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort()) {
      if (/^(?:artifacts|test-results|\.qa\/artifacts)\//.test(file)) continue;
      fingerprint
        .update(file)
        .update(await readFile(path.join(directory, file)));
    }
    return fingerprint.digest("hex");
  })();
}

afterEach(async () => {
  await Promise.all(
    scratchRoots
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("owned repository fingerprint preflight", () => {
  test("rejects an untracked symlink to a regular file", async () => {
    const { directory } = await makeGitRepository("file-symlink");
    const target = path.join(directory, "target.txt");
    const link = path.join(directory, "file-link");
    await writeFile(target, "target\n");
    await symlink("target.txt", link, "file");
    const linkStat = await lstat(link);
    expect(linkStat.isSymbolicLink()).toBe(true);
    await expect(fingerprintOwnedRepository(directory)).rejects.toThrow(
      "Cannot fingerprint non-regular untracked path: file-link",
    );
  });

  test("reproduces the old EISDIR failure for a directory symlink and rejects it explicitly", async () => {
    const { directory } = await makeGitRepository("symlink");
    const target = path.join(directory, "target-directory");
    const link = path.join(directory, "directory-link");
    await mkdir(target);
    await symlink("target-directory", link, "dir");
    await expect(readFile(link)).rejects.toMatchObject({ code: "EISDIR" });
    const linkStat = await lstat(link);
    expect(linkStat.isSymbolicLink()).toBe(true);
    await expect(fingerprintOwnedRepository(directory)).rejects.toThrow(
      "Cannot fingerprint non-regular untracked path: directory-link",
    );
  });

  test("keeps the existing regular-file working-tree hash byte-for-byte compatible", async () => {
    const { directory } = await makeGitRepository("regular");
    await mkdir(path.join(directory, "src"));
    await writeFile(
      path.join(directory, "src", "untracked.ts"),
      "export const value = 7;\n",
    );
    const actual = await fingerprintOwnedRepository(directory);
    expect(actual.workingTreeHash).toBe(await expectedExistingHash(directory));
    expect(actual.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(actual.dirty).toBe(true);
  });

  test("requires repository identity before the runtime namespace mkdir", async () => {
    const source = await readFile(
      new URL("../scripts/testing/owned-runtime.ts", import.meta.url),
      "utf8",
    );
    const fingerprintIndex = source.indexOf("fingerprintOwnedRepository(dir)");
    const mkdirIndex = source.indexOf("await mkdir(runRoot");
    expect(fingerprintIndex).toBeGreaterThanOrEqual(0);
    expect(mkdirIndex).toBeGreaterThan(fingerprintIndex);
    expect(source.slice(0, mkdirIndex)).not.toContain(
      "const manifest: TestManifest",
    );
  });
});
