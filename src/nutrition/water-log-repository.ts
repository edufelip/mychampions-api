export type WaterLog = {
  id: string;
  ownerAuthUid: string;
  dateKey: string;
  totalMl: number;
  loggedAt: string;
};

export type LogWaterIntakeInput = {
  ownerAuthUid: string;
  amountMl: number;
  dateKey: string;
};

export type ListWaterLogsInput = {
  ownerAuthUid: string;
};

export type GetWaterGoalContextInput = {
  ownerAuthUid: string;
};

export type WaterGoalContext = {
  studentGoalMl: number | null;
  nutritionistGoalMl: number | null;
  hasActiveNutritionistAssignment: boolean;
};

export interface WaterLogRepository {
  logIntake(input: LogWaterIntakeInput): Promise<WaterLog>;
  listForOwner(input: ListWaterLogsInput): Promise<WaterLog[]>;
  getGoalContext(input: GetWaterGoalContextInput): Promise<WaterGoalContext>;
}
