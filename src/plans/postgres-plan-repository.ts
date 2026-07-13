import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, or } from 'drizzle-orm';

import {
  connections,
  nutritionPlans,
  subscriptionEntitlementSnapshots,
  trainingPlans,
  type NutritionPlanRow,
  type TrainingPlanRow,
} from '../db/schema';
import { ProfessionalSubscriptionRequiredError } from '../connections/repository';
import type {
  AddTrainingSessionInput,
  AddTrainingSessionItemInput,
  BulkAssignPredefinedPlanInput,
  BulkAssignPredefinedPlanResult,
  AddNutritionMealInput,
  AddNutritionMealItemInput,
  CreateDraftAssignedFromPredefinedInput,
  CreateNutritionPlanDetailInput,
  CreateTrainingPlanDetailInput,
  GetPlanDetailInput,
  NutritionMealItemPayload,
  NutritionMealPayload,
  NutritionPlanDetail,
  Plan,
  PlanRepository,
  PlanType,
  RemoveNutritionMealInput,
  RemoveNutritionMealItemInput,
  RemoveTrainingSessionInput,
  RemoveTrainingSessionItemInput,
  ReorderNutritionMealItemsInput,
  ReorderNutritionMealsInput,
  ReorderTrainingSessionItemsInput,
  ReorderTrainingSessionsInput,
  TrainingPlanDetail,
  TrainingSessionItemPayload,
  TrainingSessionPayload,
  UpdateNutritionPlanDetailInput,
  UpdateTrainingPlanDetailInput,
} from './plan-repository';
import {
  InvalidPlanOperationError,
  PlanAssignmentTargetError,
  PlanForbiddenError,
  PlanNotFoundError,
} from './plan-repository';

type Db = {
  insert: Function;
  select: Function;
  update: Function;
};

