import { boolean, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const userProfiles = pgTable('user_profiles', {
  authUid: text('auth_uid').primaryKey(),
  displayName: text('display_name').notNull(),
  emailNormalized: text('email_normalized').notNull(),
  lockedRole: text('locked_role', { enum: ['student', 'professional'] }),
  acceptedTermsVersion: text('accepted_terms_version'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UserProfileRow = typeof userProfiles.$inferSelect;
export type NewUserProfileRow = typeof userProfiles.$inferInsert;

export const localEmailAuthCredentials = pgTable(
  'local_email_auth_credentials',
  {
    authUid: text('auth_uid').primaryKey(),
    emailNormalized: text('email_normalized').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('local_email_auth_credentials_email_idx').on(table.emailNormalized),
  ]
);

export type LocalEmailAuthCredentialRow = typeof localEmailAuthCredentials.$inferSelect;
export type NewLocalEmailAuthCredentialRow = typeof localEmailAuthCredentials.$inferInsert;

export const authIdentities = pgTable(
  'auth_identities',
  {
    provider: text('provider', { enum: ['google', 'apple'] }).notNull(),
    providerSubject: text('provider_subject').notNull(),
    authUid: text('auth_uid').notNull(),
    emailNormalized: text('email_normalized').notNull(),
    displayName: text('display_name').notNull(),
    emailVerified: boolean('email_verified').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.provider, table.providerSubject],
      name: 'auth_identities_provider_subject_pk',
    }),
    index('auth_identities_auth_uid_idx').on(table.authUid),
  ]
);

export type AuthIdentityRow = typeof authIdentities.$inferSelect;
export type NewAuthIdentityRow = typeof authIdentities.$inferInsert;

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    authUid: text('auth_uid').notNull(),
    refreshTokenDigest: text('refresh_token_digest').notNull(),
    authProviderId: text('auth_provider_id', {
      enum: ['email_password', 'google', 'apple'],
    }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedBySessionId: text('replaced_by_session_id'),
  },
  (table) => [
    index('auth_sessions_auth_uid_idx').on(table.authUid),
    index('auth_sessions_expires_at_idx').on(table.expiresAt),
  ]
);

export type AuthSessionRow = typeof authSessions.$inferSelect;
export type NewAuthSessionRow = typeof authSessions.$inferInsert;

