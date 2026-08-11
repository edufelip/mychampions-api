import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, or } from 'drizzle-orm';

import {
  activeSpecialties,
  connections,
  connectionInviteGuards,
  inviteCodes,
  nutritionPlans,
  pendingStudents,
  pendingStudentSlots,
  subscriptionEntitlementSnapshots,
  trainingPlans,
  trackingAccess,
  type ConnectionRow,
  type InviteCodeRow,
  type PendingStudentRow,
  type PendingStudentSlotRow,
} from '../db/schema';
import {
  ConnectionAlreadyExistsError,
  ConnectionForbiddenError,
  ConnectionNotFoundError,
  InviteCodeNotFoundError,
  InvalidConnectionTransitionError,
  PendingConnectionAlreadyExistsError,
  PendingConnectionCapReachedError,
  ProfessionalSubscriptionRequiredError,
  type ConfirmPendingConnectionInput,
  type Connection,
  type ConnectionRepository,
  type EndConnectionInput,
  type InviteCode,
  type ProfessionalInviteCodeInput,
  type SubmitInviteCodeInput,
} from './repository';

type Db = {
  select: Function;
  insert: Function;
  update: Function;
  delete: Function;
};

const MAX_PENDING_STUDENTS = 10;
const MAX_ACTIVE_STUDENTS_WITHOUT_ENTITLEMENT = 10;
const PENDING_STUDENT_SLOT_IDS = [
  'slot_01',
  'slot_02',
  'slot_03',
  'slot_04',
  'slot_05',
  'slot_06',
  'slot_07',
  'slot_08',
  'slot_09',
  'slot_10',
] as const;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIso(value: Date | string | null): string | null {
  return value ? toIso(value) : null;
}

function mapConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    status: row.status,
    canceledReason: row.canceledReason,
    specialty: row.specialty,
    professionalAuthUid: row.professionalAuthUid,
    studentAuthUid: row.studentAuthUid,
    sourceInviteCodeId: row.sourceInviteCodeId,
    sourceInviteCodeValue: row.sourceInviteCodeValue,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    endedAt: toNullableIso(row.endedAt),
  };
}

function mapInviteCode(row: InviteCodeRow): InviteCode {
  return {
    id: row.id,
    professionalAuthUid: row.professionalAuthUid,
    specialty: row.specialty,
    codeValue: row.codeValue,
    status: row.status,
    rotatedAt: toNullableIso(row.rotatedAt),
    expiresAt: null,
    createdAt: toIso(row.createdAt),
  };
}

function inviteCodeId(input: ProfessionalInviteCodeInput): string {
  return `${input.professionalAuthUid}_${input.specialty}`;
}

function defaultGenerateInviteCode(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}

function pendingConnectionField(
  specialty: ConnectionRow['specialty']
): 'nutritionistConnectionId' | 'fitnessCoachConnectionId' {
  return specialty === 'nutritionist' ? 'nutritionistConnectionId' : 'fitnessCoachConnectionId';
}

function pendingInviteGuardId(connection: Pick<ConnectionRow, 'professionalAuthUid' | 'studentAuthUid' | 'specialty'>): string {
  return `${connection.professionalAuthUid}_${connection.studentAuthUid}_${connection.specialty}`;
}

function pendingStudentId(connection: Pick<ConnectionRow, 'professionalAuthUid' | 'studentAuthUid'>): string {
  return `${connection.professionalAuthUid}_${connection.studentAuthUid}`;
}

function pendingStudentSlotId(professionalAuthUid: string, slotId: string): string {
  return `${professionalAuthUid}_${slotId}`;
}

function trackingAccessId(connection: Pick<ConnectionRow, 'studentAuthUid' | 'specialty' | 'professionalAuthUid'>): string {
  return `${connection.studentAuthUid}_${connection.specialty}_${connection.professionalAuthUid}`;
}

function activeSpecialtyId(connection: Pick<ConnectionRow, 'studentAuthUid' | 'specialty'>): string {
  return `${connection.studentAuthUid}_${connection.specialty}`;
}