const MAX_ACTIVE_STUDENTS_WITHOUT_ENTITLEMENT = 10;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapNutritionPlan(row: NutritionPlanRow): Plan {
  return {
    id: row.id,
    planType: 'nutrition',
    sourceKind: row.sourceKind,
    ownerProfessionalUid: row.ownerProfessionalUid,
    studentUid: row.studentAuthUid,
    isArchived: row.isArchived,
    isDraft: row.isDraft,
    name: row.name,
    hydrationGoalMl: row.hydrationGoalMl,
    caloriesTarget: row.caloriesTarget,
    carbsTarget: row.carbsTarget,
    proteinsTarget: row.proteinsTarget,
    fatsTarget: row.fatsTarget,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function normalizeNutritionMeals(value: unknown): NutritionMealPayload[] {
  return Array.isArray(value) ? (value as NutritionMealPayload[]) : [];
}

function normalizeTrainingSessions(value: unknown): TrainingSessionPayload[] {
  return Array.isArray(value) ? (value as TrainingSessionPayload[]) : [];
}

function mapNutritionPlanDetail(row: NutritionPlanRow): NutritionPlanDetail {
  return {
    ...mapNutritionPlan(row),
    planType: 'nutrition',
    studentAuthUid: row.studentAuthUid,
    hydrationGoalMl: row.hydrationGoalMl,
    caloriesTarget: row.caloriesTarget ?? 0,
    carbsTarget: row.carbsTarget ?? 0,
    proteinsTarget: row.proteinsTarget ?? 0,
    fatsTarget: row.fatsTarget ?? 0,
    meals: normalizeNutritionMeals(row.meals),
  };
}

function mapTrainingPlan(row: TrainingPlanRow): Plan {
  return {
    id: row.id,
    planType: 'training',
    sourceKind: row.sourceKind,
    ownerProfessionalUid: row.ownerProfessionalUid,
    studentUid: row.studentAuthUid,
    isArchived: row.isArchived,
    isDraft: row.isDraft,
    name: row.name,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function mapTrainingPlanDetail(row: TrainingPlanRow): TrainingPlanDetail {
  return {
    ...mapTrainingPlan(row),
    planType: 'training',
    studentAuthUid: row.studentAuthUid,
    sessions: normalizeTrainingSessions(row.sessions),
  };
}

function byUpdatedAtDesc(left: Plan, right: Plan): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

function requiredSpecialtyForPlanType(planType: PlanType): 'nutritionist' | 'fitness_coach' {
  return planType === 'nutrition' ? 'nutritionist' : 'fitness_coach';
}

function assignedPlanId(planType: PlanType): string {
  return `${planType}_plan_${randomUUID()}`;
}

function newPlanId(planType: PlanType): string {
  return `${planType}_plan_${randomUUID()}`;
}

function nutritionMealId(): string {
  return `nutrition_meal_${randomUUID()}`;
}

function nutritionItemId(): string {
  return `nutrition_item_${randomUUID()}`;
}

function trainingSessionId(): string {
  return `training_session_${randomUUID()}`;
}

function trainingItemId(): string {
  return `training_item_${randomUUID()}`;
}

function calculateMealTotals(meals: NutritionMealPayload[]): {
  caloriesTarget: number;
  carbsTarget: number;
  proteinsTarget: number;
  fatsTarget: number;
} {
  return meals.reduce(
    (totals, meal) => {
      for (const item of meal.items ?? []) {
        totals.caloriesTarget += typeof item.calories === 'number' ? item.calories : 0;
        totals.carbsTarget += typeof item.carbs === 'number' ? item.carbs : 0;
        totals.proteinsTarget += typeof item.proteins === 'number' ? item.proteins : 0;
        totals.fatsTarget += typeof item.fats === 'number' ? item.fats : 0;
      }
      return totals;
    },
    { caloriesTarget: 0, carbsTarget: 0, proteinsTarget: 0, fatsTarget: 0 }
  );
}

function canReadPlan(
  row: Pick<NutritionPlanRow | TrainingPlanRow, 'studentAuthUid' | 'ownerProfessionalUid' | 'sourceKind' | 'isDraft' | 'isArchived'>,
  authUid: string
): boolean {
  if (row.isArchived) return false;
  if (row.ownerProfessionalUid === authUid) return true;
  if (row.studentAuthUid !== authUid) return false;
  return !(row.sourceKind === 'assigned' && row.isDraft && row.ownerProfessionalUid !== authUid);
}

function canMutatePlan(
  row: Pick<NutritionPlanRow | TrainingPlanRow, 'studentAuthUid' | 'ownerProfessionalUid' | 'isArchived'>,
  authUid: string
): boolean {
  if (row.isArchived) return false;
  if (row.ownerProfessionalUid === authUid) return true;
  return row.ownerProfessionalUid === null && row.studentAuthUid === authUid;
}

export class PostgresPlanRepository implements PlanRepository {
  constructor(private readonly db: Db) {}

  async listForAuthUid(input: { authUid: string }): Promise<Plan[]> {
    const [nutritionRows, trainingRows] = await Promise.all([
      this.db
        .select()
        .from(nutritionPlans)
        .where(
          and(
            eq(nutritionPlans.isArchived, false),
            or(
              eq(nutritionPlans.studentAuthUid, input.authUid),
              eq(nutritionPlans.ownerProfessionalUid, input.authUid)
            )
          )
        )
        .orderBy(desc(nutritionPlans.updatedAt)),
      this.db
        .select()
        .from(trainingPlans)
        .where(
          and(
            eq(trainingPlans.isArchived, false),
            or(
              eq(trainingPlans.studentAuthUid, input.authUid),
              eq(trainingPlans.ownerProfessionalUid, input.authUid)
            )
          )
        )
        .orderBy(desc(trainingPlans.updatedAt)),
    ]);

    return [
      ...nutritionRows
        .map(mapNutritionPlan)
        .filter(
          (plan: Plan) =>
            !(
              plan.studentUid === input.authUid &&
              plan.ownerProfessionalUid !== input.authUid &&
              plan.sourceKind === 'assigned' &&
              plan.isDraft
            )
        ),
      ...trainingRows.map(mapTrainingPlan),
    ].sort(byUpdatedAtDesc);
  }

  async listPredefinedForOwner(input: { ownerProfessionalUid: string }): Promise<Plan[]> {
    const [nutritionRows, trainingRows] = await Promise.all([
      this.db
        .select()
        .from(nutritionPlans)
        .where(
          and(
            eq(nutritionPlans.ownerProfessionalUid, input.ownerProfessionalUid),
            eq(nutritionPlans.sourceKind, 'predefined'),
            eq(nutritionPlans.isArchived, false)
          )
        )
        .orderBy(desc(nutritionPlans.updatedAt)),
      this.db
        .select()
        .from(trainingPlans)
        .where(
          and(
            eq(trainingPlans.ownerProfessionalUid, input.ownerProfessionalUid),
            eq(trainingPlans.sourceKind, 'predefined'),
            eq(trainingPlans.isArchived, false)
          )
        )
        .orderBy(desc(trainingPlans.updatedAt)),
    ]);

    return [...nutritionRows.map(mapNutritionPlan), ...trainingRows.map(mapTrainingPlan)].sort(byUpdatedAtDesc);
  }

  async bulkAssignPredefined(input: BulkAssignPredefinedPlanInput): Promise<BulkAssignPredefinedPlanResult> {
    const uniqueStudentUids = [...new Set(input.studentUids.map((uid) => uid.trim()).filter(Boolean))];

    const [nutritionSource] = await this.db
      .select()
      .from(nutritionPlans)
      .where(eq(nutritionPlans.id, input.predefinedPlanId))
      .limit(1);
    const [trainingSource] = nutritionSource
      ? [null]
      : await this.db
          .select()
          .from(trainingPlans)
          .where(eq(trainingPlans.id, input.predefinedPlanId))
          .limit(1);

    const source = nutritionSource ?? trainingSource;
    if (!source) {
      throw new PlanNotFoundError();
    }
    if (source.ownerProfessionalUid !== input.professionalAuthUid) {
      throw new PlanForbiddenError();
    }
    if (source.sourceKind !== 'predefined') {
      throw new InvalidPlanOperationError('Only predefined plans can be bulk-assigned.');
    }
    if (source.isArchived) {
      throw new InvalidPlanOperationError('Archived predefined plans cannot be bulk-assigned.');
    }
    if (uniqueStudentUids.length === 0) {
      return { assignedCount: 0 };
    }

    const planType: PlanType = nutritionSource ? 'nutrition' : 'training';
    const requiredSpecialty = requiredSpecialtyForPlanType(planType);
    const activeRows = await this.db
      .select({ studentAuthUid: connections.studentAuthUid })
      .from(connections)
      .where(
        and(
          eq(connections.professionalAuthUid, input.professionalAuthUid),
          eq(connections.specialty, requiredSpecialty),
          eq(connections.status, 'active'),
          inArray(connections.studentAuthUid, uniqueStudentUids)
        )
      );
    const activeStudentUids = new Set(activeRows.map((row: { studentAuthUid: string }) => row.studentAuthUid));
    const invalidStudentUids = uniqueStudentUids.filter((studentUid) => !activeStudentUids.has(studentUid));
    if (invalidStudentUids.length > 0) {
      throw new PlanAssignmentTargetError(requiredSpecialty, invalidStudentUids);
    }
    await this.assertProfessionalEntitlementAllowsStudentPlanWrite(input.professionalAuthUid);

    const now = new Date();
    if (planType === 'nutrition') {
      const sourcePlan = nutritionSource as NutritionPlanRow;
      await this.db.insert(nutritionPlans).values(
        uniqueStudentUids.map((studentUid) => ({
          id: assignedPlanId('nutrition'),
          studentAuthUid: studentUid,
          ownerProfessionalUid: input.professionalAuthUid,
          sourceKind: 'assigned' as const,
          isArchived: false,
          isDraft: false,
          name: sourcePlan.name,
          hydrationGoalMl: sourcePlan.hydrationGoalMl,
          caloriesTarget: sourcePlan.caloriesTarget,
          carbsTarget: sourcePlan.carbsTarget,
          proteinsTarget: sourcePlan.proteinsTarget,
          fatsTarget: sourcePlan.fatsTarget,
          meals: normalizeNutritionMeals(sourcePlan.meals),
          createdAt: now,
          updatedAt: now,
        }))
      );
    } else {
      const sourcePlan = trainingSource as TrainingPlanRow;
      await this.db.insert(trainingPlans).values(
        uniqueStudentUids.map((studentUid) => ({
          id: assignedPlanId('training'),
          studentAuthUid: studentUid,
          ownerProfessionalUid: input.professionalAuthUid,
          sourceKind: 'assigned' as const,
          isArchived: false,
          isDraft: false,
          name: sourcePlan.name,
          sessions: normalizeTrainingSessions(sourcePlan.sessions),
          createdAt: now,
          updatedAt: now,
        }))
      );
    }

    return { assignedCount: uniqueStudentUids.length };
  }

  async createDraftAssignedFromPredefined(input: CreateDraftAssignedFromPredefinedInput): Promise<Plan> {
    const studentUid = input.studentUid.trim();
    if (!studentUid) {
      throw new PlanAssignmentTargetError('nutritionist', [input.studentUid]);
    }

    const [nutritionSource] = await this.db
      .select()
      .from(nutritionPlans)
      .where(eq(nutritionPlans.id, input.predefinedPlanId))
      .limit(1);
    const [trainingSource] = nutritionSource
      ? [null]
      : await this.db
          .select()
          .from(trainingPlans)
          .where(eq(trainingPlans.id, input.predefinedPlanId))
          .limit(1);

    const source = nutritionSource ?? trainingSource;
    if (!source) {
      throw new PlanNotFoundError();
    }
    if (source.ownerProfessionalUid !== input.professionalAuthUid) {
      throw new PlanForbiddenError();
    }
    if (source.sourceKind !== 'predefined') {
      throw new InvalidPlanOperationError('Only predefined plans can be assigned.');
    }
    if (source.isArchived) {
      throw new InvalidPlanOperationError('Archived predefined plans cannot be assigned.');
    }

    const planType: PlanType = nutritionSource ? 'nutrition' : 'training';
    const requiredSpecialty = requiredSpecialtyForPlanType(planType);
    const activeRows = await this.db
      .select({ studentAuthUid: connections.studentAuthUid })
      .from(connections)
      .where(
        and(
          eq(connections.professionalAuthUid, input.professionalAuthUid),
          eq(connections.specialty, requiredSpecialty),
          eq(connections.status, 'active'),
          eq(connections.studentAuthUid, studentUid)
        )
      );
    if (activeRows.length === 0) {
      throw new PlanAssignmentTargetError(requiredSpecialty, [studentUid]);
    }
    await this.assertProfessionalEntitlementAllowsStudentPlanWrite(input.professionalAuthUid);

    const now = new Date();
    if (planType === 'nutrition') {
      const sourcePlan = nutritionSource as NutritionPlanRow;
      const newPlan: NutritionPlanRow = {
        id: assignedPlanId('nutrition'),
        studentAuthUid: studentUid,
        ownerProfessionalUid: input.professionalAuthUid,
        sourceKind: 'assigned',
        isArchived: false,
        isDraft: true,
        lifecycleConnectionId: null,
        name: sourcePlan.name,
        hydrationGoalMl: sourcePlan.hydrationGoalMl,
        caloriesTarget: sourcePlan.caloriesTarget,
        carbsTarget: sourcePlan.carbsTarget,
        proteinsTarget: sourcePlan.proteinsTarget,
        fatsTarget: sourcePlan.fatsTarget,
        meals: normalizeNutritionMeals(sourcePlan.meals),
        createdAt: now,
        updatedAt: now,
      };
      await this.db.insert(nutritionPlans).values(newPlan);
      return mapNutritionPlan(newPlan);
    }

    const sourcePlan = trainingSource as TrainingPlanRow;
    const newPlan: TrainingPlanRow = {
      id: assignedPlanId('training'),
      studentAuthUid: studentUid,
      ownerProfessionalUid: input.professionalAuthUid,
      sourceKind: 'assigned',
      isArchived: false,
      isDraft: true,
      lifecycleConnectionId: null,
      name: sourcePlan.name,
      sessions: normalizeTrainingSessions(sourcePlan.sessions),
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(trainingPlans).values(newPlan);
    return mapTrainingPlan(newPlan);
  }

  async createNutritionPlanDetail(input: CreateNutritionPlanDetailInput): Promise<NutritionPlanDetail> {
    const now = new Date();
    const sourceKind = input.mode === 'self_managed' ? 'self_managed' : 'predefined';
    const ownerProfessionalUid = input.mode === 'self_managed' ? null : input.authUid;
    const newPlan: NutritionPlanRow = {
      id: newPlanId('nutrition'),
      studentAuthUid: input.authUid,
      ownerProfessionalUid,
      sourceKind,
      isArchived: false,
      isDraft: false,
      lifecycleConnectionId: null,
      name: input.name.trim(),
      hydrationGoalMl: input.hydrationGoalMl,
      caloriesTarget: 0,
      carbsTarget: 0,
      proteinsTarget: 0,
      fatsTarget: 0,
      meals: [],
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(nutritionPlans).values(newPlan);
    return mapNutritionPlanDetail(newPlan);
  }

  async createTrainingPlanDetail(input: CreateTrainingPlanDetailInput): Promise<TrainingPlanDetail> {
    const now = new Date();
    const sourceKind = input.mode === 'self_managed' ? 'self_managed' : 'predefined';
    const ownerProfessionalUid = input.mode === 'self_managed' ? null : input.authUid;
    const newPlan: TrainingPlanRow = {
      id: newPlanId('training'),
      studentAuthUid: input.authUid,
      ownerProfessionalUid,
      sourceKind,
      isArchived: false,
      isDraft: false,
      lifecycleConnectionId: null,
      name: input.name.trim(),
      sessions: [],
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(trainingPlans).values(newPlan);
    return mapTrainingPlanDetail(newPlan);
  }

  async getNutritionPlanDetail(input: GetPlanDetailInput): Promise<NutritionPlanDetail> {
    const row = await this.findNutritionPlanForRead(input);
    return mapNutritionPlanDetail(row);
  }

  async updateNutritionPlanDetail(input: UpdateNutritionPlanDetailInput): Promise<NutritionPlanDetail> {
    const row = await this.findNutritionPlanForRead(input);
    if (!canMutatePlan(row, input.authUid)) {
      throw new PlanForbiddenError('Plan cannot be edited by the authenticated user.');
    }
    await this.assertAssignedStudentPlanWriteAllowed(row, input.authUid);

    const now = new Date();
    await this.db
      .update(nutritionPlans)
      .set({
        name: input.name.trim(),
        hydrationGoalMl: input.hydrationGoalMl,
        isDraft: input.publish ? false : row.isDraft,
        updatedAt: now,
      })
      .where(eq(nutritionPlans.id, input.planId));

    return this.getNutritionPlanDetail(input);
  }

  async addNutritionMeal(input: AddNutritionMealInput): Promise<NutritionMealPayload> {
    const row = await this.findNutritionPlanForMutation(input);
    const meal: NutritionMealPayload = {
      id: nutritionMealId(),
      name: input.name.trim(),
      items: [],
    };
    const meals = [...normalizeNutritionMeals(row.meals), meal];
    await this.updateNutritionMeals(input.planId, meals);
    return meal;
  }

  async removeNutritionMeal(input: RemoveNutritionMealInput): Promise<NutritionPlanDetail> {
    const row = await this.findNutritionPlanForMutation(input);
    const meals = normalizeNutritionMeals(row.meals).filter((meal) => meal.id !== input.mealId);
    await this.updateNutritionMeals(input.planId, meals);
    return this.getNutritionPlanDetail(input);
  }

  async reorderNutritionMeals(input: ReorderNutritionMealsInput): Promise<NutritionPlanDetail> {
    const row = await this.findNutritionPlanForMutation(input);
    const currentMeals = normalizeNutritionMeals(row.meals);
    const meals = input.mealIds
      .map((mealId) => currentMeals.find((meal) => meal.id === mealId))
      .filter((meal): meal is NutritionMealPayload => Boolean(meal));
    await this.updateNutritionMeals(input.planId, meals);
    return this.getNutritionPlanDetail(input);
  }

  async addNutritionMealItem(input: AddNutritionMealItemInput): Promise<NutritionMealItemPayload> {
    const row = await this.findNutritionPlanForMutation(input);
    const item: NutritionMealItemPayload = {
      id: nutritionItemId(),
      name: input.item.name.trim(),
      quantity: input.item.quantity,
      notes: input.item.notes,
      ...(typeof input.item.calories === 'number' ? { calories: input.item.calories } : {}),
      ...(typeof input.item.carbs === 'number' ? { carbs: input.item.carbs } : {}),
      ...(typeof input.item.proteins === 'number' ? { proteins: input.item.proteins } : {}),
      ...(typeof input.item.fats === 'number' ? { fats: input.item.fats } : {}),
      ...(input.item.sourceKind ? { sourceKind: input.item.sourceKind } : {}),
      ...(input.item.customMealSnapshot !== undefined ? { customMealSnapshot: input.item.customMealSnapshot } : {}),
    };
    let foundMeal = false;
    const meals = normalizeNutritionMeals(row.meals).map((meal) => {
      if (meal.id !== input.mealId) return meal;
      foundMeal = true;
      return {
        ...meal,
        items: [...(meal.items ?? []), item],
      };
    });
    if (!foundMeal) {
      throw new PlanNotFoundError('Nutrition meal not found.');
    }
    await this.updateNutritionMeals(input.planId, meals);
    return item;
  }

  async removeNutritionMealItem(input: RemoveNutritionMealItemInput): Promise<NutritionPlanDetail> {
    const row = await this.findNutritionPlanForMutation(input);
    const meals = normalizeNutritionMeals(row.meals).map((meal) =>
      meal.id === input.mealId
        ? { ...meal, items: (meal.items ?? []).filter((item) => item.id !== input.itemId) }
        : meal
    );
    await this.updateNutritionMeals(input.planId, meals);
    return this.getNutritionPlanDetail(input);
  }

  async reorderNutritionMealItems(input: ReorderNutritionMealItemsInput): Promise<NutritionPlanDetail> {
    const row = await this.findNutritionPlanForMutation(input);
    const meals = normalizeNutritionMeals(row.meals).map((meal) => {
      if (meal.id !== input.mealId) return meal;
      return {
        ...meal,
        items: input.itemIds
          .map((itemId) => (meal.items ?? []).find((item) => item.id === itemId))
          .filter((item): item is NutritionMealItemPayload => Boolean(item)),
      };
    });
    await this.updateNutritionMeals(input.planId, meals);
    return this.getNutritionPlanDetail(input);
  }

  async getTrainingPlanDetail(input: GetPlanDetailInput): Promise<TrainingPlanDetail> {
    const row = await this.findTrainingPlanForRead(input);
    return mapTrainingPlanDetail(row);
  }

  async updateTrainingPlanDetail(input: UpdateTrainingPlanDetailInput): Promise<TrainingPlanDetail> {
    const row = await this.findTrainingPlanForRead(input);
    if (!canMutatePlan(row, input.authUid)) {
      throw new PlanForbiddenError('Plan cannot be edited by the authenticated user.');
    }
    await this.assertAssignedStudentPlanWriteAllowed(row, input.authUid);

    const now = new Date();
    const updates: Record<string, unknown> = {
      name: input.name.trim(),
      isDraft: input.publish ? false : row.isDraft,
      updatedAt: now,
    };
    if (input.sessions) {
      updates.sessions = input.sessions;
    }

    await this.db
      .update(trainingPlans)
      .set(updates)
      .where(eq(trainingPlans.id, input.planId));

    return this.getTrainingPlanDetail(input);
  }

  async addTrainingSession(input: AddTrainingSessionInput): Promise<TrainingSessionPayload> {
    const row = await this.findTrainingPlanForMutation(input);
    const session: TrainingSessionPayload = {
      id: trainingSessionId(),
      name: input.name.trim(),
      notes: input.notes.trim(),
      items: [],
    };
    const sessions = [...normalizeTrainingSessions(row.sessions), session];
    await this.updateTrainingSessions(input.planId, sessions);
    return session;
  }

  async removeTrainingSession(input: RemoveTrainingSessionInput): Promise<TrainingPlanDetail> {
    const row = await this.findTrainingPlanForMutation(input);
    const sessions = normalizeTrainingSessions(row.sessions).filter((session) => session.id !== input.sessionId);
    await this.updateTrainingSessions(input.planId, sessions);
    return this.getTrainingPlanDetail(input);
  }

  async reorderTrainingSessions(input: ReorderTrainingSessionsInput): Promise<TrainingPlanDetail> {
    const row = await this.findTrainingPlanForMutation(input);
    const currentSessions = normalizeTrainingSessions(row.sessions);
    const sessions = input.sessionIds
      .map((sessionId) => currentSessions.find((session) => session.id === sessionId))
      .filter((session): session is TrainingSessionPayload => Boolean(session));
    await this.updateTrainingSessions(input.planId, sessions);
    return this.getTrainingPlanDetail(input);
  }

  async addTrainingSessionItem(input: AddTrainingSessionItemInput): Promise<TrainingSessionItemPayload> {
    const row = await this.findTrainingPlanForMutation(input);
    const item: TrainingSessionItemPayload = {
      id: trainingItemId(),
      name: input.item.name.trim(),
      quantity: input.item.quantity,
      notes: input.item.notes,
      ...(input.item.exerciseId ? { exerciseId: input.item.exerciseId } : {}),
      ...(input.item.ymoveId ? { ymoveId: input.item.ymoveId } : {}),
    };
    let foundSession = false;
    const sessions = normalizeTrainingSessions(row.sessions).map((session) => {
      if (session.id !== input.sessionId) return session;
      foundSession = true;
      return {
        ...session,
        items: [...(session.items ?? []), item],
      };
    });
    if (!foundSession) {
      throw new PlanNotFoundError('Training session not found.');
    }
    await this.updateTrainingSessions(input.planId, sessions);
    return item;
  }

  async removeTrainingSessionItem(input: RemoveTrainingSessionItemInput): Promise<TrainingPlanDetail> {
    const row = await this.findTrainingPlanForMutation(input);
    const sessions = normalizeTrainingSessions(row.sessions).map((session) =>
      session.id === input.sessionId
        ? { ...session, items: (session.items ?? []).filter((item) => item.id !== input.itemId) }
        : session
    );
    await this.updateTrainingSessions(input.planId, sessions);
    return this.getTrainingPlanDetail(input);
  }

  async reorderTrainingSessionItems(input: ReorderTrainingSessionItemsInput): Promise<TrainingPlanDetail> {
    const row = await this.findTrainingPlanForMutation(input);
    const sessions = normalizeTrainingSessions(row.sessions).map((session) => {
      if (session.id !== input.sessionId) return session;
      return {
        ...session,
        items: input.itemIds
          .map((itemId) => (session.items ?? []).find((item) => item.id === itemId))
          .filter((item): item is TrainingSessionItemPayload => Boolean(item)),
      };
    });
    await this.updateTrainingSessions(input.planId, sessions);
    return this.getTrainingPlanDetail(input);
  }

  async deleteNutritionPlan(input: GetPlanDetailInput): Promise<void> {
    const row = await this.findNutritionPlanForRead(input);
    if (!canMutatePlan(row, input.authUid)) {
      throw new PlanForbiddenError('Plan cannot be deleted by the authenticated user.');
    }
    await this.assertAssignedStudentPlanWriteAllowed(row, input.authUid);

    await this.db
      .update(nutritionPlans)
      .set({
        isArchived: true,
        updatedAt: new Date(),
      })
      .where(eq(nutritionPlans.id, input.planId));
  }

  async deleteTrainingPlan(input: GetPlanDetailInput): Promise<void> {
    const row = await this.findTrainingPlanForRead(input);
    if (!canMutatePlan(row, input.authUid)) {
      throw new PlanForbiddenError('Plan cannot be deleted by the authenticated user.');
    }
    await this.assertAssignedStudentPlanWriteAllowed(row, input.authUid);

    await this.db
      .update(trainingPlans)
      .set({
        isArchived: true,
        updatedAt: new Date(),
      })
      .where(eq(trainingPlans.id, input.planId));
  }

  private async findNutritionPlanForMutation(input: GetPlanDetailInput): Promise<NutritionPlanRow> {
    const row = await this.findNutritionPlanForRead(input);
    if (!canMutatePlan(row, input.authUid)) {
      throw new PlanForbiddenError('Plan cannot be edited by the authenticated user.');
    }
    await this.assertAssignedStudentPlanWriteAllowed(row, input.authUid);
    return row;
  }

  private async updateNutritionMeals(planId: string, meals: NutritionMealPayload[]): Promise<void> {
    await this.db
      .update(nutritionPlans)
      .set({
        meals,
        ...calculateMealTotals(meals),
        updatedAt: new Date(),
      })
      .where(eq(nutritionPlans.id, planId));
  }

  private async findTrainingPlanForMutation(input: GetPlanDetailInput): Promise<TrainingPlanRow> {
    const row = await this.findTrainingPlanForRead(input);
    if (!canMutatePlan(row, input.authUid)) {
      throw new PlanForbiddenError('Plan cannot be edited by the authenticated user.');
    }
    await this.assertAssignedStudentPlanWriteAllowed(row, input.authUid);
    return row;
  }

  private async updateTrainingSessions(planId: string, sessions: TrainingSessionPayload[]): Promise<void> {
    await this.db
      .update(trainingPlans)
      .set({
        sessions,
        updatedAt: new Date(),
      })
      .where(eq(trainingPlans.id, planId));
  }

  private async assertAssignedStudentPlanWriteAllowed(
    row: Pick<NutritionPlanRow | TrainingPlanRow, 'sourceKind' | 'ownerProfessionalUid'>,
    authUid: string
  ): Promise<void> {
    if (row.sourceKind !== 'assigned' || row.ownerProfessionalUid !== authUid) {
      return;
    }
    await this.assertProfessionalEntitlementAllowsStudentPlanWrite(authUid);
  }

  private async assertProfessionalEntitlementAllowsStudentPlanWrite(professionalAuthUid: string): Promise<void> {
    const activeRows = await this.db
      .select({ studentAuthUid: connections.studentAuthUid })
      .from(connections)
      .where(
        and(
          eq(connections.professionalAuthUid, professionalAuthUid),
          eq(connections.status, 'active')
        )
      );
    const activeStudentUids = new Set(
      activeRows
        .map((row: { studentAuthUid?: string | null }) => row.studentAuthUid)
        .filter((studentAuthUid: string | null | undefined): studentAuthUid is string =>
          typeof studentAuthUid === 'string' && studentAuthUid.length > 0
        )
    );

    if (activeStudentUids.size <= MAX_ACTIVE_STUDENTS_WITHOUT_ENTITLEMENT) {
      return;
    }

    const [snapshot] = await this.db
      .select({ status: subscriptionEntitlementSnapshots.professionalEntitlementStatus })
      .from(subscriptionEntitlementSnapshots)
      .where(eq(subscriptionEntitlementSnapshots.authUid, professionalAuthUid))
      .limit(1);

    if (snapshot?.status !== 'active') {
      throw new ProfessionalSubscriptionRequiredError();
    }
  }

  private async findNutritionPlanForRead(input: GetPlanDetailInput): Promise<NutritionPlanRow> {
    const [row] = await this.db
      .select()
      .from(nutritionPlans)
      .where(eq(nutritionPlans.id, input.planId))
      .limit(1);

    if (!row || !canReadPlan(row, input.authUid)) {
      throw new PlanNotFoundError('Nutrition plan not found.');
    }
    return row;
  }

  private async findTrainingPlanForRead(input: GetPlanDetailInput): Promise<TrainingPlanRow> {
    const [row] = await this.db
      .select()
      .from(trainingPlans)
      .where(eq(trainingPlans.id, input.planId))
      .limit(1);

    if (!row || !canReadPlan(row, input.authUid)) {
      throw new PlanNotFoundError('Training plan not found.');
    }
    return row;
  }
}