export const supportMessages = pgTable('support_messages', {
  id: text('id').primaryKey(),
  authUid: text('auth_uid').notNull(),
  userEmail: text('user_email').notNull(),
  userName: text('user_name').notNull(),
  userRole: text('user_role').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  status: text('status', { enum: ['pending', 'reviewed', 'resolved'] }).notNull().default('pending'),
  appVersion: text('app_version').notNull(),
  platform: text('platform', { enum: ['ios', 'android', 'web'] }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type SupportMessageRow = typeof supportMessages.$inferSelect;
export type NewSupportMessageRow = typeof supportMessages.$inferInsert;

export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().$type<
      | 'auth.entry.viewed'
      | 'auth.sign_in.submitted'
      | 'auth.sign_in.failed'
      | 'auth.sign_up.submitted'
      | 'auth.sign_up.failed'
      | 'onboarding.role.selected'
      | 'onboarding.self_guided_start.clicked'
      | 'invite.submit.requested'
      | 'invite.submit.failed'
      | 'invite.pending.created'
      | 'invite.pending.canceled'
      | 'invite.pending.confirmed'
      | 'invite.pending.denied'
      | 'invite.pending.bulk_denied'
    >(),
    properties: jsonb('properties').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('analytics_events_name_created_idx').on(table.name, table.createdAt),
  ]
);

export type AnalyticsEventRow = typeof analyticsEvents.$inferSelect;
export type NewAnalyticsEventRow = typeof analyticsEvents.$inferInsert;

export const subscriptionEntitlementSnapshots = pgTable(
  'subscription_entitlement_snapshots',
  {
    authUid: text('auth_uid').primaryKey(),
    professionalEntitlementStatus: text('professional_entitlement_status', {
      enum: ['active', 'lapsed', 'unknown'],
    }).notNull(),
    aiEntitlementStatus: text('ai_entitlement_status', {
      enum: ['active', 'lapsed', 'unknown'],
    }).notNull(),
    professionalEntitlementExpiresAt: timestamp('professional_entitlement_expires_at', {
      withTimezone: true,
    }),
    professionalEntitlementRenewalRisk: boolean('professional_entitlement_renewal_risk')
      .notNull()
      .default(false),
    activeStudentCount: integer('active_student_count'),
    source: text('source', { enum: ['revenuecat'] }).notNull().default('revenuecat'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('subscription_entitlement_snapshots_observed_idx').on(table.observedAt),
  ]
);

export type SubscriptionEntitlementSnapshotRow = typeof subscriptionEntitlementSnapshots.$inferSelect;
export type NewSubscriptionEntitlementSnapshotRow = typeof subscriptionEntitlementSnapshots.$inferInsert;

export const passwordResetRequests = pgTable(
  'password_reset_requests',
  {
    id: text('id').primaryKey(),
    emailNormalized: text('email_normalized').notNull(),
    status: text('status', { enum: ['pending', 'consumed'] }).notNull().default('pending'),
    tokenDigest: text('token_digest').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [
    index('password_reset_requests_email_requested_idx').on(table.emailNormalized, table.requestedAt),
    index('password_reset_requests_expires_idx').on(table.expiresAt),
  ]
);

export type PasswordResetRequestRow = typeof passwordResetRequests.$inferSelect;
export type NewPasswordResetRequestRow = typeof passwordResetRequests.$inferInsert;

export const passwordResetDeliveryArtifacts = pgTable(
  'password_reset_delivery_artifacts',
  {
    requestId: text('request_id')
      .primaryKey()
      .references(() => passwordResetRequests.id, { onDelete: 'cascade' }),
    emailNormalized: text('email_normalized').notNull(),
    channel: text('channel', { enum: ['local_debug_outbox'] }).notNull(),
    resetToken: text('reset_token').notNull(),
    resetUrl: text('reset_url').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('password_reset_delivery_email_created_idx').on(
      table.emailNormalized,
      table.createdAt
    ),
    index('password_reset_delivery_expires_idx').on(table.expiresAt),
  ]
);

export type PasswordResetDeliveryArtifactRow = typeof passwordResetDeliveryArtifacts.$inferSelect;
export type NewPasswordResetDeliveryArtifactRow = typeof passwordResetDeliveryArtifacts.$inferInsert;

export const connections = pgTable('connections', {
  id: text('id').primaryKey(),
  status: text('status', { enum: ['invited', 'pending_confirmation', 'active', 'ended'] }).notNull(),
  canceledReason: text('canceled_reason', { enum: ['code_rotated'] }),
  specialty: text('specialty', { enum: ['nutritionist', 'fitness_coach'] }).notNull(),
  professionalAuthUid: text('professional_auth_uid').notNull(),
  studentAuthUid: text('student_auth_uid').notNull(),
  sourceInviteCodeId: text('source_invite_code_id'),
  sourceInviteCodeValue: text('source_invite_code_value'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
});

export type ConnectionRow = typeof connections.$inferSelect;
export type NewConnectionRow = typeof connections.$inferInsert;

export const inviteCodes = pgTable(
  'invite_codes',
  {
    id: text('id').primaryKey(),
    professionalAuthUid: text('professional_auth_uid').notNull(),
    specialty: text('specialty', { enum: ['nutritionist', 'fitness_coach'] }).notNull(),
    codeValue: text('code_value').notNull(),
    status: text('status', { enum: ['active', 'rotated', 'revoked'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('invite_codes_code_value_idx').on(table.codeValue)]
);

export type InviteCodeRow = typeof inviteCodes.$inferSelect;
export type NewInviteCodeRow = typeof inviteCodes.$inferInsert;

export const connectionInviteGuards = pgTable('connection_invite_guards', {
  id: text('id').primaryKey(),
  connectionId: text('connection_id').notNull(),
  professionalAuthUid: text('professional_auth_uid').notNull(),
  studentAuthUid: text('student_auth_uid').notNull(),
  specialty: text('specialty', { enum: ['nutritionist', 'fitness_coach'] }).notNull(),
  status: text('status', { enum: ['pending_confirmation'] }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ConnectionInviteGuardRow = typeof connectionInviteGuards.$inferSelect;
export type NewConnectionInviteGuardRow = typeof connectionInviteGuards.$inferInsert;

export const pendingStudents = pgTable(
  'pending_students',
  {
    id: text('id').primaryKey(),
    professionalAuthUid: text('professional_auth_uid').notNull(),
    studentAuthUid: text('student_auth_uid').notNull(),
    slotId: text('slot_id').notNull(),
    nutritionistConnectionId: text('nutritionist_connection_id'),
    fitnessCoachConnectionId: text('fitness_coach_connection_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('pending_students_professional_student_idx').on(table.professionalAuthUid, table.studentAuthUid),
  ]
);

export type PendingStudentRow = typeof pendingStudents.$inferSelect;
export type NewPendingStudentRow = typeof pendingStudents.$inferInsert;

export const pendingStudentSlots = pgTable(
  'pending_student_slots',
  {
    id: text('id').primaryKey(),
    professionalAuthUid: text('professional_auth_uid').notNull(),
    slotId: text('slot_id').notNull(),
    studentAuthUid: text('student_auth_uid'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('pending_student_slots_professional_slot_idx').on(table.professionalAuthUid, table.slotId),
  ]
);

export type PendingStudentSlotRow = typeof pendingStudentSlots.$inferSelect;
export type NewPendingStudentSlotRow = typeof pendingStudentSlots.$inferInsert;

export const trackingAccess = pgTable('tracking_access', {
  id: text('id').primaryKey(),
  studentAuthUid: text('student_auth_uid').notNull(),
  professionalAuthUid: text('professional_auth_uid').notNull(),
  specialty: text('specialty', { enum: ['nutritionist', 'fitness_coach'] }).notNull(),
  connectionId: text('connection_id').notNull(),
  status: text('status', { enum: ['active', 'ended'] }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type TrackingAccessRow = typeof trackingAccess.$inferSelect;
export type NewTrackingAccessRow = typeof trackingAccess.$inferInsert;

export const activeSpecialties = pgTable(
  'active_specialties',
  {
    id: text('id').primaryKey(),
    studentAuthUid: text('student_auth_uid').notNull(),
    professionalAuthUid: text('professional_auth_uid').notNull(),
    specialty: text('specialty', { enum: ['nutritionist', 'fitness_coach'] }).notNull(),
    connectionId: text('connection_id').notNull(),
    status: text('status', { enum: ['active', 'ended'] }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('active_specialties_student_specialty_idx').on(table.studentAuthUid, table.specialty),
  ]
);

export type ActiveSpecialtyRow = typeof activeSpecialties.$inferSelect;
export type NewActiveSpecialtyRow = typeof activeSpecialties.$inferInsert;

export const professionalSpecialties = pgTable(
  'professional_specialties',
  {
    id: text('id').primaryKey(),
    professionalAuthUid: text('professional_auth_uid').notNull(),
    specialty: text('specialty', { enum: ['nutritionist', 'fitness_coach'] }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('professional_specialties_owner_specialty_idx').on(table.professionalAuthUid, table.specialty),
  ]
);

export type ProfessionalSpecialtyRow = typeof professionalSpecialties.$inferSelect;
export type NewProfessionalSpecialtyRow = typeof professionalSpecialties.$inferInsert;

export const professionalCredentials = pgTable('professional_credentials', {
  id: text('id').primaryKey(),
  specialtyId: text('specialty_id').notNull(),
  professionalAuthUid: text('professional_auth_uid').notNull(),
  specialty: text('specialty', { enum: ['nutritionist', 'fitness_coach'] }).notNull(),
  credentialType: text('credential_type', { enum: ['professional_registry'] }).notNull(),
  registryId: text('registry_id').notNull(),
  authority: text('authority').notNull(),
  country: text('country').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ProfessionalCredentialRow = typeof professionalCredentials.$inferSelect;
export type NewProfessionalCredentialRow = typeof professionalCredentials.$inferInsert;

export const workoutLogs = pgTable(
  'workout_logs',
  {
    id: text('id').primaryKey(),
    ownerAuthUid: text('owner_auth_uid').notNull(),
    sessionId: text('session_id').notNull(),
    sessionName: text('session_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('workout_logs_owner_created_at_idx').on(table.ownerAuthUid, table.createdAt),
  ]
);

export type WorkoutLogRow = typeof workoutLogs.$inferSelect;
export type NewWorkoutLogRow = typeof workoutLogs.$inferInsert;

export const waterLogs = pgTable(
  'water_logs',
  {
    id: text('id').primaryKey(),
    ownerAuthUid: text('owner_auth_uid').notNull(),
    dateKey: text('date_key').notNull(),
    totalMl: integer('total_ml').notNull(),
    loggedAt: timestamp('logged_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('water_logs_owner_date_key_idx').on(table.ownerAuthUid, table.dateKey),
  ]
);

export type WaterLogRow = typeof waterLogs.$inferSelect;
export type NewWaterLogRow = typeof waterLogs.$inferInsert;

export const nutritionPlans = pgTable(
  'nutrition_plans',
  {
    id: text('id').primaryKey(),
    studentAuthUid: text('student_auth_uid').notNull(),
    ownerProfessionalUid: text('owner_professional_uid'),
    sourceKind: text('source_kind', { enum: ['predefined', 'assigned', 'self_managed'] }).notNull(),
    isArchived: boolean('is_archived').notNull().default(false),
    isDraft: boolean('is_draft').notNull().default(false),
    lifecycleConnectionId: text('lifecycle_connection_id'),
    name: text('name'),
    hydrationGoalMl: integer('hydration_goal_ml'),
    caloriesTarget: integer('calories_target'),
    carbsTarget: integer('carbs_target'),
    proteinsTarget: integer('proteins_target'),
    fatsTarget: integer('fats_target'),
    meals: jsonb('meals').$type<Array<Record<string, unknown>>>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('nutrition_plans_student_updated_idx').on(table.studentAuthUid, table.updatedAt),
    index('nutrition_plans_owner_idx').on(table.ownerProfessionalUid),
  ]
);

export type NutritionPlanRow = typeof nutritionPlans.$inferSelect;
export type NewNutritionPlanRow = typeof nutritionPlans.$inferInsert;

export const trainingPlans = pgTable(
  'training_plans',
  {
    id: text('id').primaryKey(),
    studentAuthUid: text('student_auth_uid').notNull(),
    ownerProfessionalUid: text('owner_professional_uid'),
    sourceKind: text('source_kind', { enum: ['predefined', 'assigned', 'self_managed'] }).notNull(),
    isArchived: boolean('is_archived').notNull().default(false),
    isDraft: boolean('is_draft').notNull().default(false),
    lifecycleConnectionId: text('lifecycle_connection_id'),
    name: text('name'),
    sessions: jsonb('sessions').$type<Array<Record<string, unknown>>>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('training_plans_student_updated_idx').on(table.studentAuthUid, table.updatedAt),
    index('training_plans_owner_idx').on(table.ownerProfessionalUid),
  ]
);

export type TrainingPlanRow = typeof trainingPlans.$inferSelect;
export type NewTrainingPlanRow = typeof trainingPlans.$inferInsert;

export const planChangeRequests = pgTable(
  'plan_change_requests',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id').notNull(),
    planType: text('plan_type', { enum: ['nutrition', 'training'] }).notNull(),
    studentAuthUid: text('student_auth_uid').notNull(),
    requestText: text('request_text').notNull(),
    status: text('status', { enum: ['pending', 'reviewed', 'dismissed'] }).notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('plan_change_requests_student_created_idx').on(table.studentAuthUid, table.createdAt),
    index('plan_change_requests_plan_idx').on(table.planType, table.planId),
  ]
);

export type PlanChangeRequestRow = typeof planChangeRequests.$inferSelect;
export type NewPlanChangeRequestRow = typeof planChangeRequests.$inferInsert;

export const customMeals = pgTable(
  'custom_meals',
  {
    id: text('id').primaryKey(),
    ownerAuthUid: text('owner_auth_uid').notNull(),
    name: text('name').notNull(),
    totalGrams: numeric('total_grams', { mode: 'number' }).notNull(),
    calories: numeric('calories', { mode: 'number' }).notNull(),
    carbs: numeric('carbs', { mode: 'number' }).notNull(),
    proteins: numeric('proteins', { mode: 'number' }).notNull(),
    fats: numeric('fats', { mode: 'number' }).notNull(),
    ingredientCost: numeric('ingredient_cost', { mode: 'number' }),
    imageUrl: text('image_url'),
    importedFromShareToken: text('imported_from_share_token'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('custom_meals_owner_updated_idx').on(table.ownerAuthUid, table.updatedAt),
    index('custom_meals_imported_share_token_idx').on(table.importedFromShareToken),
  ]
);

export type CustomMealRow = typeof customMeals.$inferSelect;
export type NewCustomMealRow = typeof customMeals.$inferInsert;

export const mealShareLinks = pgTable(
  'meal_share_links',
  {
    id: text('id').primaryKey(),
    ownerAuthUid: text('owner_auth_uid').notNull(),
    mealId: text('meal_id').notNull(),
    snapshotName: text('snapshot_name').notNull(),
    snapshotTotalGrams: numeric('snapshot_total_grams', { mode: 'number' }).notNull(),
    snapshotCalories: numeric('snapshot_calories', { mode: 'number' }).notNull(),
    snapshotCarbs: numeric('snapshot_carbs', { mode: 'number' }).notNull(),
    snapshotProteins: numeric('snapshot_proteins', { mode: 'number' }).notNull(),
    snapshotFats: numeric('snapshot_fats', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('meal_share_links_owner_meal_idx').on(table.ownerAuthUid, table.mealId),
    index('meal_share_links_meal_idx').on(table.mealId),
  ]
);

export type MealShareLinkRow = typeof mealShareLinks.$inferSelect;
export type NewMealShareLinkRow = typeof mealShareLinks.$inferInsert;

export const portionLogs = pgTable(
  'portion_logs',
  {
    id: text('id').primaryKey(),
    ownerAuthUid: text('owner_auth_uid').notNull(),
    mealId: text('meal_id').notNull(),
    consumedGrams: numeric('consumed_grams', { mode: 'number' }).notNull(),
    snapshotCalories: numeric('snapshot_calories', { mode: 'number' }).notNull(),
    snapshotCarbs: numeric('snapshot_carbs', { mode: 'number' }).notNull(),
    snapshotProteins: numeric('snapshot_proteins', { mode: 'number' }).notNull(),
    snapshotFats: numeric('snapshot_fats', { mode: 'number' }).notNull(),
    loggedAt: timestamp('logged_at', { withTimezone: true }).notNull().defaultNow(),
    planId: text('plan_id'),
    planType: text('plan_type', { enum: ['nutrition'] }),
    sourceKind: text('source_kind', { enum: ['assigned', 'predefined', 'self_managed'] }),
    ownerProfessionalUid: text('owner_professional_uid'),
    connectionId: text('connection_id'),
  },
  (table) => [
    index('portion_logs_owner_logged_at_idx').on(table.ownerAuthUid, table.loggedAt),
  ]
);

export type PortionLogRow = typeof portionLogs.$inferSelect;
export type NewPortionLogRow = typeof portionLogs.$inferInsert;