function hasPendingStudentOccupancy(row: PendingStudentRow | null | undefined): boolean {
  return Boolean(row?.nutritionistConnectionId || row?.fitnessCoachConnectionId);
}

function selectPendingStudentSlot(input: {
  currentOccupancy: PendingStudentRow | null | undefined;
  slots: PendingStudentSlotRow[];
}): string | null {
  const existingSlotId = input.currentOccupancy?.slotId;
  if (existingSlotId && hasPendingStudentOccupancy(input.currentOccupancy)) {
    return PENDING_STUDENT_SLOT_IDS.includes(existingSlotId as typeof PENDING_STUDENT_SLOT_IDS[number])
      ? existingSlotId
      : null;
  }

  const slotById = new Map(input.slots.map((slot) => [slot.slotId, slot]));
  const emptySlotId = PENDING_STUDENT_SLOT_IDS.find((slotId) => {
    const slot = slotById.get(slotId);
    return !slot?.studentAuthUid;
  });
  return emptySlotId ?? null;
}

export class PostgresConnectionRepository implements ConnectionRepository {
  constructor(
    private readonly db: Db,
    private readonly options: { generateInviteCode?: () => string } = {}
  ) {}

  async listForAuthUid(authUid: string): Promise<Connection[]> {
    const rows = await this.db
      .select()
      .from(connections)
      .where(or(eq(connections.studentAuthUid, authUid), eq(connections.professionalAuthUid, authUid)))
      .orderBy(desc(connections.updatedAt));

    return rows.map(mapConnection);
  }

  async getOrCreateActiveInviteCode(input: ProfessionalInviteCodeInput): Promise<InviteCode> {
    const [active] = await this.db
      .select()
      .from(inviteCodes)
      .where(
        and(
          eq(inviteCodes.professionalAuthUid, input.professionalAuthUid),
          eq(inviteCodes.specialty, input.specialty),
          eq(inviteCodes.status, 'active')
        )
      )
      .limit(1);

    if (active) {
      return mapInviteCode(active);
    }

    const now = new Date();
    const codeValue = (this.options.generateInviteCode ?? defaultGenerateInviteCode)();
    const id = inviteCodeId(input);
    const [existing] = await this.db
      .select()
      .from(inviteCodes)
      .where(eq(inviteCodes.id, id))
      .limit(1);

    if (existing) {
      const [row] = await this.db
        .update(inviteCodes)
        .set({
          codeValue,
          status: 'active',
          updatedAt: now,
          rotatedAt: null,
        })
        .where(eq(inviteCodes.id, id))
        .returning();
      return mapInviteCode(row);
    }

    const [row] = await this.db
      .insert(inviteCodes)
      .values({
        id,
        professionalAuthUid: input.professionalAuthUid,
        specialty: input.specialty,
        codeValue,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        rotatedAt: null,
      })
      .returning();

    return mapInviteCode(row);
  }

