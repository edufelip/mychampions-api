export type PlanType = 'nutrition' | 'training';
export type PlanChangeRequestStatus = 'pending' | 'reviewed' | 'dismissed';

export type PlanChangeRequest = {
  id: string;
  planId: string;
  planType: PlanType;
  studentUid: string;
  requestText: string;
  status: PlanChangeRequestStatus;
  createdAt: string;
};

export type CreatePlanChangeRequestInput = {
  studentAuthUid: string;
  planId: string;
  planType: PlanType;
  requestText: string;
};

export type ListPlanChangeRequestsForStudentInput = {
  professionalAuthUid: string;
  studentAuthUid: string;
};

export type ListPlanChangeRequestsForProfessionalInput = {
  professionalAuthUid: string;
  status?: PlanChangeRequestStatus;
};

export type ReviewPlanChangeRequestInput = {
  professionalAuthUid: string;
  requestId: string;
  status: Exclude<PlanChangeRequestStatus, 'pending'>;
};

export class PlanChangeRequestNotFoundError extends Error {
  constructor(message = 'Plan change request not found.') {
    super(message);
    this.name = 'PlanChangeRequestNotFoundError';
  }
}

export interface PlanChangeRequestRepository {
  create(input: CreatePlanChangeRequestInput): Promise<PlanChangeRequest>;
  listForStudent(input: ListPlanChangeRequestsForStudentInput): Promise<PlanChangeRequest[]>;
  listForProfessional(input: ListPlanChangeRequestsForProfessionalInput): Promise<PlanChangeRequest[]>;
  review(input: ReviewPlanChangeRequestInput): Promise<{ id: string; status: PlanChangeRequestStatus }>;
}
