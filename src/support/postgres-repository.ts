import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, sql } from 'drizzle-orm';

import { supportMessages, type SupportMessageRow } from '../db/schema';
import type {
  CreateSupportMessageInput,
  SupportMessage,
  SupportMessageRepository,
  SupportMessageSubmission,
  SubmitSupportMessageInput,
} from './repository';

type TransactionDb = {
  insert: Function;
  select: Function;
  execute: Function;
};

type Db = TransactionDb & {
  transaction: <T>(callback: (transaction: TransactionDb) => Promise<T>) => Promise<T>;
};

const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1_000;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapSupportMessage(row: SupportMessageRow): SupportMessage {
  return {
    id: row.id,
    authUid: row.authUid,
    userEmail: row.userEmail,
    userName: row.userName,
    userRole: row.userRole,
    subject: row.subject,
    body: row.body,
    status: row.status,
    appVersion: row.appVersion,
    platform: row.platform,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export class PostgresSupportMessageRepository implements SupportMessageRepository {
  constructor(private readonly db: Db) {}

  async create(input: CreateSupportMessageInput): Promise<SupportMessage> {
    const [row] = await this.db
      .insert(supportMessages)
      .values({
        id: randomUUID(),
        ...input,
        status: 'pending',
      })
      .returning();

    return mapSupportMessage(row);
  }

  async submit(input: SubmitSupportMessageInput): Promise<SupportMessageSubmission> {
    return this.db.transaction(async (transaction) => {
      // Serializing per authenticated identity makes the idempotency lookup, quota
      // check, and insert one atomic decision across workers and blue/green slots.
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.authUid}, 0))`,
      );

      const [existing] = await transaction
        .select()
        .from(supportMessages)
        .where(
          and(
            eq(supportMessages.authUid, input.authUid),
            eq(supportMessages.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) return { kind: 'replayed', message: mapSupportMessage(existing) };

      // Capture acceptance time after the lock using the shared database clock.
      // DEFAULT now() is transaction-start time and can predate a lock wait.
      const [clock] = await transaction.execute(sql`SELECT clock_timestamp() AS now`);
      const now = new Date(clock.now);
      const fifteenMinuteStart = new Date(now.getTime() - FIFTEEN_MINUTES_MS);
      const dayStart = new Date(now.getTime() - TWENTY_FOUR_HOURS_MS);
      const recent = await transaction
        .select({ createdAt: supportMessages.createdAt })
        .from(supportMessages)
        .where(
          and(eq(supportMessages.authUid, input.authUid), gt(supportMessages.createdAt, dayStart)),
        )
        .orderBy(asc(supportMessages.createdAt));
      const fifteenMinuteMessages = recent.filter(
        (message: { createdAt: Date | string }) => new Date(message.createdAt) > fifteenMinuteStart,
      );

      const unlockAt = Math.max(
        ...[
          {
            durationMs: FIFTEEN_MINUTES_MS,
            limit: 3,
            messages: fifteenMinuteMessages,
          },
          { durationMs: TWENTY_FOUR_HOURS_MS, limit: 10, messages: recent },
        ].map(({ durationMs, limit, messages }) =>
          messages.length < limit
            ? 0
            : new Date(messages[messages.length - limit].createdAt).getTime() + durationMs,
        ),
      );
      if (unlockAt > now.getTime()) {
        return {
          kind: 'limited',
          retryAfterSeconds: Math.max(1, Math.ceil((unlockAt - now.getTime()) / 1_000)),
        };
      }

      const [row] = await transaction
        .insert(supportMessages)
        .values({
          id: randomUUID(),
          ...input,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return { kind: 'created', message: mapSupportMessage(row) };
    });
  }
}
