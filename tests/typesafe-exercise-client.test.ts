import { describe, expect, it } from 'bun:test';

import { createTypeSafeExerciseClient, TypeSafeExerciseClientError } from '../src/integrations/typesafe-exercise-client';

const candidates = [
  { id: 'bench', slug: 'bench', title: 'Bench Press', muscleGroup: 'chest', equipment: 'barbell', hasVideo: false, hasVideoWhite: false, hasVideoGym: false },
];

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

describe('TypeSafe exercise client', () => {
  it('sends only bounded candidate metadata and normalizes none', async () => {
    let requestBody: Record<string, unknown> | null = null;
    const client = createTypeSafeExerciseClient({
      apiKey: 'server-only-key',
      endpoint: 'https://typesafe.test/v1/systemone',
      fetchFn: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({ model: 'jev-1.13.0', answers: { pick: { type: 'choice', choice: 'none', confidence: 1 } } });
      },
    });
    await expect(client.choose({ query: 'push', lang: 'en-US', candidates, model: 'jev-1.13.0', timeoutMs: 100 })).resolves.toMatchObject({ exerciseId: null });
    expect(requestBody).toMatchObject({ state: { query: 'push', lang: 'en-US' } });
    expect(JSON.stringify(requestBody)).not.toContain('server-only-key');
    expect(JSON.stringify(requestBody)).toContain('Bench Press');
  });

  it('rejects a choice outside the returned candidate set and invalid probabilities', async () => {
    const client = createTypeSafeExerciseClient({
      apiKey: 'key',
      fetchFn: async () => response({ model: 'jev-1.13.0', answers: { pick: { type: 'choice', choice: 'unknown', confidence: 1 } } }),
    });
    await expect(client.choose({ query: 'push', lang: 'en-US', candidates, model: 'jev-1.13.0', timeoutMs: 100 })).rejects.toBeInstanceOf(TypeSafeExerciseClientError);
    const invalid = createTypeSafeExerciseClient({
      apiKey: 'key',
      fetchFn: async () => response({ model: 'jev-1.13.0', answers: { pick: { type: 'choice', choice: 'bench', confidence: 1, probabilities: { bench: 2 } } } }),
    });
    await expect(invalid.choose({ query: 'push', lang: 'en-US', candidates, model: 'jev-1.13.0', timeoutMs: 100 })).rejects.toBeInstanceOf(TypeSafeExerciseClientError);
    const unknownProbability = createTypeSafeExerciseClient({
      apiKey: 'key',
      fetchFn: async () => response({ model: 'jev-1.13.0', answers: { pick: { type: 'choice', choice: 'bench', confidence: 1, probabilities: { unknown: 1 } } } }),
    });
    await expect(unknownProbability.choose({ query: 'push', lang: 'en-US', candidates, model: 'jev-1.13.0', timeoutMs: 100 })).rejects.toBeInstanceOf(TypeSafeExerciseClientError);
  });

  it('does not dispatch an already-aborted request', async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const client = createTypeSafeExerciseClient({ apiKey: 'key', fetchFn: async () => { calls += 1; return response({}); } });
    await expect(client.choose({ query: 'push', lang: 'en-US', candidates, model: 'jev-1.13.0', timeoutMs: 100, signal: controller.signal })).rejects.toBeInstanceOf(TypeSafeExerciseClientError);
    expect(calls).toBe(0);
  });

  it('rejects a successful response without a readable body before parsing', async () => {
    const client = createTypeSafeExerciseClient({
      apiKey: 'key',
      fetchFn: async () => new Response(null, { status: 200 }),
    });
    await expect(
      client.choose({ query: 'push', lang: 'en-US', candidates, model: 'jev-1.13.0', timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(TypeSafeExerciseClientError);
  });
});
