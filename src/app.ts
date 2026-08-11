import { bearer } from '@elysiajs/bearer';
import { cors } from '@elysiajs/cors';
import { jwt } from '@elysiajs/jwt';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Elysia, t } from 'elysia';

import { readConfig, type ServerConfig } from './config';
import { createDatabase } from './db/client';
import {
  EmailAuthGatewayError,
  createEmailAuthGateway,
  type EmailAuthGateway,
  type EmailAuthIdentity,
} from './auth/email-auth';
import {
  SocialAuthGatewayError,
  createSocialAuthGateway,
  type SocialAuthGateway,
} from './auth/social-auth';
import {
  InMemorySocialIdentityRepository,
  SocialIdentityService,
  type ResolvedSocialIdentity,
  type SocialIdentityRepository,
} from './auth/social-identity';
import { PostgresSocialIdentityRepository } from './auth/postgres-social-identity-repository';
import {
  PasswordResetDeliveryGatewayError,
  createPasswordResetDeliveryGateway,
  type PasswordResetDeliveryGateway,
} from './auth/password-reset-delivery';
import {
  LOCAL_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  LOCAL_REFRESH_TOKEN_EXPIRES_IN_SECONDS,
  createTokenService,
  type TokenService,
} from './auth/tokens';
import { createLocalSigningKeyLoader } from './auth/local-signing-key';
import {
  InMemoryRefreshSessionRepository,
  InvalidRefreshTokenError,
  RefreshSessionService,
  type RefreshSessionService as RefreshSessionServiceType,
} from './auth/refresh-session-service';
import { PostgresRefreshSessionRepository } from './auth/postgres-refresh-session-repository';
import {
  InMemoryPasswordResetService,
  type PasswordResetService,
} from './auth/password-reset';
import { PostgresPasswordResetService } from './auth/postgres-password-reset';
import type { AnalyticsEventRepository } from './analytics/repository';
import { PostgresAnalyticsEventRepository } from './analytics/postgres-repository';
import type { SubscriptionEntitlementRepository } from './subscription/entitlement-repository';
import { PostgresSubscriptionEntitlementRepository } from './subscription/postgres-entitlement-repository';
import {
  RevenueCatCustomerManagerError,
  RevenueCatRestCustomerManager,
  type RevenueCatCustomerManager,
} from './subscription/revenuecat-customer-manager';
import {
  ConnectionAlreadyExistsError,
  ConnectionForbiddenError,
  ConnectionNotFoundError,
  InviteCodeNotFoundError,
  InvalidConnectionTransitionError,
  PendingConnectionAlreadyExistsError,
  PendingConnectionCapReachedError,
  ProfessionalSubscriptionRequiredError,
  type ConnectionRepository,
  type InviteCode,
  type ConnectionSpecialty,
} from './connections/repository';
import { PostgresConnectionRepository } from './connections/postgres-repository';
import {
  ProfileConflictError,
  ProfileNotFoundError,
  type ProfileRepository,
  type Role,
} from './profile/repository';
import { PostgresProfileRepository } from './profile/postgres-repository';
import type { SupportMessageRepository } from './support/repository';
import { PostgresSupportMessageRepository } from './support/postgres-repository';
import type { WorkoutLog, WorkoutLogRepository } from './training/workout-log-repository';
import { PostgresWorkoutLogRepository } from './training/postgres-workout-log-repository';
import type { WaterGoalContext, WaterLog, WaterLogRepository } from './nutrition/water-log-repository';
import { PostgresWaterLogRepository } from './nutrition/postgres-water-log-repository';
import type { CustomMeal, CustomMealRepository } from './nutrition/custom-meal-repository';
import { PostgresCustomMealRepository } from './nutrition/postgres-custom-meal-repository';
import {
  MealImageStorageError,
  createMealImageStorage,
  type MealImageStorage,
} from './nutrition/meal-image-storage';
import {
  createMealPhotoAnalyzer,
  MealPhotoAnalyzerError,
  isValidMacroEstimateResult,
  type MealPhotoAnalyzer,
} from './nutrition/meal-photo-analyzer';
import type { PortionLog, PortionLogRepository } from './nutrition/portion-log-repository';
import { PostgresPortionLogRepository } from './nutrition/postgres-portion-log-repository';
import {
  ProfessionalSpecialtyRepositoryError,
  type ProfessionalCredential,
  type ProfessionalSpecialtyRepository,
  type SpecialtyRecord,
} from './professional/specialty-repository';
import { PostgresProfessionalSpecialtyRepository } from './professional/postgres-specialty-repository';
import {
  FoodSearchGatewayError,
  PostgresFoodSearchGateway,
  type FoodSearchGateway,
} from './integrations/food-search-gateway';
import {
  ExerciseSearchGatewayError,
  PostgresExerciseSearchGateway,
  type ExerciseSearchGateway,
} from './integrations/exercise-search-gateway';
import {
  PlanChangeRequestForbiddenError,
  PlanChangeRequestNotFoundError,
  type PlanChangeRequest,
  type PlanChangeRequestRepository,
} from './plans/plan-change-request-repository';
import { PostgresPlanChangeRequestRepository } from './plans/postgres-plan-change-request-repository';
import type {
  NutritionPlanDetail,
  Plan,
  PlanRepository,
  TrainingPlanDetail,
} from './plans/plan-repository';
import { PlanAssignmentTargetError, PlanRepositoryError } from './plans/plan-repository';
import { PostgresPlanRepository } from './plans/postgres-plan-repository';
import { findStarterTemplate, listStarterTemplates } from './plans/starter-templates';

type CreateAppDeps = {
  config?: ServerConfig;
  profileRepository?: ProfileRepository;
  supportMessageRepository?: SupportMessageRepository;
  connectionRepository?: ConnectionRepository;
  workoutLogRepository?: WorkoutLogRepository;
  waterLogRepository?: WaterLogRepository;
  customMealRepository?: CustomMealRepository;
  mealImageStorage?: MealImageStorage;
  mealPhotoAnalyzer?: MealPhotoAnalyzer;
  portionLogRepository?: PortionLogRepository;
  specialtyRepository?: ProfessionalSpecialtyRepository;
  foodSearchGateway?: FoodSearchGateway;
  exerciseSearchGateway?: ExerciseSearchGateway;
  planChangeRequestRepository?: PlanChangeRequestRepository;
  planRepository?: PlanRepository;
  tokenService?: TokenService;
  refreshSessionService?: RefreshSessionServiceType;
  passwordResetService?: PasswordResetService;
  passwordResetDeliveryGateway?: PasswordResetDeliveryGateway;
  emailAuthGateway?: EmailAuthGateway;
  socialAuthGateway?: SocialAuthGateway;
  socialIdentityRepository?: SocialIdentityRepository;
  analyticsEventRepository?: AnalyticsEventRepository;
  subscriptionEntitlementRepository?: SubscriptionEntitlementRepository;
  revenueCatCustomerManager?: RevenueCatCustomerManager;
};

const LOCAL_ACCESS_TOKEN_COOKIE = 'mychampions_access_token';
const WEB_REFRESH_TOKEN_COOKIE = 'mychampions_refresh_token';
const MAX_MEAL_PHOTO_ANALYSIS_IMAGE_BASE64_LENGTH = 6_000_000;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const SENSITIVE_ANALYTICS_PROPERTY_KEYS = new Set([
  'password',
  'token',
  'id_token',
  'access_token',
  'refresh_token',
  'invite_code',
  'code',
  'email',
  'secret',
]);

const REVENUECAT_SIGNATURE_TOLERANCE_SECONDS = 300;

type RevenueCatWebhookEvent = {
  app_user_id?: unknown;
  event_timestamp_ms?: unknown;
  id?: unknown;
  transferred_from?: unknown;
  transferred_to?: unknown;
  type?: unknown;
};

function containsSensitiveAnalyticsProperty(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((item) => containsSensitiveAnalyticsProperty(item));
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (SENSITIVE_ANALYTICS_PROPERTY_KEYS.has(key.toLowerCase())) {
      return true;
    }
    if (containsSensitiveAnalyticsProperty(nestedValue)) {
      return true;
    }
  }

  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseRevenueCatWebhookPayload(rawBody: string): { event: RevenueCatWebhookEvent } | null {
  try {
    const payload = JSON.parse(rawBody) as unknown;
    if (!isRecord(payload) || !isRecord(payload.event)) {
      return null;
    }
    return { event: payload.event };
  } catch {
    return null;
  }
}

function revenueCatWebhookAppUserIds(event: RevenueCatWebhookEvent): string[] {
  const ids = new Set<string>();
  if (typeof event.app_user_id === 'string' && event.app_user_id.trim()) {
    ids.add(event.app_user_id.trim());
  }
  if (event.type === 'TRANSFER') {
    for (const value of [event.transferred_from, event.transferred_to]) {
      if (!Array.isArray(value)) continue;
      for (const appUserId of value) {
        if (typeof appUserId === 'string' && appUserId.trim()) ids.add(appUserId.trim());
      }
    }
  }
  return [...ids];
}

function parseRevenueCatSignatureHeader(header: string): { timestamp: number; signature: string } | null {
  const parts = new Map<string, string>();
  for (const rawPart of header.split(',')) {
    const separatorIndex = rawPart.indexOf('=');
    if (separatorIndex === -1) {
      return null;
    }
    parts.set(rawPart.slice(0, separatorIndex).trim(), rawPart.slice(separatorIndex + 1).trim());
  }

  const timestamp = Number(parts.get('t'));
  const signature = parts.get('v1') ?? '';
  if (!Number.isFinite(timestamp) || !/^[a-f0-9]{64}$/i.test(signature)) {
    return null;
  }
  return { timestamp, signature };
}

function timingSafeHexEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyRevenueCatWebhookSignature(input: {
  rawBody: string;
  signatureHeader: string | null;
  signingSecret: string;
  nowSeconds?: number;
}): boolean {
  if (!input.signatureHeader) {
    return false;
  }
  const parsed = parseRevenueCatSignatureHeader(input.signatureHeader);
  if (!parsed) {
    return false;
  }
  const nowSeconds = input.nowSeconds ?? Date.now() / 1000;
  if (Math.abs(nowSeconds - parsed.timestamp) > REVENUECAT_SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }
  const expectedSignature = createHmac('sha256', input.signingSecret)
    .update(`${parsed.timestamp}.${input.rawBody}`)
    .digest('hex');
  return timingSafeHexEqual(expectedSignature, parsed.signature);
}

function authUidForEmail(emailNormalized: string): string {
  return `local_${Buffer.from(emailNormalized).toString('base64url')}`;
}

function isEmailLike(emailNormalized: string): boolean {
  return emailNormalized.includes('@') && emailNormalized.indexOf('@') > 0;
}

type DevSessionBody = {
  email: string;
  displayName: string;
  authProviderId?: 'email_password' | 'google' | 'apple';
  sessionMode?: 'bearer' | 'cookie';
};

type DevRefreshBody = {
  refreshToken: string;
};

function validationError(set: { status?: number | string }) {
  set.status = 422;
  return { error: { code: 'validation' } };
}

function parseDevSessionBody(body: unknown): DevSessionBody | null {
  if (!isRecord(body)) {
    return null;
  }

  const email = typeof body.email === 'string' ? body.email : null;
  const displayName = typeof body.displayName === 'string' ? body.displayName : null;
  const authProviderId = body.authProviderId;
  const sessionMode = body.sessionMode;

  if (!email || !isEmailLike(normalizeEmail(email)) || !displayName || displayName.trim().length === 0) {
    return null;
  }

  if (
    authProviderId !== undefined &&
    authProviderId !== 'email_password' &&
    authProviderId !== 'google' &&
    authProviderId !== 'apple'
  ) {
    return null;
  }

  if (sessionMode !== undefined && sessionMode !== 'bearer' && sessionMode !== 'cookie') {
    return null;
  }

  return {
    email,
    displayName,
    authProviderId,
    sessionMode,
  };
}

function parseDevRefreshBody(body: unknown): DevRefreshBody | null {
  if (!isRecord(body) || typeof body.refreshToken !== 'string' || body.refreshToken.length === 0) {
    return null;
  }

  return { refreshToken: body.refreshToken };
}

function localAccessTokenCookieOptions(accessToken: string, secure: boolean) {
  return {
    value: accessToken,
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: LOCAL_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
    secure,
  };
}

function webRefreshTokenCookieOptions(
  refreshToken: string,
  secure: boolean,
  crossOrigin: boolean
) {
  return {
    value: refreshToken,
    httpOnly: true,
    sameSite: secure && crossOrigin ? ('none' as const) : ('lax' as const),
    path: '/auth/session',
    maxAge: LOCAL_REFRESH_TOKEN_EXPIRES_IN_SECONDS,
    secure,
  };
}

function clearedCookieOptions(path: string, secure: boolean, crossOrigin = false) {
  return {
    value: '',
    httpOnly: true,
    sameSite: secure && crossOrigin ? ('none' as const) : ('lax' as const),
    path,
    maxAge: 0,
    expires: new Date(0),
    secure,
  };
}

type SessionMode = 'bearer' | 'cookie';

function resolveSessionModeForRequest(
  requestedMode: SessionMode | undefined,
  request: Request,
  allowedWebOrigins: string[]
): SessionMode {
  const origin = request.headers.get('origin');
  if (origin && allowedWebOrigins.includes(origin)) return 'cookie';
  return requestedMode ?? 'bearer';
}

