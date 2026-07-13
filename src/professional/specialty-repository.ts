export type ProfessionalSpecialty = 'nutritionist' | 'fitness_coach';

export type ProfessionalCredential = {
  id: string;
  specialty: ProfessionalSpecialty;
  credentialType: 'professional_registry';
  registryId: string;
  authority: string;
  country: string;
};

export type SpecialtyRecord = {
  id: string;
  professionalAuthUid: string;
  specialty: ProfessionalSpecialty;
  isActive: boolean;
  credential: ProfessionalCredential | null;
};

export type AddProfessionalSpecialtyInput = {
  professionalAuthUid: string;
  specialty: ProfessionalSpecialty;
};

export type SpecialtyBlockerCounts = {
  activeCount: number;
  pendingCount: number;
};

export type GetSpecialtyBlockerCountsInput = {
  professionalAuthUid: string;
  specialty: ProfessionalSpecialty;
};

export type RemoveProfessionalSpecialtyInput = {
  professionalAuthUid: string;
  specialtyId: string;
};

export type UpsertProfessionalCredentialInput = {
  professionalAuthUid: string;
  specialtyId: string;
  registryId: string;
  authority: string;
  country: string;
};

export type ProfessionalSpecialtyRepositoryErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'last_specialty'
  | 'removal_blocked';

export class ProfessionalSpecialtyRepositoryError extends Error {
  constructor(
    readonly code: ProfessionalSpecialtyRepositoryErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ProfessionalSpecialtyRepositoryError';
  }
}

export interface ProfessionalSpecialtyRepository {
  listForProfessional(professionalAuthUid: string): Promise<SpecialtyRecord[]>;
  addOrReactivate(input: AddProfessionalSpecialtyInput): Promise<SpecialtyRecord>;
  getBlockerCounts(input: GetSpecialtyBlockerCountsInput): Promise<SpecialtyBlockerCounts>;
  removeForProfessional(input: RemoveProfessionalSpecialtyInput): Promise<void>;
  upsertCredential(input: UpsertProfessionalCredentialInput): Promise<ProfessionalCredential>;
}
