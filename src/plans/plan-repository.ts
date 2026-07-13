export type PlanType = 'nutrition' | 'training';
export type PlanSourceKind = 'predefined' | 'assigned' | 'self_managed';

export type Plan = {
  id: string;
  planType: PlanType;
  sourceKind: PlanSourceKind;
  ownerProfessionalUid: string | null;
  studentUid: string;
  isArchived: boolean;
  isDraft: boolean;
  name: string | null;
  hydrationGoalMl?: number | null;
  caloriesTarget?: number | null;
  carbsTarget?: number | null;
  proteinsTarget?: number | null;
  fatsTarget?: number | null;
  createdAt: string;
  updatedAt: string;
};

export type NutritionMealItemPayload = {
  id: string;
  name: string;
  quantity: string;
  notes: string;
  calories?: number;
  carbs?: number;
  proteins?: number;
  fats?: number;
  sourceKind?: 'manual' | 'food_search' | 'custom_meal';
  customMealSnapshot?: unknown;
};

export type NutritionMealPayload = {
  id: string;
  name: string;
  items: NutritionMealItemPayload[];
};

export type TrainingSessionItemPayload = {
  id: string;
  name: string;
  quantity: string;
  notes: string;
  exerciseId?: string;
  ymoveId?: string;
};

export type TrainingSessionPayload = {
  id: string;
  name: string;
  notes: string;
  items: TrainingSessionItemPayload[];
};

export type NutritionPlanDetail = Plan & {
  planType: 'nutrition';
  studentAuthUid: string;
  hydrationGoalMl: number | null;
  caloriesTarget: number;
  carbsTarget: number;
  proteinsTarget: number;
  fatsTarget: number;
  meals: NutritionMealPayload[];
};

export type TrainingPlanDetail = Plan & {
  planType: 'training';
  studentAuthUid: string;
  sessions: TrainingSessionPayload[];
};

export type ListPlansForAuthUidInput = {
  authUid: string;
};

export type ListPredefinedPlansForOwnerInput = {
  ownerProfessionalUid: string;
};

export type BulkAssignPredefinedPlanInput = {
  professionalAuthUid: string;
  predefinedPlanId: string;
  studentUids: string[];
};

export type BulkAssignPredefinedPlanResult = {
  assignedCount: number;
};

export type CreateDraftAssignedFromPredefinedInput = {
  professionalAuthUid: string;
  predefinedPlanId: string;
  studentUid: string;
};

export type PlanCreationMode = 'professional_library' | 'self_managed';

export type CreateNutritionPlanDetailInput = {
  authUid: string;
  name: string;
  hydrationGoalMl: number | null;
  mode: PlanCreationMode;
};

export type CreateTrainingPlanDetailInput = {
  authUid: string;
  name: string;
  mode: PlanCreationMode;
};

export type GetPlanDetailInput = {
  authUid: string;
  planId: string;
};

export type UpdateNutritionPlanDetailInput = GetPlanDetailInput & {
  name: string;
  hydrationGoalMl: number | null;
  publish?: boolean;
};

export type AddNutritionMealInput = GetPlanDetailInput & {
  name: string;
};

export type RemoveNutritionMealInput = GetPlanDetailInput & {
  mealId: string;
};

export type ReorderNutritionMealsInput = GetPlanDetailInput & {
  mealIds: string[];
};

export type AddNutritionMealItemInput = GetPlanDetailInput & {
  mealId: string;
  item: Omit<NutritionMealItemPayload, 'id'>;
};

export type RemoveNutritionMealItemInput = GetPlanDetailInput & {
  mealId: string;
  itemId: string;
};

export type ReorderNutritionMealItemsInput = GetPlanDetailInput & {
  mealId: string;
  itemIds: string[];
};

export type UpdateTrainingPlanDetailInput = GetPlanDetailInput & {
  name: string;
  sessions?: TrainingSessionPayload[];
  publish?: boolean;
};

export type AddTrainingSessionInput = GetPlanDetailInput & {
  name: string;
  notes: string;
};

export type RemoveTrainingSessionInput = GetPlanDetailInput & {
  sessionId: string;
};

export type ReorderTrainingSessionsInput = GetPlanDetailInput & {
  sessionIds: string[];
};

export type AddTrainingSessionItemInput = GetPlanDetailInput & {
  sessionId: string;
  item: Omit<TrainingSessionItemPayload, 'id'>;
};

