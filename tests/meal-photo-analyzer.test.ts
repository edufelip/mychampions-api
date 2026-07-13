import { describe, expect, it } from 'bun:test';

import {
  LocalMockMealPhotoAnalyzer,
  MealPhotoAnalyzerError,
  UnconfiguredMealPhotoAnalyzer,
  createMealPhotoAnalyzer,
  isValidMacroEstimateResult,
} from '../src/nutrition/meal-photo-analyzer';

describe('meal photo analyzer selection', () => {
  it('selects the deterministic local analyzer only when explicitly configured', () => {
    expect(createMealPhotoAnalyzer('local_mock')).toBeInstanceOf(LocalMockMealPhotoAnalyzer);
    expect(createMealPhotoAnalyzer('unconfigured')).toBeInstanceOf(UnconfiguredMealPhotoAnalyzer);
  });

  it('fails closed when analysis is not configured', async () => {
    await expect(new UnconfiguredMealPhotoAnalyzer().analyze()).rejects.toMatchObject({
      name: 'MealPhotoAnalyzerError',
      code: 'configuration',
    } satisfies Partial<MealPhotoAnalyzerError>);
  });
});

describe('macro estimate validation', () => {
  const valid = {
    calories: 420,
    carbs: 48,
    proteins: 24,
    fats: 14,
    totalGrams: 300,
    confidence: 'medium' as const,
  };

  it('accepts finite non-negative macros, positive weight, and known confidence values', () => {
    expect(isValidMacroEstimateResult(valid)).toBeTrue();
    expect(isValidMacroEstimateResult({ ...valid, confidence: 'high' })).toBeTrue();
    expect(isValidMacroEstimateResult({ ...valid, confidence: 'low' })).toBeTrue();
  });

  it('rejects negative, non-finite, zero-weight, and unknown-confidence estimates', () => {
    const invalid = [
      { ...valid, calories: -1 },
      { ...valid, carbs: Number.NaN },
      { ...valid, proteins: Number.POSITIVE_INFINITY },
      { ...valid, fats: -1 },
      { ...valid, totalGrams: 0 },
      { ...valid, confidence: 'certain' },
    ];

    for (const result of invalid) {
      expect(isValidMacroEstimateResult(result as typeof valid)).toBeFalse();
    }
  });
});
