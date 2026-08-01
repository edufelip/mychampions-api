#!/usr/bin/env bun
// Classifies a diff between two refs as either full-scope (run everything) or
// narrow (let `bun test --changed` pick related tests). Conservative by design:
// dependency/tooling/CI changes and any unrecognized path force full scope.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FULL_SCOPE_PATTERNS: RegExp[] = [
  /^package\.json$/,
  /^bun\.lock$/,
  /^\.bun-version$/,
  /^tsconfig\.json$/,
  /^Dockerfile$/,
  /^drizzle\.config\.ts$/,
  /^drizzle\//,
  /^\.github\/workflows\//,
  /^scripts\/ci\//,
];

const IGNORED_PATTERNS: RegExp[] = [
  /^README\.md$/,
  /^docs\//,
  /\.md$/,
  /^\.gitignore$/,
  /^\.env\.example$/,
  /^infra\//,
];

const SOURCE_ROOT_PATTERNS: RegExp[] = [/^src\//, /^tests\//];

export interface ClassifyResult {
  fullScope: boolean;
  fullScopeHits: string[];
  unknownHits: string[];
}

export function classify(paths: string[]): ClassifyResult {
  const fullScopeHits: string[] = [];
  const unknownHits: string[] = [];

  for (const path of paths) {
    if (FULL_SCOPE_PATTERNS.some((re) => re.test(path))) {
      fullScopeHits.push(path);
      continue;
    }
    if (IGNORED_PATTERNS.some((re) => re.test(path))) {
      continue;
    }
    if (SOURCE_ROOT_PATTERNS.some((re) => re.test(path))) {
      continue;
    }
    unknownHits.push(path);
  }

  return {
    fullScope: fullScopeHits.length > 0 || unknownHits.length > 0,
    fullScopeHits,
    unknownHits,
  };
}

export function parseNameStatusZ(output: string): string[] {
  const entries = output.split('\0').filter((entry) => entry.length > 0);
  const paths: string[] = [];
  let i = 0;
  while (i < entries.length) {
    const status = entries[i++];
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = entries[i++];
      const newPath = entries[i++];
      if (oldPath) paths.push(oldPath);
      if (newPath) paths.push(newPath);
    } else {
      const path = entries[i++];
      if (path) paths.push(path);
    }
  }
  return paths;
}

function getChangedPaths(mergeBase: string, head: string): string[] {
  const output = execFileSync(
    'git',
    ['diff', '--name-status', '-z', '-M', mergeBase, head],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 16 },
  );
  return parseNameStatusZ(output);
}

function main(): void {
  const [, , base, head] = process.argv;
  if (!base || !head) {
    console.error('Usage: classify-change-scope.ts <base-ref> <head-ref>');
    process.exit(2);
  }

  const mergeBase = execFileSync('git', ['merge-base', base, head], {
    encoding: 'utf8',
  }).trim();

  const paths = getChangedPaths(mergeBase, head);
  const { fullScope, fullScopeHits, unknownHits } = classify(paths);

  const result = { mergeBase, changedFiles: paths, fullScope, fullScopeHits, unknownHits };
  console.log(JSON.stringify(result, null, 2));

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `full_scope=${fullScope}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `merge_base=${mergeBase}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
