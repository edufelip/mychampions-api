import { describe, expect, it } from 'bun:test';

import {
  exactCandidateMatches,
  isCandidateEligibleForSuggestion,
  rankAndCapCandidates,
  type ExerciseCandidate,
} from '../src/integrations/exercise-candidates';
import { parseExerciseQuery } from '../src/integrations/exercise-query';

function candidate(id: string, title: string, equipment: string): ExerciseCandidate {
  return {
    id,
    slug: id,
    title,
    description: null,
    muscleGroup: 'chest',
    equipment,
    canonicalEquipment: null,
    rank: [1, 1, 0, 1, 1, '', ''],
  };
}

describe('deterministic exercise candidates', () => {
  it('ranks exact and movement matches before display-name ties and caps after ranking', () => {
    const query = parseExerciseQuery('supino reto');
    const results = rankAndCapCandidates(query, [
      candidate('z', 'Bench Press', 'barbell'),
      candidate('a', 'Supino Reto', 'barbell'),
      candidate('b', 'Chest Press', 'machine'),
    ], 2);

    expect(results.map((item) => item.id)).toEqual(['a', 'z']);
  });

  it('deduplicates catalog rows by exercise id and applies explicit equipment eligibility', () => {
    const query = parseExerciseQuery('push up sem barra');
    const rows = rankAndCapCandidates(query, [
      candidate('same', 'Push Up', 'bodyweight'),
      candidate('same', 'Push Up', 'bodyweight'),
      candidate('unknown', 'Push Up', 'mystery apparatus'),
    ]);
    expect(rows).toHaveLength(2);
    expect(isCandidateEligibleForSuggestion(query, rows[0])).toBe(true);
    expect(isCandidateEligibleForSuggestion(query, rows[1])).toBe(false);
    expect(exactCandidateMatches(parseExerciseQuery('push up'), rows)).toHaveLength(2);
  });
});