  async rotateInviteCode(input: ProfessionalInviteCodeInput): Promise<InviteCode> {
    const [current] = await this.db
      .select()
      .from(inviteCodes)
      .where(
        and(
          eq(inviteCodes.professionalAuthUid, input.professionalAuthUid),
          eq(inviteCodes.specialty, input.specialty),
          eq(inviteCodes.status, 'active')
        )
      )
      .limit(1);

    if (!current) {
      const created = await this.getOrCreateActiveInviteCode(input);
      const now = new Date();
      const [row] = await this.db
        .update(inviteCodes)
        .set({ rotatedAt: now, updatedAt: now })
        .where(eq(inviteCodes.id, created.id))
        .returning();
      return mapInviteCode(row);
    }

    const now = new Date();
    const codeValue = (this.options.generateInviteCode ?? defaultGenerateInviteCode)();
    const pendingRows = await this.db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.professionalAuthUid, input.professionalAuthUid),
          eq(connections.specialty, input.specialty),
          eq(connections.status, 'pending_confirmation'),
          eq(connections.sourceInviteCodeValue, current.codeValue)
        )
      );
    const [row] = await this.db
      .update(inviteCodes)
      .set({
        codeValue,
        status: 'active',
        rotatedAt: now,
        updatedAt: now,
      })
      .where(eq(inviteCodes.id, current.id))
      .returning();

    await this.db
      .update(connections)
      .set({
        status: 'ended',
        canceledReason: 'code_rotated',
        endedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(connections.professionalAuthUid, input.professionalAuthUid),
          eq(connections.specialty, input.specialty),
          eq(connections.status, 'pending_confirmation'),
          eq(connections.sourceInviteCodeValue, current.codeValue)
        )
      );

    await Promise.all(
      pendingRows.map((pendingConnection: ConnectionRow) => this.releasePendingInviteState(pendingConnection, now))
    );

    return mapInviteCode(row);
  }

  async confirmPendingConnection(input: ConfirmPendingConnectionInput): Promise<Connection> {
    const [connection] = await this.db
      .select()
      .from(connections)
      .where(eq(connections.id, input.connectionId))
      .limit(1);

    if (!connection) {
      throw new ConnectionNotFoundError();
    }
    if (connection.professionalAuthUid !== input.professionalAuthUid) {
      throw new ConnectionForbiddenError();
    }
    if (connection.status !== 'pending_confirmation') {
      throw new InvalidConnectionTransitionError();
    }

    const activeConflicts = await this.db
      .select({ id: connections.id })
      .from(connections)
      .where(
        and(
          eq(connections.studentAuthUid, connection.studentAuthUid),
          eq(connections.specialty, connection.specialty),
          eq(connections.status, 'active')
        )
      );

    if (activeConflicts.length > 0) {
      throw new ConnectionAlreadyExistsError();
    }

    await this.assertProfessionalEntitlementAllowsActivation(connection);

    const now = new Date();
    const [row] = await this.db
      .update(connections)
      .set({
        status: 'active',
        canceledReason: null,
        endedAt: null,
        updatedAt: now,
      })
      .where(and(eq(connections.id, input.connectionId), eq(connections.status, 'pending_confirmation')))
      .returning();

    // The UPDATE above is the single source of truth for "did this request win
    // the transition": its WHERE clause re-checks status atomically with the
    // write, so a concurrent confirm that lost the race affects zero rows here
    // even though it passed the earlier read-only status check. Only the
    // winner reaches the side effects below.
    if (!row) {
      throw new InvalidConnectionTransitionError();
    }

    await this.releasePendingInviteState(connection, now);
    await this.writeTrackingAccess(connection, 'active', now);
    await this.writeActiveSpecialty(connection, 'active', now);
    await this.archiveSelfManagedPlansForConfirmedConnection(connection, now);

    return mapConnection(row);
  }

  private async assertProfessionalEntitlementAllowsActivation(connection: ConnectionRow): Promise<void> {
    const activeRows = await this.db
      .select({ studentAuthUid: connections.studentAuthUid })
      .from(connections)
      .where(
        and(
          eq(connections.professionalAuthUid, connection.professionalAuthUid),
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

    if (
      activeStudentUids.has(connection.studentAuthUid) ||
      activeStudentUids.size < MAX_ACTIVE_STUDENTS_WITHOUT_ENTITLEMENT
    ) {
      return;
    }

    const [snapshot] = await this.db
      .select({ status: subscriptionEntitlementSnapshots.professionalEntitlementStatus })
      .from(subscriptionEntitlementSnapshots)
      .where(eq(subscriptionEntitlementSnapshots.authUid, connection.professionalAuthUid))
      .limit(1);

    if (snapshot?.status !== 'active') {
      throw new ProfessionalSubscriptionRequiredError();
    }
  }

  async endConnection(input: EndConnectionInput): Promise<Connection> {
    const [connection] = await this.db
      .select()
      .from(connections)
      .where(eq(connections.id, input.connectionId))
      .limit(1);

    if (!connection) {
      throw new ConnectionNotFoundError();
    }
    if (connection.studentAuthUid !== input.authUid && connection.professionalAuthUid !== input.authUid) {
      throw new ConnectionForbiddenError();
    }
    if (connection.status === 'ended') {
      return mapConnection(connection);
    }

    const now = new Date();
    const [row] = await this.db
      .update(connections)
      .set({
        status: 'ended',
        endedAt: now,
        updatedAt: now,
      })
      .where(eq(connections.id, input.connectionId))
      .returning();

    await this.releasePendingInviteState(connection, now);
    await this.writeTrackingAccess(connection, 'ended', now);
    await this.writeEndedActiveSpecialtyIfOwned(connection, now);
    await this.archiveAssignedPlansForEndedConnection(connection, now);
    await this.restoreLatestSelfManagedPlanForEndedConnection(connection, now);

    return mapConnection(row);
  }

  async submitInviteCode(input: SubmitInviteCodeInput): Promise<Connection> {
    const codeValue = input.code.trim().toUpperCase();
    const [invite] = await this.db
      .select()
      .from(inviteCodes)
      .where(and(eq(inviteCodes.codeValue, codeValue), eq(inviteCodes.status, 'active')))
      .limit(1);

    if (!invite) {
      throw new InviteCodeNotFoundError();
    }

    const existing = await this.db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.professionalAuthUid, invite.professionalAuthUid),
          eq(connections.studentAuthUid, input.studentAuthUid),
          eq(connections.specialty, invite.specialty),
          inArray(connections.status, ['active', 'pending_confirmation'])
        )
      );

    if (existing.some((connection: ConnectionRow) => connection.status === 'active')) {
      throw new ConnectionAlreadyExistsError();
    }
    if (existing.some((connection: ConnectionRow) => connection.status === 'pending_confirmation')) {
      throw new PendingConnectionAlreadyExistsError();
    }

    const pending = await this.db
      .select({ studentAuthUid: connections.studentAuthUid })
      .from(connections)
      .where(
        and(
          eq(connections.professionalAuthUid, invite.professionalAuthUid),
          eq(connections.status, 'pending_confirmation')
        )
      );

    const pendingStudentUids = new Set(
      pending
        .map((connection: { studentAuthUid?: string | null }) => connection.studentAuthUid)
        .filter((studentAuthUid: string | null | undefined): studentAuthUid is string =>
          typeof studentAuthUid === 'string' && studentAuthUid.length > 0
        )
    );
    pendingStudentUids.add(input.studentAuthUid);
    if (pendingStudentUids.size > MAX_PENDING_STUDENTS) {
      throw new PendingConnectionCapReachedError();
    }

    const now = new Date();
    const [row] = await this.db
      .insert(connections)
      .values({
        id: randomUUID(),
        status: 'pending_confirmation',
        canceledReason: null,
        specialty: invite.specialty,
        professionalAuthUid: invite.professionalAuthUid,
        studentAuthUid: input.studentAuthUid,
        sourceInviteCodeId: invite.id,
        sourceInviteCodeValue: invite.codeValue,
        createdAt: now,
        updatedAt: now,
        endedAt: null,
      })
      .returning();

    await this.allocatePendingInviteState(row, now);

    return mapConnection(row);
  }

  private async allocatePendingInviteState(connection: ConnectionRow, now: Date): Promise<void> {
    const field = pendingConnectionField(connection.specialty);
    const [currentOccupancy] = await this.db
      .select()
      .from(pendingStudents)
      .where(eq(pendingStudents.id, pendingStudentId(connection)))
      .limit(1);

    if (currentOccupancy?.[field]) {
      throw new PendingConnectionAlreadyExistsError();
    }

    const slotRows = await this.db
      .select()
      .from(pendingStudentSlots)
      .where(eq(pendingStudentSlots.professionalAuthUid, connection.professionalAuthUid));
    const slotId = selectPendingStudentSlot({ currentOccupancy, slots: slotRows });
    if (!slotId) {
      throw new PendingConnectionCapReachedError();
    }

    await this.db.insert(connectionInviteGuards).values({
      id: pendingInviteGuardId(connection),
      connectionId: connection.id,
      professionalAuthUid: connection.professionalAuthUid,
      studentAuthUid: connection.studentAuthUid,
      specialty: connection.specialty,
      status: 'pending_confirmation',
      createdAt: now,
      updatedAt: now,
    });

    if (connection.specialty === 'nutritionist') {
      await this.db
        .insert(pendingStudents)
        .values({
          id: pendingStudentId(connection),
          professionalAuthUid: connection.professionalAuthUid,
          studentAuthUid: connection.studentAuthUid,
          slotId,
          nutritionistConnectionId: connection.id,
          fitnessCoachConnectionId: null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: pendingStudents.id,
          set: {
            slotId,
            nutritionistConnectionId: connection.id,
            updatedAt: now,
          },
        });
    } else {
      await this.db
        .insert(pendingStudents)
        .values({
          id: pendingStudentId(connection),
          professionalAuthUid: connection.professionalAuthUid,
          studentAuthUid: connection.studentAuthUid,
          slotId,
          nutritionistConnectionId: null,
          fitnessCoachConnectionId: connection.id,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: pendingStudents.id,
          set: {
            slotId,
            fitnessCoachConnectionId: connection.id,
            updatedAt: now,
          },
        });
    }

    await this.db
      .insert(pendingStudentSlots)
      .values({
        id: pendingStudentSlotId(connection.professionalAuthUid, slotId),
        professionalAuthUid: connection.professionalAuthUid,
        slotId,
        studentAuthUid: connection.studentAuthUid,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: pendingStudentSlots.id,
        set: {
          studentAuthUid: connection.studentAuthUid,
          updatedAt: now,
        },
      });
  }

  private async releasePendingInviteState(connection: ConnectionRow, now: Date): Promise<void> {
    if (connection.status !== 'pending_confirmation') return;

    await this.db
      .delete(connectionInviteGuards)
      .where(eq(connectionInviteGuards.id, pendingInviteGuardId(connection)));

    const [occupancy] = await this.db
      .select()
      .from(pendingStudents)
      .where(eq(pendingStudents.id, pendingStudentId(connection)))
      .limit(1);
    const field = pendingConnectionField(connection.specialty);
    if (!occupancy || occupancy[field] !== connection.id) return;

    const nutritionistConnectionId =
      field === 'nutritionistConnectionId' ? null : occupancy.nutritionistConnectionId;
    const fitnessCoachConnectionId =
      field === 'fitnessCoachConnectionId' ? null : occupancy.fitnessCoachConnectionId;
    const shouldReleaseSlot = !nutritionistConnectionId && !fitnessCoachConnectionId;

    await this.db
      .update(pendingStudents)
      .set({
        nutritionistConnectionId,
        fitnessCoachConnectionId,
        updatedAt: now,
      })
      .where(eq(pendingStudents.id, occupancy.id));

    if (shouldReleaseSlot) {
      await this.db
        .update(pendingStudentSlots)
        .set({
          studentAuthUid: null,
          updatedAt: now,
        })
        .where(eq(pendingStudentSlots.id, pendingStudentSlotId(connection.professionalAuthUid, occupancy.slotId)));
    }
  }

  private async writeTrackingAccess(
    connection: ConnectionRow,
    status: 'active' | 'ended',
    now: Date
  ): Promise<void> {
    await this.db
      .insert(trackingAccess)
      .values({
        id: trackingAccessId(connection),
        studentAuthUid: connection.studentAuthUid,
        professionalAuthUid: connection.professionalAuthUid,
        specialty: connection.specialty,
        connectionId: connection.id,
        status,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: trackingAccess.id,
        set: {
          connectionId: connection.id,
          status,
          updatedAt: now,
        },
      });
  }

  private async writeActiveSpecialty(
    connection: ConnectionRow,
    status: 'active' | 'ended',
    now: Date
  ): Promise<void> {
    await this.db
      .insert(activeSpecialties)
      .values({
        id: activeSpecialtyId(connection),
        studentAuthUid: connection.studentAuthUid,
        professionalAuthUid: connection.professionalAuthUid,
        specialty: connection.specialty,
        connectionId: connection.id,
        status,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: activeSpecialties.id,
        set: {
          professionalAuthUid: connection.professionalAuthUid,
          connectionId: connection.id,
          status,
          updatedAt: now,
        },
      });
  }

  private async writeEndedActiveSpecialtyIfOwned(connection: ConnectionRow, now: Date): Promise<void> {
    const [existing] = await this.db
      .select()
      .from(activeSpecialties)
      .where(eq(activeSpecialties.id, activeSpecialtyId(connection)))
      .limit(1);

    if (existing && existing.connectionId !== connection.id) return;

    await this.writeActiveSpecialty(connection, 'ended', now);
  }

  private async archiveSelfManagedPlansForConfirmedConnection(connection: ConnectionRow, now: Date): Promise<void> {
    if (connection.specialty === 'nutritionist') {
      await this.db
        .update(nutritionPlans)
        .set({
          isArchived: true,
          lifecycleConnectionId: connection.id,
          updatedAt: now,
        })
        .where(
          and(
            eq(nutritionPlans.studentAuthUid, connection.studentAuthUid),
            eq(nutritionPlans.sourceKind, 'self_managed'),
            eq(nutritionPlans.isArchived, false)
          )
        );
      return;
    }

    await this.db
      .update(trainingPlans)
      .set({
        isArchived: true,
        lifecycleConnectionId: connection.id,
        updatedAt: now,
      })
      .where(
        and(
          eq(trainingPlans.studentAuthUid, connection.studentAuthUid),
          eq(trainingPlans.sourceKind, 'self_managed'),
          eq(trainingPlans.isArchived, false)
        )
      );
  }

  private async archiveAssignedPlansForEndedConnection(connection: ConnectionRow, now: Date): Promise<void> {
    if (connection.specialty === 'nutritionist') {
      await this.db
        .update(nutritionPlans)
        .set({
          isArchived: true,
          lifecycleConnectionId: connection.id,
          updatedAt: now,
        })
        .where(
          and(
            eq(nutritionPlans.studentAuthUid, connection.studentAuthUid),
            eq(nutritionPlans.ownerProfessionalUid, connection.professionalAuthUid),
            eq(nutritionPlans.sourceKind, 'assigned'),
            eq(nutritionPlans.isArchived, false)
          )
        );
      return;
    }

    await this.db
      .update(trainingPlans)
      .set({
        isArchived: true,
        lifecycleConnectionId: connection.id,
        updatedAt: now,
      })
      .where(
        and(
          eq(trainingPlans.studentAuthUid, connection.studentAuthUid),
          eq(trainingPlans.ownerProfessionalUid, connection.professionalAuthUid),
          eq(trainingPlans.sourceKind, 'assigned'),
          eq(trainingPlans.isArchived, false)
        )
      );
  }

  private async restoreLatestSelfManagedPlanForEndedConnection(connection: ConnectionRow, now: Date): Promise<void> {
    if (connection.specialty === 'nutritionist') {
      const [latest] = await this.db
        .select({ id: nutritionPlans.id })
        .from(nutritionPlans)
        .where(
          and(
            eq(nutritionPlans.studentAuthUid, connection.studentAuthUid),
            eq(nutritionPlans.sourceKind, 'self_managed'),
            eq(nutritionPlans.isArchived, true),
            eq(nutritionPlans.lifecycleConnectionId, connection.id)
          )
        )
        .orderBy(desc(nutritionPlans.updatedAt))
        .limit(1);

      if (latest) {
        await this.db
          .update(nutritionPlans)
          .set({
            isArchived: false,
            lifecycleConnectionId: connection.id,
            updatedAt: now,
          })
          .where(eq(nutritionPlans.id, latest.id));
      }
      return;
    }

    const [latest] = await this.db
      .select({ id: trainingPlans.id })
      .from(trainingPlans)
      .where(
        and(
          eq(trainingPlans.studentAuthUid, connection.studentAuthUid),
          eq(trainingPlans.sourceKind, 'self_managed'),
          eq(trainingPlans.isArchived, true),
          eq(trainingPlans.lifecycleConnectionId, connection.id)
        )
      )
      .orderBy(desc(trainingPlans.updatedAt))
      .limit(1);

    if (latest) {
      await this.db
        .update(trainingPlans)
        .set({
          isArchived: false,
          lifecycleConnectionId: connection.id,
          updatedAt: now,
        })
        .where(eq(trainingPlans.id, latest.id));
    }
  }
}
