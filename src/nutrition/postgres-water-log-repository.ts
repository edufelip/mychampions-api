import { and, desc, eq, sql } from 'drizzle-orm';

import { connections, nutritionPlans, waterLogs, type NutritionPlanRow, type WaterLogRow } from '../db/schema';
import type {
  GetWaterGoalContextInput,
  ListWaterLogsInput,
  LogWaterIntakeInput,
  WaterGoalContext,
  WaterLog,
  WaterLogRepository,
} from './water-log-repository';

type Db = {
  select: Function;
  insert: Function;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapWaterLog(row: WaterLogRow): WaterLog {
  return {
    id: row.id,
    ownerAuthUid: row.ownerAuthUid,
    dateKey: row.dateKey,
    totalMl: row.totalMl,
    loggedAt: toIso(row.loggedAt),
  };
}

function isPositiveGoal(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function latestGoal(
  plans: NutritionPlanRow[],
  predicate: (plan: NutritionPlanRow) => boolean
): number | null {
  const plan = plans.find((candidate) => predicate(candidate) && isPositiveGoal(candidate.hydrationGoalMl));
  return plan?.hydrationGoalMl ?? null;
}

export class PostgresWaterLogRepository implements WaterLogRepository {
  constructor(private readonly db: Db) {}

  async logIntake(input: LogWaterIntakeInput): Promise<WaterLog> {
    const id = `${input.ownerAuthUid}_${input.dateKey}`;
    const [row] = await this.db
      .insert(waterLogs)
      .values({
        id,
        ownerAuthUid: input.ownerAuthUid,
        dateKey: input.dateKey,
        totalMl: input.amountMl,
        loggedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: waterLogs.id,
        set: {
          totalMl: sql`${waterLogs.totalMl} + ${input.amountMl}`,
          loggedAt: new Date(),
        },
      })
      .returning();

    return mapWaterLog(row);
  }

  async listForOwner(input: ListWaterLogsInput): Promise<WaterLog[]> {
    const rows = await this.db
      .select()
      .from(waterLogs)
      .where(eq(waterLogs.ownerAuthUid, input.ownerAuthUid))
      .orderBy(desc(waterLogs.dateKey));

    return rows.map(mapWaterLog);
  }

  async getGoalContext(input: GetWaterGoalContextInput): Promise<WaterGoalContext> {
    const [plans, activeAssignments] = await Promise.all([
      this.db
        .select()
        .from(nutritionPlans)
        .where(
          and(
            eq(nutritionPlans.studentAuthUid, input.ownerAuthUid),
            eq(nutritionPlans.isArchived, false)
          )
        )
        .orderBy(desc(nutritionPlans.updatedAt)),
      this.db
        .select({ professionalAuthUid: connections.professionalAuthUid })
        .from(connections)
        .where(
          and(
            eq(connections.studentAuthUid, input.ownerAuthUid),
            eq(connections.specialty, 'nutritionist'),
            eq(connections.status, 'active')
          )
        ),
    ]);

    const activeNutritionistUids = new Set<string>(
      activeAssignments
        .map((assignment: { professionalAuthUid: string }) => assignment.professionalAuthUid)
        .filter((value: string) => value.length > 0)
    );
    const nutritionistGoalMl = latestGoal(
      plans,
      (plan) =>
        plan.sourceKind === 'assigned' &&
        typeof plan.ownerProfessionalUid === 'string' &&
        activeNutritionistUids.has(plan.ownerProfessionalUid)
    );
    const studentGoalMl =
      latestGoal(plans, (plan) => plan.sourceKind === 'self_managed') ??
      latestGoal(
        plans,
        (plan) => plan.sourceKind === 'predefined' && plan.ownerProfessionalUid === input.ownerAuthUid
      );

    return {
      studentGoalMl,
      nutritionistGoalMl,
      hasActiveNutritionistAssignment: nutritionistGoalMl !== null,
    };
  }
}
