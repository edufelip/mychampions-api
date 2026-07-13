import { describe, expect, it } from 'bun:test';

import {
  buildMealPhotoAnalysisSystemPrompt,
  buildMealPhotoAnalysisUserPrompt,
} from '../src/nutrition/meal-photo-analysis-prompt';

describe('meal photo analysis prompt contract', () => {
  it('keeps analyzer prompt instructions server-owned', () => {
    const prompt = buildMealPhotoAnalysisSystemPrompt();

    expect(prompt).toContain('calories');
    expect(prompt).toContain('carbs');
    expect(prompt).toContain('proteins');
    expect(prompt).toContain('fats');
    expect(prompt).toContain('totalGrams');
    expect(prompt).toContain('confidence');
    expect(prompt).toContain('unrecognizable_image');
    expect(prompt.toLowerCase()).toContain('json');
  });

  it('builds the server-side user prompt paired with image input', () => {
    expect(buildMealPhotoAnalysisUserPrompt()).toBe(
      'Analyze this meal photo and estimate its macronutrients.'
    );
  });
});
