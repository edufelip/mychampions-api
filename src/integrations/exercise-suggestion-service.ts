import type { ServerConfig } from '../config';
import { exactCandidateMatches, isCandidateEligibleForSuggestion, type ExerciseCandidate } from './exercise-candidates';
import { parseExerciseQuery } from './exercise-query';
import { ExerciseSuggestionLimiter } from './exercise-suggestion-limits';
import type { ExerciseItem, ExerciseSearchGateway } from './exercise-search-gateway';
import type { TypeSafeExerciseClient } from './typesafe-exercise-client';

export type ExerciseSuggestionStatus =
  | 'suggested'
  | 'no_match'
  | 'unsupported_query'
  | 'disabled'
  | 'unavailable';

export type ExerciseSuggestionResult = {
  schemaVersion: 'exercise-suggestion.v1';
  query: string;
  lang: string;
  page: 1;
  pageSize: number;
  total: number;
  results: ExerciseItem[];
  suggestion: { exerciseId: string } | null;
  status: ExerciseSuggestionStatus;
  rateLimited?: boolean;
};

export type ExerciseSuggestionService = {
  suggest(input: {
    authUid: string;
    query: string;
    pageSize: number;
    lang: string;
    requestId?: string;
    signal?: AbortSignal;
  }): Promise<ExerciseSuggestionResult>;
};

function asCandidate(item: ExerciseItem): ExerciseCandidate {
  return {
    id: item.id,
    slug: item.slug,
    title: item.title,
    description: item.description,
    muscleGroup: item.muscleGroup,
    equipment: item.equipment,
    canonicalEquipment: null,
    rank: [1, 1, 0, 1, 1, '', ''],
  };
}

export class DefaultExerciseSuggestionService implements ExerciseSuggestionService {
  private readonly limiter: ExerciseSuggestionLimiter;

  constructor(
    private readonly deps: {
      gateway: ExerciseSearchGateway;
      config: ServerConfig;
      client: TypeSafeExerciseClient;
      limiter?: ExerciseSuggestionLimiter;
    },
  ) {
    this.limiter = deps.limiter ?? new ExerciseSuggestionLimiter();
  }

  async suggest(input: {
    authUid: string;
    query: string;
    pageSize: number;
    lang: string;
    requestId?: string;
    signal?: AbortSignal;
  }): Promise<ExerciseSuggestionResult> {
    const query = input.query.trim();
    const pageSize = Math.min(Math.max(input.pageSize, 1), 50);
    const search = await this.deps.gateway.search({
      authUid: input.authUid,
      query,
      pageSize,
      lang: input.lang.trim(),
    });
    const base = {
      schemaVersion: 'exercise-suggestion.v1' as const,
      query,
      lang: input.lang.trim(),
      page: 1 as const,
      pageSize,
      total: search.exercises.length,
      results: search.exercises,
      suggestion: null,
    };
    const parsed = parseExerciseQuery(query);

    if (!this.deps.config.exerciseSuggestionsEnabled || !this.deps.config.exerciseSearchV2Enabled) {
      return { ...base, status: 'disabled' };
    }
    if (parsed.unsupportedConstraint || parsed.contradictoryConstraint) {
      return { ...base, status: 'unsupported_query' };
    }
    if (search.exercises.length === 0) return { ...base, status: 'no_match' };

    const candidates = search.exercises.map(asCandidate);
    const exact = exactCandidateMatches(parsed, candidates);
    if (exact.length === 1) return { ...base, status: 'no_match' };

    const eligible = candidates.filter((candidate) => isCandidateEligibleForSuggestion(parsed, candidate));
    if (eligible.length === 0) return { ...base, status: 'no_match' };
    if (!this.deps.config.typesafeApiKey) {
      console.info(JSON.stringify({ event: 'exercise_suggestion', status: 'unavailable', reason: 'missing_provider_key', candidateCount: eligible.length }));
      return { ...base, status: 'unavailable' };
    }

    const permit = this.limiter.tryAcquire(input.authUid);
    if (!permit) {
      return { ...base, status: 'unavailable', rateLimited: true };
    }
    try {
      const modelCandidates = search.exercises
        .filter((item) => eligible.some((candidate) => candidate.id === item.id))
        .slice(0, Math.min(pageSize, 20));
      const choice = await this.deps.client.choose({
        query,
        lang: input.lang,
        candidates: modelCandidates,
        model: this.deps.config.typesafeModel,
        timeoutMs: this.deps.config.exerciseSuggestionTimeoutMs,
        requestId: input.requestId,
        signal: input.signal,
      });
      if (choice.exerciseId === null) {
        this.limiter.release(permit, 'success');
        console.info(JSON.stringify({ event: 'exercise_suggestion', status: 'no_match', candidateCount: eligible.length, model: choice.model }));
        return { ...base, status: 'no_match' };
      }
      const selected = search.exercises.find((candidate) => candidate.id === choice.exerciseId);
      if (!selected) {
        this.limiter.release(permit, 'failure');
        return { ...base, status: 'unavailable' };
      }
      if (!eligible.some((candidate) => candidate.id === selected.id)) {
        this.limiter.release(permit, 'failure');
        return { ...base, status: 'unavailable' };
      }
      if (choice.confidence < this.deps.config.exerciseSuggestionConfidence) {
        this.limiter.release(permit, 'success');
        return { ...base, status: 'no_match' };
      }
      this.limiter.release(permit, 'success');
      console.info(JSON.stringify({ event: 'exercise_suggestion', status: 'suggested', candidateCount: eligible.length, model: choice.model }));
      return { ...base, status: 'suggested', suggestion: { exerciseId: selected.id } };
    } catch (error) {
      this.limiter.release(permit, 'failure');
      console.info(JSON.stringify({ event: 'exercise_suggestion', status: 'unavailable', candidateCount: eligible.length }));
      return { ...base, status: 'unavailable' };
    }
  }
}

export function createExerciseSuggestionService(deps: {
  gateway: ExerciseSearchGateway;
  config: ServerConfig;
  client: TypeSafeExerciseClient;
  limiter?: ExerciseSuggestionLimiter;
}): ExerciseSuggestionService {
  return new DefaultExerciseSuggestionService(deps);
}
