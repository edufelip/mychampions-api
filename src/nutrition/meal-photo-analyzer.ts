export type MacroEstimateConfidence = 'high' | 'medium' | 'low';

export type MacroEstimateResult = {
  calories: number;
  carbs: number;
  proteins: number;
  fats: number;
  totalGrams: number;
  confidence: MacroEstimateConfidence;
};

export type MealPhotoAnalyzerErrorCode =
  | 'configuration'
  | 'unrecognizable_image'
  | 'quota_exceeded'
  | 'invalid_response'
  | 'unknown';

export class MealPhotoAnalyzerError extends Error {
  code: MealPhotoAnalyzerErrorCode;

  constructor(code: MealPhotoAnalyzerErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'MealPhotoAnalyzerError';
  }
}

export type MealPhotoAnalysisInput = {
  base64Image: string;
  mimeType: 'image/jpeg';
};

export interface MealPhotoAnalyzer {
  analyze(input: MealPhotoAnalysisInput): Promise<MacroEstimateResult>;
}

export type MealPhotoAnalyzerMode = 'unconfigured' | 'local_mock';

export class UnconfiguredMealPhotoAnalyzer implements MealPhotoAnalyzer {
  async analyze(): Promise<MacroEstimateResult> {
    throw new MealPhotoAnalyzerError(
      'configuration',
      'Meal photo analyzer is not configured for this local server.'
    );
  }
}

export class LocalMockMealPhotoAnalyzer implements MealPhotoAnalyzer {
  async analyze(): Promise<MacroEstimateResult> {
    return {
      calories: 420,
      carbs: 48,
      proteins: 24,
      fats: 14,
      totalGrams: 300,
      confidence: 'low',
    };
  }
}

export function createMealPhotoAnalyzer(mode: MealPhotoAnalyzerMode): MealPhotoAnalyzer {
  if (mode === 'local_mock') {
    return new LocalMockMealPhotoAnalyzer();
  }
  return new UnconfiguredMealPhotoAnalyzer();
}

export function isValidMacroEstimateResult(result: MacroEstimateResult): boolean {
  return (
    Number.isFinite(result.calories) &&
    result.calories >= 0 &&
    Number.isFinite(result.carbs) &&
    result.carbs >= 0 &&
    Number.isFinite(result.proteins) &&
    result.proteins >= 0 &&
    Number.isFinite(result.fats) &&
    result.fats >= 0 &&
    Number.isFinite(result.totalGrams) &&
    result.totalGrams > 0 &&
    (result.confidence === 'high' || result.confidence === 'medium' || result.confidence === 'low')
  );
}
