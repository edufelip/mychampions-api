import { describe, expect, it } from 'bun:test';

import { createApp } from '../src/app';
import { ProfessionalSubscriptionRequiredError, type ConnectionRepository } from '../src/connections/repository';
import type { PlanChangeRequestRepository } from '../src/plans/plan-change-request-repository';
import type { ProfessionalSpecialtyRepository } from '../src/professional/specialty-repository';
import type { Profile, ProfileRepository } from '../src/profile/repository';
import type { SupportMessageRepository } from '../src/support/repository';

type ServerPlan = {
  id: string;
  planType: 'nutrition' | 'training';
  sourceKind: 'predefined' | 'assigned' | 'self_managed';
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

type ServerNutritionPlanDetail = ServerPlan & {
  planType: 'nutrition';
  studentAuthUid: string;
  hydrationGoalMl: number | null;
  caloriesTarget: number;
  carbsTarget: number;
  proteinsTarget: number;
  fatsTarget: number;
  meals: Array<{
    id: string;
    name: string;
    items: Array<{
      id: string;
      name: string;
      quantity: string;
      notes: string;
      calories?: number;
      carbs?: number;
      proteins?: number;
      fats?: number;
      sourceKind?: 'manual' | 'food_search' | 'custom_meal';
    }>;
  }>;
};

type ServerTrainingPlanDetail = ServerPlan & {
  planType: 'training';
  studentAuthUid: string;
  sessions: Array<{
    id: string;
    name: string;
    notes: string;
    items: Array<{
      id: string;
      name: string;
      quantity: string;
      notes: string;
      exerciseId?: string;
    }>;
  }>;
};

type PlanRepository = {
  listForAuthUid(input: { authUid: string }): Promise<ServerPlan[]>;
  listPredefinedForOwner(input: { ownerProfessionalUid: string }): Promise<ServerPlan[]>;
  bulkAssignPredefined?(input: {
    professionalAuthUid: string;
    predefinedPlanId: string;
    studentUids: string[];
  }): Promise<{ assignedCount: number }>;
  createDraftAssignedFromPredefined?(input: {
    professionalAuthUid: string;
    predefinedPlanId: string;
    studentUid: string;
  }): Promise<ServerPlan>;
  createNutritionPlanDetail?(input: {
    authUid: string;
    name: string;
    hydrationGoalMl: number | null;
    mode: 'professional_library' | 'self_managed';
  }): Promise<ServerNutritionPlanDetail>;
  createTrainingPlanDetail?(input: {
    authUid: string;
    name: string;
    mode: 'professional_library' | 'self_managed';
  }): Promise<ServerTrainingPlanDetail>;
  getNutritionPlanDetail?(input: { authUid: string; planId: string }): Promise<ServerNutritionPlanDetail>;
  updateNutritionPlanDetail?(input: {
    authUid: string;
    planId: string;
    name: string;
    hydrationGoalMl: number | null;
    publish?: boolean;
  }): Promise<ServerNutritionPlanDetail>;
  addNutritionMeal?(input: {
    authUid: string;
    planId: string;
    name: string;
  }): Promise<ServerNutritionPlanDetail['meals'][number]>;
  removeNutritionMeal?(input: {
    authUid: string;
    planId: string;
    mealId: string;
  }): Promise<ServerNutritionPlanDetail>;
  reorderNutritionMeals?(input: {
    authUid: string;
    planId: string;
    mealIds: string[];
  }): Promise<ServerNutritionPlanDetail>;
  addNutritionMealItem?(input: {
    authUid: string;
    planId: string;
    mealId: string;
    item: ServerNutritionPlanDetail['meals'][number]['items'][number] & { id?: string };
  }): Promise<ServerNutritionPlanDetail['meals'][number]['items'][number]>;
  removeNutritionMealItem?(input: {
    authUid: string;
    planId: string;
    mealId: string;
    itemId: string;
  }): Promise<ServerNutritionPlanDetail>;
  reorderNutritionMealItems?(input: {
    authUid: string;
    planId: string;
    mealId: string;
    itemIds: string[];
  }): Promise<ServerNutritionPlanDetail>;
  getTrainingPlanDetail?(input: { authUid: string; planId: string }): Promise<ServerTrainingPlanDetail>;
  updateTrainingPlanDetail?(input: {
    authUid: string;
    planId: string;
    name: string;
    sessions?: ServerTrainingPlanDetail['sessions'];
    publish?: boolean;
  }): Promise<ServerTrainingPlanDetail>;
  addTrainingSession?(input: {
    authUid: string;
    planId: string;
    name: string;
    notes: string;
  }): Promise<ServerTrainingPlanDetail['sessions'][number]>;
  removeTrainingSession?(input: {
    authUid: string;
    planId: string;
    sessionId: string;
  }): Promise<ServerTrainingPlanDetail>;
  reorderTrainingSessions?(input: {
    authUid: string;
    planId: string;
    sessionIds: string[];
  }): Promise<ServerTrainingPlanDetail>;
  addTrainingSessionItem?(input: {
    authUid: string;
    planId: string;
    sessionId: string;
    item: ServerTrainingPlanDetail['sessions'][number]['items'][number] & { ymoveId?: string };
  }): Promise<ServerTrainingPlanDetail['sessions'][number]['items'][number]>;
  removeTrainingSessionItem?(input: {
    authUid: string;
    planId: string;
    sessionId: string;
    itemId: string;
  }): Promise<ServerTrainingPlanDetail>;
  reorderTrainingSessionItems?(input: {
    authUid: string;
    planId: string;
    sessionId: string;
    itemIds: string[];
  }): Promise<ServerTrainingPlanDetail>;
  deleteNutritionPlan?(input: { authUid: string; planId: string }): Promise<void>;
  deleteTrainingPlan?(input: { authUid: string; planId: string }): Promise<void>;
};

function authUidForEmail(email: string): string {
  return `local_${Buffer.from(email.trim().toLowerCase()).toString('base64url')}`;
}

function makeProfile(input: Partial<Profile> & Pick<Profile, 'authUid' | 'displayName'>): Profile {
  return {
    emailNormalized: `${input.authUid}@example.test`,
    lockedRole: null,
    acceptedTermsVersion: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...input,
  };
}

function makeProfileRepository(seed: Profile[] = []): ProfileRepository {
  const profiles = new Map(seed.map((profile) => [profile.authUid, profile]));

  return {
    async upsertFromSession(input) {
      const profile = makeProfile({
        authUid: input.authUid,
        displayName: input.displayName,
        emailNormalized: input.emailNormalized,
      });
      profiles.set(profile.authUid, profile);
      return profile;
    },
    async findByAuthUid(authUid) {
      return profiles.get(authUid) ?? null;
    },
    async lockRole() {
      throw new Error('not implemented');
    },
    async setAcceptedTermsVersion() {
      throw new Error('not implemented');
    },
    async deleteByAuthUid() {},
  };
}

const supportMessageRepository: SupportMessageRepository = {
  async create() {
    throw new Error('not implemented');
  },
};

const connectionRepository: ConnectionRepository = {
  async listForAuthUid() {
    return [];
  },
  async getOrCreateActiveInviteCode() {
    throw new Error('not implemented');
  },
  async rotateInviteCode() {
    throw new Error('not implemented');
  },
  async submitInviteCode() {
    throw new Error('not implemented');
  },
  async confirmPendingConnection() {
    throw new Error('not implemented');
  },
  async endConnection() {
    throw new Error('not implemented');
  },
};

const specialtyRepository: ProfessionalSpecialtyRepository = {
  async listForProfessional() {
    return [];
  },
  async addOrReactivate() {
    throw new Error('not implemented');
  },
  async getBlockerCounts() {
    return { activeCount: 0, pendingCount: 0 };
  },
  async removeForProfessional() {
    throw new Error('not implemented');
  },
  async upsertCredential() {
    throw new Error('not implemented');
  },
};

const planChangeRequestRepository: PlanChangeRequestRepository = {
  async create() {
    throw new Error('not implemented');
  },
  async listForStudent() {
    throw new Error('not implemented');
  },
  async listForProfessional() {
    throw new Error('not implemented');
  },
  async review() {
    throw new Error('not implemented');
  },
};

async function issueSession(app: ReturnType<typeof createApp>, email: string, displayName: string) {
  const sessionResponse = await app.handle(
    new Request('http://server.test/auth/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, displayName }),
    })
  );
  return sessionResponse.json() as Promise<{ accessToken: string; profile: { authUid: string } }>;
}