export type RemoveTrainingSessionItemInput = GetPlanDetailInput & {
  sessionId: string;
  itemId: string;
};

export type ReorderTrainingSessionItemsInput = GetPlanDetailInput & {
  sessionId: string;
  itemIds: string[];
};

export type PlanRepositoryErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'invalid_operation'
  | 'invalid_assignment_targets';

export class PlanRepositoryError extends Error {
  constructor(
    readonly code: PlanRepositoryErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'PlanRepositoryError';
  }
}

export class PlanNotFoundError extends PlanRepositoryError {
  constructor(message = 'Predefined plan not found.') {
    super('not_found', message);
    this.name = 'PlanNotFoundError';
  }
}

export class PlanForbiddenError extends PlanRepositoryError {
  constructor(message = 'Plan is not owned by the authenticated professional.') {
    super('forbidden', message);
    this.name = 'PlanForbiddenError';
  }
}

export class InvalidPlanOperationError extends PlanRepositoryError {
  constructor(message: string) {
    super('invalid_operation', message);
    this.name = 'InvalidPlanOperationError';
  }
}

export class PlanAssignmentTargetError extends PlanRepositoryError {
  constructor(
    readonly requiredSpecialty: 'nutritionist' | 'fitness_coach',
    readonly invalidStudentUids: string[]
  ) {
    super(
      'invalid_assignment_targets',
      `No active assignment for ${requiredSpecialty}: ${invalidStudentUids.join(', ')}`
    );
    this.name = 'PlanAssignmentTargetError';
  }
}

export type PlanRepository = {
  listForAuthUid(input: ListPlansForAuthUidInput): Promise<Plan[]>;
  listPredefinedForOwner(input: ListPredefinedPlansForOwnerInput): Promise<Plan[]>;
  bulkAssignPredefined(input: BulkAssignPredefinedPlanInput): Promise<BulkAssignPredefinedPlanResult>;
  createDraftAssignedFromPredefined(input: CreateDraftAssignedFromPredefinedInput): Promise<Plan>;
  createNutritionPlanDetail(input: CreateNutritionPlanDetailInput): Promise<NutritionPlanDetail>;
  createTrainingPlanDetail(input: CreateTrainingPlanDetailInput): Promise<TrainingPlanDetail>;
  getNutritionPlanDetail(input: GetPlanDetailInput): Promise<NutritionPlanDetail>;
  updateNutritionPlanDetail(input: UpdateNutritionPlanDetailInput): Promise<NutritionPlanDetail>;
  addNutritionMeal(input: AddNutritionMealInput): Promise<NutritionMealPayload>;
  removeNutritionMeal(input: RemoveNutritionMealInput): Promise<NutritionPlanDetail>;
  reorderNutritionMeals(input: ReorderNutritionMealsInput): Promise<NutritionPlanDetail>;
  addNutritionMealItem(input: AddNutritionMealItemInput): Promise<NutritionMealItemPayload>;
  removeNutritionMealItem(input: RemoveNutritionMealItemInput): Promise<NutritionPlanDetail>;
  reorderNutritionMealItems(input: ReorderNutritionMealItemsInput): Promise<NutritionPlanDetail>;
  getTrainingPlanDetail(input: GetPlanDetailInput): Promise<TrainingPlanDetail>;
  updateTrainingPlanDetail(input: UpdateTrainingPlanDetailInput): Promise<TrainingPlanDetail>;
  addTrainingSession(input: AddTrainingSessionInput): Promise<TrainingSessionPayload>;
  removeTrainingSession(input: RemoveTrainingSessionInput): Promise<TrainingPlanDetail>;
  reorderTrainingSessions(input: ReorderTrainingSessionsInput): Promise<TrainingPlanDetail>;
  addTrainingSessionItem(input: AddTrainingSessionItemInput): Promise<TrainingSessionItemPayload>;
  removeTrainingSessionItem(input: RemoveTrainingSessionItemInput): Promise<TrainingPlanDetail>;
  reorderTrainingSessionItems(input: ReorderTrainingSessionItemsInput): Promise<TrainingPlanDetail>;
  deleteNutritionPlan(input: GetPlanDetailInput): Promise<void>;
  deleteTrainingPlan(input: GetPlanDetailInput): Promise<void>;
};
