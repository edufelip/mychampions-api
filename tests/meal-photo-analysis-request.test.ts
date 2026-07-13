import { describe, expect, it } from 'bun:test';

import {
  MEAL_PHOTO_ANALYSIS_IMAGE_DETAIL,
  MEAL_PHOTO_ANALYSIS_MAX_OUTPUT_TOKENS,
  buildMealPhotoAnalysisProviderRequest,
} from '../src/nutrition/meal-photo-analysis-request';

describe('meal photo analysis provider request contract', () => {
  it('pins image detail and output-token limits server-side', () => {
    const request = buildMealPhotoAnalysisProviderRequest({
      base64Image: 'base64-jpeg==',
      mimeType: 'image/jpeg',
    });

    expect(MEAL_PHOTO_ANALYSIS_IMAGE_DETAIL).toBe('high');
    expect(MEAL_PHOTO_ANALYSIS_MAX_OUTPUT_TOKENS).toBe(500);
    expect(request.imageDetail).toBe('high');
    expect(request.maxOutputTokens).toBe(500);
    expect(request.imageDataUrl).toBe('data:image/jpeg;base64,base64-jpeg==');
    expect(request.systemPrompt).toContain('valid JSON');
    expect(request.userPrompt).toBe('Analyze this meal photo and estimate its macronutrients.');
  });
});
