import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';

const workflow = readFileSync('.github/workflows/quality.yml', 'utf8');

describe('service quality workflow contract', () => {
  it('checks out and verifies the exact pull-request head without persisting credentials', () => {
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('ref: ${{ github.event.pull_request.head.sha || github.sha }}');
    expect(workflow).toContain('EXPECTED_SHA: ${{ github.event.pull_request.head.sha || github.sha }}');
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"');
  });

  it('seeds catalog fixtures before executing integration coverage', () => {
    const seedIndex = workflow.indexOf('Seed deterministic catalog fixtures');
    const integrationIndex = workflow.indexOf('name: Integration tests');
    expect(seedIndex).toBeGreaterThanOrEqual(0);
    expect(integrationIndex).toBeGreaterThan(seedIndex);
    expect(workflow).toContain('tests/fixtures/food-catalog-ci.sql');
    expect(workflow).toContain('tests/fixtures/exercise-catalog-ci.sql');
    expect(workflow).toContain("CATALOG_TEST_FIXTURES: 'true'");
  });
});