function isAllowedCrossOriginRequest(request: Request, allowedWebOrigins: string[]): boolean {
  const origin = request.headers.get('origin');
  if (!origin || !allowedWebOrigins.includes(origin)) return false;

  try {
    return new URL(origin).origin !== new URL(request.url).origin;
  } catch {
    return false;
  }
}

type AuthCookieJar = Record<
  string,
  {
    value?: unknown;
    set: (
      options:
        | ReturnType<typeof localAccessTokenCookieOptions>
        | ReturnType<typeof webRefreshTokenCookieOptions>
        | ReturnType<typeof clearedCookieOptions>
    ) => void;
  }
>;

function emailAuthGatewayErrorResponse(error: unknown, set: { status?: number | string }) {
  if (!(error instanceof EmailAuthGatewayError)) {
    throw error;
  }

  if (error.code === 'configuration') {
    set.status = 503;
  } else if (error.code === 'invalid_credentials') {
    set.status = 401;
  } else {
    set.status = 409;
  }

  return {
    error: {
      code: error.code,
      message: error.message,
    },
  };
}

function socialAuthGatewayErrorResponse(error: unknown, set: { status?: number | string }) {
  if (!(error instanceof SocialAuthGatewayError)) {
    throw error;
  }

  if (error.code === 'configuration') {
    set.status = 503;
  } else if (error.code === 'invalid_credentials') {
    set.status = 401;
  } else {
    set.status = 409;
  }

  return {
    error: {
      code: error.code,
      message: error.message,
    },
  };
}

function passwordResetDeliveryGatewayErrorResponse(
  error: unknown,
  set: { status?: number | string }
) {
  if (!(error instanceof PasswordResetDeliveryGatewayError)) {
    throw error;
  }

  set.status = error.code === 'configuration' ? 503 : 502;

  return {
    error: {
      code: error.code,
      message: error.message,
    },
  };
}

function inviteCodeResponse(inviteCode: InviteCode) {
  return {
    inviteCode: {
      id: inviteCode.id,
      codeValue: inviteCode.codeValue,
      specialty: inviteCode.specialty,
      status: inviteCode.status,
      rotatedAt: inviteCode.rotatedAt,
      expiresAt: inviteCode.expiresAt,
      createdAt: inviteCode.createdAt,
    },
  };
}

function specialtyRecordResponse(record: SpecialtyRecord) {
  return {
    id: record.id,
    specialty: record.specialty,
    isActive: record.isActive,
    credential: record.credential,
  };
}

function professionalCredentialResponse(credential: ProfessionalCredential) {
  return {
    id: credential.id,
    specialty: credential.specialty,
    credentialType: credential.credentialType,
    registryId: credential.registryId,
    authority: credential.authority,
    country: credential.country,
  };
}

function professionalSpecialtyErrorResponse(error: unknown, set: { status?: number | string }) {
  if (!(error instanceof ProfessionalSpecialtyRepositoryError)) {
    throw error;
  }

  if (error.code === 'not_found') {
    set.status = 404;
  } else if (error.code === 'forbidden') {
    set.status = 403;
  } else {
    set.status = 409;
  }

  return {
    error: {
      code: error.code,
      message: error.message,
    },
  };
}

function workoutLogResponse(log: WorkoutLog) {
  return {
    id: log.id,
    ownerUid: log.ownerAuthUid,
    sessionId: log.sessionId,
    sessionName: log.sessionName,
    createdAt: log.createdAt,
  };
}

function waterLogResponse(log: WaterLog) {
  return {
    id: log.id,
    dateKey: log.dateKey,
    totalMl: log.totalMl,
    loggedAt: log.loggedAt,
  };
}

function portionLogResponse(log: PortionLog) {
  return {
    id: log.id,
    ownerUid: log.ownerAuthUid,
    mealId: log.mealId,
    consumedGrams: log.consumedGrams,
    snapshot: log.snapshot,
    loggedAt: log.loggedAt,
    planId: log.planId ?? null,
    planType: log.planType ?? null,
    sourceKind: log.sourceKind ?? null,
    ownerProfessionalUid: log.ownerProfessionalUid ?? null,
    connectionId: log.connectionId ?? null,
  };
}

function customMealResponse(meal: CustomMeal) {
  return {
    id: meal.id,
    ownerUid: meal.ownerAuthUid,
    name: meal.name,
    totalGrams: meal.totalGrams,
    calories: meal.calories,
    carbs: meal.carbs,
    proteins: meal.proteins,
    fats: meal.fats,
    ingredientCost: meal.ingredientCost,
    imageUrl: meal.imageUrl,
    createdAt: meal.createdAt,
    updatedAt: meal.updatedAt,
  };
}

function planChangeRequestResponse(request: PlanChangeRequest) {
  return {
    id: request.id,
    planId: request.planId,
    planType: request.planType,
    studentUid: request.studentUid,
    requestText: request.requestText,
    status: request.status,
    createdAt: request.createdAt,
  };
}

function planResponse(plan: Plan) {
  const response: Record<string, unknown> = {
    id: plan.id,
    planType: plan.planType,
    sourceKind: plan.sourceKind,
    ownerProfessionalUid: plan.ownerProfessionalUid,
    studentUid: plan.studentUid,
    isArchived: plan.isArchived,
    isDraft: plan.isDraft,
    name: plan.name,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };

  if (plan.planType === 'nutrition') {
    response.hydrationGoalMl = plan.hydrationGoalMl ?? null;
    response.caloriesTarget = plan.caloriesTarget ?? null;
    response.carbsTarget = plan.carbsTarget ?? null;
    response.proteinsTarget = plan.proteinsTarget ?? null;
    response.fatsTarget = plan.fatsTarget ?? null;
  }

  return response;
}

function predefinedPlanResponse(plan: Plan) {
  return {
    id: plan.id,
    planType: plan.planType,
    name: plan.name ?? 'Untitled plan',
    ownerProfessionalUid: plan.ownerProfessionalUid ?? '',
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

function starterTemplateResponse(template: ReturnType<typeof listStarterTemplates>[number]) {
  return {
    id: template.id,
    planType: template.planType,
    name: template.name,
    description: template.description,
  };
}

async function cloneStarterTemplatePlan(input: {
  authUid: string;
  templateId: string;
  name: string;
  planRepository: PlanRepository;
}): Promise<NutritionPlanDetail | TrainingPlanDetail | null> {
  const template = findStarterTemplate(input.templateId);
  if (!template) return null;

  if (template.planType === 'nutrition') {
    const plan = await input.planRepository.createNutritionPlanDetail({
      authUid: input.authUid,
      name: input.name,
      hydrationGoalMl: template.nutritionDefaults?.hydrationGoalMl ?? null,
      mode: 'professional_library',
    });

    for (const mealTemplate of template.nutritionDefaults?.meals ?? []) {
      const meal = await input.planRepository.addNutritionMeal({
        authUid: input.authUid,
        planId: plan.id,
        name: mealTemplate.name,
      });
      for (const itemTemplate of mealTemplate.items) {
        await input.planRepository.addNutritionMealItem({
          authUid: input.authUid,
          planId: plan.id,
          mealId: meal.id,
          item: itemTemplate,
        });
      }
    }

    return input.planRepository.getNutritionPlanDetail({
      authUid: input.authUid,
      planId: plan.id,
    });
  }

  const plan = await input.planRepository.createTrainingPlanDetail({
    authUid: input.authUid,
    name: input.name,
    mode: 'professional_library',
  });

  for (const sessionTemplate of template.trainingDefaults?.sessions ?? []) {
    const session = await input.planRepository.addTrainingSession({
      authUid: input.authUid,
      planId: plan.id,
      name: sessionTemplate.name,
      notes: sessionTemplate.notes,
    });
    for (const itemTemplate of sessionTemplate.items) {
      await input.planRepository.addTrainingSessionItem({
        authUid: input.authUid,
        planId: plan.id,
        sessionId: session.id,
        item: itemTemplate,
      });
    }
  }

  return input.planRepository.getTrainingPlanDetail({
    authUid: input.authUid,
    planId: plan.id,
  });
}

function nutritionPlanDetailResponse(plan: NutritionPlanDetail) {
  return {
    ...planResponse(plan),
    studentAuthUid: plan.studentAuthUid,
    hydrationGoalMl: plan.hydrationGoalMl,
    caloriesTarget: plan.caloriesTarget,
    carbsTarget: plan.carbsTarget,
    proteinsTarget: plan.proteinsTarget,
    fatsTarget: plan.fatsTarget,
    meals: plan.meals,
  };
}

function trainingPlanDetailResponse(plan: TrainingPlanDetail) {
  return {
    ...planResponse(plan),
    studentAuthUid: plan.studentAuthUid,
    sessions: plan.sessions,
  };
}

function planRepositoryErrorResponse(error: unknown, set: { status?: number | string }) {
  if (
    error instanceof ProfessionalSubscriptionRequiredError ||
    (error instanceof Error && error.name === 'ProfessionalSubscriptionRequiredError')
  ) {
    set.status = 402;
    return {
      error: {
        code: 'professional_subscription_required',
        message: error.message,
      },
    };
  }

  if (!(error instanceof PlanRepositoryError)) {
    throw error;
  }

  if (error.code === 'not_found') {
    set.status = 404;
  } else if (error.code === 'forbidden') {
    set.status = 403;
  } else if (error.code === 'invalid_assignment_targets') {
    set.status = 409;
  } else {
    set.status = 400;
  }

  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error instanceof PlanAssignmentTargetError
        ? {
            requiredSpecialty: error.requiredSpecialty,
            invalidStudentUids: error.invalidStudentUids,
          }
        : {}),
    },
  };
}

function sharedMealSnapshotResponse(snapshot: {
  name: string;
  totalGrams: number;
  calories: number;
  carbs: number;
  proteins: number;
  fats: number;
}) {
  return {
    name: snapshot.name,
    totalGrams: snapshot.totalGrams,
    calories: snapshot.calories,
    carbs: snapshot.carbs,
    proteins: snapshot.proteins,
    fats: snapshot.fats,
  };
}

function summarizeStudentConnections(
  rows: Array<{ status: string; specialty: string }>
): {
  assignmentStatus: 'active' | 'pending' | null;
  representativeSpecialty: ConnectionSpecialty;
  nutritionStatus: 'active' | 'pending' | 'none';
  trainingStatus: 'active' | 'pending' | 'none';
} {
  let nutritionStatus: 'active' | 'pending' | 'none' = 'none';
  let trainingStatus: 'active' | 'pending' | 'none' = 'none';

  for (const row of rows) {
    const nextStatus = row.status === 'active'
      ? 'active'
      : row.status === 'pending_confirmation'
        ? 'pending'
        : 'none';
    if (nextStatus === 'none') continue;

    if (row.specialty === 'nutritionist') {
      if (nutritionStatus !== 'active') nutritionStatus = nextStatus;
    } else if (trainingStatus !== 'active') {
      trainingStatus = nextStatus;
    }
  }

  const assignmentStatus = nutritionStatus === 'active' || trainingStatus === 'active'
    ? 'active'
    : nutritionStatus === 'pending' || trainingStatus === 'pending'
      ? 'pending'
      : null;

  return {
    assignmentStatus,
    representativeSpecialty: nutritionStatus !== 'none' ? 'nutritionist' : 'fitness_coach',
    nutritionStatus,
    trainingStatus,
  };
}

function trackingReviewDateWindow(todayKey: string): {
  startDateKey: string;
  endDateKey: string;
  startLoggedAtIso: string;
} {
  const today = new Date(`${todayKey}T00:00:00.000Z`);
  const start = new Date(today.getTime() - 6 * 86_400_000);
  const startDateKey = start.toISOString().slice(0, 10);
  return {
    startDateKey,
    endDateKey: todayKey,
    startLoggedAtIso: `${startDateKey}T00:00:00.000Z`,
  };
}

function effectiveWaterGoalMl(context: WaterGoalContext): number | null {
  if (context.hasActiveNutritionistAssignment && context.nutritionistGoalMl !== null) {
    return context.nutritionistGoalMl;
  }
  return context.studentGoalMl;
}

function isValidDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

