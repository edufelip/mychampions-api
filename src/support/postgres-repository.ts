import { randomUUID } from 'node:crypto';

import { supportMessages, type SupportMessageRow } from '../db/schema';
import type {
  CreateSupportMessageInput,
  SupportMessage,
  SupportMessageRepository,
} from './repository';

type Db = {
  insert: Function;
};

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
}
