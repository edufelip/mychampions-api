import { describe, expect, it } from 'bun:test';

import { createApp } from '../src/app';
import { readConfig } from '../src/config';
import type { ExerciseSearchGateway } from '../src/integrations/exercise-search-gateway';
import type { TypeSafeExerciseClient } from '../src/integrations/typesafe-exercise-client';
import type { ProfileRepository } from '../src/profile/repository';

function makeProfileRepository(): ProfileRepository {
  return {
    async upsertFromSession(input) {
      return {
        authUid: input.authUid,
        displayName: input.displayName,
        emailNormalized: input.emailNormalized,
        lockedRole: 'student',
        acceptedTermsVersion: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
    },
    async findByAuthUid() { return null; },
    async lockRole() { throw new Error('not implemented'); },
    async setAcceptedTermsVersion() { throw new Error('not implemented'); },
    async deleteByAuthUid() {},
  };
}

async function issueSession(app: ReturnType<typeof createApp>) {
  const response = await app.handle(new Request('http://server.test/auth/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'exercise@example.test', displayName: 'Exercise User' }),
  }));
  return response.json() as Promise<{ accessToken: string; profile: { authUid: string } }>;
}

const results = [
  { id: 'bench', slug: 'bench-press', title: 'Bench Press', muscleGroup: 'chest', equipment: 'barbell', hasVideo: false, hasVideoWhite: false, hasVideoGym: false },
  { id: 'push', slug: 'push-up', title: 'Push-Up', muscleGroup: 'chest', equipment: 'bodyweight', hasVideo: false, hasVideoWhite: false, hasVideoGym: false },
];

function makeGateway(): ExerciseSearchGateway {
  return {
    async search() { return { page: 1, pageSize: 20, total: results.length, exercises: results }; },
    async getById() { return results[0]; },
  };
}

