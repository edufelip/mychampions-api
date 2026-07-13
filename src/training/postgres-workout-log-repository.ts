import { randomUUID } from 'node:crypto';

import { and, asc, eq, gte } from 'drizzle-orm';

import { workoutLogs, type WorkoutLogRow } from '../db/schema';
import type {
  CreateWorkoutLogInput,
  ListWorkoutLogsSinceInput,
  WorkoutLog,
  WorkoutLogRepository,
} from './workout-log-repository';

type Db = {
  select: Function;
  insert: Function;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapWorkoutLog(row: WorkoutLogRow): WorkoutLog {
  return {
    id: row.id,
    ownerAuthUid: row.ownerAuthUid,
    sessionId: row.sessionId,
    sessionName: row.sessionName,
    createdAt: toIso(row.createdAt),
  };
}

export class PostgresWorkoutLogRepository implements WorkoutLogRepository {
  constructor(private readonly db: Db) {}

  async create(input: CreateWorkoutLogInput): Promise<WorkoutLog> {
    const [row] = await this.db
      .insert(workoutLogs)
      .values({
        id: randomUUID(),
        ownerAuthUid: input.ownerAuthUid,
        sessionId: input.sessionId,
        sessionName: input.sessionName,
        createdAt: new Date(),
      })
      .returning();

    return mapWorkoutLog(row);
  }

  async listSince(input: ListWorkoutLogsSinceInput): Promise<WorkoutLog[]> {
    const from = new Date(input.fromIso);
    const rows = await this.db
      .select()
      .from(workoutLogs)
      .where(
        and(
          eq(workoutLogs.ownerAuthUid, input.ownerAuthUid),
          gte(workoutLogs.createdAt, from)
        )
      )
      .orderBy(asc(workoutLogs.createdAt));

    return rows.map(mapWorkoutLog);
  }
}
