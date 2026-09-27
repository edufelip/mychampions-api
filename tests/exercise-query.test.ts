import { describe, expect, it } from 'bun:test';

import {
  equipmentConstraintMatches,
  normalizeEquipment,
  normalizeExerciseText,
  parseExerciseQuery,
} from '../src/integrations/exercise-query';

describe('exercise query normalization and constraints', () => {
  it('normalizes accents, punctuation, and whitespace without rewriting the source query', () => {
    expect(normalizeExerciseText('  Supino   Reto — com barra  ')).toBe('supino reto com barra');
    expect(parseExerciseQuery('  Supino   Reto — com barra  ').original).toBe('Supino   Reto — com barra');
  });

  it('recognizes supported positive and negative equipment phrases', () => {
    expect(parseExerciseQuery('supino reto com barra').equipmentConstraint).toEqual({ kind: 'include', canonical: 'barbell' });
    expect(parseExerciseQuery('flexão sem equipamento').equipmentConstraint).toEqual({ kind: 'include', canonical: 'bodyweight' });
    expect(parseExerciseQuery('supino sem barra').equipmentConstraint).toEqual({ kind: 'exclude', canonical: 'barbell' });
  });

  it('keeps phrase-local negation and rejects contradictory or unsupported constraints', () => {
    const mixed = parseExerciseQuery('sem barra com halteres');
    expect(mixed.equipmentConstraint).toBeNull();
    expect(mixed.unsupportedConstraint).toBe(true);
    expect(parseExerciseQuery('com barra sem barra').contradictoryConstraint).toBe(true);
    expect(parseExerciseQuery('sem máquina').unsupportedConstraint).toBe(true);
    expect(parseExerciseQuery('without barbells').equipmentConstraint).toEqual({ kind: 'exclude', canonical: 'barbell' });
    expect(parseExerciseQuery('anything except the thing I used yesterday').unsupportedConstraint).toBe(true);
  });

  it('fails closed for unknown equipment metadata', () => {
    expect(normalizeEquipment('mystery apparatus')).toBeNull();
    expect(normalizeEquipment('barbell dumbbell')).toBeNull();
    const query = parseExerciseQuery('push up sem barra');
    expect(equipmentConstraintMatches(query, 'mystery apparatus')).toBe(false);
  });
});
