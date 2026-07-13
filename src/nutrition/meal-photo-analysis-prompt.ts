export function buildMealPhotoAnalysisSystemPrompt(): string {
  return (
    'You are a professional nutritionist. ' +
    'Given a photo of a meal, estimate the macronutrients with high accuracy. ' +
    'Respond ONLY with valid JSON matching this exact shape: ' +
    '{ "calories": number, "carbs": number, "proteins": number, "fats": number, ' +
    '"totalGrams": number, "confidence": "high" | "medium" | "low" }. ' +
    'All values must be non-negative numbers. totalGrams must be positive. ' +
    'If the image does not contain a recognizable meal, respond: { "error": "unrecognizable_image" }.'
  );
}

export function buildMealPhotoAnalysisUserPrompt(): string {
  return 'Analyze this meal photo and estimate its macronutrients.';
}
