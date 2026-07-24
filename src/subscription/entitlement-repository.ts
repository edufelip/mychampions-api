export type EntitlementStatus = 'active' | 'lapsed' | 'unknown';

export type SubscriptionEntitlementSnapshot = {
  authUid: string;
  professionalEntitlementStatus: EntitlementStatus;
  aiEntitlementStatus: EntitlementStatus;
  professionalEntitlementExpiresAt: string | null;
  professionalEntitlementRenewalRisk: boolean;
  activeStudentCount: number | null;
  source: 'revenuecat';
  observedAt: string;
  updatedAt: string;
};

export type UpsertSubscriptionEntitlementSnapshotInput = {
  authUid: string;
  professionalEntitlementStatus: EntitlementStatus;
  aiEntitlementStatus: EntitlementStatus;
  professionalEntitlementExpiresAt?: string | null;
  professionalEntitlementRenewalRisk?: boolean;
  activeStudentCount: number | null;
  source: 'revenuecat';
  observedAt: string;
};

export interface SubscriptionEntitlementRepository {
  upsertSnapshot(
    input: UpsertSubscriptionEntitlementSnapshotInput
  ): Promise<SubscriptionEntitlementSnapshot>;

  findLatestForAuthUid(authUid: string): Promise<SubscriptionEntitlementSnapshot | null>;
}