function isPositiveNumber(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isValidCustomMealInput(input: {
  name: string;
  totalGrams: number;
  calories: number;
  carbs: number;
  proteins: number;
  fats: number;
  ingredientCost?: number | null;
}): boolean {
  return (
    input.name.trim().length > 0 &&
    Number.isFinite(input.totalGrams) &&
    input.totalGrams > 0 &&
    isPositiveNumber(input.calories) &&
    isPositiveNumber(input.carbs) &&
    isPositiveNumber(input.proteins) &&
    isPositiveNumber(input.fats) &&
    (input.ingredientCost === undefined ||
      input.ingredientCost === null ||
      isPositiveNumber(input.ingredientCost))
  );
}

function normalizeJpegContentType(contentType: string | null): string | null {
  const normalized = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  return normalized === 'image/jpeg' ? 'image/jpeg' : null;
}

function mealImageStorageErrorResponse(error: unknown, set: { status?: number | string }) {
  if (!(error instanceof MealImageStorageError)) {
    throw error;
  }

  set.status = error.code === 'file_too_large' ? 413 : 400;
  return {
    error: {
      code: error.code,
      message: error.message,
    },
  };
}

function mealPhotoAnalyzerErrorResponse(error: unknown, set: { status?: number | string }) {
  if (!(error instanceof MealPhotoAnalyzerError)) {
    throw error;
  }

  if (error.code === 'configuration') {
    set.status = 503;
  } else if (error.code === 'unrecognizable_image' || error.code === 'invalid_response') {
    set.status = 422;
  } else if (error.code === 'quota_exceeded') {
    set.status = 429;
  } else {
    set.status = 500;
  }

  return {
    error: error.code,
    message: error.message,
  };
}

function foodSearchGatewayErrorResponse(error: unknown, set: { status?: number | string }) {
  if (!(error instanceof FoodSearchGatewayError)) {
    throw error;
  }

  set.status = error.code === 'configuration' ? 503 : 502;

  if (error.code === 'upstream') {
    console.error('[food-search] upstream gateway error:', error.message);
    return { error: error.code, message: 'Food catalog search failed.' };
  }

  return {
    error: error.code,
    message: error.message,
  };
}

function exerciseSearchGatewayErrorResponse(error: unknown, set: { status?: number | string }) {
  if (!(error instanceof ExerciseSearchGatewayError)) {
    throw error;
  }

  set.status = error.code === 'configuration' ? 503 : 502;

  if (error.code === 'upstream') {
    console.error('[exercise-search] upstream gateway error:', error.message);
    return { error: error.code, message: 'Exercise catalog search failed.' };
  }

  return {
    error: error.code,
    message: error.message,
  };
}

export function createApp(deps: CreateAppDeps = {}) {
  const config = deps.config ?? readConfig();
  const database =
    deps.profileRepository &&
    deps.supportMessageRepository &&
    deps.connectionRepository &&
    deps.specialtyRepository &&
    deps.planChangeRequestRepository &&
    deps.planRepository
      ? null
      : createDatabase(config.databaseUrl);
  const profileRepository =
    deps.profileRepository ?? new PostgresProfileRepository(database!.db);
  const supportMessageRepository =
    deps.supportMessageRepository ?? new PostgresSupportMessageRepository(database!.db);
  const connectionRepository =
    deps.connectionRepository ?? new PostgresConnectionRepository(database!.db);
  const specialtyRepository =
    deps.specialtyRepository ??
    (database
      ? new PostgresProfessionalSpecialtyRepository(database.db)
      : {
          async listForProfessional() {
            throw new Error('specialty_repository_not_configured');
          },
          async addOrReactivate() {
            throw new Error('specialty_repository_not_configured');
          },
          async getBlockerCounts() {
            throw new Error('specialty_repository_not_configured');
          },
          async removeForProfessional() {
            throw new Error('specialty_repository_not_configured');
          },
          async upsertCredential() {
            throw new Error('specialty_repository_not_configured');
          },
        });
  const workoutLogRepository =
    deps.workoutLogRepository ??
    (database
      ? new PostgresWorkoutLogRepository(database.db)
      : {
          async create() {
            throw new Error('workout_log_repository_not_configured');
          },
          async listSince() {
            throw new Error('workout_log_repository_not_configured');
          },
        });
  const waterLogRepository =
    deps.waterLogRepository ??
    (database
      ? new PostgresWaterLogRepository(database.db)
      : {
          async logIntake() {
            throw new Error('water_log_repository_not_configured');
          },
          async listForOwner() {
            throw new Error('water_log_repository_not_configured');
          },
          async getGoalContext() {
            throw new Error('water_log_repository_not_configured');
          },
        });
  const customMealRepository =
    deps.customMealRepository ??
    (database
      ? new PostgresCustomMealRepository(database.db)
      : {
          async listForOwner() {
            throw new Error('custom_meal_repository_not_configured');
          },
          async getForOwner() {
            throw new Error('custom_meal_repository_not_configured');
          },
          async create() {
            throw new Error('custom_meal_repository_not_configured');
          },
          async updateForOwner() {
            throw new Error('custom_meal_repository_not_configured');
          },
          async deleteForOwner() {
            throw new Error('custom_meal_repository_not_configured');
          },
          async createShareLink() {
            throw new Error('custom_meal_repository_not_configured');
          },
          async previewShare() {
            throw new Error('custom_meal_repository_not_configured');
          },
          async importShare() {
            throw new Error('custom_meal_repository_not_configured');
          },
        });
  const mealImageStorage = deps.mealImageStorage ?? createMealImageStorage(config);
  const mealPhotoAnalyzer = deps.mealPhotoAnalyzer ?? createMealPhotoAnalyzer(config.mealPhotoAnalyzer);
  const foodSearchGateway =
    deps.foodSearchGateway ?? new PostgresFoodSearchGateway(config.foodCatalogDatabaseUrl);
  const exerciseSearchGateway =
    deps.exerciseSearchGateway ?? new PostgresExerciseSearchGateway(config.exerciseCatalogDatabaseUrl);
  const planChangeRequestRepository =
    deps.planChangeRequestRepository ??
    (database
      ? new PostgresPlanChangeRequestRepository(database.db)
      : {
          async create() {
            throw new Error('plan_change_request_repository_not_configured');
          },
          async listForStudent() {
            throw new Error('plan_change_request_repository_not_configured');
          },
          async listForProfessional() {
            throw new Error('plan_change_request_repository_not_configured');
          },
          async review() {
            throw new Error('plan_change_request_repository_not_configured');
          },
        });
  const planRepository =
    deps.planRepository ??
    (database
      ? new PostgresPlanRepository(database.db)
      : {
          async listForAuthUid() {
            throw new Error('plan_repository_not_configured');
          },
          async listPredefinedForOwner() {
            throw new Error('plan_repository_not_configured');
          },
          async bulkAssignPredefined() {
            throw new Error('plan_repository_not_configured');
          },
          async createDraftAssignedFromPredefined() {
            throw new Error('plan_repository_not_configured');
          },
          async createNutritionPlanDetail() {
            throw new Error('plan_repository_not_configured');
          },
          async createTrainingPlanDetail() {
            throw new Error('plan_repository_not_configured');
          },
          async getNutritionPlanDetail() {
            throw new Error('plan_repository_not_configured');
          },
          async updateNutritionPlanDetail() {
            throw new Error('plan_repository_not_configured');
          },
          async addNutritionMeal() {
            throw new Error('plan_repository_not_configured');
          },
          async removeNutritionMeal() {
            throw new Error('plan_repository_not_configured');
          },
          async reorderNutritionMeals() {
            throw new Error('plan_repository_not_configured');
          },
          async addNutritionMealItem() {
            throw new Error('plan_repository_not_configured');
          },
          async removeNutritionMealItem() {
            throw new Error('plan_repository_not_configured');
          },
          async reorderNutritionMealItems() {
            throw new Error('plan_repository_not_configured');
          },
          async getTrainingPlanDetail() {
            throw new Error('plan_repository_not_configured');
          },
          async updateTrainingPlanDetail() {
            throw new Error('plan_repository_not_configured');
          },
          async addTrainingSession() {
            throw new Error('plan_repository_not_configured');
          },
          async removeTrainingSession() {
            throw new Error('plan_repository_not_configured');
          },
          async reorderTrainingSessions() {
            throw new Error('plan_repository_not_configured');
          },
          async addTrainingSessionItem() {
            throw new Error('plan_repository_not_configured');
          },
          async removeTrainingSessionItem() {
            throw new Error('plan_repository_not_configured');
          },
          async reorderTrainingSessionItems() {
            throw new Error('plan_repository_not_configured');
          },
          async deleteNutritionPlan() {
            throw new Error('plan_repository_not_configured');
          },
          async deleteTrainingPlan() {
            throw new Error('plan_repository_not_configured');
          },
        });
  const portionLogRepository =
    deps.portionLogRepository ??
    (database
      ? new PostgresPortionLogRepository(database.db)
      : {
          async create() {
            throw new Error('portion_log_repository_not_configured');
          },
          async listSince() {
            throw new Error('portion_log_repository_not_configured');
          },
        });
  const tokenService =
    deps.tokenService ??
    createTokenService({
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
      signingKey: config.authJwtPrivateJwk ?? undefined,
      signingKeyLoader:
        config.authJwtPrivateJwk || config.production ? undefined : createLocalSigningKeyLoader(),
      requireConfiguredSigningKey: config.production,
    });
  const refreshSessionService =
    deps.refreshSessionService ??
    new RefreshSessionService(
      tokenService,
      // Route tests inject a profile repository but intentionally do not need a database.
      deps.profileRepository
        ? new InMemoryRefreshSessionRepository()
        : database
          ? new PostgresRefreshSessionRepository(database.db)
          : new InMemoryRefreshSessionRepository()
    );
  const emailAuthGateway = deps.emailAuthGateway ?? createEmailAuthGateway(config, database?.db);
  const socialAuthGateway = deps.socialAuthGateway ?? createSocialAuthGateway(config);
  const socialIdentityRepository =
    deps.socialIdentityRepository ??
    (database ? new PostgresSocialIdentityRepository(database.db) : new InMemorySocialIdentityRepository());
  const socialIdentityService = new SocialIdentityService(socialIdentityRepository);
  const passwordResetDeliveryGateway =
    deps.passwordResetDeliveryGateway ?? createPasswordResetDeliveryGateway(config);
  const passwordResetService =
    deps.passwordResetService ??
    (database
      ? new PostgresPasswordResetService(database.db, {
          deliveryGateway: passwordResetDeliveryGateway,
        })
      : new InMemoryPasswordResetService({
          deliveryGateway: passwordResetDeliveryGateway,
        }));
  const analyticsEventRepository =
    deps.analyticsEventRepository ??
    (database
      ? new PostgresAnalyticsEventRepository(database.db)
      : {
          async create() {
            throw new Error('analytics_event_repository_not_configured');
          },
        });
  const subscriptionEntitlementRepository =
    deps.subscriptionEntitlementRepository ??
    (database
      ? new PostgresSubscriptionEntitlementRepository(database.db)
      : {
          async upsertSnapshot() {
            throw new Error('subscription_entitlement_repository_not_configured');
          },
          async upsertSnapshotsAtomically() {
            throw new Error('subscription_entitlement_repository_not_configured');
          },
          async findLatestForAuthUid() {
            throw new Error('subscription_entitlement_repository_not_configured');
          },
        });
  const revenueCatCustomerManager =
    deps.revenueCatCustomerManager ??
    new RevenueCatRestCustomerManager(config.revenueCatSecretApiKey ?? '');

  async function issueProviderAuthSession(
    identity: EmailAuthIdentity | ResolvedSocialIdentity,
    authProviderId: 'email_password' | 'google' | 'apple',
    cookie: AuthCookieJar,
    set: { status?: number | string },
    sessionMode: SessionMode = 'bearer',
    crossOrigin = false
  ) {
    const emailNormalized = normalizeEmail(identity.email);
    const profile = await profileRepository.upsertFromSession({
      authUid: identity.authUid,
      displayName: identity.displayName.trim(),
      emailNormalized,
    });
    const accessToken = await tokenService.issue({
      sub: identity.authUid,
      email: emailNormalized,
      displayName: profile.displayName,
      emailVerified: identity.emailVerified,
    });
    const { refreshToken } = await refreshSessionService.issue({
      sub: identity.authUid,
      email: emailNormalized,
      displayName: profile.displayName,
      emailVerified: identity.emailVerified,
      authProviderId,
    });
    const expiresAt = new Date(Date.now() + LOCAL_ACCESS_TOKEN_EXPIRES_IN_SECONDS * 1000).toISOString();

    set.status = 201;
    if (sessionMode === 'cookie') {
      cookie[LOCAL_ACCESS_TOKEN_COOKIE].set(clearedCookieOptions('/', config.production));
      cookie[WEB_REFRESH_TOKEN_COOKIE].set(
        webRefreshTokenCookieOptions(refreshToken, config.production, crossOrigin)
      );
    } else {
      cookie[LOCAL_ACCESS_TOKEN_COOKIE].set(
        localAccessTokenCookieOptions(accessToken, config.production)
      );
    }
    return {
      accessToken,
      ...(sessionMode === 'bearer' ? { refreshToken } : {}),
      tokenType: 'Bearer',
      expiresAt,
      authProviderIds: [authProviderId],
      emailVerified: identity.emailVerified,
      profile,
    };
  }

  async function refreshAuthSession(
    refreshToken: string,
    sessionMode: SessionMode,
    cookie: AuthCookieJar,
    set: { status?: number | string },
    crossOrigin = false
  ) {
    let claims;
    try {
      claims = await refreshSessionService.verify(refreshToken);
    } catch (error) {
      if (!(error instanceof InvalidRefreshTokenError)) {
        throw error;
      }
      set.status = 401;
      return { error: { code: 'invalid_refresh_token' } };
    }

    const profile = await profileRepository.findByAuthUid(claims.sub);
    if (!profile) {
      set.status = 401;
      return { error: { code: 'invalid_refresh_token' } };
    }

    const authProviderId = claims.authProviderId ?? 'email_password';
    const currentEmailVerified =
      normalizeEmail(claims.email) === profile.emailNormalized && claims.emailVerified;
    const accessToken = await tokenService.issue({
      sub: claims.sub,
      email: profile.emailNormalized,
      displayName: profile.displayName,
      emailVerified: currentEmailVerified,
    });
    let refreshSession;
    try {
      refreshSession = await refreshSessionService.rotate(refreshToken, {
        email: profile.emailNormalized,
        displayName: profile.displayName,
        emailVerified: currentEmailVerified,
      });
    } catch (error) {
      if (!(error instanceof InvalidRefreshTokenError)) {
        throw error;
      }
      set.status = 401;
      return { error: { code: 'invalid_refresh_token' } };
    }
    const nextRefreshToken = refreshSession.refreshToken;
    const expiresAt = new Date(Date.now() + LOCAL_ACCESS_TOKEN_EXPIRES_IN_SECONDS * 1000).toISOString();

    if (sessionMode === 'cookie') {
      cookie[LOCAL_ACCESS_TOKEN_COOKIE].set(clearedCookieOptions('/', config.production));
      cookie[WEB_REFRESH_TOKEN_COOKIE].set(
        webRefreshTokenCookieOptions(nextRefreshToken, config.production, crossOrigin)
      );
    } else {
      cookie[LOCAL_ACCESS_TOKEN_COOKIE].set(
        localAccessTokenCookieOptions(accessToken, config.production)
      );
    }
    return {
      accessToken,
      ...(sessionMode === 'bearer' ? { refreshToken: nextRefreshToken } : {}),
      tokenType: 'Bearer',
      expiresAt,
      authProviderIds: [authProviderId],
      emailVerified: currentEmailVerified,
      profile,
    };
  }

  const app = new Elysia()
    .onRequest(({ request, set }) => {
      const origin = request.headers.get('origin');
      if (origin && !config.allowedWebOrigins.includes(origin)) {
        set.status = 403;
        return { error: { code: 'origin_not_allowed' } };
      }
    })
    .use(
      cors({
        origin: (request) => {
          const origin = request.headers.get('origin');
          return origin !== null && config.allowedWebOrigins.includes(origin);
        },
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
        exposeHeaders: ['X-Request-ID'],
        credentials: true,
        maxAge: 600,
      })
    )
    .use(bearer())
    .use(jwt({ name: 'jwt', secret: config.jwtPluginSecret }))
    .get('/health', () => ({
      status: 'ok',
      service: 'mychampions-server',
      runtime: {
        bunVersion: Bun.version,
      },
    }))
    .get('/.well-known/jwks.json', async () => tokenService.jwks())
    .post(
      '/auth/dev/session',
      async ({ body, cookie, request, set }) => {
        if (!config.localDevAuthEnabled) {
          set.status = 404;
          return { error: { code: 'local_dev_auth_disabled' } };
        }

        const parsedBody = parseDevSessionBody(body);
        if (!parsedBody) {
          return validationError(set);
        }

        const emailNormalized = normalizeEmail(parsedBody.email);
        const authProviderId = parsedBody.authProviderId ?? 'email_password';
        const authUid = authUidForEmail(emailNormalized);
        const profile = await profileRepository.upsertFromSession({
          authUid,
          displayName: parsedBody.displayName.trim(),
          emailNormalized,
        });
        const accessToken = await tokenService.issue({
          sub: authUid,
          email: emailNormalized,
          displayName: profile.displayName,
          emailVerified: false,
        });
        const { refreshToken } = await refreshSessionService.issue({
          sub: authUid,
          email: emailNormalized,
          displayName: profile.displayName,
          emailVerified: false,
          authProviderId,
        });
        const expiresAt = new Date(Date.now() + LOCAL_ACCESS_TOKEN_EXPIRES_IN_SECONDS * 1000).toISOString();
        const sessionMode = resolveSessionModeForRequest(
          parsedBody.sessionMode,
          request,
          config.allowedWebOrigins
        );

        set.status = 201;
        if (sessionMode === 'cookie') {
          cookie[LOCAL_ACCESS_TOKEN_COOKIE].set(clearedCookieOptions('/', config.production));
          cookie[WEB_REFRESH_TOKEN_COOKIE].set(
            webRefreshTokenCookieOptions(
              refreshToken,
              config.production,
              isAllowedCrossOriginRequest(request, config.allowedWebOrigins)
            )
          );
        } else {
          cookie[LOCAL_ACCESS_TOKEN_COOKIE].set(
            localAccessTokenCookieOptions(accessToken, config.production)
          );
        }
        return {
          accessToken,
          ...(sessionMode === 'bearer' ? { refreshToken } : {}),
          tokenType: 'Bearer',
          expiresAt,
          authProviderIds: [authProviderId],
          emailVerified: false,
          profile,
        };
      }
    )
    .post(
      '/auth/dev/refresh',
      async ({ body, cookie, request, set }) => {
        if (!config.localDevAuthEnabled) {
          set.status = 404;
          return { error: { code: 'local_dev_auth_disabled' } };
        }

        const parsedBody = parseDevRefreshBody(body);
        if (!parsedBody) {
          return validationError(set);
        }

        return refreshAuthSession(parsedBody.refreshToken, 'bearer', cookie, set, false);
      }
    )
    .post(
      '/auth/session/refresh',
      async ({ body, cookie, request, set }) => {
        const sessionMode = resolveSessionModeForRequest(
          body?.sessionMode,
          request,
          config.allowedWebOrigins
        );
        const cookieRefreshToken = cookie[WEB_REFRESH_TOKEN_COOKIE].value;
        const refreshToken =
          sessionMode === 'cookie'
            ? typeof cookieRefreshToken === 'string'
              ? cookieRefreshToken
              : null
            : body?.refreshToken ?? null;
        if (!refreshToken) {
          set.status = 401;
          return { error: { code: 'invalid_refresh_token' } };
        }
        return refreshAuthSession(
          refreshToken,
          sessionMode,
          cookie,
          set,
          isAllowedCrossOriginRequest(request, config.allowedWebOrigins)
        );
      },
      {
        body: t.Optional(
          t.Object({
            refreshToken: t.Optional(t.String({ minLength: 1 })),
            sessionMode: t.Optional(t.Union([t.Literal('bearer'), t.Literal('cookie')])),
          })
        ),
      }
    )
    .post(
      '/auth/session/sign-out',
      async ({ body, cookie, request, set }) => {
        const cookieRefreshToken = cookie[WEB_REFRESH_TOKEN_COOKIE].value;
        const refreshTokens = new Set<string>();
        if (typeof cookieRefreshToken === 'string') {
          refreshTokens.add(cookieRefreshToken);
        }
        if (typeof body?.refreshToken === 'string') {
          refreshTokens.add(body.refreshToken);
        }
        const revokeResults = await Promise.allSettled(
          [...refreshTokens].map((refreshToken) => refreshSessionService.revoke(refreshToken))
        );
        const revokeFailed = revokeResults.some((result) => result.status === 'rejected');
        const crossOrigin = isAllowedCrossOriginRequest(request, config.allowedWebOrigins);
        cookie[LOCAL_ACCESS_TOKEN_COOKIE].set(clearedCookieOptions('/', config.production));
        cookie[WEB_REFRESH_TOKEN_COOKIE].set(
          clearedCookieOptions('/auth/session', config.production, crossOrigin)
        );
        if (revokeFailed) {
          set.status = 503;
          return {
            error: {
              code: 'refresh_session_revocation_failed',
              message: 'The local session was cleared, but server revocation must be retried.',
            },
          };
        }
        set.status = 204;
      },
      {
        body: t.Optional(
          t.Object({
            refreshToken: t.Optional(t.String({ minLength: 1 })),
          })
        ),
      }
    )
    .post(
      '/auth/email/sign-in',
      async ({ body, cookie, request, set }) => {
        const emailNormalized = normalizeEmail(body.email);
        if (!isEmailLike(emailNormalized)) {
          set.status = 400;
          return { error: { code: 'invalid_email', message: 'Email is invalid.' } };
        }

        try {
          const identity = await emailAuthGateway.signIn({
            email: emailNormalized,
            password: body.password,
          });
          return await issueProviderAuthSession(
            identity,
            'email_password',
            cookie,
            set,
            resolveSessionModeForRequest(body.sessionMode, request, config.allowedWebOrigins),
            isAllowedCrossOriginRequest(request, config.allowedWebOrigins)
          );
        } catch (error) {
          return emailAuthGatewayErrorResponse(error, set);
        }
      },
      {
        body: t.Object({
          email: t.String({ minLength: 1 }),
          password: t.String({ minLength: 1 }),
          sessionMode: t.Optional(t.Union([t.Literal('bearer'), t.Literal('cookie')])),
        }),
      }
    )
    .post(
      '/auth/email/create-account',
      async ({ body, cookie, request, set }) => {
        const emailNormalized = normalizeEmail(body.email);
        const displayName = body.displayName.trim();
        if (!isEmailLike(emailNormalized)) {
          set.status = 400;
          return { error: { code: 'invalid_email', message: 'Email is invalid.' } };
        }
        if (displayName.length === 0) {
          set.status = 400;
          return { error: { code: 'invalid_display_name', message: 'Display name is required.' } };
        }

        try {
          const identity = await emailAuthGateway.createAccount({
            email: emailNormalized,
            password: body.password,
            displayName,
          });
          return await issueProviderAuthSession(
            identity,
            'email_password',
            cookie,
            set,
            resolveSessionModeForRequest(body.sessionMode, request, config.allowedWebOrigins),
            isAllowedCrossOriginRequest(request, config.allowedWebOrigins)
          );
        } catch (error) {
          return emailAuthGatewayErrorResponse(error, set);
        }
      },
      {
        body: t.Object({
          email: t.String({ minLength: 1 }),
          password: t.String({ minLength: 1 }),
          displayName: t.String({ minLength: 1 }),
          sessionMode: t.Optional(t.Union([t.Literal('bearer'), t.Literal('cookie')])),
        }),
      }
    )
    .post(
      '/auth/social/sign-in',
      async ({ body, cookie, request, set }) => {
        try {
          const verifiedIdentity = await socialAuthGateway.signInWithIdToken({
            provider: body.provider,
            idToken: body.idToken,
            ...(body.accessToken ? { accessToken: body.accessToken } : {}),
            ...(body.nonce ? { nonce: body.nonce } : {}),
          });
          const identity = await socialIdentityService.resolve(verifiedIdentity);
          return await issueProviderAuthSession(
            identity,
            identity.provider,
            cookie,
            set,
            resolveSessionModeForRequest(body.sessionMode, request, config.allowedWebOrigins),
            isAllowedCrossOriginRequest(request, config.allowedWebOrigins)
          );
        } catch (error) {
          return socialAuthGatewayErrorResponse(error, set);
        }
      },
      {
        body: t.Object({
          provider: t.Union([t.Literal('google'), t.Literal('apple')]),
          idToken: t.String({ minLength: 1 }),
          accessToken: t.Optional(t.String({ minLength: 1 })),
          nonce: t.Optional(t.String({ minLength: 1 })),
          sessionMode: t.Optional(t.Union([t.Literal('bearer'), t.Literal('cookie')])),
        }),
      }
    )
    .post(
      '/auth/password-reset',
      async ({ body, set }) => {
        const emailNormalized = normalizeEmail(body.email);
        if (!emailNormalized.includes('@')) {
          set.status = 400;
          return { error: { code: 'invalid_email', message: 'Email is invalid.' } };
        }

        try {
          await passwordResetService.request({ emailNormalized });
        } catch (error) {
          return passwordResetDeliveryGatewayErrorResponse(error, set);
        }

        set.status = 202;
        return { status: 'accepted' };
      },
      {
        body: t.Object({
          email: t.String({ minLength: 1 }),
        }),
      }
    )
    .post(
      '/analytics/events',
      async ({ body, set }) => {
        if (containsSensitiveAnalyticsProperty(body.properties)) {
          set.status = 400;
          return {
            error: {
              code: 'sensitive_analytics_property',
              message: 'Analytics events must not include sensitive property keys.',
            },
          };
        }

        const event = await analyticsEventRepository.create({
          name: body.name,
          properties: body.properties,
        });

        set.status = 202;
        return { id: event.id };
      },
      {
        body: t.Object({
          name: t.Union([
            t.Literal('auth.entry.viewed'),
            t.Literal('auth.sign_in.submitted'),
            t.Literal('auth.sign_in.failed'),
            t.Literal('auth.sign_up.submitted'),
            t.Literal('auth.sign_up.failed'),
            t.Literal('onboarding.role.selected'),
            t.Literal('onboarding.self_guided_start.clicked'),
            t.Literal('invite.submit.requested'),
            t.Literal('invite.submit.failed'),
            t.Literal('invite.pending.created'),
            t.Literal('invite.pending.canceled'),
            t.Literal('invite.pending.confirmed'),
            t.Literal('invite.pending.denied'),
            t.Literal('invite.pending.bulk_denied'),
          ]),
          properties: t.Record(t.String(), t.Any()),
        }),
      }
    )
    .derive(async ({ bearer, cookie, set }) => {
      const cookieAccessToken = cookie[LOCAL_ACCESS_TOKEN_COOKIE].value;
      const accessToken = bearer ?? (typeof cookieAccessToken === 'string' ? cookieAccessToken : null);
      if (!accessToken) {
        return { auth: null };
      }
      try {
        return { auth: await tokenService.verify(accessToken) };
      } catch {
        set.status = 401;
        return { auth: null };
      }
    })
    .post('/webhooks/revenuecat', async ({ request, set }) => {
      if (!config.revenueCatWebhookAuthorization) {
        set.status = 503;
        return {
          error: {
            code: 'revenuecat_webhook_not_configured',
            message: 'RevenueCat webhook authorization is not configured.',
          },
        };
      }

      if (config.production && !config.revenueCatWebhookSigningSecret) {
        // RevenueCat emits this header natively when HMAC signing is enabled:
        // https://www.revenuecat.com/docs/integrations/webhooks#webhook-signature-verification-hmac
        set.status = 503;
        return {
          error: {
            code: 'revenuecat_webhook_signing_not_configured',
            message: 'RevenueCat webhook signing is required in production.',
          },
        };
      }

      const providedAuthorization = request.headers.get('authorization');
      const expectedAuthorization = config.revenueCatWebhookAuthorization;
      if (
        !providedAuthorization ||
        !expectedAuthorization ||
        !timingSafeStringEqual(providedAuthorization, expectedAuthorization)
      ) {
        set.status = 401;
        return {
          error: {
            code: 'invalid_revenuecat_webhook_authorization',
            message: 'Invalid RevenueCat webhook authorization.',
          },
        };
      }

      const rawBody = await request.text();
      if (
        config.revenueCatWebhookSigningSecret &&
        !verifyRevenueCatWebhookSignature({
          rawBody,
          signatureHeader: request.headers.get('x-revenuecat-webhook-signature'),
          signingSecret: config.revenueCatWebhookSigningSecret,
        })
      ) {
        set.status = 401;
        return {
          error: {
            code: 'invalid_revenuecat_webhook_signature',
            message: 'Invalid RevenueCat webhook signature.',
          },
        };
      }

      const payload = parseRevenueCatWebhookPayload(rawBody);
      if (!payload) {
        set.status = 400;
        return {
          error: {
            code: 'invalid_revenuecat_webhook_payload',
            message:
              'RevenueCat webhook requires event.app_user_id or transfer customer identifiers.',
          },
        };
      }

      if (payload.event.type === 'TEST') {
        set.status = 200;
        return { status: 'accepted', reconciledCustomers: 0 };
      }

      const appUserIds = revenueCatWebhookAppUserIds(payload.event);
      if (appUserIds.length === 0) {
        set.status = 400;
        return {
          error: {
            code: 'invalid_revenuecat_webhook_payload',
            message:
              'RevenueCat webhook requires event.app_user_id or transfer customer identifiers.',
          },
        };
      }

      let customerPrivileges;
      try {
        customerPrivileges = await Promise.all(
          appUserIds.map((appUserId) =>
            revenueCatCustomerManager.getCustomerPrivileges(appUserId)
          )
        );
      } catch (error) {
        const configurationFailure =
          error instanceof RevenueCatCustomerManagerError && error.code === 'configuration';
        set.status = configurationFailure ? 503 : 502;
        return {
          error: {
            code: configurationFailure
              ? 'revenuecat_customer_api_not_configured'
              : 'revenuecat_customer_reconciliation_failed',
            message: configurationFailure
              ? 'RevenueCat canonical customer lookup is not configured.'
              : 'RevenueCat canonical customer lookup failed.',
          },
        };
      }

      try {
        await subscriptionEntitlementRepository.upsertSnapshotsAtomically(
          customerPrivileges.map((privileges) => ({
            authUid: privileges.appUserId,
            professionalEntitlementStatus: privileges.professionalEntitlementStatus,
            aiEntitlementStatus: privileges.aiEntitlementStatus,
            professionalEntitlementExpiresAt: privileges.professionalEntitlementExpiresAt,
            professionalEntitlementRenewalRisk: privileges.professionalEntitlementRenewalRisk,
            activeStudentCount: null,
            source: 'revenuecat',
            observedAt: privileges.observedAt,
          }))
        );
      } catch {
        set.status = 503;
        return {
          error: {
            code: 'revenuecat_snapshot_persistence_failed',
            message: 'RevenueCat customer state could not be persisted; retry the delivery.',
          },
        };
      }

      set.status = 200;
      return { status: 'accepted', reconciledCustomers: customerPrivileges.length };
    })
    .get('/me', async ({ auth, set }) => {
      if (!auth?.sub) {
        set.status = 401;
        return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
      }
      const profile = await profileRepository.findByAuthUid(auth.sub);
      if (!profile) {
        set.status = 404;
        return { error: { code: 'profile_not_found', message: 'Profile not found.' } };
      }
      return { profile };
    })
    .post(
      '/subscription/entitlements/snapshot',
      async ({ auth, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        if (config.production) {
          set.status = 403;
          return {
            error: {
              code: 'client_subscription_snapshot_sync_disabled',
              message: 'Client entitlement snapshots are disabled in production.',
            },
          };
        }

        const observedAt = new Date(body.observedAt ?? Date.now());
        if (!Number.isFinite(observedAt.getTime())) {
          set.status = 400;
          return { error: { code: 'invalid_observed_at', message: 'observedAt must be an ISO date.' } };
        }

        const professionalEntitlementExpiresAt = body.professionalEntitlementExpiresAt
          ? new Date(body.professionalEntitlementExpiresAt)
          : null;
        if (
          professionalEntitlementExpiresAt &&
          !Number.isFinite(professionalEntitlementExpiresAt.getTime())
        ) {
          set.status = 400;
          return {
            error: {
              code: 'invalid_professional_entitlement_expiry',
              message: 'professionalEntitlementExpiresAt must be an ISO date or null.',
            },
          };
        }

        const snapshot = await subscriptionEntitlementRepository.upsertSnapshot({
          authUid: auth.sub,
          professionalEntitlementStatus: body.professionalEntitlementStatus,
          aiEntitlementStatus: body.aiEntitlementStatus,
          professionalEntitlementExpiresAt:
            professionalEntitlementExpiresAt?.toISOString() ?? null,
          professionalEntitlementRenewalRisk:
            body.professionalEntitlementRenewalRisk ?? false,
          activeStudentCount: body.activeStudentCount ?? null,
          source: 'revenuecat',
          observedAt: observedAt.toISOString(),
        });

        set.status = 202;
        return { snapshot };
      },
      {
        body: t.Object({
          professionalEntitlementStatus: t.Union([
            t.Literal('active'),
            t.Literal('lapsed'),
            t.Literal('unknown'),
          ]),
          aiEntitlementStatus: t.Union([
            t.Literal('active'),
            t.Literal('lapsed'),
            t.Literal('unknown'),
          ]),
          activeStudentCount: t.Optional(t.Number({ minimum: 0 })),
          professionalEntitlementExpiresAt: t.Optional(
            t.Union([t.String({ minLength: 1 }), t.Null()])
          ),
          professionalEntitlementRenewalRisk: t.Optional(t.Boolean()),
          observedAt: t.Optional(t.String({ minLength: 1 })),
        }),
      }
    )
    .get('/subscription/entitlements/snapshot', async ({ auth, set }) => {
      if (!auth?.sub) {
        set.status = 401;
        return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
      }

      const snapshot = await subscriptionEntitlementRepository.findLatestForAuthUid(auth.sub);
      return { snapshot };
    })
    .post(
      '/me/hydrate',
      async ({ auth, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const emailNormalized = normalizeEmail(body.email || auth.email);
        const profile = await profileRepository.upsertFromSession({
          authUid: auth.sub,
          displayName: (body.displayName || auth.displayName).trim(),
          emailNormalized,
        });

        return { profile };
      },
      {
        body: t.Object({
          email: t.String({ format: 'email' }),
          displayName: t.String(),
        }),
      }
    )
    .patch(
      '/me/role',
      async ({ auth, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }
        try {
          const profile = await profileRepository.lockRole(auth.sub, body.role as Role);
          return { profile };
        } catch (error) {
          if (error instanceof ProfileConflictError || (error as Error).message === 'role_already_locked') {
            set.status = 409;
            return { error: { code: 'role_already_locked', message: 'Role is already locked.' } };
          }
          if (error instanceof ProfileNotFoundError || (error as Error).message === 'profile_not_found') {
            set.status = 404;
            return { error: { code: 'profile_not_found', message: 'Profile not found.' } };
          }
          throw error;
        }
      },
      {
        body: t.Object({
          role: t.Union([t.Literal('student'), t.Literal('professional')]),
        }),
      }
    )
    .patch(
      '/me/terms',
      async ({ auth, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }
        try {
          const profile = await profileRepository.setAcceptedTermsVersion(
            auth.sub,
            body.acceptedTermsVersion
          );
          return { profile };
        } catch (error) {
          if (error instanceof ProfileNotFoundError || (error as Error).message === 'profile_not_found') {
            set.status = 404;
            return { error: { code: 'profile_not_found', message: 'Profile not found.' } };
          }
          throw error;
        }
      },
      {
        body: t.Object({
          acceptedTermsVersion: t.String({ minLength: 1 }),
        }),
      }
    )
    .delete('/me', async ({ auth, set }) => {
      if (!auth?.sub) {
        set.status = 401;
        return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
      }
      await profileRepository.deleteByAuthUid(auth.sub);
      set.status = 204;
      return null;
    })
    .get('/connections', async ({ auth, set }) => {
      if (!auth?.sub) {
        set.status = 401;
        return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
      }

      const connections = await connectionRepository.listForAuthUid(auth.sub);
      return {
        connections: connections.map((connection) => ({
          id: connection.id,
          status: connection.status,
          canceledReason: connection.canceledReason,
          specialty: connection.specialty,
          professionalAuthUid: connection.professionalAuthUid,
        })),
      };
    })
    .get(
      '/professional/invite-codes/:specialty',
      async ({ auth, params, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const inviteCode = await connectionRepository.getOrCreateActiveInviteCode({
          professionalAuthUid: auth.sub,
          specialty: params.specialty as ConnectionSpecialty,
        });
        return inviteCodeResponse(inviteCode);
      },
      {
        params: t.Object({
          specialty: t.Union([t.Literal('nutritionist'), t.Literal('fitness_coach')]),
        }),
      }
    )
    .post(
      '/professional/invite-codes/:specialty/rotate',
      async ({ auth, params, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const inviteCode = await connectionRepository.rotateInviteCode({
          professionalAuthUid: auth.sub,
          specialty: params.specialty as ConnectionSpecialty,
        });
        return inviteCodeResponse(inviteCode);
      },
      {
        params: t.Object({
          specialty: t.Union([t.Literal('nutritionist'), t.Literal('fitness_coach')]),
        }),
      }
    )
    .get('/professional/specialties', async ({ auth, set }) => {
      if (!auth?.sub) {
        set.status = 401;
        return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
      }

      const specialties = await specialtyRepository.listForProfessional(auth.sub);
      return {
        specialties: specialties.map(specialtyRecordResponse),
      };
    })
    .post(
      '/professional/specialties',
      async ({ auth, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const specialty = await specialtyRepository.addOrReactivate({
          professionalAuthUid: auth.sub,
          specialty: body.specialty,
        });
        set.status = 201;
        return { specialty: specialtyRecordResponse(specialty) };
      },
      {
        body: t.Object({
          specialty: t.Union([t.Literal('nutritionist'), t.Literal('fitness_coach')]),
        }),
      }
    )
    .get(
      '/professional/specialties/:specialty/blockers',
      async ({ auth, params, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        return specialtyRepository.getBlockerCounts({
          professionalAuthUid: auth.sub,
          specialty: params.specialty,
        });
      },
      {
        params: t.Object({
          specialty: t.Union([t.Literal('nutritionist'), t.Literal('fitness_coach')]),
        }),
      }
    )
    .delete(
      '/professional/specialties/:specialtyId',
      async ({ auth, params, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          await specialtyRepository.removeForProfessional({
            professionalAuthUid: auth.sub,
            specialtyId: params.specialtyId,
          });
          set.status = 204;
          return undefined;
        } catch (error) {
          return professionalSpecialtyErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          specialtyId: t.String({ minLength: 1 }),
        }),
      }
    )
    .put(
      '/professional/specialties/:specialtyId/credential',
      async ({ auth, params, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const credential = await specialtyRepository.upsertCredential({
            professionalAuthUid: auth.sub,
            specialtyId: params.specialtyId,
            registryId: body.registryId,
            authority: body.authority,
            country: body.country,
          });
          return { credential: professionalCredentialResponse(credential) };
        } catch (error) {
          return professionalSpecialtyErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          specialtyId: t.String({ minLength: 1 }),
        }),
        body: t.Object({
          registryId: t.String({ minLength: 1 }),
          authority: t.String({ minLength: 1 }),
          country: t.String({ minLength: 1 }),
        }),
      }
    )
    .get('/professional/students', async ({ auth, set }) => {
      if (!auth?.sub) {
        set.status = 401;
        return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
      }

      const connections = await connectionRepository.listForAuthUid(auth.sub);
      const byStudent = new Map<string, Array<{ status: string; specialty: string }>>();
      for (const connection of connections) {
        if (connection.professionalAuthUid !== auth.sub) continue;
        if (connection.status !== 'active' && connection.status !== 'pending_confirmation') continue;

        const current = byStudent.get(connection.studentAuthUid) ?? [];
        current.push({ status: connection.status, specialty: connection.specialty });
        byStudent.set(connection.studentAuthUid, current);
      }

      const students = await Promise.all(
        [...byStudent.entries()].map(async ([studentAuthUid, rows]) => {
          const summary = summarizeStudentConnections(rows);
          if (!summary.assignmentStatus) return null;
          const profile = await profileRepository.findByAuthUid(studentAuthUid);
          return {
            studentAuthUid,
            displayName: profile?.displayName?.trim() || studentAuthUid,
            specialty: summary.representativeSpecialty,
            assignmentStatus: summary.assignmentStatus,
            nutritionStatus: summary.nutritionStatus,
            trainingStatus: summary.trainingStatus,
          };
        })
      );

      return {
        students: students
          .filter((student): student is NonNullable<typeof student> => student !== null)
          .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      };
    })
    .get(
      '/professional/students/:studentUid/assignment-snapshot',
      async ({ auth, params, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const connections = await connectionRepository.listForAuthUid(auth.sub);
        const relevant = connections.filter(
          (connection) =>
            connection.professionalAuthUid === auth.sub &&
            connection.studentAuthUid === params.studentUid
        );

        if (relevant.length === 0) {
          set.status = 403;
          return {
            error: {
              code: 'assignment_snapshot_forbidden',
              message: 'A connection to this student is required to read their assignment snapshot.',
            },
          };
        }

        const summary = summarizeStudentConnections(relevant);
        const profile = await profileRepository.findByAuthUid(params.studentUid);

        return {
          snapshot: {
            studentAuthUid: params.studentUid,
            displayName: profile?.displayName?.trim() || params.studentUid,
            nutritionStatus: summary.nutritionStatus,
            trainingStatus: summary.trainingStatus,
            activeConnectionIds: relevant
              .filter((connection) => connection.status === 'active')
              .map((connection) => connection.id),
          },
        };
      },
      {
        params: t.Object({
          studentUid: t.String({ minLength: 1 }),
        }),
      }
    )
    .post(
      '/plans/change-requests',
      async ({ auth, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const requestText = body.requestText.trim();
        if (!requestText) {
          set.status = 400;
          return {
            error: { code: 'invalid_plan_change_request', message: 'Request text is required.' },
          };
        }

        const request = await planChangeRequestRepository.create({
          studentAuthUid: auth.sub,
          planId: body.planId,
          planType: body.planType,
          requestText,
        });

        set.status = 201;
        return { request: planChangeRequestResponse(request) };
      },
      {
        body: t.Object({
          planId: t.String({ minLength: 1 }),
          planType: t.Union([t.Literal('nutrition'), t.Literal('training')]),
          requestText: t.String({ minLength: 1 }),
        }),
      }
    )
    .get('/plans/my', async ({ auth, set }) => {
      if (!auth?.sub) {
        set.status = 401;
        return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
      }

      const plans = await planRepository.listForAuthUid({ authUid: auth.sub });
      return { plans: plans.map(planResponse) };
    })
    .get('/plans/predefined', async ({ auth, set }) => {
      if (!auth?.sub) {
        set.status = 401;
        return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
      }

      const plans = await planRepository.listPredefinedForOwner({ ownerProfessionalUid: auth.sub });
      return { plans: plans.map(predefinedPlanResponse) };
    })
    .get(
      '/plans/starter-templates',
      async ({ auth, query, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const templates = listStarterTemplates(query.planType);
        return { templates: templates.map(starterTemplateResponse) };
      },
      {
        query: t.Object({
          planType: t.Union([t.Literal('nutrition'), t.Literal('training')]),
        }),
      }
    )
    .post(
      '/plans/starter-templates/:templateId/clone',
      async ({ auth, params, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const plan = await cloneStarterTemplatePlan({
            authUid: auth.sub,
            templateId: params.templateId,
            name: body.name.trim(),
            planRepository,
          });
          if (!plan) {
            set.status = 404;
            return { error: { code: 'not_found', message: 'Starter template not found.' } };
          }

          set.status = 201;
          return {
            plan: plan.planType === 'nutrition'
              ? nutritionPlanDetailResponse(plan)
              : trainingPlanDetailResponse(plan),
          };
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          templateId: t.String({ minLength: 1 }),
        }),
        body: t.Object({
          name: t.String({ minLength: 1 }),
        }),
      }
    )
    .post(
      '/plans/predefined/:planId/bulk-assign',
      async ({ auth, params, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          return await planRepository.bulkAssignPredefined({
            professionalAuthUid: auth.sub,
            predefinedPlanId: params.planId,
            studentUids: body.studentUids,
          });
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          planId: t.String({ minLength: 1 }),
        }),
        body: t.Object({
          studentUids: t.Array(t.String({ minLength: 1 }), { minItems: 1 }),
        }),
      }
    )
    .post(
      '/plans/predefined/:planId/draft-assignments',
      async ({ auth, params, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const plan = await planRepository.createDraftAssignedFromPredefined({
            professionalAuthUid: auth.sub,
            predefinedPlanId: params.planId,
            studentUid: body.studentUid,
          });
          set.status = 201;
          return { plan: planResponse(plan) };
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          planId: t.String({ minLength: 1 }),
        }),
        body: t.Object({
          studentUid: t.String({ minLength: 1 }),
        }),
      }
    )
    .post(
      '/plans/nutrition',
      async ({ auth, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const plan = await planRepository.createNutritionPlanDetail({
            authUid: auth.sub,
            name: body.name.trim(),
            hydrationGoalMl: body.hydrationGoalMl,
            mode: body.mode,
          });
          set.status = 201;
          return { plan: nutritionPlanDetailResponse(plan) };
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        body: t.Object({
          name: t.String({ minLength: 1 }),
          hydrationGoalMl: t.Union([t.Number(), t.Null()]),
          mode: t.Union([t.Literal('professional_library'), t.Literal('self_managed')]),
        }),
      }
    )
    .get(
      '/plans/nutrition/:planId',
      async ({ auth, params, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const plan = await planRepository.getNutritionPlanDetail({
            authUid: auth.sub,
            planId: params.planId,
          });
          return { plan: nutritionPlanDetailResponse(plan) };
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          planId: t.String({ minLength: 1 }),
        }),
      }
    )
    .patch(
      '/plans/nutrition/:planId',
      async ({ auth, params, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const plan = await planRepository.updateNutritionPlanDetail({
            authUid: auth.sub,
            planId: params.planId,
            name: body.name.trim(),
            hydrationGoalMl: body.hydrationGoalMl,
            publish: body.publish,
          });
          return { plan: nutritionPlanDetailResponse(plan) };
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          planId: t.String({ minLength: 1 }),
        }),
        body: t.Object({
          name: t.String({ minLength: 1 }),
          hydrationGoalMl: t.Union([t.Number(), t.Null()]),
          publish: t.Optional(t.Boolean()),
        }),
      }
    )
    .post(
      '/plans/nutrition/:planId/meals',
      async ({ auth, params, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const meal = await planRepository.addNutritionMeal({
            authUid: auth.sub,
            planId: params.planId,
            name: body.name.trim(),
          });
          set.status = 201;
          return { meal };
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          planId: t.String({ minLength: 1 }),
        }),
        body: t.Object({
          name: t.String({ minLength: 1 }),
        }),
      }
    )
    .put(
      '/plans/nutrition/:planId/meals/reorder',
      async ({ auth, params, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const plan = await planRepository.reorderNutritionMeals({
            authUid: auth.sub,
            planId: params.planId,
            mealIds: body.mealIds,
          });
          return { plan: nutritionPlanDetailResponse(plan) };
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          planId: t.String({ minLength: 1 }),
        }),
        body: t.Object({
          mealIds: t.Array(t.String({ minLength: 1 })),
        }),
      }
    )
    .delete(
      '/plans/nutrition/:planId/meals/:mealId',
      async ({ auth, params, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const plan = await planRepository.removeNutritionMeal({
            authUid: auth.sub,
            planId: params.planId,
            mealId: params.mealId,
          });
          return { plan: nutritionPlanDetailResponse(plan) };
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          planId: t.String({ minLength: 1 }),
          mealId: t.String({ minLength: 1 }),
        }),
      }
    )
    .post(
      '/plans/nutrition/:planId/meals/:mealId/items',
      async ({ auth, params, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const item = await planRepository.addNutritionMealItem({
            authUid: auth.sub,
            planId: params.planId,
            mealId: params.mealId,
            item: {
              name: body.name.trim(),
              quantity: body.quantity,
              notes: body.notes,
              ...(body.calories !== undefined ? { calories: body.calories } : {}),
              ...(body.carbs !== undefined ? { carbs: body.carbs } : {}),
              ...(body.proteins !== undefined ? { proteins: body.proteins } : {}),
              ...(body.fats !== undefined ? { fats: body.fats } : {}),
              ...(body.sourceKind !== undefined ? { sourceKind: body.sourceKind } : {}),
              ...(body.customMealSnapshot !== undefined ? { customMealSnapshot: body.customMealSnapshot } : {}),
            },
          });
          set.status = 201;
          return { item };
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          planId: t.String({ minLength: 1 }),
          mealId: t.String({ minLength: 1 }),
        }),
        body: t.Object({
          name: t.String({ minLength: 1 }),
          quantity: t.String(),
          notes: t.String(),
          calories: t.Optional(t.Number()),
          carbs: t.Optional(t.Number()),
          proteins: t.Optional(t.Number()),
          fats: t.Optional(t.Number()),
          sourceKind: t.Optional(t.Union([t.Literal('manual'), t.Literal('food_search'), t.Literal('custom_meal')])),
          customMealSnapshot: t.Optional(t.Unknown()),
        }),
      }
    )
    .put(
      '/plans/nutrition/:planId/meals/:mealId/items/reorder',
      async ({ auth, params, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const plan = await planRepository.reorderNutritionMealItems({
            authUid: auth.sub,
            planId: params.planId,
            mealId: params.mealId,
            itemIds: body.itemIds,
          });
          return { plan: nutritionPlanDetailResponse(plan) };
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          planId: t.String({ minLength: 1 }),
          mealId: t.String({ minLength: 1 }),
        }),
        body: t.Object({
          itemIds: t.Array(t.String({ minLength: 1 })),
        }),
      }
    )
    .delete(
      '/plans/nutrition/:planId/meals/:mealId/items/:itemId',
      async ({ auth, params, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const plan = await planRepository.removeNutritionMealItem({
            authUid: auth.sub,
            planId: params.planId,
            mealId: params.mealId,
            itemId: params.itemId,
          });
          return { plan: nutritionPlanDetailResponse(plan) };
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          planId: t.String({ minLength: 1 }),
          mealId: t.String({ minLength: 1 }),
          itemId: t.String({ minLength: 1 }),
        }),
      }
    )
    .delete(
      '/plans/nutrition/:planId',
      async ({ auth, params, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          await planRepository.deleteNutritionPlan({
            authUid: auth.sub,
            planId: params.planId,
          });
          set.status = 204;
          return undefined;
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          planId: t.String({ minLength: 1 }),
        }),
      }
    )
    .post(
      '/plans/training',
      async ({ auth, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const plan = await planRepository.createTrainingPlanDetail({
            authUid: auth.sub,
            name: body.name.trim(),
            mode: body.mode,
          });
          set.status = 201;
          return { plan: trainingPlanDetailResponse(plan) };
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        body: t.Object({
          name: t.String({ minLength: 1 }),
          mode: t.Union([t.Literal('professional_library'), t.Literal('self_managed')]),
        }),
      }
    )
    .get(
      '/plans/training/:planId',
      async ({ auth, params, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const plan = await planRepository.getTrainingPlanDetail({
            authUid: auth.sub,
            planId: params.planId,
          });
          return { plan: trainingPlanDetailResponse(plan) };
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          planId: t.String({ minLength: 1 }),
        }),
      }
    )
    .patch(
      '/plans/training/:planId',
      async ({ auth, params, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const plan = await planRepository.updateTrainingPlanDetail({
            authUid: auth.sub,
            planId: params.planId,
            name: body.name.trim(),
            sessions: body.sessions,
            publish: body.publish,
          });
          return { plan: trainingPlanDetailResponse(plan) };
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          planId: t.String({ minLength: 1 }),
        }),
        body: t.Object({
          name: t.String({ minLength: 1 }),
          publish: t.Optional(t.Boolean()),
          sessions: t.Optional(t.Array(t.Object({
            id: t.String({ minLength: 1 }),
            name: t.String(),
            notes: t.String(),
            items: t.Array(t.Object({
              id: t.String({ minLength: 1 }),
              name: t.String(),
              quantity: t.String(),
              notes: t.String(),
              exerciseId: t.Optional(t.String()),
              ymoveId: t.Optional(t.String()),
            })),
          }))),
        }),
      }
    )
    .post(
      '/plans/training/:planId/sessions',
      async ({ auth, params, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const session = await planRepository.addTrainingSession({
            authUid: auth.sub,
            planId: params.planId,
            name: body.name.trim(),
            notes: body.notes.trim(),
          });
          set.status = 201;
          return { session };
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          planId: t.String({ minLength: 1 }),
        }),
        body: t.Object({
          name: t.String({ minLength: 1 }),
          notes: t.String(),
        }),
      }
    )
    .put(
      '/plans/training/:planId/sessions/reorder',
      async ({ auth, params, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const plan = await planRepository.reorderTrainingSessions({
            authUid: auth.sub,
            planId: params.planId,
            sessionIds: body.sessionIds,
          });
          return { plan: trainingPlanDetailResponse(plan) };
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          planId: t.String({ minLength: 1 }),
        }),
        body: t.Object({
          sessionIds: t.Array(t.String({ minLength: 1 })),
        }),
      }
    )
    .delete(
      '/plans/training/:planId/sessions/:sessionId',
      async ({ auth, params, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const plan = await planRepository.removeTrainingSession({
            authUid: auth.sub,
            planId: params.planId,
            sessionId: params.sessionId,
          });
          return { plan: trainingPlanDetailResponse(plan) };
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          planId: t.String({ minLength: 1 }),
          sessionId: t.String({ minLength: 1 }),
        }),
      }
    )
    .post(
      '/plans/training/:planId/sessions/:sessionId/items',
      async ({ auth, params, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const item = await planRepository.addTrainingSessionItem({
            authUid: auth.sub,
            planId: params.planId,
            sessionId: params.sessionId,
            item: {
              name: body.name.trim(),
              quantity: body.quantity,
              notes: body.notes,
              ...(body.exerciseId !== undefined ? { exerciseId: body.exerciseId } : {}),
              ...(body.ymoveId !== undefined ? { ymoveId: body.ymoveId } : {}),
            },
          });
          set.status = 201;
          return { item };
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          planId: t.String({ minLength: 1 }),
          sessionId: t.String({ minLength: 1 }),
        }),
        body: t.Object({
          name: t.String({ minLength: 1 }),
          quantity: t.String(),
          notes: t.String(),
          exerciseId: t.Optional(t.String()),
          ymoveId: t.Optional(t.String()),
        }),
      }
    )
    .put(
      '/plans/training/:planId/sessions/:sessionId/items/reorder',
      async ({ auth, params, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const plan = await planRepository.reorderTrainingSessionItems({
            authUid: auth.sub,
            planId: params.planId,
            sessionId: params.sessionId,
            itemIds: body.itemIds,
          });
          return { plan: trainingPlanDetailResponse(plan) };
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          planId: t.String({ minLength: 1 }),
          sessionId: t.String({ minLength: 1 }),
        }),
        body: t.Object({
          itemIds: t.Array(t.String({ minLength: 1 })),
        }),
      }
    )
    .delete(
      '/plans/training/:planId/sessions/:sessionId/items/:itemId',
      async ({ auth, params, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const plan = await planRepository.removeTrainingSessionItem({
            authUid: auth.sub,
            planId: params.planId,
            sessionId: params.sessionId,
            itemId: params.itemId,
          });
          return { plan: trainingPlanDetailResponse(plan) };
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          planId: t.String({ minLength: 1 }),
          sessionId: t.String({ minLength: 1 }),
          itemId: t.String({ minLength: 1 }),
        }),
      }
    )
    .delete(
      '/plans/training/:planId',
      async ({ auth, params, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          await planRepository.deleteTrainingPlan({
            authUid: auth.sub,
            planId: params.planId,
          });
          set.status = 204;
          return undefined;
        } catch (error) {
          return planRepositoryErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          planId: t.String({ minLength: 1 }),
        }),
      }
    )
    .get(
      '/professional/plan-change-requests',
      async ({ auth, query, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const requests = await planChangeRequestRepository.listForProfessional({
          professionalAuthUid: auth.sub,
          status: query.status,
        });

        return { requests: requests.map(planChangeRequestResponse) };
      },
      {
        query: t.Object({
          status: t.Optional(t.Union([t.Literal('pending'), t.Literal('reviewed'), t.Literal('dismissed')])),
        }),
      }
    )
    .get(
      '/professional/students/:studentUid/plan-change-requests',
      async ({ auth, params, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const requests = await planChangeRequestRepository.listForStudent({
          professionalAuthUid: auth.sub,
          studentAuthUid: params.studentUid,
        });

        return { requests: requests.map(planChangeRequestResponse) };
      },
      {
        params: t.Object({
          studentUid: t.String({ minLength: 1 }),
        }),
      }
    )
    .patch(
      '/plans/change-requests/:requestId/review',
      async ({ auth, params, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          return await planChangeRequestRepository.review({
            professionalAuthUid: auth.sub,
            requestId: params.requestId,
            status: body.status,
          });
        } catch (error) {
          if (error instanceof PlanChangeRequestNotFoundError) {
            set.status = 404;
            return { error: { code: 'plan_change_request_not_found', message: error.message } };
          }
          if (error instanceof PlanChangeRequestForbiddenError) {
            set.status = 403;
            return { error: { code: 'plan_change_request_forbidden', message: error.message } };
          }
          throw error;
        }
      },
      {
        params: t.Object({
          requestId: t.String({ minLength: 1 }),
        }),
        body: t.Object({
          status: t.Union([t.Literal('reviewed'), t.Literal('dismissed')]),
        }),
      }
    )
    .post(
      '/connections/:connectionId/confirm',
      async ({ auth, params, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const connection = await connectionRepository.confirmPendingConnection({
            connectionId: params.connectionId,
            professionalAuthUid: auth.sub,
          });
          return { connectionId: connection.id, status: 'active' };
        } catch (error) {
          if (error instanceof ConnectionNotFoundError) {
            set.status = 404;
            return { error: 'not_found' };
          }
          if (error instanceof ConnectionForbiddenError) {
            set.status = 403;
            return { error: 'forbidden' };
          }
          if (error instanceof InvalidConnectionTransitionError) {
            set.status = 409;
            return { error: 'invalid_transition' };
          }
          if (error instanceof ConnectionAlreadyExistsError) {
            set.status = 409;
            return { error: 'already_connected' };
          }
          if (
            error instanceof ProfessionalSubscriptionRequiredError ||
            (error instanceof Error && error.name === 'ProfessionalSubscriptionRequiredError')
          ) {
            set.status = 402;
            return { error: 'professional_subscription_required' };
          }
          throw error;
        }
      },
      {
        params: t.Object({
          connectionId: t.String({ minLength: 1 }),
        }),
      }
    )
    .post(
      '/connections/:connectionId/end',
      async ({ auth, params, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const connection = await connectionRepository.endConnection({
            connectionId: params.connectionId,
            authUid: auth.sub,
          });
          return { connectionId: connection.id, status: 'ended' };
        } catch (error) {
          if (error instanceof ConnectionNotFoundError) {
            set.status = 404;
            return { error: 'not_found' };
          }
          if (error instanceof ConnectionForbiddenError) {
            set.status = 403;
            return { error: 'forbidden' };
          }
          throw error;
        }
      },
      {
        params: t.Object({
          connectionId: t.String({ minLength: 1 }),
        }),
      }
    )
    .post(
      '/connections/invite-submissions',
      async ({ auth, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const connection = await connectionRepository.submitInviteCode({
            code: body.code.trim().toUpperCase(),
            studentAuthUid: auth.sub,
          });
          set.status = 201;
          return { connectionId: connection.id, status: 'pending_confirmation' };
        } catch (error) {
          if (error instanceof InviteCodeNotFoundError) {
            set.status = 404;
            return { error: 'not_found' };
          }
          if (error instanceof ConnectionAlreadyExistsError) {
            set.status = 409;
            return { error: 'already_connected' };
          }
          if (error instanceof PendingConnectionAlreadyExistsError) {
            set.status = 409;
            return { error: 'pending_already_exists' };
          }
          if (error instanceof PendingConnectionCapReachedError) {
            set.status = 409;
            return { error: 'pending_cap_reached' };
          }
          throw error;
        }
      },
      {
        body: t.Object({
          code: t.String({ minLength: 1 }),
        }),
      }
    )
    .post(
      '/training/workout-logs',
      async ({ auth, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const sessionId = body.sessionId.trim();
        const sessionName = body.sessionName.trim();
        if (!sessionId || !sessionName) {
          set.status = 400;
          return { error: { code: 'invalid_workout_log', message: 'Session id and name are required.' } };
        }

        const log = await workoutLogRepository.create({
          ownerAuthUid: auth.sub,
          sessionId,
          sessionName,
        });

        set.status = 201;
        return { log: workoutLogResponse(log) };
      },
      {
        body: t.Object({
          sessionId: t.String({ minLength: 1 }),
          sessionName: t.String({ minLength: 1 }),
        }),
      }
    )
    .get(
      '/training/workout-logs',
      async ({ auth, query, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const fromIso = query.from ?? new Date(0).toISOString();
        if (Number.isNaN(Date.parse(fromIso))) {
          set.status = 400;
          return { error: { code: 'invalid_from', message: 'from must be an ISO timestamp.' } };
        }

        const logs = await workoutLogRepository.listSince({
          ownerAuthUid: auth.sub,
          fromIso,
        });
        return { logs: logs.map(workoutLogResponse) };
      },
      {
        query: t.Object({
          from: t.Optional(t.String()),
        }),
      }
    )
    .post(
      '/nutrition/water-logs',
      async ({ auth, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const dateKey = body.dateKey.trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || body.amountMl <= 0) {
          set.status = 400;
          return { error: { code: 'invalid_water_log', message: 'Positive amountMl and YYYY-MM-DD dateKey are required.' } };
        }

        const log = await waterLogRepository.logIntake({
          ownerAuthUid: auth.sub,
          amountMl: body.amountMl,
          dateKey,
        });

        set.status = 201;
        return { log: waterLogResponse(log) };
      },
      {
        body: t.Object({
          amountMl: t.Number({ minimum: 1 }),
          dateKey: t.String({ minLength: 10 }),
        }),
      }
    )
    .get('/nutrition/water-logs', async ({ auth, set }) => {
      if (!auth?.sub) {
        set.status = 401;
        return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
      }

      const logs = await waterLogRepository.listForOwner({ ownerAuthUid: auth.sub });
      return { logs: logs.map(waterLogResponse) };
    })
    .get('/nutrition/water-goal-context', async ({ auth, set }) => {
      if (!auth?.sub) {
        set.status = 401;
        return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
      }

      return waterLogRepository.getGoalContext({ ownerAuthUid: auth.sub });
    })
    .get('/nutrition/custom-meals', async ({ auth, set }) => {
      if (!auth?.sub) {
        set.status = 401;
        return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
      }

      const meals = await customMealRepository.listForOwner({ ownerAuthUid: auth.sub });
      return { meals: meals.map(customMealResponse) };
    })
    .post(
      '/integrations/food/search',
      async ({ auth, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const query = body.query.trim();
        if (!query) {
          set.status = 400;
          return { error: { code: 'invalid_query', message: 'Food search query is required.' } };
        }

        try {
          const results = await foodSearchGateway.search({
            authUid: auth.sub,
            query,
            maxResults: Math.min(body.maxResults ?? 10, 25),
            region: body.region.trim().toLowerCase(),
            language: body.language.trim().toLowerCase(),
          });
          return { results };
        } catch (error) {
          return foodSearchGatewayErrorResponse(error, set);
        }
      },
      {
        body: t.Object({
          query: t.String({ minLength: 1 }),
          maxResults: t.Optional(t.Number({ minimum: 1, maximum: 25 })),
          region: t.String({ minLength: 2 }),
          language: t.String({ minLength: 2 }),
        }),
      }
    )
    .post(
      '/integrations/exercise/search',
      async ({ auth, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const result = await exerciseSearchGateway.search({
            authUid: auth.sub,
            query: body.query.trim(),
            pageSize: Math.min(body.pageSize ?? 20, 50),
            lang: body.lang.trim(),
          });
          return {
            page: result.page,
            pageSize: result.pageSize,
            total: result.total,
            results: result.exercises,
          };
        } catch (error) {
          return exerciseSearchGatewayErrorResponse(error, set);
        }
      },
      {
        body: t.Object({
          query: t.String(),
          pageSize: t.Optional(t.Number({ minimum: 1, maximum: 50 })),
          lang: t.String({ minLength: 2 }),
        }),
      }
    )
    .get(
      '/integrations/exercise/exercises/:exerciseId',
      async ({ auth, params, query, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        try {
          const exercise = await exerciseSearchGateway.getById({
            authUid: auth.sub,
            id: params.exerciseId,
            lang: typeof query.lang === 'string' && query.lang.trim() ? query.lang.trim() : 'en-US',
          });
          if (!exercise) {
            set.status = 404;
            return { error: 'not_found' };
          }
          return exercise;
        } catch (error) {
          return exerciseSearchGatewayErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          exerciseId: t.String({ minLength: 1 }),
        }),
        query: t.Object({
          lang: t.Optional(t.String()),
        }),
      }
    )
    .post(
      '/nutrition/meal-photo-analysis',
      async ({ auth, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const base64Image = body.image.trim();
        if (!base64Image) {
          set.status = 400;
          return {
            error: {
              code: 'invalid_image',
              message: 'Meal photo analysis image must be a non-empty base64 JPEG string.',
            },
          };
        }

        if (base64Image.length > MAX_MEAL_PHOTO_ANALYSIS_IMAGE_BASE64_LENGTH) {
          set.status = 413;
          return {
            error: {
              code: 'file_too_large',
              message: `Meal photo analysis image must be ${MAX_MEAL_PHOTO_ANALYSIS_IMAGE_BASE64_LENGTH} base64 characters or fewer.`,
            },
          };
        }

        try {
          const result = await mealPhotoAnalyzer.analyze({
            base64Image,
            mimeType: body.mimeType,
          });

          if (!isValidMacroEstimateResult(result)) {
            set.status = 502;
            return {
              error: 'invalid_response',
              message: 'Meal photo analyzer returned an invalid macro estimate.',
            };
          }

          return result;
        } catch (error) {
          return mealPhotoAnalyzerErrorResponse(error, set);
        }
      },
      {
        body: t.Object({
          image: t.String({ minLength: 1 }),
          mimeType: t.Literal('image/jpeg'),
        }),
      }
    )
    .post(
      '/nutrition/custom-meal-images/:mealId',
      async ({ auth, params, query, request, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const contentType = normalizeJpegContentType(request.headers.get('content-type'));
        if (!contentType) {
          set.status = 400;
          return {
            error: {
              code: 'invalid_image',
              message: 'Custom meal images must be JPEG files.',
            },
          };
        }

        if (!query.filename) {
          set.status = 400;
          return {
            error: {
              code: 'invalid_image',
              message: 'Custom meal image filename is required.',
            },
          };
        }

        const data = await request.arrayBuffer();
        try {
          const saved = await mealImageStorage.save({
            ownerAuthUid: auth.sub,
            mealId: params.mealId,
            filename: query.filename,
            contentType,
            data,
            requestOrigin: new URL(request.url).origin,
          });
          set.status = 201;
          return saved;
        } catch (error) {
          return mealImageStorageErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          mealId: t.String({ minLength: 1 }),
        }),
        query: t.Object({
          filename: t.String({ minLength: 1 }),
        }),
      }
    )
    .get(
      '/media/custom-meal-images/:ownerAuthUid/:mealId/:filename',
      async ({ auth, params, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        if (auth.sub !== params.ownerAuthUid) {
          set.status = 403;
          return {
            error: {
              code: 'custom_meal_image_forbidden',
              message: 'You do not have access to this custom meal image.',
            },
          };
        }

        try {
          const stored = await mealImageStorage.read(params);
          if (!stored) {
            set.status = 404;
            return {
              error: {
                code: 'custom_meal_image_not_found',
                message: 'Custom meal image not found.',
              },
            };
          }

          return new Response(stored.body, {
            headers: {
              'content-type': stored.contentType,
              'content-length': String(stored.sizeBytes),
            },
          });
        } catch (error) {
          return mealImageStorageErrorResponse(error, set);
        }
      },
      {
        params: t.Object({
          ownerAuthUid: t.String({ minLength: 1 }),
          mealId: t.String({ minLength: 1 }),
          filename: t.String({ minLength: 1 }),
        }),
      }
    )
    .get(
      '/nutrition/custom-meals/:mealId',
      async ({ auth, params, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const meal = await customMealRepository.getForOwner({
          ownerAuthUid: auth.sub,
          mealId: params.mealId,
        });
        if (!meal) {
          set.status = 404;
          return {
            error: {
              code: 'custom_meal_not_found',
              message: 'Custom meal not found.',
            },
          };
        }

        return { meal: customMealResponse(meal) };
      },
      {
        params: t.Object({
          mealId: t.String({ minLength: 1 }),
        }),
      }
    )
    .post(
      '/nutrition/custom-meals',
      async ({ auth, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        if (!isValidCustomMealInput(body)) {
          set.status = 400;
          return {
            error: {
              code: 'invalid_custom_meal',
              message: 'Custom meals require a name, positive totalGrams, and non-negative nutrition values.',
            },
          };
        }

        const meal = await customMealRepository.create({
          ownerAuthUid: auth.sub,
          name: body.name.trim(),
          totalGrams: body.totalGrams,
          calories: body.calories,
          carbs: body.carbs,
          proteins: body.proteins,
          fats: body.fats,
          ingredientCost: body.ingredientCost ?? null,
          imageUrl: body.imageUrl ?? null,
          importedFromShareToken: null,
        });

        set.status = 201;
        return { meal: customMealResponse(meal) };
      },
      {
        body: t.Object({
          name: t.String({ minLength: 1 }),
          totalGrams: t.Number({ minimum: 0 }),
          calories: t.Number({ minimum: 0 }),
          carbs: t.Number({ minimum: 0 }),
          proteins: t.Number({ minimum: 0 }),
          fats: t.Number({ minimum: 0 }),
          ingredientCost: t.Optional(t.Union([t.Number({ minimum: 0 }), t.Null()])),
          imageUrl: t.Optional(t.Union([t.String(), t.Null()])),
        }),
      }
    )
    .put(
      '/nutrition/custom-meals/:mealId',
      async ({ auth, params, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        if (!isValidCustomMealInput(body)) {
          set.status = 400;
          return {
            error: {
              code: 'invalid_custom_meal',
              message: 'Custom meals require a name, positive totalGrams, and non-negative nutrition values.',
            },
          };
        }

        const meal = await customMealRepository.updateForOwner({
          ownerAuthUid: auth.sub,
          mealId: params.mealId,
          name: body.name.trim(),
          totalGrams: body.totalGrams,
          calories: body.calories,
          carbs: body.carbs,
          proteins: body.proteins,
          fats: body.fats,
          ingredientCost: body.ingredientCost ?? null,
          imageUrl: body.imageUrl ?? null,
          importedFromShareToken: null,
        });

        if (!meal) {
          set.status = 404;
          return {
            error: {
              code: 'custom_meal_not_found',
              message: 'Custom meal not found.',
            },
          };
        }

        return { meal: customMealResponse(meal) };
      },
      {
        params: t.Object({
          mealId: t.String({ minLength: 1 }),
        }),
        body: t.Object({
          name: t.String({ minLength: 1 }),
          totalGrams: t.Number({ minimum: 0 }),
          calories: t.Number({ minimum: 0 }),
          carbs: t.Number({ minimum: 0 }),
          proteins: t.Number({ minimum: 0 }),
          fats: t.Number({ minimum: 0 }),
          ingredientCost: t.Optional(t.Union([t.Number({ minimum: 0 }), t.Null()])),
          imageUrl: t.Optional(t.Union([t.String(), t.Null()])),
        }),
      }
    )
    .delete(
      '/nutrition/custom-meals/:mealId',
      async ({ auth, params, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const deleted = await customMealRepository.deleteForOwner({
          ownerAuthUid: auth.sub,
          mealId: params.mealId,
        });
        if (!deleted) {
          set.status = 404;
          return {
            error: {
              code: 'custom_meal_not_found',
              message: 'Custom meal not found.',
            },
          };
        }

        set.status = 204;
        return undefined;
      },
      {
        params: t.Object({
          mealId: t.String({ minLength: 1 }),
        }),
      }
    )
    .post(
      '/nutrition/custom-meals/:mealId/share-links',
      async ({ auth, params, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const link = await customMealRepository.createShareLink({
          ownerAuthUid: auth.sub,
          mealId: params.mealId,
        });

        if (!link) {
          set.status = 404;
          return {
            error: {
              code: 'custom_meal_not_found',
              message: 'Custom meal not found.',
            },
          };
        }

        set.status = 201;
        return { shareLinkId: link.id };
      },
      {
        params: t.Object({
          mealId: t.String({ minLength: 1 }),
        }),
      }
    )
    .get(
      '/nutrition/custom-meal-shares/:shareToken',
      async ({ params, set }) => {
        const snapshot = await customMealRepository.previewShare({
          shareToken: params.shareToken,
        });

        if (!snapshot) {
          set.status = 404;
          return {
            error: {
              code: 'share_link_not_found',
              message: 'Shared meal not found.',
            },
          };
        }

        return { snapshot: sharedMealSnapshotResponse(snapshot) };
      },
      {
        params: t.Object({
          shareToken: t.String({ minLength: 1 }),
        }),
      }
    )
    .post(
      '/nutrition/custom-meal-shares/:shareToken/import',
      async ({ auth, params, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const meal = await customMealRepository.importShare({
          ownerAuthUid: auth.sub,
          shareToken: params.shareToken,
        });

        if (!meal) {
          set.status = 404;
          return {
            error: {
              code: 'share_link_not_found',
              message: 'Shared meal not found.',
            },
          };
        }

        set.status = 201;
        return { meal: customMealResponse(meal) };
      },
      {
        params: t.Object({
          shareToken: t.String({ minLength: 1 }),
        }),
      }
    )
    .get(
      '/professional/students/:studentUid/tracking-review',
      async ({ auth, params, query, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const todayKey = query.todayKey.trim();
        if (!isValidDateKey(todayKey)) {
          set.status = 400;
          return { error: { code: 'invalid_today_key', message: 'todayKey must be YYYY-MM-DD.' } };
        }

        const connections = await connectionRepository.listForAuthUid(auth.sub);
        const hasActiveNutritionConnection = connections.some(
          (connection) =>
            connection.status === 'active' &&
            connection.specialty === 'nutritionist' &&
            connection.professionalAuthUid === auth.sub &&
            connection.studentAuthUid === params.studentUid
        );

        if (!hasActiveNutritionConnection) {
          set.status = 403;
          return {
            error: {
              code: 'tracking_review_forbidden',
              message: 'Active nutritionist connection is required to read student tracking review.',
            },
          };
        }

        const dateWindow = trackingReviewDateWindow(todayKey);
        const [waterLogs, portionLogs, goalContext] = await Promise.all([
          waterLogRepository.listForOwner({ ownerAuthUid: params.studentUid }),
          portionLogRepository.listSince({
            ownerAuthUid: params.studentUid,
            fromIso: dateWindow.startLoggedAtIso,
          }),
          waterLogRepository.getGoalContext({ ownerAuthUid: params.studentUid }),
        ]);

        return {
          waterLogs: waterLogs
            .filter((log) => log.dateKey >= dateWindow.startDateKey && log.dateKey <= dateWindow.endDateKey)
            .map(waterLogResponse),
          waterGoalMl: effectiveWaterGoalMl(goalContext),
          portionLogs: portionLogs.map(portionLogResponse),
        };
      },
      {
        params: t.Object({
          studentUid: t.String({ minLength: 1 }),
        }),
        query: t.Object({
          todayKey: t.String({ minLength: 10 }),
        }),
      }
    )
    .post(
      '/nutrition/portion-logs',
      async ({ auth, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const mealId = body.mealId.trim();
        const snapshot = body.snapshot;
        if (
          !mealId ||
          body.consumedGrams < 0 ||
          !isPositiveNumber(snapshot.calories) ||
          !isPositiveNumber(snapshot.carbs) ||
          !isPositiveNumber(snapshot.proteins) ||
          !isPositiveNumber(snapshot.fats)
        ) {
          set.status = 400;
          return {
            error: {
              code: 'invalid_portion_log',
              message: 'Portion logs require a mealId, non-negative consumedGrams, and non-negative snapshot macros.',
            },
          };
        }

        const log = await portionLogRepository.create({
          ownerAuthUid: auth.sub,
          mealId,
          consumedGrams: body.consumedGrams,
          snapshot,
          planId: body.planId ?? null,
          planType: body.planType ?? null,
          sourceKind: body.sourceKind ?? null,
          ownerProfessionalUid: body.ownerProfessionalUid ?? null,
          connectionId: body.connectionId ?? null,
        });

        set.status = 201;
        return { log: portionLogResponse(log) };
      },
      {
        body: t.Object({
          mealId: t.String({ minLength: 1 }),
          consumedGrams: t.Number({ minimum: 0 }),
          snapshot: t.Object({
            calories: t.Number({ minimum: 0 }),
            carbs: t.Number({ minimum: 0 }),
            proteins: t.Number({ minimum: 0 }),
            fats: t.Number({ minimum: 0 }),
          }),
          planId: t.Optional(t.Union([t.String(), t.Null()])),
          planType: t.Optional(t.Union([t.Literal('nutrition'), t.Null()])),
          sourceKind: t.Optional(t.Union([t.Literal('assigned'), t.Literal('predefined'), t.Literal('self_managed'), t.Null()])),
          ownerProfessionalUid: t.Optional(t.Union([t.String(), t.Null()])),
          connectionId: t.Optional(t.Union([t.String(), t.Null()])),
        }),
      }
    )
    .get(
      '/nutrition/portion-logs',
      async ({ auth, query, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const fromIso = query.from ?? new Date(0).toISOString();
        if (Number.isNaN(Date.parse(fromIso))) {
          set.status = 400;
          return { error: { code: 'invalid_from', message: 'from must be an ISO timestamp.' } };
        }

        const logs = await portionLogRepository.listSince({
          ownerAuthUid: auth.sub,
          fromIso,
        });
        return { logs: logs.map(portionLogResponse) };
      },
      {
        query: t.Object({
          from: t.Optional(t.String()),
        }),
      }
    )
    .post(
      '/support/messages',
      async ({ auth, body, set }) => {
        if (!auth?.sub) {
          set.status = 401;
          return { error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } };
        }

        const subject = body.subject.trim();
        const messageBody = body.body.trim();
        if (!subject || !messageBody || subject.length > 50 || messageBody.length > 500) {
          set.status = 400;
          return {
            error: {
              code: 'invalid_support_message',
              message: 'Support subject and body must be non-empty and within limits.',
            },
          };
        }

        const message = await supportMessageRepository.create({
          authUid: auth.sub,
          userEmail: auth.email,
          userName: auth.displayName,
          userRole: body.userRole?.trim() || 'unknown',
          subject,
          body: messageBody,
          appVersion: body.appVersion.trim() || 'unknown',
          platform: body.platform,
        });

        set.status = 201;
        return { id: message.id };
      },
      {
        body: t.Object({
          subject: t.String({ minLength: 1, maxLength: 50 }),
          body: t.String({ minLength: 1, maxLength: 500 }),
          userRole: t.Optional(t.String()),
          appVersion: t.String(),
          platform: t.Union([t.Literal('ios'), t.Literal('android'), t.Literal('web')]),
        }),
      }
    );

  return app;
}
