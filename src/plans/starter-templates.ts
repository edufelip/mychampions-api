import type {
  NutritionMealItemPayload,
  PlanType,
  TrainingSessionItemPayload,
} from './plan-repository';

type StarterNutritionMealTemplate = {
  name: string;
  items: Array<Omit<NutritionMealItemPayload, 'id'>>;
};

type StarterTrainingSessionTemplate = {
  name: string;
  notes: string;
  items: Array<Omit<TrainingSessionItemPayload, 'id'>>;
};

export type StarterTemplate = {
  id: string;
  planType: PlanType;
  name: string;
  description: string;
  nutritionDefaults?: {
    hydrationGoalMl: number | null;
    meals: StarterNutritionMealTemplate[];
  };
  trainingDefaults?: {
    sessions: StarterTrainingSessionTemplate[];
  };
};

const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    id: 'starter_nutrition_default_balance',
    planType: 'nutrition',
    name: 'Balanced Starter',
    description: 'Balanced calories and macros for kickoff.',
    nutritionDefaults: {
      hydrationGoalMl: null,
      meals: [
        {
          name: 'Breakfast',
          items: [
            {
              name: 'Oats + banana breakfast',
              quantity: '1 bowl',
              notes: 'Morning',
              sourceKind: 'manual',
            },
          ],
        },
        {
          name: 'Lunch',
          items: [
            {
              name: 'Chicken + rice lunch',
              quantity: '1 plate',
              notes: 'Post-workout',
              sourceKind: 'manual',
            },
          ],
        },
      ],
    },
  },
  {
    id: 'starter_training_default_fullbody',
    planType: 'training',
    name: 'Full Body Starter',
    description: 'Simple full-body 3-day split.',
    trainingDefaults: {
      sessions: [
        {
          name: 'Day A',
          notes: '',
          items: [{ name: 'Squat 3x8', quantity: '', notes: '' }],
        },
      ],
    },
  },
];

export function listStarterTemplates(planType: PlanType): StarterTemplate[] {
  return STARTER_TEMPLATES.filter((template) => template.planType === planType);
}

export function findStarterTemplate(templateId: string): StarterTemplate | null {
  return STARTER_TEMPLATES.find((template) => template.id === templateId) ?? null;
}
