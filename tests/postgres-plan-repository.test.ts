import { afterAll, beforeEach, describe, expect, it } from 'bun:test';

import { createDatabase } from '../src/db/client';
import { ProfessionalSubscriptionRequiredError } from '../src/connections/repository';
import { PlanAssignmentTargetError } from '../src/plans/plan-repository';
import { PostgresPlanRepository } from '../src/plans/postgres-plan-repository';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_server_local';

const database = createDatabase(databaseUrl);
const repository = new PostgresPlanRepository(database.db);

beforeEach(async () => {
  await database.client`truncate table nutrition_plans, training_plans, connections, subscription_entitlement_snapshots`;
});

afterAll(async () => {
  await database.close();
});

describe('PostgresPlanRepository', () => {
  async function seedActiveStudentsForProfessional(count: number) {
    for (let index = 1; index <= count; index += 1) {
      await database.client`
        insert into connections (
          id,
          status,
          canceled_reason,
          specialty,
          professional_auth_uid,
          student_auth_uid,
          source_invite_code_id,
          source_invite_code_value,
          created_at,
          updated_at,
          ended_at
        ) values (
          ${`active-${index}`},
          'active',
          null,
          'nutritionist',
          'professional-1',
          ${`student-${index}`},
          'nutritionist',
          'NUT123',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          null
        )
      `;
    }
  }

  async function seedAssignedNutritionPlan() {
    await database.client`
      insert into nutrition_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        hydration_goal_ml,
        calories_target,
        carbs_target,
        proteins_target,
        fats_target,
        meals,
        created_at,
        updated_at
      ) values (
        'assigned-nutrition-over-cap',
        'student-11',
        'professional-1',
        'assigned',
        false,
        true,
        'Draft Nutrition',
        2400,
        0,
        0,
        0,
        0,
        '[]'::jsonb,
        '2026-06-29T10:00:00.000Z',
        '2026-06-29T10:00:00.000Z'
      )
    `;
  }

  it('lists visible nutrition and training plans for the authenticated user newest first', async () => {
    await database.client`
      insert into nutrition_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        hydration_goal_ml,
        calories_target,
        carbs_target,
        proteins_target,
        fats_target,
        created_at,
        updated_at
      ) values
        (
          'nutrition-visible',
          'student-1',
          'professional-1',
          'assigned',
          false,
          false,
          'High Protein',
          2800,
          2200,
          210,
          160,
          70,
          '2026-06-28T10:00:00.000Z',
          '2026-06-29T10:00:00.000Z'
        ),
        (
          'nutrition-hidden-draft',
          'student-1',
          'professional-1',
          'assigned',
          false,
          true,
          'Hidden Draft',
          3000,
          null,
          null,
          null,
          null,
          '2026-06-28T11:00:00.000Z',
          '2026-06-29T11:00:00.000Z'
        ),
        (
          'nutrition-archived',
          'student-1',
          null,
          'self_managed',
          true,
          false,
          'Archived',
          2400,
          null,
          null,
          null,
          null,
          '2026-06-28T12:00:00.000Z',
          '2026-06-29T12:00:00.000Z'
        )
    `;
    await database.client`
      insert into training_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        created_at,
        updated_at
      ) values
        (
          'training-visible',
          'student-1',
          null,
          'self_managed',
          false,
          false,
          'Upper Strength',
          '2026-06-27T10:00:00.000Z',
          '2026-06-28T10:00:00.000Z'
        ),
        (
          'training-other',
          'student-2',
          null,
          'self_managed',
          false,
          false,
          'Other Student',
          '2026-06-27T10:00:00.000Z',
          '2026-06-28T10:00:00.000Z'
        )
    `;

    const plans = await repository.listForAuthUid({ authUid: 'student-1' });

    expect(plans.map((plan) => plan.id)).toEqual(['nutrition-visible', 'training-visible']);
    expect(plans[0]).toMatchObject({
      id: 'nutrition-visible',
      planType: 'nutrition',
      hydrationGoalMl: 2800,
      caloriesTarget: 2200,
      carbsTarget: 210,
      proteinsTarget: 160,
      fatsTarget: 70,
    });
    expect(plans[1]).toMatchObject({
      id: 'training-visible',
      planType: 'training',
      name: 'Upper Strength',
    });
  });

  it('lists predefined plans owned by the authenticated professional newest first', async () => {
    await database.client`
      insert into nutrition_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        created_at,
        updated_at
      ) values
        (
          'nutrition-template',
          'professional-1',
          'professional-1',
          'predefined',
          false,
          false,
          'Nutrition Template',
          '2026-06-26T10:00:00.000Z',
          '2026-06-28T10:00:00.000Z'
        ),
        (
          'nutrition-assigned',
          'student-1',
          'professional-1',
          'assigned',
          false,
          false,
          'Assigned',
          '2026-06-26T10:00:00.000Z',
          '2026-06-29T10:00:00.000Z'
        )
    `;
    await database.client`
      insert into training_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        created_at,
        updated_at
      ) values
        (
          'training-template',
          'professional-1',
          'professional-1',
          'predefined',
          false,
          false,
          'Training Template',
          '2026-06-27T10:00:00.000Z',
          '2026-06-29T10:00:00.000Z'
        ),
        (
          'training-template-other',
          'professional-2',
          'professional-2',
          'predefined',
          false,
          false,
          'Other Template',
          '2026-06-27T10:00:00.000Z',
          '2026-06-30T10:00:00.000Z'
        )
    `;

    const plans = await repository.listPredefinedForOwner({ ownerProfessionalUid: 'professional-1' });

    expect(plans.map((plan) => plan.id)).toEqual(['training-template', 'nutrition-template']);
  });

  it('bulk assigns a nutrition predefined plan to active nutritionist students', async () => {
    await database.client`
      insert into connections (
        id,
        status,
        specialty,
        professional_auth_uid,
        student_auth_uid,
        created_at,
        updated_at
      ) values
        (
          'connection-1',
          'active',
          'nutritionist',
          'professional-1',
          'student-1',
          '2026-06-28T10:00:00.000Z',
          '2026-06-28T10:00:00.000Z'
        ),
        (
          'connection-2',
          'active',
          'nutritionist',
          'professional-1',
          'student-2',
          '2026-06-28T10:00:00.000Z',
          '2026-06-28T10:00:00.000Z'
        )
    `;
    await database.client`
      insert into nutrition_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        hydration_goal_ml,
        calories_target,
        carbs_target,
        proteins_target,
        fats_target,
        created_at,
        updated_at
      ) values (
        'nutrition-template',
        'professional-1',
        'professional-1',
        'predefined',
        false,
        false,
        'Balanced Template',
        2800,
        2200,
        210,
        160,
        70,
        '2026-06-28T10:00:00.000Z',
        '2026-06-28T10:00:00.000Z'
      )
    `;

    const result = await repository.bulkAssignPredefined({
      professionalAuthUid: 'professional-1',
      predefinedPlanId: 'nutrition-template',
      studentUids: ['student-1', 'student-2', 'student-2'],
    });

    expect(result).toEqual({ assignedCount: 2 });
    const rows = await database.client`
      select
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        hydration_goal_ml,
        calories_target,
        carbs_target,
        proteins_target,
        fats_target
      from nutrition_plans
      where source_kind = 'assigned'
      order by student_auth_uid
    `;
    expect(rows.map((row) => ({
      studentAuthUid: row.student_auth_uid,
      ownerProfessionalUid: row.owner_professional_uid,
      sourceKind: row.source_kind,
      isArchived: row.is_archived,
      isDraft: row.is_draft,
      name: row.name,
      hydrationGoalMl: row.hydration_goal_ml,
      caloriesTarget: row.calories_target,
      carbsTarget: row.carbs_target,
      proteinsTarget: row.proteins_target,
      fatsTarget: row.fats_target,
    }))).toEqual([
      {
        studentAuthUid: 'student-1',
        ownerProfessionalUid: 'professional-1',
        sourceKind: 'assigned',
        isArchived: false,
        isDraft: false,
        name: 'Balanced Template',
        hydrationGoalMl: 2800,
        caloriesTarget: 2200,
        carbsTarget: 210,
        proteinsTarget: 160,
        fatsTarget: 70,
      },
      {
        studentAuthUid: 'student-2',
        ownerProfessionalUid: 'professional-1',
        sourceKind: 'assigned',
        isArchived: false,
        isDraft: false,
        name: 'Balanced Template',
        hydrationGoalMl: 2800,
        caloriesTarget: 2200,
        carbsTarget: 210,
        proteinsTarget: 160,
        fatsTarget: 70,
      },
    ]);
    expect(rows.every((row) => row.id !== 'nutrition-template')).toBe(true);
  });

  it('creates a draft assigned nutrition plan from a predefined plan for an active nutritionist student', async () => {
    await database.client`
      insert into connections (
        id,
        status,
        specialty,
        professional_auth_uid,
        student_auth_uid,
        created_at,
        updated_at
      ) values (
        'connection-1',
        'active',
        'nutritionist',
        'professional-1',
        'student-1',
        '2026-06-28T10:00:00.000Z',
        '2026-06-28T10:00:00.000Z'
      )
    `;
    await database.client`
      insert into nutrition_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        hydration_goal_ml,
        calories_target,
        carbs_target,
        proteins_target,
        fats_target,
        created_at,
        updated_at
      ) values (
        'nutrition-template',
        'professional-1',
        'professional-1',
        'predefined',
        false,
        false,
        'Balanced Template',
        2800,
        2200,
        210,
        160,
        70,
        '2026-06-28T10:00:00.000Z',
        '2026-06-28T10:00:00.000Z'
      )
    `;

    const plan = await repository.createDraftAssignedFromPredefined({
      professionalAuthUid: 'professional-1',
      predefinedPlanId: 'nutrition-template',
      studentUid: 'student-1',
    });

    expect(plan).toMatchObject({
      planType: 'nutrition',
      sourceKind: 'assigned',
      ownerProfessionalUid: 'professional-1',
      studentUid: 'student-1',
      isArchived: false,
      isDraft: true,
      name: 'Balanced Template',
      hydrationGoalMl: 2800,
      caloriesTarget: 2200,
      carbsTarget: 210,
      proteinsTarget: 160,
      fatsTarget: 70,
    });
    expect(plan.id).not.toBe('nutrition-template');

    const rows = await database.client`
      select
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        hydration_goal_ml,
        calories_target,
        carbs_target,
        proteins_target,
        fats_target
      from nutrition_plans
      where source_kind = 'assigned'
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: plan.id,
      student_auth_uid: 'student-1',
      owner_professional_uid: 'professional-1',
      source_kind: 'assigned',
      is_archived: false,
      is_draft: true,
      name: 'Balanced Template',
      hydration_goal_ml: 2800,
      calories_target: 2200,
      carbs_target: 210,
      proteins_target: 160,
      fats_target: 70,
    });
  });

  it('loads nutrition plan detail with persisted meals for the owner professional', async () => {
    await database.client`
      insert into nutrition_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        hydration_goal_ml,
        calories_target,
        carbs_target,
        proteins_target,
        fats_target,
        meals,
        created_at,
        updated_at
      ) values (
        'nutrition-detail',
        'student-1',
        'professional-1',
        'assigned',
        false,
        true,
        'Draft Nutrition',
        2800,
        2200,
        210,
        160,
        70,
        ${JSON.stringify([
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
        ])}::jsonb,
        '2026-06-29T10:00:00.000Z',
        '2026-06-29T11:00:00.000Z'
      )
    `;

    const plan = await repository.getNutritionPlanDetail({
      authUid: 'professional-1',
      planId: 'nutrition-detail',
    });

    expect(plan).toMatchObject({
      id: 'nutrition-detail',
      planType: 'nutrition',
      sourceKind: 'assigned',
      ownerProfessionalUid: 'professional-1',
      studentAuthUid: 'student-1',
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
    });
  });

  it('requires an active professional entitlement before editing an assigned student nutrition plan while over cap', async () => {
    await seedActiveStudentsForProfessional(11);
    await seedAssignedNutritionPlan();

    await expect(repository.updateNutritionPlanDetail({
      authUid: 'professional-1',
      planId: 'assigned-nutrition-over-cap',
      name: 'Updated Nutrition',
      hydrationGoalMl: 2600,
      publish: true,
    })).rejects.toBeInstanceOf(ProfessionalSubscriptionRequiredError);

    const [row] = await database.client`
      select name, hydration_goal_ml, is_draft
      from nutrition_plans
      where id = 'assigned-nutrition-over-cap'
    `;
    expect(row).toMatchObject({
      name: 'Draft Nutrition',
      hydration_goal_ml: 2400,
      is_draft: true,
    });
  });

  it('allows editing an assigned student nutrition plan while over cap when professional entitlement is active', async () => {
    await seedActiveStudentsForProfessional(11);
    await seedAssignedNutritionPlan();
    await database.client`
      insert into subscription_entitlement_snapshots (
        auth_uid,
        professional_entitlement_status,
        ai_entitlement_status,
        active_student_count,
        source,
        observed_at,
        updated_at
      ) values (
        'professional-1',
        'active',
        'lapsed',
        11,
        'revenuecat',
        '2026-07-03T16:45:00.000Z',
        '2026-07-03T16:45:00.000Z'
      )
    `;

    const plan = await repository.updateNutritionPlanDetail({
      authUid: 'professional-1',
      planId: 'assigned-nutrition-over-cap',
      name: 'Updated Nutrition',
      hydrationGoalMl: 2600,
      publish: true,
    });

    expect(plan).toMatchObject({
      id: 'assigned-nutrition-over-cap',
      name: 'Updated Nutrition',
      hydrationGoalMl: 2600,
      isDraft: false,
    });
  });

  it('requires an active professional entitlement before mutating assigned student training sessions while over cap', async () => {
    await seedActiveStudentsForProfessional(11);
    await database.client`
      insert into training_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        sessions,
        created_at,
        updated_at
      ) values (
        'assigned-training-over-cap',
        'student-11',
        'professional-1',
        'assigned',
        false,
        true,
        'Draft Training',
        '[]'::jsonb,
        '2026-06-29T10:00:00.000Z',
        '2026-06-29T10:00:00.000Z'
      )
    `;

    await expect(repository.addTrainingSession({
      authUid: 'professional-1',
      planId: 'assigned-training-over-cap',
      name: 'Upper A',
      notes: 'Controlled tempo',
    })).rejects.toBeInstanceOf(ProfessionalSubscriptionRequiredError);

    const [row] = await database.client`
      select sessions
      from training_plans
      where id = 'assigned-training-over-cap'
    `;
    expect(row.sessions).toEqual([]);
  });

  it('stores training sessions and publishes a draft for the owner professional', async () => {
    await database.client`
      insert into training_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        sessions,
        created_at,
        updated_at
      ) values (
        'training-detail',
        'student-1',
        'professional-1',
        'assigned',
        false,
        true,
        'Draft Training',
        '[]'::jsonb,
        '2026-06-29T10:00:00.000Z',
        '2026-06-29T10:00:00.000Z'
      )
    `;

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

    const plan = await repository.updateTrainingPlanDetail({
      authUid: 'professional-1',
      planId: 'training-detail',
      name: 'Upper A',
      publish: true,
      sessions,
    });

    expect(plan).toMatchObject({
      id: 'training-detail',
      planType: 'training',
      sourceKind: 'assigned',
      ownerProfessionalUid: 'professional-1',
      studentAuthUid: 'student-1',
      isArchived: false,
      isDraft: false,
      name: 'Upper A',
      sessions,
    });

    const rows = await database.client`
      select name, is_draft, sessions
      from training_plans
      where id = 'training-detail'
    `;
    expect(rows[0]).toMatchObject({
      name: 'Upper A',
      is_draft: false,
      sessions,
    });
  });

  it('creates a self-managed nutrition plan with empty builder payloads', async () => {
    const plan = await repository.createNutritionPlanDetail({
      authUid: 'student-1',
      name: ' New Nutrition ',
      hydrationGoalMl: 2600,
      mode: 'self_managed',
    });

    expect(plan).toMatchObject({
      planType: 'nutrition',
      sourceKind: 'self_managed',
      ownerProfessionalUid: null,
      studentAuthUid: 'student-1',
      studentUid: 'student-1',
      isArchived: false,
      isDraft: false,
      name: 'New Nutrition',
      hydrationGoalMl: 2600,
      caloriesTarget: 0,
      carbsTarget: 0,
      proteinsTarget: 0,
      fatsTarget: 0,
      meals: [],
    });
    expect(plan.id).toStartWith('nutrition_plan_');

    const rows = await database.client`
      select
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        hydration_goal_ml,
        calories_target,
        carbs_target,
        proteins_target,
        fats_target,
        meals
      from nutrition_plans
      where id = ${plan.id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: plan.id,
      student_auth_uid: 'student-1',
      owner_professional_uid: null,
      source_kind: 'self_managed',
      is_archived: false,
      is_draft: false,
      name: 'New Nutrition',
      hydration_goal_ml: 2600,
      calories_target: 0,
      carbs_target: 0,
      proteins_target: 0,
      fats_target: 0,
      meals: [],
    });
  });

  it('creates a professional-library training plan with empty sessions', async () => {
    const plan = await repository.createTrainingPlanDetail({
      authUid: 'professional-1',
      name: ' Strength Template ',
      mode: 'professional_library',
    });

    expect(plan).toMatchObject({
      planType: 'training',
      sourceKind: 'predefined',
      ownerProfessionalUid: 'professional-1',
      studentAuthUid: 'professional-1',
      studentUid: 'professional-1',
      isArchived: false,
      isDraft: false,
      name: 'Strength Template',
      sessions: [],
    });
    expect(plan.id).toStartWith('training_plan_');

    const rows = await database.client`
      select
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        sessions
      from training_plans
      where id = ${plan.id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: plan.id,
      student_auth_uid: 'professional-1',
      owner_professional_uid: 'professional-1',
      source_kind: 'predefined',
      is_archived: false,
      is_draft: false,
      name: 'Strength Template',
      sessions: [],
    });
  });

  it('adds nutrition meals and meal items while recalculating totals', async () => {
    await database.client`
      insert into nutrition_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        hydration_goal_ml,
        meals,
        created_at,
        updated_at
      ) values (
        'nutrition-meal-mutations',
        'student-1',
        null,
        'self_managed',
        false,
        false,
        'Self Nutrition',
        2400,
        '[]'::jsonb,
        '2026-06-29T10:00:00.000Z',
        '2026-06-29T10:00:00.000Z'
      )
    `;

    const meal = await repository.addNutritionMeal({
      authUid: 'student-1',
      planId: 'nutrition-meal-mutations',
      name: ' Breakfast ',
    });
    const item = await repository.addNutritionMealItem({
      authUid: 'student-1',
      planId: 'nutrition-meal-mutations',
      mealId: meal.id,
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

    expect(meal).toMatchObject({
      name: 'Breakfast',
      items: [],
    });
    expect(meal.id).toStartWith('nutrition_meal_');
    expect(item).toMatchObject({
      name: 'Greek Yogurt',
      quantity: '200 g',
      notes: 'Add berries',
      calories: 180,
      carbs: 18,
      proteins: 22,
      fats: 2,
      sourceKind: 'manual',
    });
    expect(item.id).toStartWith('nutrition_item_');

    const [row] = await database.client`
      select
        calories_target,
        carbs_target,
        proteins_target,
        fats_target,
        meals
      from nutrition_plans
      where id = 'nutrition-meal-mutations'
    `;
    expect(row).toMatchObject({
      calories_target: 180,
      carbs_target: 18,
      proteins_target: 22,
      fats_target: 2,
      meals: [
        {
          id: meal.id,
          name: 'Breakfast',
          items: [
            {
              id: item.id,
              name: 'Greek Yogurt',
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
    });
  });

  it('removes and reorders nutrition meal payloads while recalculating totals', async () => {
    await database.client`
      insert into nutrition_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        hydration_goal_ml,
        calories_target,
        carbs_target,
        proteins_target,
        fats_target,
        meals,
        created_at,
        updated_at
      ) values (
        'nutrition-meal-reorder',
        'student-1',
        null,
        'self_managed',
        false,
        false,
        'Self Nutrition',
        2400,
        300,
        30,
        40,
        8,
        ${JSON.stringify([
          {
            id: 'meal-1',
            name: 'Breakfast',
            items: [
              { id: 'item-1', name: 'Oats', quantity: '1 bowl', notes: '', calories: 120, carbs: 20, proteins: 5, fats: 3 },
              { id: 'item-2', name: 'Eggs', quantity: '2', notes: '', calories: 180, carbs: 2, proteins: 14, fats: 10 },
            ],
          },
          {
            id: 'meal-2',
            name: 'Lunch',
            items: [
              { id: 'item-3', name: 'Chicken', quantity: '150 g', notes: '', calories: 220, carbs: 0, proteins: 35, fats: 6 },
            ],
          },
        ])}::jsonb,
        '2026-06-29T10:00:00.000Z',
        '2026-06-29T10:00:00.000Z'
      )
    `;

    await repository.reorderNutritionMeals({
      authUid: 'student-1',
      planId: 'nutrition-meal-reorder',
      mealIds: ['meal-2', 'meal-1'],
    });
    await repository.reorderNutritionMealItems({
      authUid: 'student-1',
      planId: 'nutrition-meal-reorder',
      mealId: 'meal-1',
      itemIds: ['item-2', 'item-1'],
    });
    await repository.removeNutritionMealItem({
      authUid: 'student-1',
      planId: 'nutrition-meal-reorder',
      mealId: 'meal-1',
      itemId: 'item-1',
    });
    await repository.removeNutritionMeal({
      authUid: 'student-1',
      planId: 'nutrition-meal-reorder',
      mealId: 'meal-2',
    });

    const [row] = await database.client`
      select
        calories_target,
        carbs_target,
        proteins_target,
        fats_target,
        meals
      from nutrition_plans
      where id = 'nutrition-meal-reorder'
    `;
    expect(row).toMatchObject({
      calories_target: 180,
      carbs_target: 2,
      proteins_target: 14,
      fats_target: 10,
      meals: [
        {
          id: 'meal-1',
          name: 'Breakfast',
          items: [
            { id: 'item-2', name: 'Eggs', quantity: '2', notes: '', calories: 180, carbs: 2, proteins: 14, fats: 10 },
          ],
        },
      ],
    });
  });

  it('adds training sessions and session items into the plan payload', async () => {
    await database.client`
      insert into training_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        sessions,
        created_at,
        updated_at
      ) values (
        'training-session-mutations',
        'student-1',
        null,
        'self_managed',
        false,
        false,
        'Self Training',
        '[]'::jsonb,
        '2026-06-29T10:00:00.000Z',
        '2026-06-29T10:00:00.000Z'
      )
    `;

    const session = await repository.addTrainingSession({
      authUid: 'student-1',
      planId: 'training-session-mutations',
      name: ' Upper A ',
      notes: ' Controlled tempo ',
    });
    const item = await repository.addTrainingSessionItem({
      authUid: 'student-1',
      planId: 'training-session-mutations',
      sessionId: session.id,
      item: {
        name: 'Bench Press',
        quantity: '3x8',
        notes: 'RPE 8',
        exerciseId: 'exercise-catalog-1',
      },
    });

    expect(session).toMatchObject({
      name: 'Upper A',
      notes: 'Controlled tempo',
      items: [],
    });
    expect(session.id).toStartWith('training_session_');
    expect(item).toMatchObject({
      name: 'Bench Press',
      quantity: '3x8',
      notes: 'RPE 8',
      exerciseId: 'exercise-catalog-1',
    });
    expect(item.id).toStartWith('training_item_');

    const [row] = await database.client`
      select sessions
      from training_plans
      where id = 'training-session-mutations'
    `;
    expect(row.sessions).toEqual([
      {
        id: session.id,
        name: 'Upper A',
        notes: 'Controlled tempo',
        items: [
          {
            id: item.id,
            name: 'Bench Press',
            quantity: '3x8',
            notes: 'RPE 8',
            exerciseId: 'exercise-catalog-1',
          },
        ],
      },
    ]);
  });

  it('removes and reorders training session payloads', async () => {
    await database.client`
      insert into training_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        sessions,
        created_at,
        updated_at
      ) values (
        'training-session-reorder',
        'student-1',
        null,
        'self_managed',
        false,
        false,
        'Self Training',
        ${JSON.stringify([
          {
            id: 'session-1',
            name: 'Upper A',
            notes: 'Tempo',
            items: [
              { id: 'item-1', name: 'Bench Press', quantity: '3x8', notes: 'RPE 8', exerciseId: 'exercise-1' },
              { id: 'item-2', name: 'Row', quantity: '3x10', notes: 'Strict', exerciseId: 'exercise-2' },
            ],
          },
          {
            id: 'session-2',
            name: 'Lower A',
            notes: 'Heavy',
            items: [
              { id: 'item-3', name: 'Squat', quantity: '5x5', notes: 'RPE 7', exerciseId: 'exercise-3' },
            ],
          },
        ])}::jsonb,
        '2026-06-29T10:00:00.000Z',
        '2026-06-29T10:00:00.000Z'
      )
    `;

    await repository.reorderTrainingSessions({
      authUid: 'student-1',
      planId: 'training-session-reorder',
      sessionIds: ['session-2', 'session-1'],
    });
    await repository.reorderTrainingSessionItems({
      authUid: 'student-1',
      planId: 'training-session-reorder',
      sessionId: 'session-1',
      itemIds: ['item-2', 'item-1'],
    });
    await repository.removeTrainingSessionItem({
      authUid: 'student-1',
      planId: 'training-session-reorder',
      sessionId: 'session-1',
      itemId: 'item-1',
    });
    await repository.removeTrainingSession({
      authUid: 'student-1',
      planId: 'training-session-reorder',
      sessionId: 'session-2',
    });

    const [row] = await database.client`
      select sessions
      from training_plans
      where id = 'training-session-reorder'
    `;
    expect(row.sessions).toEqual([
      {
        id: 'session-1',
        name: 'Upper A',
        notes: 'Tempo',
        items: [
          { id: 'item-2', name: 'Row', quantity: '3x10', notes: 'Strict', exerciseId: 'exercise-2' },
        ],
      },
    ]);
  });

  it('archives a self-managed nutrition plan when deleted by its student', async () => {
    await database.client`
      insert into nutrition_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        meals,
        created_at,
        updated_at
      ) values (
        'nutrition-owned-delete',
        'student-1',
        null,
        'self_managed',
        false,
        false,
        'Self Nutrition',
        '[]'::jsonb,
        '2026-06-29T10:00:00.000Z',
        '2026-06-29T10:00:00.000Z'
      )
    `;

    await repository.deleteNutritionPlan({
      authUid: 'student-1',
      planId: 'nutrition-owned-delete',
    });

    const rows = await database.client`
      select is_archived, updated_at
      from nutrition_plans
      where id = 'nutrition-owned-delete'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].is_archived).toBe(true);
    expect(new Date(rows[0].updated_at).toISOString()).not.toBe('2026-06-29T10:00:00.000Z');
  });

  it('archives an owned training plan when deleted', async () => {
    await database.client`
      insert into training_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        sessions,
        created_at,
        updated_at
      ) values (
        'training-owned-delete',
        'student-1',
        'professional-1',
        'assigned',
        false,
        false,
        'Assigned Training',
        '[]'::jsonb,
        '2026-06-29T10:00:00.000Z',
        '2026-06-29T10:00:00.000Z'
      )
    `;

    await repository.deleteTrainingPlan({
      authUid: 'professional-1',
      planId: 'training-owned-delete',
    });

    const rows = await database.client`
      select is_archived, updated_at
      from training_plans
      where id = 'training-owned-delete'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].is_archived).toBe(true);
    expect(new Date(rows[0].updated_at).toISOString()).not.toBe('2026-06-29T10:00:00.000Z');
  });

  it('rejects bulk assignment targets without an active required-specialty connection', async () => {
    await database.client`
      insert into connections (
        id,
        status,
        specialty,
        professional_auth_uid,
        student_auth_uid,
        created_at,
        updated_at
      ) values (
        'connection-1',
        'active',
        'fitness_coach',
        'professional-1',
        'student-1',
        '2026-06-28T10:00:00.000Z',
        '2026-06-28T10:00:00.000Z'
      )
    `;
    await database.client`
      insert into nutrition_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        created_at,
        updated_at
      ) values (
        'nutrition-template',
        'professional-1',
        'professional-1',
        'predefined',
        false,
        false,
        'Balanced Template',
        '2026-06-28T10:00:00.000Z',
        '2026-06-28T10:00:00.000Z'
      )
    `;

    await expect(repository.bulkAssignPredefined({
      professionalAuthUid: 'professional-1',
      predefinedPlanId: 'nutrition-template',
      studentUids: ['student-1', 'student-2'],
    })).rejects.toMatchObject({
      constructor: PlanAssignmentTargetError,
      requiredSpecialty: 'nutritionist',
      invalidStudentUids: ['student-1', 'student-2'],
    });
  });
});
