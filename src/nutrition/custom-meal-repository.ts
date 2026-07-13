export type CustomMeal = {
  id: string;
  ownerAuthUid: string;
  name: string;
  totalGrams: number;
  calories: number;
  carbs: number;
  proteins: number;
  fats: number;
  ingredientCost: number | null;
  imageUrl: string | null;
  importedFromShareToken: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CustomMealInput = {
  ownerAuthUid: string;
  name: string;
  totalGrams: number;
  calories: number;
  carbs: number;
  proteins: number;
  fats: number;
  ingredientCost?: number | null;
  imageUrl?: string | null;
  importedFromShareToken?: string | null;
};

export type ListCustomMealsInput = {
  ownerAuthUid: string;
};

export type GetCustomMealInput = {
  ownerAuthUid: string;
  mealId: string;
};

export type CreateCustomMealInput = CustomMealInput;

export type UpdateCustomMealInput = CustomMealInput & {
  mealId: string;
};

export type DeleteCustomMealInput = {
  ownerAuthUid: string;
  mealId: string;
};

export type SharedMealSnapshot = {
  name: string;
  totalGrams: number;
  calories: number;
  carbs: number;
  proteins: number;
  fats: number;
};

export type MealShareLink = {
  id: string;
  ownerAuthUid: string;
  mealId: string;
  snapshot: SharedMealSnapshot;
  createdAt: string;
};

export type CreateMealShareLinkInput = {
  ownerAuthUid: string;
  mealId: string;
};

export type PreviewMealShareInput = {
  shareToken: string;
};

export type ImportMealShareInput = {
  ownerAuthUid: string;
  shareToken: string;
};

export interface CustomMealRepository {
  listForOwner(input: ListCustomMealsInput): Promise<CustomMeal[]>;
  getForOwner(input: GetCustomMealInput): Promise<CustomMeal | null>;
  create(input: CreateCustomMealInput): Promise<CustomMeal>;
  updateForOwner(input: UpdateCustomMealInput): Promise<CustomMeal | null>;
  deleteForOwner(input: DeleteCustomMealInput): Promise<boolean>;
  createShareLink(input: CreateMealShareLinkInput): Promise<MealShareLink | null>;
  previewShare(input: PreviewMealShareInput): Promise<SharedMealSnapshot | null>;
  importShare(input: ImportMealShareInput): Promise<CustomMeal | null>;
}
