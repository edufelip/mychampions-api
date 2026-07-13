import { randomUUID } from 'node:crypto';

import { and, desc, eq, gte } from 'drizzle-orm';

import { portionLogs, type PortionLogRow } from '../db/schema';
import type {
  CreatePortionLogInput,
  ListPortionLogsSinceInput,
  PortionLog,
  PortionLogRepository,
} from './portion-log-repository';

type Db = {
  select: Function;
  insert: Function;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapPortionLog(row: PortionLogRow): PortionLog {
  return {
    id: row.id,
    ownerAuthUid: row.ownerAuthUid,
    mealId: row.mealId,
    consumedGrams: row.consumedGrams,
    snapshot: {
      calories: row.snapshotCalories,
      carbs: row.snapshotCarbs,
      proteins: row.snapshotProteins,
      fats: row.snapshotFats,
    },
    loggedAt: toIso(row.loggedAt),
    planId: row.planId,
    planType: row.planType,
    sourceKind: row.sourceKind,
    ownerProfessionalUid: row.ownerProfessionalUid,
    connectionId: row.connectionId,
  };
}

export class PostgresPortionLogRepository implements PortionLogRepository {
  constructor(private readonly db: Db) {}

  async create(input: CreatePortionLogInput): Promise<PortionLog> {
    const [row] = await this.db
      .insert(portionLogs)
      .values({
        id: randomUUID(),
        ownerAuthUid: input.ownerAuthUid,
        mealId: input.mealId,
        consumedGrams: input.consumedGrams,
        snapshotCalories: input.snapshot.calories,
        snapshotCarbs: input.snapshot.carbs,
        snapshotProteins: input.snapshot.proteins,
        snapshotFats: input.snapshot.fats,
        loggedAt: new Date(),
        planId: input.planId ?? null,
        planType: input.planType ?? null,
        sourceKind: input.sourceKind ?? null,
        ownerProfessionalUid: input.ownerProfessionalUid ?? null,
        connectionId: input.connectionId ?? null,
      })
      .returning();

    return mapPortionLog(row);
  }

  async listSince(input: ListPortionLogsSinceInput): Promise<PortionLog[]> {
    const from = new Date(input.fromIso);
    const rows = await this.db
      .select()
      .from(portionLogs)
      .where(
        and(
          eq(portionLogs.ownerAuthUid, input.ownerAuthUid),
          gte(portionLogs.loggedAt, from)
        )
      )
      .orderBy(desc(portionLogs.loggedAt));

    return rows.map(mapPortionLog);
  }
}
