export type Role = 'student' | 'professional';

export type Profile = {
  authUid: string;
  displayName: string;
  emailNormalized: string;
  lockedRole: Role | null;
  acceptedTermsVersion: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UpsertProfileInput = {
  authUid: string;
  displayName: string;
  emailNormalized: string;
};

export interface ProfileRepository {
  upsertFromSession(input: UpsertProfileInput): Promise<Profile>;
  findByAuthUid(authUid: string): Promise<Profile | null>;
  lockRole(authUid: string, role: Role): Promise<Profile>;
  setAcceptedTermsVersion(authUid: string, version: string): Promise<Profile>;
  deleteByAuthUid(authUid: string): Promise<void>;
}

export class ProfileConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileConflictError';
  }
}

export class ProfileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileNotFoundError';
  }
}