function makeApp(planRepository: PlanRepository) {
  return createApp({
    profileRepository: makeProfileRepository([
      makeProfile({ authUid: authUidForEmail('student@example.test'), displayName: 'Student One' }),
      makeProfile({ authUid: authUidForEmail('professional@example.test'), displayName: 'Professional One' }),
    ]),
    supportMessageRepository,
    connectionRepository,
    specialtyRepository,
    planChangeRequestRepository,
    planRepository,
  } as Parameters<typeof createApp>[0] & { planRepository: PlanRepository });
}

describe('plans API', () => {
  it('returns mixed nutrition and training plans for the authenticated user', async () => {
    const captured: { authUid: string | null } = { authUid: null };
    const app = makeApp({
      async listForAuthUid(input) {
        captured.authUid = input.authUid;
        return [
          {
            id: 'nutrition-plan-1',
            planType: 'nutrition',
            sourceKind: 'assigned',
            ownerProfessionalUid: 'professional-1',
            studentUid: input.authUid,
            isArchived: false,
            isDraft: false,
            name: 'High Protein Plan',
            hydrationGoalMl: 2800,
            caloriesTarget: 2200,
            carbsTarget: 210,
            proteinsTarget: 160,
            fatsTarget: 70,
            createdAt: '2026-06-28T10:00:00.000Z',
            updatedAt: '2026-06-29T10:00:00.000Z',
          },
          {
            id: 'training-plan-1',
            planType: 'training',
            sourceKind: 'self_managed',
            ownerProfessionalUid: null,
            studentUid: input.authUid,
            isArchived: false,
            isDraft: false,
            name: 'Upper Strength',
            createdAt: '2026-06-27T10:00:00.000Z',
            updatedAt: '2026-06-28T10:00:00.000Z',
          },
        ];
      },
      async listPredefinedForOwner() {
        throw new Error('not implemented');
      },
    });
    const session = await issueSession(app, 'student@example.test', 'Student One');

    const response = await app.handle(
      new Request('http://server.test/plans/my', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(200);
    expect(captured.authUid).toBe(session.profile.authUid);
    await expect(response.json()).resolves.toEqual({
      plans: [
        {
          id: 'nutrition-plan-1',
          planType: 'nutrition',
          sourceKind: 'assigned',
          ownerProfessionalUid: 'professional-1',
          studentUid: session.profile.authUid,
          isArchived: false,
          isDraft: false,
          name: 'High Protein Plan',
          hydrationGoalMl: 2800,
          caloriesTarget: 2200,
          carbsTarget: 210,
          proteinsTarget: 160,
          fatsTarget: 70,
          createdAt: '2026-06-28T10:00:00.000Z',
          updatedAt: '2026-06-29T10:00:00.000Z',
        },
        {
          id: 'training-plan-1',
          planType: 'training',
          sourceKind: 'self_managed',
          ownerProfessionalUid: null,
          studentUid: session.profile.authUid,
          isArchived: false,
          isDraft: false,
          name: 'Upper Strength',
          createdAt: '2026-06-27T10:00:00.000Z',
          updatedAt: '2026-06-28T10:00:00.000Z',
        },
      ],
    });
  });

  it('returns predefined plans owned by the authenticated professional', async () => {
    const captured: { ownerProfessionalUid: string | null } = { ownerProfessionalUid: null };
    const app = makeApp({
      async listForAuthUid() {
        throw new Error('not implemented');
      },
      async listPredefinedForOwner(input) {
        captured.ownerProfessionalUid = input.ownerProfessionalUid;
        return [
          {
            id: 'training-template-1',
            planType: 'training',
            sourceKind: 'predefined',
            ownerProfessionalUid: input.ownerProfessionalUid,
            studentUid: input.ownerProfessionalUid,
            isArchived: false,
            isDraft: false,
            name: 'Strength Template',
            createdAt: '2026-06-27T10:00:00.000Z',
            updatedAt: '2026-06-29T10:00:00.000Z',
          },
          {
            id: 'nutrition-template-1',
            planType: 'nutrition',
            sourceKind: 'predefined',
            ownerProfessionalUid: input.ownerProfessionalUid,
            studentUid: input.ownerProfessionalUid,
            isArchived: false,
            isDraft: false,
            name: 'Nutrition Template',
            createdAt: '2026-06-26T10:00:00.000Z',
            updatedAt: '2026-06-28T10:00:00.000Z',
          },
        ];
      },
    });
    const session = await issueSession(app, 'professional@example.test', 'Professional One');

    const response = await app.handle(
      new Request('http://server.test/plans/predefined', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(200);
    expect(captured.ownerProfessionalUid).toBe(session.profile.authUid);
    await expect(response.json()).resolves.toEqual({
      plans: [
        {
          id: 'training-template-1',
          planType: 'training',
          name: 'Strength Template',
          ownerProfessionalUid: session.profile.authUid,
          createdAt: '2026-06-27T10:00:00.000Z',
          updatedAt: '2026-06-29T10:00:00.000Z',
        },
        {
          id: 'nutrition-template-1',
          planType: 'nutrition',
          name: 'Nutrition Template',
          ownerProfessionalUid: session.profile.authUid,
          createdAt: '2026-06-26T10:00:00.000Z',
          updatedAt: '2026-06-28T10:00:00.000Z',
        },
      ],
    });
  });

  it('returns server-owned starter templates for the requested plan type', async () => {
    const app = makeApp({
      async listForAuthUid() {
        throw new Error('not implemented');
      },
      async listPredefinedForOwner() {
        throw new Error('not implemented');
      },
    });
    const session = await issueSession(app, 'professional@example.test', 'Professional One');

    const response = await app.handle(
      new Request('http://server.test/plans/starter-templates?planType=nutrition', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.templates).toEqual([
      {
        id: 'starter_nutrition_default_balance',
        planType: 'nutrition',
        name: 'Balanced Starter',
        description: 'Balanced calories and macros for kickoff.',
      },
    ]);
  });

  it('clones a starter nutrition template with server-owned default meals and targets', async () => {
    const calls: string[] = [];
    const createdPlan: ServerNutritionPlanDetail = {
      id: 'nutrition-clone-1',
      planType: 'nutrition',
      sourceKind: 'predefined',
      ownerProfessionalUid: authUidForEmail('professional@example.test'),
      studentUid: authUidForEmail('professional@example.test'),
      studentAuthUid: authUidForEmail('professional@example.test'),
      isArchived: false,
      isDraft: false,
      name: 'Client Balanced Starter',
      hydrationGoalMl: null,
      caloriesTarget: 0,
      carbsTarget: 0,
      proteinsTarget: 0,
      fatsTarget: 0,
      meals: [],
      createdAt: '2026-07-03T12:00:00.000Z',
      updatedAt: '2026-07-03T12:00:00.000Z',
    };
    let plan = createdPlan;
    const app = makeApp({
      async listForAuthUid() {
        throw new Error('not implemented');
      },
      async listPredefinedForOwner() {
        throw new Error('not implemented');
      },
      async createNutritionPlanDetail(input) {
        calls.push(`create:${input.name}:${input.mode}`);
        return plan;
      },
      async addNutritionMeal(input) {
        calls.push(`meal:${input.name}`);
        return { id: `meal-${calls.filter((call) => call.startsWith('meal:')).length}`, name: input.name, items: [] };
      },
      async addNutritionMealItem(input) {
        calls.push(`item:${input.mealId}:${input.item.name}:${input.item.quantity}`);
        const meal = plan.meals.find((candidate) => candidate.id === input.mealId);
        if (meal) {
          meal.items.push({ ...input.item, id: `item-${meal.items.length + 1}` });
        }
        return { ...input.item, id: 'item-added' };
      },
      async getNutritionPlanDetail() {
        plan = {
          ...plan,
          caloriesTarget: 2000,
          carbsTarget: 220,
          proteinsTarget: 140,
          fatsTarget: 70,
          meals: [
            {
              id: 'meal-1',
              name: 'Breakfast',
              items: [
                {
                  id: 'item-1',
                  name: 'Oats + banana breakfast',
                  quantity: '1 bowl',
                  notes: 'Morning',
                  sourceKind: 'manual',
                },
              ],
            },
          ],
        };
        return plan;
      },
    });
    const session = await issueSession(app, 'professional@example.test', 'Professional One');

    const response = await app.handle(
      new Request('http://server.test/plans/starter-templates/starter_nutrition_default_balance/clone', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Client Balanced Starter' }),
      })
    );

    expect(response.status).toBe(201);
    expect(calls).toEqual([
      'create:Client Balanced Starter:professional_library',
      'meal:Breakfast',
      'item:meal-1:Oats + banana breakfast:1 bowl',
      'meal:Lunch',
      'item:meal-2:Chicken + rice lunch:1 plate',
    ]);
    const body = await response.json();
    expect(body.plan).toMatchObject({
      id: 'nutrition-clone-1',
      planType: 'nutrition',
      name: 'Client Balanced Starter',
      caloriesTarget: 2000,
      carbsTarget: 220,
      proteinsTarget: 140,
      fatsTarget: 70,
      meals: [
        {
          name: 'Breakfast',
          items: [{ name: 'Oats + banana breakfast', quantity: '1 bowl', notes: 'Morning' }],
        },
      ],
    });
  });

  it('rejects unauthenticated plan list requests', async () => {
    const app = makeApp({
      async listForAuthUid() {
        throw new Error('not implemented');
      },
      async listPredefinedForOwner() {
        throw new Error('not implemented');
      },
    });

    const response = await app.handle(new Request('http://server.test/plans/my'));

    expect(response.status).toBe(401);
  });

  it('bulk assigns a predefined plan for the authenticated professional', async () => {
    const captured: {
      professionalAuthUid: string | null;
      predefinedPlanId: string | null;
      studentUids: string[];
    } = {
      professionalAuthUid: null,
      predefinedPlanId: null,
      studentUids: [],
    };
    const app = makeApp({
      async listForAuthUid() {
        throw new Error('not implemented');
      },
      async listPredefinedForOwner() {
        throw new Error('not implemented');
      },
      async bulkAssignPredefined(input) {
        captured.professionalAuthUid = input.professionalAuthUid;
        captured.predefinedPlanId = input.predefinedPlanId;
        captured.studentUids = input.studentUids;
        return { assignedCount: 2 };
      },
    });
    const session = await issueSession(app, 'professional@example.test', 'Professional One');

    const response = await app.handle(
      new Request('http://server.test/plans/predefined/template-1/bulk-assign', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ studentUids: ['student-1', 'student-2'] }),
      })
    );

    expect(response.status).toBe(200);
    expect(captured).toEqual({
      professionalAuthUid: session.profile.authUid,
      predefinedPlanId: 'template-1',
      studentUids: ['student-1', 'student-2'],
    });
    await expect(response.json()).resolves.toEqual({ assignedCount: 2 });
  });

  it('creates a draft assigned plan for the authenticated professional', async () => {
    const captured: {
      professionalAuthUid: string | null;
      predefinedPlanId: string | null;
      studentUid: string | null;
    } = {
      professionalAuthUid: null,
      predefinedPlanId: null,
      studentUid: null,
    };
    const app = makeApp({
      async listForAuthUid() {
        throw new Error('not implemented');
      },
      async listPredefinedForOwner() {
        throw new Error('not implemented');
      },
      async createDraftAssignedFromPredefined(input) {
        captured.professionalAuthUid = input.professionalAuthUid;
        captured.predefinedPlanId = input.predefinedPlanId;
        captured.studentUid = input.studentUid;
        return {
          id: 'nutrition-draft-1',
          planType: 'nutrition',
          sourceKind: 'assigned',
          ownerProfessionalUid: input.professionalAuthUid,
          studentUid: input.studentUid,
          isArchived: false,
          isDraft: true,
          name: 'Draft Nutrition',
          hydrationGoalMl: 2800,
          caloriesTarget: 2200,
          carbsTarget: 210,
          proteinsTarget: 160,
          fatsTarget: 70,
          createdAt: '2026-06-29T10:00:00.000Z',
          updatedAt: '2026-06-29T10:00:00.000Z',
        };
      },
    });
    const session = await issueSession(app, 'professional@example.test', 'Professional One');

    const response = await app.handle(
      new Request('http://server.test/plans/predefined/template-1/draft-assignments', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ studentUid: 'student-1' }),
      })
    );

    expect(response.status).toBe(201);
    expect(captured).toEqual({
      professionalAuthUid: session.profile.authUid,
      predefinedPlanId: 'template-1',
      studentUid: 'student-1',
    });
    await expect(response.json()).resolves.toEqual({
      plan: {
        id: 'nutrition-draft-1',
        planType: 'nutrition',
        sourceKind: 'assigned',
        ownerProfessionalUid: session.profile.authUid,
        studentUid: 'student-1',
        isArchived: false,
        isDraft: true,
        name: 'Draft Nutrition',
        hydrationGoalMl: 2800,
        caloriesTarget: 2200,
        carbsTarget: 210,
        proteinsTarget: 160,
        fatsTarget: 70,
        createdAt: '2026-06-29T10:00:00.000Z',
        updatedAt: '2026-06-29T10:00:00.000Z',
      },
    });
  });

  it('returns nutrition plan detail for the authenticated user', async () => {
    const captured: { authUid: string | null; planId: string | null } = {
      authUid: null,
      planId: null,
    };
    const app = makeApp({
      async listForAuthUid() {
        throw new Error('not implemented');
      },
      async listPredefinedForOwner() {
        throw new Error('not implemented');
      },
      async getNutritionPlanDetail(input) {
        captured.authUid = input.authUid;
        captured.planId = input.planId;
        return {
          id: input.planId,
          planType: 'nutrition',
          sourceKind: 'assigned',
          ownerProfessionalUid: 'professional-1',
          studentUid: input.authUid,
          studentAuthUid: input.authUid,
          isArchived: false,
          isDraft: true,
          name: 'Draft Nutrition',
          hydrationGoalMl: 2800,
          caloriesTarget: 2200,
          carbsTarget: 210,
          proteinsTarget: 160,
          fatsTarget: 70,
          meals: [
            {
              id: 'meal-1',
              name: 'Breakfast',
              items: [
                {
                  id: 'item-1',
                  name: 'Greek yogurt',
                  quantity: '200 g',
                  notes: 'Add berries',
                  calories: 180,
                  carbs: 18,
                  proteins: 22,
                  fats: 2,
                  sourceKind: 'manual',
                },
              ],
            },
          ],
          createdAt: '2026-06-29T10:00:00.000Z',
          updatedAt: '2026-06-29T11:00:00.000Z',
        };
      },
    });
    const session = await issueSession(app, 'student@example.test', 'Student One');

    const response = await app.handle(
      new Request('http://server.test/plans/nutrition/nutrition-plan-1', {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );

    expect(response.status).toBe(200);
    expect(captured).toEqual({
      authUid: session.profile.authUid,
      planId: 'nutrition-plan-1',
    });
    await expect(response.json()).resolves.toEqual({
      plan: {
        id: 'nutrition-plan-1',
        planType: 'nutrition',
        sourceKind: 'assigned',
        ownerProfessionalUid: 'professional-1',
        studentUid: session.profile.authUid,
        studentAuthUid: session.profile.authUid,
        isArchived: false,
        isDraft: true,
        name: 'Draft Nutrition',
        hydrationGoalMl: 2800,
        caloriesTarget: 2200,
        carbsTarget: 210,
        proteinsTarget: 160,
        fatsTarget: 70,
        meals: [
          {
            id: 'meal-1',
            name: 'Breakfast',
            items: [
              {
                id: 'item-1',
                name: 'Greek yogurt',
                quantity: '200 g',
                notes: 'Add berries',
                calories: 180,
                carbs: 18,
                proteins: 22,
                fats: 2,
                sourceKind: 'manual',
              },
            ],
          },
        ],
        createdAt: '2026-06-29T10:00:00.000Z',
        updatedAt: '2026-06-29T11:00:00.000Z',
      },
    });
  });

  it('creates a self-managed nutrition plan for the authenticated user', async () => {
    const captured: {
      authUid: string | null;
      name: string | null;
      hydrationGoalMl: number | null;
      mode: 'professional_library' | 'self_managed' | null;
    } = {
      authUid: null,
      name: null,
      hydrationGoalMl: null,
      mode: null,
    };
    const app = makeApp({
      async listForAuthUid() {
        throw new Error('not implemented');
      },
      async listPredefinedForOwner() {
        throw new Error('not implemented');
      },
      async createNutritionPlanDetail(input) {
        captured.authUid = input.authUid;
        captured.name = input.name;
        captured.hydrationGoalMl = input.hydrationGoalMl;
        captured.mode = input.mode;
        return {
          id: 'nutrition-created-1',
          planType: 'nutrition',
          sourceKind: 'self_managed',
          ownerProfessionalUid: null,
          studentUid: input.authUid,
          studentAuthUid: input.authUid,
          isArchived: false,
          isDraft: false,
          name: input.name,
          hydrationGoalMl: input.hydrationGoalMl,
          caloriesTarget: 0,
          carbsTarget: 0,
          proteinsTarget: 0,
          fatsTarget: 0,
          meals: [],
          createdAt: '2026-06-29T10:00:00.000Z',
          updatedAt: '2026-06-29T10:00:00.000Z',
        };
      },
    });
    const session = await issueSession(app, 'student@example.test', 'Student One');

    const response = await app.handle(
      new Request('http://server.test/plans/nutrition', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: ' New Nutrition ',
          hydrationGoalMl: 2600,
          mode: 'self_managed',
        }),
      })
    );

    expect(response.status).toBe(201);
    expect(captured).toEqual({
      authUid: session.profile.authUid,
      name: 'New Nutrition',
      hydrationGoalMl: 2600,
      mode: 'self_managed',
    });
    await expect(response.json()).resolves.toEqual({
      plan: {
        id: 'nutrition-created-1',
        planType: 'nutrition',
        sourceKind: 'self_managed',
        ownerProfessionalUid: null,
        studentUid: session.profile.authUid,
        studentAuthUid: session.profile.authUid,
        isArchived: false,
        isDraft: false,
        name: 'New Nutrition',
        hydrationGoalMl: 2600,
        caloriesTarget: 0,
        carbsTarget: 0,
        proteinsTarget: 0,
        fatsTarget: 0,
        meals: [],
        createdAt: '2026-06-29T10:00:00.000Z',
        updatedAt: '2026-06-29T10:00:00.000Z',
      },
    });
  });

  it('updates training plan detail for the authenticated user', async () => {
    const captured: {
      authUid: string | null;
      planId: string | null;
      name: string | null;
      publish: boolean | undefined;
      sessions: ServerTrainingPlanDetail['sessions'] | null;
    } = {
      authUid: null,
      planId: null,
      name: null,
      publish: undefined,
      sessions: null,
    };
    const app = makeApp({
      async listForAuthUid() {
        throw new Error('not implemented');
      },
      async listPredefinedForOwner() {
        throw new Error('not implemented');
      },
      async updateTrainingPlanDetail(input) {
        captured.authUid = input.authUid;
        captured.planId = input.planId;
        captured.name = input.name;
        captured.publish = input.publish;
        captured.sessions = input.sessions ?? null;
        return {
          id: input.planId,
          planType: 'training',
          sourceKind: 'assigned',
          ownerProfessionalUid: input.authUid,
          studentUid: 'student-1',
          studentAuthUid: 'student-1',
          isArchived: false,
          isDraft: false,
          name: input.name,
          sessions: input.sessions ?? [],
          createdAt: '2026-06-29T10:00:00.000Z',
          updatedAt: '2026-06-29T11:00:00.000Z',
        };
      },
    });
    const session = await issueSession(app, 'professional@example.test', 'Professional One');

    const sessions = [
      {
        id: 'session-1',
        name: 'Upper A',
        notes: 'Controlled tempo',
        items: [
          {
            id: 'exercise-1',
            name: 'Bench Press',
            quantity: '3x8',
            notes: 'RPE 8',
            exerciseId: 'exercise-catalog-1',
          },
        ],
      },
    ];
    const response = await app.handle(
      new Request('http://server.test/plans/training/training-plan-1', {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: ' Upper A ', publish: true, sessions }),
      })
    );

    expect(response.status).toBe(200);
    expect(captured).toEqual({
      authUid: session.profile.authUid,
      planId: 'training-plan-1',
      name: 'Upper A',
      publish: true,
      sessions,
    });
    await expect(response.json()).resolves.toEqual({
      plan: {
        id: 'training-plan-1',
        planType: 'training',
        sourceKind: 'assigned',
        ownerProfessionalUid: session.profile.authUid,
        studentUid: 'student-1',
        studentAuthUid: 'student-1',
        isArchived: false,
        isDraft: false,
        name: 'Upper A',
        sessions,
        createdAt: '2026-06-29T10:00:00.000Z',
        updatedAt: '2026-06-29T11:00:00.000Z',
      },
    });
  });

  it('returns subscription-required when plan repository rejects a professional plan update', async () => {
    const app = makeApp({
      async listForAuthUid() {
        throw new Error('not implemented');
      },
      async listPredefinedForOwner() {
        throw new Error('not implemented');
      },
      async updateNutritionPlanDetail() {
        throw new ProfessionalSubscriptionRequiredError();
      },
    });
    const session = await issueSession(app, 'professional@example.test', 'Professional One');

    const response = await app.handle(
      new Request('http://server.test/plans/nutrition/nutrition-plan-1', {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Updated Nutrition', hydrationGoalMl: 2600, publish: true }),
      })
    );

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'professional_subscription_required',
        message: 'Professional subscription required.',
      },
    });
  });

  it('adds a nutrition meal for the authenticated user', async () => {
    const captured: { authUid: string | null; planId: string | null; name: string | null } = {
      authUid: null,
      planId: null,
      name: null,
    };
    const app = makeApp({
      async listForAuthUid() {
        throw new Error('not implemented');
      },
      async listPredefinedForOwner() {
        throw new Error('not implemented');
      },
      async addNutritionMeal(input) {
        captured.authUid = input.authUid;
        captured.planId = input.planId;
        captured.name = input.name;
        return { id: 'meal-created-1', name: input.name, items: [] };
      },
    });
    const session = await issueSession(app, 'student@example.test', 'Student One');

    const response = await app.handle(
      new Request('http://server.test/plans/nutrition/nutrition-plan-1/meals', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: ' Breakfast ' }),
      })
    );

    expect(response.status).toBe(201);
    expect(captured).toEqual({
      authUid: session.profile.authUid,
      planId: 'nutrition-plan-1',
      name: 'Breakfast',
    });
    await expect(response.json()).resolves.toEqual({
      meal: { id: 'meal-created-1', name: 'Breakfast', items: [] },
    });
  });

  it('adds a nutrition meal item for the authenticated user', async () => {
    const captured: {
      authUid: string | null;
      planId: string | null;
      mealId: string | null;
      item: unknown;
    } = {
      authUid: null,
      planId: null,
      mealId: null,
      item: null,
    };
    const app = makeApp({
      async listForAuthUid() {
        throw new Error('not implemented');
      },
      async listPredefinedForOwner() {
        throw new Error('not implemented');
      },
      async addNutritionMealItem(input) {
        captured.authUid = input.authUid;
        captured.planId = input.planId;
        captured.mealId = input.mealId;
        captured.item = input.item;
        return {
          id: 'item-created-1',
          name: input.item.name,
          quantity: input.item.quantity,
          notes: input.item.notes,
          calories: input.item.calories,
          carbs: input.item.carbs,
          proteins: input.item.proteins,
          fats: input.item.fats,
          sourceKind: input.item.sourceKind,
        };
      },
    });
    const session = await issueSession(app, 'student@example.test', 'Student One');

    const response = await app.handle(
      new Request('http://server.test/plans/nutrition/nutrition-plan-1/meals/meal-1/items', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: ' Greek Yogurt ',
          quantity: '200 g',
          notes: 'Add berries',
          calories: 180,
          carbs: 18,
          proteins: 22,
          fats: 2,
          sourceKind: 'manual',
        }),
      })
    );

    expect(response.status).toBe(201);
    expect(captured).toEqual({
      authUid: session.profile.authUid,
      planId: 'nutrition-plan-1',
      mealId: 'meal-1',
      item: {
        name: 'Greek Yogurt',
        quantity: '200 g',
        notes: 'Add berries',
        calories: 180,
        carbs: 18,
        proteins: 22,
        fats: 2,
        sourceKind: 'manual',
      },
    });
    await expect(response.json()).resolves.toEqual({
      item: {
        id: 'item-created-1',
        name: 'Greek Yogurt',
        quantity: '200 g',
        notes: 'Add berries',
        calories: 180,
        carbs: 18,
        proteins: 22,
        fats: 2,
        sourceKind: 'manual',
      },
    });
  });

  it('removes and reorders nutrition meal payloads for the authenticated user', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const plan: ServerNutritionPlanDetail = {
      id: 'nutrition-plan-1',
      planType: 'nutrition',
      sourceKind: 'self_managed',
      ownerProfessionalUid: null,
      studentUid: 'student-1',
      studentAuthUid: 'student-1',
      isArchived: false,
      isDraft: false,
      name: 'Nutrition',
      hydrationGoalMl: null,
      caloriesTarget: 0,
      carbsTarget: 0,
      proteinsTarget: 0,
      fatsTarget: 0,
      meals: [],
      createdAt: '2026-06-29T10:00:00.000Z',
      updatedAt: '2026-06-29T11:00:00.000Z',
    };
    const app = makeApp({
      async listForAuthUid() {
        throw new Error('not implemented');
      },
      async listPredefinedForOwner() {
        throw new Error('not implemented');
      },
      async removeNutritionMeal(input) {
        captured.push({ operation: 'removeMeal', ...input });
        return plan;
      },
      async reorderNutritionMeals(input) {
        captured.push({ operation: 'reorderMeals', ...input });
        return plan;
      },
      async removeNutritionMealItem(input) {
        captured.push({ operation: 'removeItem', ...input });
        return plan;
      },
      async reorderNutritionMealItems(input) {
        captured.push({ operation: 'reorderItems', ...input });
        return plan;
      },
    });
    const session = await issueSession(app, 'student@example.test', 'Student One');

    const removeMeal = await app.handle(
      new Request('http://server.test/plans/nutrition/nutrition-plan-1/meals/meal-1', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );
    const reorderMeals = await app.handle(
      new Request('http://server.test/plans/nutrition/nutrition-plan-1/meals/reorder', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ mealIds: ['meal-2', 'meal-1'] }),
      })
    );
    const removeItem = await app.handle(
      new Request('http://server.test/plans/nutrition/nutrition-plan-1/meals/meal-1/items/item-1', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );
    const reorderItems = await app.handle(
      new Request('http://server.test/plans/nutrition/nutrition-plan-1/meals/meal-1/items/reorder', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ itemIds: ['item-2', 'item-1'] }),
      })
    );

    expect(removeMeal.status).toBe(200);
    expect(reorderMeals.status).toBe(200);
    expect(removeItem.status).toBe(200);
    expect(reorderItems.status).toBe(200);
    expect(captured).toEqual([
      { operation: 'removeMeal', authUid: session.profile.authUid, planId: 'nutrition-plan-1', mealId: 'meal-1' },
      { operation: 'reorderMeals', authUid: session.profile.authUid, planId: 'nutrition-plan-1', mealIds: ['meal-2', 'meal-1'] },
      { operation: 'removeItem', authUid: session.profile.authUid, planId: 'nutrition-plan-1', mealId: 'meal-1', itemId: 'item-1' },
      { operation: 'reorderItems', authUid: session.profile.authUid, planId: 'nutrition-plan-1', mealId: 'meal-1', itemIds: ['item-2', 'item-1'] },
    ]);
  });

  it('adds a training session for the authenticated user', async () => {
    const captured: { authUid: string | null; planId: string | null; name: string | null; notes: string | null } = {
      authUid: null,
      planId: null,
      name: null,
      notes: null,
    };
    const app = makeApp({
      async listForAuthUid() {
        throw new Error('not implemented');
      },
      async listPredefinedForOwner() {
        throw new Error('not implemented');
      },
      async addTrainingSession(input) {
        captured.authUid = input.authUid;
        captured.planId = input.planId;
        captured.name = input.name;
        captured.notes = input.notes;
        return { id: 'session-created-1', name: input.name, notes: input.notes, items: [] };
      },
    });
    const session = await issueSession(app, 'student@example.test', 'Student One');

    const response = await app.handle(
      new Request('http://server.test/plans/training/training-plan-1/sessions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: ' Upper A ', notes: ' Controlled tempo ' }),
      })
    );

    expect(response.status).toBe(201);
    expect(captured).toEqual({
      authUid: session.profile.authUid,
      planId: 'training-plan-1',
      name: 'Upper A',
      notes: 'Controlled tempo',
    });
    await expect(response.json()).resolves.toEqual({
      session: { id: 'session-created-1', name: 'Upper A', notes: 'Controlled tempo', items: [] },
    });
  });

  it('adds a training session item for the authenticated user', async () => {
    const captured: {
      authUid: string | null;
      planId: string | null;
      sessionId: string | null;
      item: unknown;
    } = {
      authUid: null,
      planId: null,
      sessionId: null,
      item: null,
    };
    const app = makeApp({
      async listForAuthUid() {
        throw new Error('not implemented');
      },
      async listPredefinedForOwner() {
        throw new Error('not implemented');
      },
      async addTrainingSessionItem(input) {
        captured.authUid = input.authUid;
        captured.planId = input.planId;
        captured.sessionId = input.sessionId;
        captured.item = input.item;
        return {
          id: 'training-item-created-1',
          name: input.item.name,
          quantity: input.item.quantity,
          notes: input.item.notes,
          exerciseId: input.item.exerciseId,
          ymoveId: input.item.ymoveId,
        };
      },
    });
    const session = await issueSession(app, 'student@example.test', 'Student One');

    const response = await app.handle(
      new Request('http://server.test/plans/training/training-plan-1/sessions/session-1/items', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: ' Bench Press ',
          quantity: '3x8',
          notes: 'RPE 8',
          exerciseId: 'exercise-catalog-1',
        }),
      })
    );

    expect(response.status).toBe(201);
    expect(captured).toEqual({
      authUid: session.profile.authUid,
      planId: 'training-plan-1',
      sessionId: 'session-1',
      item: {
        name: 'Bench Press',
        quantity: '3x8',
        notes: 'RPE 8',
        exerciseId: 'exercise-catalog-1',
      },
    });
    await expect(response.json()).resolves.toEqual({
      item: {
        id: 'training-item-created-1',
        name: 'Bench Press',
        quantity: '3x8',
        notes: 'RPE 8',
        exerciseId: 'exercise-catalog-1',
      },
    });
  });

  it('removes and reorders training session payloads for the authenticated user', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const plan: ServerTrainingPlanDetail = {
      id: 'training-plan-1',
      planType: 'training',
      sourceKind: 'self_managed',
      ownerProfessionalUid: null,
      studentUid: 'student-1',
      studentAuthUid: 'student-1',
      isArchived: false,
      isDraft: false,
      name: 'Training',
      sessions: [],
      createdAt: '2026-06-29T10:00:00.000Z',
      updatedAt: '2026-06-29T11:00:00.000Z',
    };
    const app = makeApp({
      async listForAuthUid() {
        throw new Error('not implemented');
      },
      async listPredefinedForOwner() {
        throw new Error('not implemented');
      },
      async removeTrainingSession(input) {
        captured.push({ operation: 'removeSession', ...input });
        return plan;
      },
      async reorderTrainingSessions(input) {
        captured.push({ operation: 'reorderSessions', ...input });
        return plan;
      },
      async removeTrainingSessionItem(input) {
        captured.push({ operation: 'removeItem', ...input });
        return plan;
      },
      async reorderTrainingSessionItems(input) {
        captured.push({ operation: 'reorderItems', ...input });
        return plan;
      },
    });
    const session = await issueSession(app, 'student@example.test', 'Student One');

    const removeSession = await app.handle(
      new Request('http://server.test/plans/training/training-plan-1/sessions/session-1', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );
    const reorderSessions = await app.handle(
      new Request('http://server.test/plans/training/training-plan-1/sessions/reorder', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sessionIds: ['session-2', 'session-1'] }),
      })
    );
    const removeItem = await app.handle(
      new Request('http://server.test/plans/training/training-plan-1/sessions/session-1/items/item-1', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${session.accessToken}` },
      })
    );
    const reorderItems = await app.handle(
      new Request('http://server.test/plans/training/training-plan-1/sessions/session-1/items/reorder', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ itemIds: ['item-2', 'item-1'] }),
      })
    );

    expect(removeSession.status).toBe(200);
    expect(reorderSessions.status).toBe(200);
    expect(removeItem.status).toBe(200);
    expect(reorderItems.status).toBe(200);
    expect(captured).toEqual([
      { operation: 'removeSession', authUid: session.profile.authUid, planId: 'training-plan-1', sessionId: 'session-1' },
      { operation: 'reorderSessions', authUid: session.profile.authUid, planId: 'training-plan-1', sessionIds: ['session-2', 'session-1'] },
      { operation: 'removeItem', authUid: session.profile.authUid, planId: 'training-plan-1', sessionId: 'session-1', itemId: 'item-1' },
      { operation: 'reorderItems', authUid: session.profile.authUid, planId: 'training-plan-1', sessionId: 'session-1', itemIds: ['item-2', 'item-1'] },
    ]);
  });

  it('creates a professional-library training plan for the authenticated user', async () => {
    const captured: {
      authUid: string | null;
      name: string | null;
      mode: 'professional_library' | 'self_managed' | null;
    } = {
      authUid: null,
      name: null,
      mode: null,
    };
    const app = makeApp({
      async listForAuthUid() {
        throw new Error('not implemented');
      },
      async listPredefinedForOwner() {
        throw new Error('not implemented');
      },
      async createTrainingPlanDetail(input) {
        captured.authUid = input.authUid;
        captured.name = input.name;
        captured.mode = input.mode;
        return {
          id: 'training-created-1',
          planType: 'training',
          sourceKind: 'predefined',
          ownerProfessionalUid: input.authUid,
          studentUid: input.authUid,
          studentAuthUid: input.authUid,
          isArchived: false,
          isDraft: false,
          name: input.name,
          sessions: [],
          createdAt: '2026-06-29T10:00:00.000Z',
          updatedAt: '2026-06-29T10:00:00.000Z',
        };
      },
    });
    const session = await issueSession(app, 'professional@example.test', 'Professional One');

    const response = await app.handle(
      new Request('http://server.test/plans/training', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: ' Strength Template ',
          mode: 'professional_library',
        }),
      })
    );

    expect(response.status).toBe(201);
    expect(captured).toEqual({
      authUid: session.profile.authUid,
      name: 'Strength Template',
      mode: 'professional_library',
    });
    await expect(response.json()).resolves.toEqual({
      plan: {
        id: 'training-created-1',
        planType: 'training',
        sourceKind: 'predefined',
        ownerProfessionalUid: session.profile.authUid,
        studentUid: session.profile.authUid,
        studentAuthUid: session.profile.authUid,
        isArchived: false,
        isDraft: false,
        name: 'Strength Template',
        sessions: [],
        createdAt: '2026-06-29T10:00:00.000Z',
        updatedAt: '2026-06-29T10:00:00.000Z',
      },
    });
  });

  it('deletes a nutrition plan for the authenticated user', async () => {
    const captured: { authUid: string | null; planId: string | null } = {
      authUid: null,
      planId: null,
    };
    const app = makeApp({
      async listForAuthUid() {
        throw new Error('not implemented');
      },
      async listPredefinedForOwner() {
        throw new Error('not implemented');
      },
      async deleteNutritionPlan(input) {
        captured.authUid = input.authUid;
        captured.planId = input.planId;
      },
    });
    const session = await issueSession(app, 'student@example.test', 'Student One');

    const response = await app.handle(
      new Request('http://server.test/plans/nutrition/nutrition-plan-1', {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      })
    );

    expect(response.status).toBe(204);
    expect(captured).toEqual({
      authUid: session.profile.authUid,
      planId: 'nutrition-plan-1',
    });
  });

  it('deletes a training plan for the authenticated user', async () => {
    const captured: { authUid: string | null; planId: string | null } = {
      authUid: null,
      planId: null,
    };
    const app = makeApp({
      async listForAuthUid() {
        throw new Error('not implemented');
      },
      async listPredefinedForOwner() {
        throw new Error('not implemented');
      },
      async deleteTrainingPlan(input) {
        captured.authUid = input.authUid;
        captured.planId = input.planId;
      },
    });
    const session = await issueSession(app, 'professional@example.test', 'Professional One');

    const response = await app.handle(
      new Request('http://server.test/plans/training/training-plan-1', {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      })
    );

    expect(response.status).toBe(204);
    expect(captured).toEqual({
      authUid: session.profile.authUid,
      planId: 'training-plan-1',
    });
  });
});
