import { describe, expect, it } from 'bun:test';
import { validateTestTarget, type TestManifest } from './helpers/test-database';
import { manifestFixture } from './helpers/resource-manifest';

const runId = 'abcdef012345abcdef012345';
const token = 'owned-test-token';
const manifest: TestManifest = {
  ...manifestFixture(runId, '/private/test', token),
  containerId: 'a'.repeat(64),
  port: 25432,
};
const url = `postgres://mc_test:password@127.0.0.1:25432/mc_test_${runId}`;
describe('owned test database target guard', () => {
  it('accepts only the exact local target and owner proof', () => {
    expect(validateTestTarget(url, manifest, 'DATABASE_URL', token)).toBe(url);
  });
  for (const [name, value] of [
    ['missing', undefined],
    ['malformed', 'invalid'],
    [
      'developer DB',
      url.replace(`mc_test_${runId}`, 'mychampions_server_local'),
    ],
    ['remote host', url.replace('127.0.0.1', 'example.com')],
    ['developer port', url.replace('25432', '15432')],
    ['wrong run', url.replace(runId, '123456abcdef123456abcdef')],
    ['connection overrides', `${url}?host=example.com`],
    ['wrong user', url.replace('mc_test:password', 'postgres:password')],
  ] as const)
    it(`rejects ${name} before opening a connection`, () =>
      expect(() =>
        validateTestTarget(value, manifest, 'DATABASE_URL', token)
      ).toThrow('Unsafe/unowned'));
  it('rejects a copied prefix without owner proof or manifest match', () => {
    expect(() =>
      validateTestTarget(url, manifest, 'DATABASE_URL', 'another-owner')
    ).toThrow();
    expect(() =>
      validateTestTarget(
        url,
        {
          ...manifest,
          targets: { ...manifest.targets, DATABASE_URL: 'other' },
        },
        'DATABASE_URL',
        token
      )
    ).toThrow();
  });
});
