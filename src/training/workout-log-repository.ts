export type WorkoutLog = {
  id: string;
  ownerAuthUid: string;
  sessionId: string;
  sessionName: string;
  createdAt: string;
};

export type CreateWorkoutLogInput = {
  ownerAuthUid: string;
  sessionId: string;
  sessionName: string;
};

export type ListWorkoutLogsSinceInput = {
  ownerAuthUid: string;
  fromIso: string;
};

export interface WorkoutLogRepository {
  create(input: CreateWorkoutLogInput): Promise<WorkoutLog>;
  listSince(input: ListWorkoutLogsSinceInput): Promise<WorkoutLog[]>;
}
