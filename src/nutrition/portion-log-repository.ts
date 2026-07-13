export type PortionLogSnapshot = {
  calories: number;
  carbs: number;
  proteins: number;
  fats: number;
};

export type PortionLogProvenance = {
  planId?: string | null;
  planType?: 'nutrition' | null;
  sourceKind?: 'assigned' | 'predefined' | 'self_managed' | null;
  ownerProfessionalUid?: string | null;
  connectionId?: string | null;
};

export type PortionLog = PortionLogProvenance & {
  id: string;
  ownerAuthUid: string;
  mealId: string;
  consumedGrams: number;
  snapshot: PortionLogSnapshot;
  loggedAt: string;
};

export type CreatePortionLogInput = PortionLogProvenance & {
  ownerAuthUid: string;
  mealId: string;
  consumedGrams: number;
  snapshot: PortionLogSnapshot;
};

export type ListPortionLogsSinceInput = {
  ownerAuthUid: string;
  fromIso: string;
};

export interface PortionLogRepository {
  create(input: CreatePortionLogInput): Promise<PortionLog>;
  listSince(input: ListPortionLogsSinceInput): Promise<PortionLog[]>;
}
