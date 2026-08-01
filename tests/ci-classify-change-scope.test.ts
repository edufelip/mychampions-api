import { describe, expect, test } from 'bun:test';
import { classify, parseNameStatusZ } from '../scripts/ci/classify-change-scope';

describe('classify', () => {
  test('src/tests-only changes stay narrow', () => {
    const result = classify(['src/routes/auth.ts', 'tests/auth-account.test.ts']);
    expect(result.fullScope).toBe(false);
  });

  test('docs-only changes stay narrow', () => {
    const result = classify(['README.md', 'docs/qa-smoke-pack.md']);
    expect(result.fullScope).toBe(false);
  });

  test('lockfile changes force full scope', () => {
    const result = classify(['bun.lock']);
    expect(result.fullScope).toBe(true);
    expect(result.fullScopeHits).toContain('bun.lock');
  });

  test('workflow changes force full scope', () => {
    const result = classify(['.github/workflows/ci.yml']);
    expect(result.fullScope).toBe(true);
  });

  test('classifier script changes force full scope', () => {
    const result = classify(['scripts/ci/classify-change-scope.js']);
    expect(result.fullScope).toBe(true);
  });

  test('drizzle schema changes force full scope', () => {
    const result = classify(['drizzle/0032_add_specialty.sql']);
    expect(result.fullScope).toBe(true);
  });

  test('unrecognized root path fails conservative to full scope', () => {
    const result = classify(['some-new-top-level-thing.ts']);
    expect(result.fullScope).toBe(true);
    expect(result.unknownHits).toContain('some-new-top-level-thing.ts');
  });

  test('mixed source + docs stays narrow', () => {
    const result = classify(['src/routes/exercise-search.ts', 'README.md']);
    expect(result.fullScope).toBe(false);
  });

  test('tooling config changes force full scope', () => {
    for (const path of ['.bun-version', 'tsconfig.json', 'Dockerfile', 'drizzle.config.ts']) {
      expect(classify([path]).fullScope).toBe(true);
    }
  });

  test('infra and env-example changes stay narrow', () => {
    const result = classify(['infra/main.tf', '.env.example', '.gitignore']);
    expect(result.fullScope).toBe(false);
  });

  test('empty changeset stays narrow', () => {
    const result = classify([]);
    expect(result.fullScope).toBe(false);
    expect(result.fullScopeHits).toEqual([]);
    expect(result.unknownHits).toEqual([]);
  });
});

describe('parseNameStatusZ', () => {
  test('parses simple add/modify/delete entries', () => {
    const raw = ['M', 'src/a.ts', 'A', 'src/b.ts', 'D', 'src/c.ts'].join('\0') + '\0';
    expect(parseNameStatusZ(raw)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  test('parses rename entries keeping old and new paths', () => {
    const raw = ['R100', 'src/old.ts', 'src/new.ts'].join('\0') + '\0';
    expect(parseNameStatusZ(raw)).toEqual(['src/old.ts', 'src/new.ts']);
  });

  test('parses a mix of modify, rename, and copy entries in one diff', () => {
    const raw =
      ['M', 'src/a.ts', 'R087', 'src/old.ts', 'src/new.ts', 'C092', 'src/base.ts', 'src/copy.ts'].join('\0') + '\0';
    expect(parseNameStatusZ(raw)).toEqual([
      'src/a.ts',
      'src/old.ts',
      'src/new.ts',
      'src/base.ts',
      'src/copy.ts',
    ]);
  });

  test('returns an empty list for an empty diff', () => {
    expect(parseNameStatusZ('')).toEqual([]);
  });
});
