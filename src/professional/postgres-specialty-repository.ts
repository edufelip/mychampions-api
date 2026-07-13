import { and, asc, eq, inArray } from 'drizzle-orm';

import {
  connections,
  inviteCodes,
  professionalCredentials,
  professionalSpecialties,
  type ProfessionalCredentialRow,
  type ProfessionalSpecialtyRow,
} from '../db/schema';
import type {
  AddProfessionalSpecialtyInput,
  GetSpecialtyBlockerCountsInput,
  ProfessionalCredential,
  ProfessionalSpecialtyRepository,
  RemoveProfessionalSpecialtyInput,
  SpecialtyRecord,
  UpsertProfessionalCredentialInput,
} from './specialty-repository';
import { ProfessionalSpecialtyRepositoryError } from './specialty-repository';

type Db = {
  select: Function;
  insert: Function;
  update: Function;
};

function specialtyId(input: AddProfessionalSpecialtyInput): string {
  return `${input.professionalAuthUid}_${input.specialty}`;
}

function mapCredential(row: ProfessionalCredentialRow | null | undefined): ProfessionalCredential | null {
  if (!row) return null;
  return {
    id: row.id,
    specialty: row.specialty,
    credentialType: row.credentialType,
    registryId: row.registryId,
    authority: row.authority,
    country: row.country,
  };
}

function mapSpecialty(row: ProfessionalSpecialtyRow, credential?: ProfessionalCredentialRow | null): SpecialtyRecord {
  return {
    id: row.id,
    professionalAuthUid: row.professionalAuthUid,
    specialty: row.specialty,
    isActive: row.isActive,
    credential: mapCredential(credential),
  };
}

export class PostgresProfessionalSpecialtyRepository implements ProfessionalSpecialtyRepository {
  constructor(private readonly db: Db) {}

  async listForProfessional(professionalAuthUid: string): Promise<SpecialtyRecord[]> {
    const rows = await this.db
      .select({
        specialty: professionalSpecialties,
        credential: professionalCredentials,
      })
      .from(professionalSpecialties)
      .leftJoin(
        professionalCredentials,
        eq(professionalCredentials.specialtyId, professionalSpecialties.id)
      )
      .where(eq(professionalSpecialties.professionalAuthUid, professionalAuthUid))
      .orderBy(asc(professionalSpecialties.specialty));

    return rows.map((row: {
      specialty: ProfessionalSpecialtyRow;
      credential: ProfessionalCredentialRow | null;
    }) => mapSpecialty(row.specialty, row.credential));
  }

  async addOrReactivate(input: AddProfessionalSpecialtyInput): Promise<SpecialtyRecord> {
    const id = specialtyId(input);
    const [existing] = await this.db
      .select()
      .from(professionalSpecialties)
      .where(eq(professionalSpecialties.id, id))
      .limit(1);

    if (existing) {
      const now = new Date();
      const [row] = await this.db
        .update(professionalSpecialties)
        .set({ isActive: true, updatedAt: now })
        .where(eq(professionalSpecialties.id, id))
        .returning();
      return mapSpecialty(row);
    }

    const now = new Date();
    const [row] = await this.db
      .insert(professionalSpecialties)
      .values({
        id,
        professionalAuthUid: input.professionalAuthUid,
        specialty: input.specialty,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return mapSpecialty(row);
  }

  async getBlockerCounts(input: GetSpecialtyBlockerCountsInput): Promise<{ activeCount: number; pendingCount: number }> {
    const rows = await this.db
      .select({ status: connections.status })
      .from(connections)
      .where(
        and(
          eq(connections.professionalAuthUid, input.professionalAuthUid),
          eq(connections.specialty, input.specialty),
          inArray(connections.status, ['active', 'pending_confirmation'])
        )
      );

    return {
      activeCount: rows.filter((row: { status: string }) => row.status === 'active').length,
      pendingCount: rows.filter((row: { status: string }) => row.status === 'pending_confirmation').length,
    };
  }

  async removeForProfessional(input: RemoveProfessionalSpecialtyInput): Promise<void> {
    const [specialty] = await this.db
      .select()
      .from(professionalSpecialties)
      .where(eq(professionalSpecialties.id, input.specialtyId))
      .limit(1);

    if (!specialty) {
      throw new ProfessionalSpecialtyRepositoryError('not_found', 'Specialty not found.');
    }
    if (specialty.professionalAuthUid !== input.professionalAuthUid) {
      throw new ProfessionalSpecialtyRepositoryError('forbidden', 'Specialty is not owned by the authenticated professional.');
    }

    const activeSpecialties = await this.db
      .select({ id: professionalSpecialties.id })
      .from(professionalSpecialties)
      .where(
        and(
          eq(professionalSpecialties.professionalAuthUid, input.professionalAuthUid),
          eq(professionalSpecialties.isActive, true)
        )
      );

    if (specialty.isActive && activeSpecialties.length <= 1) {
      throw new ProfessionalSpecialtyRepositoryError('last_specialty', 'Cannot remove the last active Specialty.');
    }

    const blockers = await this.getBlockerCounts({
      professionalAuthUid: input.professionalAuthUid,
      specialty: specialty.specialty,
    });
    if (blockers.activeCount > 0 || blockers.pendingCount > 0) {
      throw new ProfessionalSpecialtyRepositoryError(
        'removal_blocked',
        'Specialty removal blocked by active/pending students.'
      );
    }

    const now = new Date();
    await this.db
      .update(professionalSpecialties)
      .set({ isActive: false, updatedAt: now })
      .where(eq(professionalSpecialties.id, input.specialtyId));

    await this.db
      .update(inviteCodes)
      .set({ status: 'revoked', updatedAt: now })
      .where(
        and(
          eq(inviteCodes.professionalAuthUid, input.professionalAuthUid),
          eq(inviteCodes.specialty, specialty.specialty),
          eq(inviteCodes.status, 'active')
        )
      );
  }

  async upsertCredential(input: UpsertProfessionalCredentialInput): Promise<ProfessionalCredential> {
    const [specialty] = await this.db
      .select()
      .from(professionalSpecialties)
      .where(eq(professionalSpecialties.id, input.specialtyId))
      .limit(1);

    if (!specialty) {
      throw new ProfessionalSpecialtyRepositoryError('not_found', 'Specialty not found.');
    }
    if (specialty.professionalAuthUid !== input.professionalAuthUid) {
      throw new ProfessionalSpecialtyRepositoryError('forbidden', 'Specialty is not owned by the authenticated professional.');
    }

    const now = new Date();
    const [row] = await this.db
      .insert(professionalCredentials)
      .values({
        id: input.specialtyId,
        specialtyId: input.specialtyId,
        professionalAuthUid: input.professionalAuthUid,
        specialty: specialty.specialty,
        credentialType: 'professional_registry',
        registryId: input.registryId,
        authority: input.authority,
        country: input.country,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: professionalCredentials.id,
        set: {
          registryId: input.registryId,
          authority: input.authority,
          country: input.country,
          updatedAt: now,
        },
      })
      .returning();

    return mapCredential(row) as ProfessionalCredential;
  }
}
