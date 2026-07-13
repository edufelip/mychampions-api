import { randomUUID } from 'node:crypto';

import { analyticsEvents, type AnalyticsEventRow } from '../db/schema';
import type {
  AnalyticsEvent,
  AnalyticsEventRepository,
  CreateAnalyticsEventInput,
} from './repository';

type Db = {
  insert: Function;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeProperties(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mapAnalyticsEvent(row: AnalyticsEventRow): AnalyticsEvent {
  return {
    id: row.id,
    name: row.name,
    properties: normalizeProperties(row.properties),
    createdAt: toIso(row.createdAt),
  };
}

export class PostgresAnalyticsEventRepository implements AnalyticsEventRepository {
  constructor(private readonly db: Db) {}

  async create(input: CreateAnalyticsEventInput): Promise<AnalyticsEvent> {
    const [row] = await this.db
      .insert(analyticsEvents)
      .values({
        id: randomUUID(),
        name: input.name,
        properties: input.properties,
      })
      .returning();

    return mapAnalyticsEvent(row);
  }
}
