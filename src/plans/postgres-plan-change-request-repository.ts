import { randomUUID } from 'node:crypto';
import { and, desc, eq, type SQL } from 'drizzle-orm';

import { connections, nutritionPlans, planChangeRequests, trainingPlans, type PlanChangeRequestRow } from '../db/schema';
import type {
  CreatePlanChangeRequestInput,
  ListPlanChangeRequestsForProfessionalInput,
  ListPlanChangeRequestsForStudentInput,
  PlanChangeRequest,
  PlanChangeRequestRepository,
  ReviewPlanChangeRequestInput,
} from './plan-change-request-repository';
import { PlanChangeRequestForbiddenError, PlanChangeRequestNotFoundError } from './plan-change-request-repository';

type Db = {
  insert: Function;
  select: Function;
  update: Function;
};

type PlanChangeRequestProjection = Pick<
  PlanChangeRequestRow,
  'id' | 'planId' | 'planType' | 'studentAuthUid' | 'requestText' | 'status' | 'createdAt'
>;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const requestColumns = {
  id: planChangeRequests.id,
  planId: planChangeRequests.planId,
  planType: planChangeRequests.planType,
  studentAuthUid: planChangeRequests.studentAuthUid,
  requestText: planChangeRequests.requestText,
  status: planChangeRequests.status,
  createdAt: planChangeRequests.createdAt,
};

function mapPlanChangeRequest(row: PlanChangeRequestProjection): PlanChangeRequest {
  return {
    id: row.id,
    planId: row.planId,
    planType: row.planType,
    studentUid: row.studentAuthUid,
    requestText: row.requestText,
    status: row.status,
    createdAt: toIso(row.createdAt),
  };
}

export class PostgresPlanChangeRequestRepository implements PlanChangeRequestRepository {
  constructor(private readonly db: Db) {}

  async create(input: CreatePlanChangeRequestInput): Promise<PlanChangeRequest> {
    const [row] = await this.db
      .insert(planChangeRequests)
      .values({
        id: randomUUID(),
        planId: input.planId,
        planType: input.planType,
        studentAuthUid: input.studentAuthUid,
        requestText: input.requestText,
        status: 'pending',
      })
      .returning();

    return mapPlanChangeRequest(row);
  }

  async listForStudent(input: ListPlanChangeRequestsForStudentInput): Promise<PlanChangeRequest[]> {
    const [activeConnection] = await this.db
      .select({ id: connections.id })
      .from(connections)
      .where(and(
        eq(connections.professionalAuthUid, input.professionalAuthUid),
        eq(connections.studentAuthUid, input.studentAuthUid),
        eq(connections.status, 'active')
      ))
      .limit(1);

    if (!activeConnection) {
      return [];
    }

    const rows = await this.db
      .select()
      .from(planChangeRequests)
      .where(eq(planChangeRequests.studentAuthUid, input.studentAuthUid))
      .orderBy(desc(planChangeRequests.createdAt));

    return rows.map(mapPlanChangeRequest);
  }

  async listForProfessional(input: ListPlanChangeRequestsForProfessionalInput): Promise<PlanChangeRequest[]> {
    const statusFilter: SQL | undefined = input.status
      ? eq(planChangeRequests.status, input.status)
      : undefined;

    const nutritionRows = await this.db
      .select(requestColumns)
      .from(planChangeRequests)
      .innerJoin(nutritionPlans, eq(planChangeRequests.planId, nutritionPlans.id))
      .where(and(
        eq(planChangeRequests.planType, 'nutrition'),
        eq(nutritionPlans.ownerProfessionalUid, input.professionalAuthUid),
        statusFilter
      ));

    const trainingRows = await this.db
      .select(requestColumns)
      .from(planChangeRequests)
      .innerJoin(trainingPlans, eq(planChangeRequests.planId, trainingPlans.id))
      .where(and(
        eq(planChangeRequests.planType, 'training'),
        eq(trainingPlans.ownerProfessionalUid, input.professionalAuthUid),
        statusFilter
      ));

    return [...nutritionRows, ...trainingRows]
      .map(mapPlanChangeRequest)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async review(input: ReviewPlanChangeRequestInput): Promise<{ id: string; status: 'reviewed' | 'dismissed' }> {
    const [existing] = await this.db
      .select({
        planId: planChangeRequests.planId,
        planType: planChangeRequests.planType,
      })
      .from(planChangeRequests)
      .where(eq(planChangeRequests.id, input.requestId))
      .limit(1);

    if (!existing) {
      throw new PlanChangeRequestNotFoundError();
    }

    const ownerTable = existing.planType === 'nutrition' ? nutritionPlans : trainingPlans;
    const [plan] = await this.db
      .select({ ownerProfessionalUid: ownerTable.ownerProfessionalUid })
      .from(ownerTable)
      .where(eq(ownerTable.id, existing.planId))
      .limit(1);

    if (!plan || plan.ownerProfessionalUid !== input.professionalAuthUid) {
      throw new PlanChangeRequestForbiddenError();
    }

    const [row] = await this.db
      .update(planChangeRequests)
      .set({
        status: input.status,
        updatedAt: new Date(),
      })
      .where(eq(planChangeRequests.id, input.requestId))
      .returning({
        id: planChangeRequests.id,
        status: planChangeRequests.status,
      });

    if (!row) {
      throw new PlanChangeRequestNotFoundError();
    }

    return { id: row.id, status: row.status };
  }
}
