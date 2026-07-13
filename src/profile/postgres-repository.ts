import { createHash } from 'node:crypto';
import { eq, or } from 'drizzle-orm';

import {
  activeSpecialties,
  authIdentities,
  authSessions,
  connectionInviteGuards,
  connections,
  customMeals,
  inviteCodes,
  localEmailAuthCredentials,
  mealShareLinks,
  nutritionPlans,
  passwordResetRequests,
  pendingStudentSlots,
  pendingStudents,
  planChangeRequests,
  portionLogs,
  professionalCredentials,
  professionalSpecialties,
  subscriptionEntitlementSnapshots,
  supportMessages,
  trackingAccess,
  trainingPlans,
  userProfiles,
  waterLogs,
  workoutLogs,
  type UserProfileRow,
} from '../db/schema';
import { ProfileConflictError, ProfileNotFoundError, type Profile, type ProfileRepository, type Role, type UpsertProfileInput } from './repository';

type Db = {
  select: Function;
  insert: Function;
  update: Function;
  delete: Function;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapProfile(row: UserProfileRow): Profile {
  return {
    authUid: row.authUid,
    displayName: row.displayName,
    emailNormalized: row.emailNormalized,
    lockedRole: row.lockedRole,
    acceptedTermsVersion: row.acceptedTermsVersion,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function createDeletedAccountPseudonym(authUid: string): string {
  const digest = createHash('sha256').update(authUid).digest('hex').slice(0, 24);
  return `deleted_account_${digest}`;
}

export class PostgresProfileRepository implements ProfileRepository {
  constructor(private readonly db: Db) {}

  async upsertFromSession(input: UpsertProfileInput): Promise<Profile> {
    const [row] = await this.db
      .insert(userProfiles)
      .values({
        authUid: input.authUid,
        displayName: input.displayName,
        emailNormalized: input.emailNormalized,
      })
      .onConflictDoUpdate({
        target: userProfiles.authUid,
        set: {
          displayName: input.displayName,
          emailNormalized: input.emailNormalized,
          updatedAt: new Date(),
        },
      })
      .returning();

    return mapProfile(row);
  }

  async findByAuthUid(authUid: string): Promise<Profile | null> {
    const [row] = await this.db.select().from(userProfiles).where(eq(userProfiles.authUid, authUid)).limit(1);
    return row ? mapProfile(row) : null;
  }

  async lockRole(authUid: string, role: Role): Promise<Profile> {
    const existing = await this.findByAuthUid(authUid);
    if (!existing) throw new ProfileNotFoundError('Profile not found.');
    if (existing.lockedRole && existing.lockedRole !== role) {
      throw new ProfileConflictError('Role is already locked and cannot be changed.');
    }
    if (existing.lockedRole === role) return existing;

    const [row] = await this.db
      .update(userProfiles)
      .set({ lockedRole: role, updatedAt: new Date() })
      .where(eq(userProfiles.authUid, authUid))
      .returning();

    return mapProfile(row);
  }

  async setAcceptedTermsVersion(authUid: string, version: string): Promise<Profile> {
    const [row] = await this.db
      .update(userProfiles)
      .set({ acceptedTermsVersion: version, updatedAt: new Date() })
      .where(eq(userProfiles.authUid, authUid))
      .returning();

    if (!row) throw new ProfileNotFoundError('Profile not found.');
    return mapProfile(row);
  }

  async deleteByAuthUid(authUid: string): Promise<void> {
    const existing = await this.findByAuthUid(authUid);
    const pseudonym = createDeletedAccountPseudonym(authUid);
    const deletedAt = new Date();

    await this.db
      .delete(passwordResetRequests)
      .where(eq(passwordResetRequests.emailNormalized, existing?.emailNormalized ?? ''));
    await this.db
      .delete(localEmailAuthCredentials)
      .where(eq(localEmailAuthCredentials.authUid, authUid));
    await this.db.delete(supportMessages).where(eq(supportMessages.authUid, authUid));
    await this.db
      .delete(subscriptionEntitlementSnapshots)
      .where(eq(subscriptionEntitlementSnapshots.authUid, authUid));
    await this.db.delete(authIdentities).where(eq(authIdentities.authUid, authUid));
    await this.db.delete(authSessions).where(eq(authSessions.authUid, authUid));
    await this.db
      .delete(professionalCredentials)
      .where(eq(professionalCredentials.professionalAuthUid, authUid));
    await this.db
      .delete(professionalSpecialties)
      .where(eq(professionalSpecialties.professionalAuthUid, authUid));
    await this.db.delete(inviteCodes).where(eq(inviteCodes.professionalAuthUid, authUid));
    await this.db
      .delete(connectionInviteGuards)
      .where(
        or(
          eq(connectionInviteGuards.professionalAuthUid, authUid),
          eq(connectionInviteGuards.studentAuthUid, authUid)
        )
      );
    await this.db
      .delete(pendingStudents)
      .where(
        or(
          eq(pendingStudents.professionalAuthUid, authUid),
          eq(pendingStudents.studentAuthUid, authUid)
        )
      );
    await this.db
      .delete(pendingStudentSlots)
      .where(
        or(
          eq(pendingStudentSlots.professionalAuthUid, authUid),
          eq(pendingStudentSlots.studentAuthUid, authUid)
        )
      );
    await this.db.delete(workoutLogs).where(eq(workoutLogs.ownerAuthUid, authUid));
    await this.db.delete(waterLogs).where(eq(waterLogs.ownerAuthUid, authUid));
    await this.db
      .delete(planChangeRequests)
      .where(eq(planChangeRequests.studentAuthUid, authUid));
    await this.db
      .delete(portionLogs)
      .where(
        or(
          eq(portionLogs.ownerAuthUid, authUid),
          eq(portionLogs.ownerProfessionalUid, authUid)
        )
      );
    await this.db
      .delete(mealShareLinks)
      .where(eq(mealShareLinks.ownerAuthUid, authUid));
    await this.db.delete(customMeals).where(eq(customMeals.ownerAuthUid, authUid));
    await this.db
      .delete(nutritionPlans)
      .where(
        or(
          eq(nutritionPlans.studentAuthUid, authUid),
          eq(nutritionPlans.ownerProfessionalUid, authUid)
        )
      );
    await this.db
      .delete(trainingPlans)
      .where(
        or(
          eq(trainingPlans.studentAuthUid, authUid),
          eq(trainingPlans.ownerProfessionalUid, authUid)
        )
      );

    await this.db
      .update(connections)
      .set({ professionalAuthUid: pseudonym, status: 'ended', endedAt: deletedAt, updatedAt: deletedAt })
      .where(eq(connections.professionalAuthUid, authUid));
    await this.db
      .update(connections)
      .set({ studentAuthUid: pseudonym, status: 'ended', endedAt: deletedAt, updatedAt: deletedAt })
      .where(eq(connections.studentAuthUid, authUid));
    await this.db
      .update(trackingAccess)
      .set({ professionalAuthUid: pseudonym, status: 'ended', updatedAt: deletedAt })
      .where(eq(trackingAccess.professionalAuthUid, authUid));
    await this.db
      .update(trackingAccess)
      .set({ studentAuthUid: pseudonym, status: 'ended', updatedAt: deletedAt })
      .where(eq(trackingAccess.studentAuthUid, authUid));
    await this.db
      .update(activeSpecialties)
      .set({ professionalAuthUid: pseudonym, status: 'ended', updatedAt: deletedAt })
      .where(eq(activeSpecialties.professionalAuthUid, authUid));
    await this.db
      .update(activeSpecialties)
      .set({ studentAuthUid: pseudonym, status: 'ended', updatedAt: deletedAt })
      .where(eq(activeSpecialties.studentAuthUid, authUid));

    await this.db.delete(userProfiles).where(eq(userProfiles.authUid, authUid));
  }
}
