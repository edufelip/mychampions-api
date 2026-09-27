import {
  equipmentConstraintMatches,
  normalizeEquipment,
  normalizeExerciseText,
  type ExerciseQuery,
} from './exercise-query';

export type ExerciseCandidate = {
  id: string;
  slug: string;
  title: string;
  description?: string | null;
  muscleGroup: string;
  equipment: string;
  canonicalEquipment: string | null;
  rank: [number, number, number, number, number, string, string];
};

export function candidateText(candidate: Pick<ExerciseCandidate, 'title' | 'slug' | 'muscleGroup' | 'equipment'>): string {
  return normalizeExerciseText(
    [candidate.title, candidate.slug, candidate.muscleGroup, candidate.equipment].filter(Boolean).join(' '),
  );
}

function tokenMatchCount(query: ExerciseQuery, candidate: ExerciseCandidate): number {
  const text = candidateText(candidate);
  return query.tokens.filter((token) => text.includes(token)).length;
}

function movementMatchCount(query: ExerciseQuery, candidate: ExerciseCandidate): number {
  const text = candidateText(candidate);
  return query.movementTokens.filter((token) => token.split(' ').every((part) => text.includes(part))).length;
}

export function isCandidateEligibleForSuggestion(query: ExerciseQuery, candidate: ExerciseCandidate): boolean {
  if (query.unsupportedConstraint || query.contradictoryConstraint) return false;
  return equipmentConstraintMatches(query, candidate.equipment);
}

export function rankExerciseCandidate(query: ExerciseQuery, candidate: ExerciseCandidate): ExerciseCandidate {
  const normalizedTitle = normalizeExerciseText(candidate.title);
  const normalizedSlug = normalizeExerciseText(candidate.slug);
  const exact = normalizedTitle === query.normalized || normalizedSlug === query.normalized ? 0 : 1;
  const matches = tokenMatchCount(query, candidate);
  const movementMatches = movementMatchCount(query, candidate);
  const allMovementTokens = query.movementTokens.length > 0 && movementMatches === query.movementTokens.length ? 0 : 1;
  const prefix = normalizedTitle.startsWith(query.normalized) || normalizedSlug.startsWith(query.normalized) ? 0 : 1;
  const equipmentAgreement = query.equipmentConstraint && isCandidateEligibleForSuggestion(query, candidate) ? 0 : 1;

  return {
    ...candidate,
    canonicalEquipment: normalizeEquipment(candidate.equipment),
    rank: [exact, allMovementTokens, -matches, prefix, equipmentAgreement, normalizedTitle, candidate.id],
  };
}

export function compareCandidateRank(a: ExerciseCandidate, b: ExerciseCandidate): number {
  for (let index = 0; index < a.rank.length; index += 1) {
    const left = a.rank[index];
    const right = b.rank[index];
    if (left === right) continue;
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left).localeCompare(String(right));
  }
  return 0;
}

export function rankAndCapCandidates(
  query: ExerciseQuery,
  candidates: ExerciseCandidate[],
  cap = 50,
): ExerciseCandidate[] {
  const deduplicated = new Map<string, ExerciseCandidate>();
  for (const candidate of candidates) {
    const ranked = rankExerciseCandidate(query, candidate);
    const current = deduplicated.get(ranked.id);
    if (!current || compareCandidateRank(ranked, current) < 0) deduplicated.set(ranked.id, ranked);
  }
  return [...deduplicated.values()].sort(compareCandidateRank).slice(0, cap);
}

export function exactCandidateMatches(query: ExerciseQuery, candidates: ExerciseCandidate[]): ExerciseCandidate[] {
  return candidates.filter((candidate) => {
    const title = normalizeExerciseText(candidate.title);
    const slug = normalizeExerciseText(candidate.slug);
    return title === query.normalized || slug === query.normalized;
  });
}