describe('exercise suggestion route', () => {
  it('keeps ordinary search independent from the model client', async () => {
    let modelCalls = 0;
    const client: TypeSafeExerciseClient = {
      async choose() { modelCalls += 1; throw new Error('model must not be called by ordinary search'); },
    };
    const app = createApp({
      config: readConfig({ EXERCISE_SEARCH_V2_ENABLED: 'true', EXERCISE_SUGGESTIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'test-key' }),
      profileRepository: makeProfileRepository(),
      exerciseSearchGateway: makeGateway(),
      typeSafeExerciseClient: client,
    });
    const session = await issueSession(app);
    const response = await app.handle(new Request('http://server.test/integrations/exercise/search', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'push', pageSize: 20, lang: 'en-US' }),
    }));
    expect(response.status).toBe(200);
    expect(modelCalls).toBe(0);
  });

  it('requires authentication and explicit consent before catalog/provider access', async () => {
    let searches = 0;
    const gateway = makeGateway();
    const wrappedGateway: ExerciseSearchGateway = {
      async search(input) { searches += 1; return gateway.search(input); },
      async getById(input) { return gateway.getById(input); },
    };
    const app = createApp({ profileRepository: makeProfileRepository(), exerciseSearchGateway: wrappedGateway });
    const unauthenticated = await app.handle(new Request('http://server.test/integrations/exercise/suggest', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'push', lang: 'en-US', consent: true }),
    }));
    expect(unauthenticated.status).toBe(401);
    expect(searches).toBe(0);
    const session = await issueSession(app);
    const noConsent = await app.handle(new Request('http://server.test/integrations/exercise/suggest', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'push', lang: 'en-US', consent: false }),
    }));
    expect(noConsent.status).toBe(400);
    expect(searches).toBe(0);
  });

  it('returns a bounded suggestion whose id belongs to the same response results', async () => {
    const client: TypeSafeExerciseClient = {
      async choose(input) {
        expect(input.candidates.map((item) => item.id)).toEqual(['bench', 'push']);
        return { exerciseId: 'push', confidence: 0.99, model: 'jev-1.13.0' };
      },
    };
    const app = createApp({
      config: readConfig({ EXERCISE_SEARCH_V2_ENABLED: 'true', EXERCISE_SUGGESTIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'test-key' }),
      profileRepository: makeProfileRepository(), exerciseSearchGateway: makeGateway(), typeSafeExerciseClient: client,
    });
    const session = await issueSession(app);
    const response = await app.handle(new Request('http://server.test/integrations/exercise/suggest', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json', 'x-request-id': 'exercise-test' },
      body: JSON.stringify({ query: 'push', lang: 'en-US', pageSize: 20, consent: true }),
    }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.status).toBe('suggested');
    expect(payload.suggestion).toEqual({ exerciseId: 'push' });
    expect(payload.results.map((item: { id: string }) => item.id)).toContain(payload.suggestion.exerciseId);
  });

  it('does not send hard-excluded candidates to the provider', async () => {
    const client: TypeSafeExerciseClient = {
      async choose(input) {
        expect(input.candidates.map((item) => item.id)).toEqual(['push']);
        return { exerciseId: 'push', confidence: 0.99, model: 'jev-1.13.0' };
      },
    };
    const app = createApp({
      config: readConfig({ EXERCISE_SEARCH_V2_ENABLED: 'true', EXERCISE_SUGGESTIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'test-key' }),
      profileRepository: makeProfileRepository(), exerciseSearchGateway: makeGateway(), typeSafeExerciseClient: client,
    });
    const session = await issueSession(app);
    const response = await app.handle(new Request('http://server.test/integrations/exercise/suggest', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'sem barra', lang: 'pt-BR', pageSize: 20, consent: true }),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'suggested', suggestion: { exerciseId: 'push' } });
  });

  it('abstains from mixed or unknown negation instead of broadening eligibility', async () => {
    let modelCalls = 0;
    const client: TypeSafeExerciseClient = {
      async choose() {
        modelCalls += 1;
        throw new Error('unsupported constraints must not reach the provider');
      },
    };
    const app = createApp({
      config: readConfig({ EXERCISE_SEARCH_V2_ENABLED: 'true', EXERCISE_SUGGESTIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'test-key' }),
      profileRepository: makeProfileRepository(), exerciseSearchGateway: makeGateway(), typeSafeExerciseClient: client,
    });
    const session = await issueSession(app);
    for (const query of ['sem barra com halteres', 'sem máquina']) {
      const response = await app.handle(new Request('http://server.test/integrations/exercise/suggest', {
        method: 'POST',
        headers: { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, lang: 'pt-BR', pageSize: 20, consent: true }),
      }));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: 'unsupported_query', suggestion: null });
    }
    expect(modelCalls).toBe(0);
  });

  it('treats an unknown provider choice as unavailable rather than no_match', async () => {
    const client: TypeSafeExerciseClient = {
      async choose() {
        return { exerciseId: 'not-in-results', confidence: 0.99, model: 'jev-1.13.0' };
      },
    };
    const app = createApp({
      config: readConfig({ EXERCISE_SEARCH_V2_ENABLED: 'true', EXERCISE_SUGGESTIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'test-key' }),
      profileRepository: makeProfileRepository(), exerciseSearchGateway: makeGateway(), typeSafeExerciseClient: client,
    });
    const session = await issueSession(app);
    const response = await app.handle(new Request('http://server.test/integrations/exercise/suggest', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'unknown phrase', lang: 'en-US', pageSize: 20, consent: true }),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'unavailable', suggestion: null });
  });

  it('keeps the default limiter alive across repeated requests from one app instance', async () => {
    let modelCalls = 0;
    const client: TypeSafeExerciseClient = {
      async choose() {
        modelCalls += 1;
        return { exerciseId: 'push', confidence: 0.99, model: 'jev-1.13.0' };
      },
    };
    const app = createApp({
      config: readConfig({ EXERCISE_SEARCH_V2_ENABLED: 'true', EXERCISE_SUGGESTIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'test-key' }),
      profileRepository: makeProfileRepository(), exerciseSearchGateway: makeGateway(), typeSafeExerciseClient: client,
    });
    const session = await issueSession(app);
    const statuses: string[] = [];
    const httpStatuses: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      const response = await app.handle(new Request('http://server.test/integrations/exercise/suggest', {
        method: 'POST',
        headers: { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: `candidate phrase ${index}`, lang: 'en-US', pageSize: 20, consent: true }),
      }));
      const payload = await response.json() as { status: string; rateLimited?: boolean };
      statuses.push(payload.status);
      httpStatuses.push(response.status);
    }
    expect(modelCalls).toBe(5);
    expect(statuses).toEqual(['suggested', 'suggested', 'suggested', 'suggested', 'suggested', 'unavailable']);
    expect(httpStatuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('falls back to ordinary results when provider configuration is absent', async () => {
    let modelCalls = 0;
    const client: TypeSafeExerciseClient = { async choose() { modelCalls += 1; throw new Error('not called'); } };
    const app = createApp({
      config: readConfig({ EXERCISE_SEARCH_V2_ENABLED: 'true', EXERCISE_SUGGESTIONS_ENABLED: 'true' }),
      profileRepository: makeProfileRepository(), exerciseSearchGateway: makeGateway(), typeSafeExerciseClient: client,
    });
    const session = await issueSession(app);
    const response = await app.handle(new Request('http://server.test/integrations/exercise/suggest', {
      method: 'POST', headers: { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'push', lang: 'en-US', consent: true }),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'unavailable', suggestion: null, total: 2 });
    expect(modelCalls).toBe(0);
  });

});
