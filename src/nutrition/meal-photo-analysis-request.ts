import type { MealPhotoAnalysisInput } from './meal-photo-analyzer';
import {
  buildMealPhotoAnalysisSystemPrompt,
  buildMealPhotoAnalysisUserPrompt,
} from './meal-photo-analysis-prompt';

export const MEAL_PHOTO_ANALYSIS_IMAGE_DETAIL = 'high' as const;
export const MEAL_PHOTO_ANALYSIS_MAX_OUTPUT_TOKENS = 500;

export type MealPhotoAnalysisProviderRequest = {
  systemPrompt: string;
  userPrompt: string;
  imageDataUrl: string;
  imageDetail: typeof MEAL_PHOTO_ANALYSIS_IMAGE_DETAIL;
  maxOutputTokens: typeof MEAL_PHOTO_ANALYSIS_MAX_OUTPUT_TOKENS;
};

export function buildMealPhotoAnalysisProviderRequest(
  input: MealPhotoAnalysisInput
): MealPhotoAnalysisProviderRequest {
  return {
    systemPrompt: buildMealPhotoAnalysisSystemPrompt(),
    userPrompt: buildMealPhotoAnalysisUserPrompt(),
    imageDataUrl: `data:${input.mimeType};base64,${input.base64Image}`,
    imageDetail: MEAL_PHOTO_ANALYSIS_IMAGE_DETAIL,
    maxOutputTokens: MEAL_PHOTO_ANALYSIS_MAX_OUTPUT_TOKENS,
  };
}
