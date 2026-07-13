import { afterAll, beforeEach, describe, expect, it } from 'bun:test';

import { createDatabase } from '../src/db/client';
import { PostgresProfileRepository } from '../src/profile/postgres-repository';
import { ProfileConflictError } from '../src/profile/repository';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_server_local';

const database = createDatabase(databaseUrl);
const repository = new PostgresProfileRepository(database.db);

beforeEach(async () => {
  await database.client`
    truncate table
      active_specialties,
      auth_identities,
      auth_sessions,
      connection_invite_guards,
      connections,
      custom_meals,
      invite_codes,
      meal_share_links,
      nutrition_plans,
      password_reset_delivery_artifacts,
      password_reset_requests,
      pending_student_slots,
      pending_students,
      plan_change_requests,
      portion_logs,
      professional_credentials,
      professional_specialties,
      subscription_entitlement_snapshots,
      support_messages,
      tracking_access,
      training_plans,
      user_profiles,
      water_logs,
      workout_logs
    cascade
  `;
});

afterAll(async () => {
  await database.close();
});

describe('PostgresProfileRepository', () => {
  it('upserts a session profile without clearing role or terms', async () => {
    await repository.upsertFromSession({
      authUid: 'uid-1',
      displayName: 'First Name',
      emailNormalized: 'first@example.test',
    });
    await repository.lockRole('uid-1', 'student');
    await repository.setAcceptedTermsVersion('uid-1', 'v1');

    const profile = await repository.upsertFromSession({
      authUid: 'uid-1',
      displayName: 'Updated Name',
      emailNormalized: 'updated@example.test',
    });

    expect(profile.displayName).toBe('Updated Name');
    expect(profile.emailNormalized).toBe('updated@example.test');
    expect(profile.lockedRole).toBe('student');
    expect(profile.acceptedTermsVersion).toBe('v1');
  });

  it('rejects changing a locked role', async () => {
    await repository.upsertFromSession({
      authUid: 'uid-2',
      displayName: 'Role User',
      emailNormalized: 'role@example.test',
    });
    await repository.lockRole('uid-2', 'professional');

    await expect(repository.lockRole('uid-2', 'student')).rejects.toBeInstanceOf(ProfileConflictError);
  });

  it('removes direct account rows and pseudonymizes relationship history on account deletion', async () => {
    await database.client`
      insert into user_profiles (auth_uid, display_name, email_normalized, locked_role)
      values
        ('uid-delete', 'Delete Me', 'delete@example.test', 'professional'),
        ('uid-other', 'Other User', 'other@example.test', 'student')
    `;
    await database.client`
      insert into support_messages (
        id, auth_uid, user_email, user_name, user_role, subject, body, status, app_version, platform
      )
      values (
        'support-delete', 'uid-delete', 'delete@example.test', 'Delete Me', 'professional',
        'subject', 'body', 'pending', '1.0.0', 'ios'
      )
    `;
    await database.client`
      insert into password_reset_requests (
        id, email_normalized, status, token_digest, requested_at, expires_at
      )
      values (
        'reset-delete', 'delete@example.test', 'pending', 'digest', now(), now() + interval '15 minutes'
      )
    `;
    await database.client`
      insert into password_reset_delivery_artifacts (
        request_id, email_normalized, channel, reset_token, reset_url, expires_at, created_at
      )
      values (
        'reset-delete', 'delete@example.test', 'local_debug_outbox', 'raw-token',
        'mychampions://auth/password-reset?token=raw-token', now() + interval '15 minutes', now()
      )
    `;
    await database.client`
      insert into subscription_entitlement_snapshots (
        auth_uid, professional_entitlement_status, ai_entitlement_status, active_student_count, source, observed_at
      )
      values ('uid-delete', 'active', 'active', 1, 'revenuecat', now())
    `;
    await database.client`
      insert into auth_sessions (
        id, auth_uid, refresh_token_digest, auth_provider_id, expires_at
      )
      values ('session-delete', 'uid-delete', 'digest-only', 'email_password', now() + interval '30 days')
    `;
    await database.client`
      insert into auth_identities (
        provider, provider_subject, auth_uid, email_normalized, display_name, email_verified
      )
      values ('apple', 'apple-delete-subject', 'uid-delete', 'delete@example.test', 'Delete Me', true)
    `;
    await database.client`
      insert into professional_specialties (id, professional_auth_uid, specialty, is_active)
      values ('specialty-delete', 'uid-delete', 'nutritionist', true)
    `;
    await database.client`
      insert into professional_credentials (
        id, specialty_id, professional_auth_uid, specialty, credential_type, registry_id, authority, country
      )
      values (
        'credential-delete', 'specialty-delete', 'uid-delete', 'nutritionist',
        'professional_registry', '123', 'CRN', 'BR'
      )
    `;
    await database.client`
      insert into invite_codes (id, professional_auth_uid, specialty, code_value, status)
      values ('invite-delete', 'uid-delete', 'nutritionist', 'DELETE1', 'active')
    `;
    await database.client`
      insert into pending_student_slots (id, professional_auth_uid, slot_id, student_auth_uid)
      values ('slot-delete', 'uid-delete', 'slot-1', 'uid-other')
    `;
    await database.client`
      insert into pending_students (
        id, professional_auth_uid, student_auth_uid, slot_id, nutritionist_connection_id
      )
      values ('pending-delete', 'uid-delete', 'uid-other', 'slot-1', 'connection-delete')
    `;
    await database.client`
      insert into connections (
        id, status, specialty, professional_auth_uid, student_auth_uid
      )
      values
        ('connection-delete-pro', 'active', 'nutritionist', 'uid-delete', 'uid-other'),
        ('connection-delete-student', 'pending_confirmation', 'fitness_coach', 'uid-other', 'uid-delete'),
        ('connection-other', 'active', 'nutritionist', 'uid-other', 'uid-other')
    `;
    await database.client`
      insert into tracking_access (
        id, student_auth_uid, professional_auth_uid, specialty, connection_id, status
      )
      values
        ('tracking-delete', 'uid-other', 'uid-delete', 'nutritionist', 'connection-delete-pro', 'active'),
        ('tracking-other', 'uid-other', 'uid-other', 'nutritionist', 'connection-other', 'active')
    `;
    await database.client`
      insert into active_specialties (
        id, student_auth_uid, professional_auth_uid, specialty, connection_id, status
      )
      values ('active-delete', 'uid-delete', 'uid-other', 'fitness_coach', 'connection-delete-student', 'active')
    `;
    await database.client`
      insert into workout_logs (id, owner_auth_uid, session_id, session_name)
      values ('workout-delete', 'uid-delete', 'session-1', 'Workout')
    `;
    await database.client`
      insert into water_logs (id, owner_auth_uid, date_key, total_ml)
      values ('water-delete', 'uid-delete', '2026-07-04', 500)
    `;
    await database.client`
      insert into nutrition_plans (id, student_auth_uid, owner_professional_uid, source_kind, name)
      values
        ('nutrition-student-delete', 'uid-delete', null, 'self_managed', 'Mine'),
        ('nutrition-owner-delete', 'uid-other', 'uid-delete', 'assigned', 'Assigned')
    `;
    await database.client`
      insert into training_plans (id, student_auth_uid, owner_professional_uid, source_kind, name)
      values
        ('training-student-delete', 'uid-delete', null, 'self_managed', 'Mine'),
        ('training-owner-delete', 'uid-other', 'uid-delete', 'assigned', 'Assigned')
    `;
    await database.client`
      insert into plan_change_requests (id, plan_id, plan_type, student_auth_uid, request_text, status)
      values ('change-delete', 'nutrition-student-delete', 'nutrition', 'uid-delete', 'change this', 'pending')
    `;
    await database.client`
      insert into custom_meals (
        id, owner_auth_uid, name, total_grams, calories, carbs, proteins, fats
      )
      values ('meal-delete', 'uid-delete', 'Meal', 100, 200, 20, 10, 5)
    `;
    await database.client`
      insert into meal_share_links (
        id, owner_auth_uid, meal_id, snapshot_name, snapshot_total_grams,
        snapshot_calories, snapshot_carbs, snapshot_proteins, snapshot_fats
      )
      values ('share-delete', 'uid-delete', 'meal-delete', 'Meal', 100, 200, 20, 10, 5)
    `;
    await database.client`
      insert into portion_logs (
        id, owner_auth_uid, meal_id, consumed_grams, snapshot_calories,
        snapshot_carbs, snapshot_proteins, snapshot_fats, owner_professional_uid
      )
      values ('portion-delete', 'uid-delete', 'meal-delete', 50, 100, 10, 5, 2.5, 'uid-delete')
    `;

    await repository.deleteByAuthUid('uid-delete');

    const directRows = await database.client`
      select 'user_profiles' as table_name, auth_uid as auth_uid from user_profiles where auth_uid = 'uid-delete'
      union all select 'support_messages', auth_uid from support_messages where auth_uid = 'uid-delete'
      union all select 'subscription_entitlement_snapshots', auth_uid from subscription_entitlement_snapshots where auth_uid = 'uid-delete'
      union all select 'auth_identities', auth_uid from auth_identities where auth_uid = 'uid-delete'
      union all select 'auth_sessions', auth_uid from auth_sessions where auth_uid = 'uid-delete'
      union all select 'professional_specialties', professional_auth_uid from professional_specialties where professional_auth_uid = 'uid-delete'
      union all select 'professional_credentials', professional_auth_uid from professional_credentials where professional_auth_uid = 'uid-delete'
      union all select 'invite_codes', professional_auth_uid from invite_codes where professional_auth_uid = 'uid-delete'
      union all select 'pending_student_slots_professional', professional_auth_uid from pending_student_slots where professional_auth_uid = 'uid-delete'
      union all select 'pending_student_slots_student', student_auth_uid from pending_student_slots where student_auth_uid = 'uid-delete'
      union all select 'pending_students_professional', professional_auth_uid from pending_students where professional_auth_uid = 'uid-delete'
      union all select 'pending_students_student', student_auth_uid from pending_students where student_auth_uid = 'uid-delete'
      union all select 'workout_logs', owner_auth_uid from workout_logs where owner_auth_uid = 'uid-delete'
      union all select 'water_logs', owner_auth_uid from water_logs where owner_auth_uid = 'uid-delete'
      union all select 'nutrition_plans_student', student_auth_uid from nutrition_plans where student_auth_uid = 'uid-delete'
      union all select 'nutrition_plans_owner', owner_professional_uid from nutrition_plans where owner_professional_uid = 'uid-delete'
      union all select 'training_plans_student', student_auth_uid from training_plans where student_auth_uid = 'uid-delete'
      union all select 'training_plans_owner', owner_professional_uid from training_plans where owner_professional_uid = 'uid-delete'
      union all select 'plan_change_requests', student_auth_uid from plan_change_requests where student_auth_uid = 'uid-delete'
      union all select 'custom_meals', owner_auth_uid from custom_meals where owner_auth_uid = 'uid-delete'
      union all select 'meal_share_links', owner_auth_uid from meal_share_links where owner_auth_uid = 'uid-delete'
      union all select 'portion_logs_owner', owner_auth_uid from portion_logs where owner_auth_uid = 'uid-delete'
      union all select 'portion_logs_professional', owner_professional_uid from portion_logs where owner_professional_uid = 'uid-delete'
      union all select 'connections_professional', professional_auth_uid from connections where professional_auth_uid = 'uid-delete'
      union all select 'connections_student', student_auth_uid from connections where student_auth_uid = 'uid-delete'
      union all select 'tracking_access_professional', professional_auth_uid from tracking_access where professional_auth_uid = 'uid-delete'
      union all select 'tracking_access_student', student_auth_uid from tracking_access where student_auth_uid = 'uid-delete'
      union all select 'active_specialties_professional', professional_auth_uid from active_specialties where professional_auth_uid = 'uid-delete'
      union all select 'active_specialties_student', student_auth_uid from active_specialties where student_auth_uid = 'uid-delete'
    `;
    expect(directRows).toHaveLength(0);

    const passwordResetRows = await database.client`
      select count(*)::int as count
      from password_reset_requests
      where email_normalized = 'delete@example.test'
    `;
    expect(passwordResetRows[0].count).toBe(0);

    const relationshipRows = await database.client`
      select id, status, professional_auth_uid, student_auth_uid, ended_at
      from connections
      where id in ('connection-delete-pro', 'connection-delete-student')
      order by id
    `;
    expect(relationshipRows).toHaveLength(2);
    for (const row of relationshipRows) {
      expect(row.status).toBe('ended');
      expect(row.ended_at).not.toBeNull();
      expect(JSON.stringify(row)).not.toContain('uid-delete');
      expect(JSON.stringify(row)).toContain('deleted_account_');
    }

    const otherRows = await database.client`
      select
        (select count(*)::int from user_profiles where auth_uid = 'uid-other') as other_profiles,
        (select count(*)::int from connections where id = 'connection-other' and status = 'active') as other_connections,
        (select count(*)::int from tracking_access where id = 'tracking-other' and status = 'active') as other_tracking
    `;
    expect(otherRows[0]).toEqual({
      other_profiles: 1,
      other_connections: 1,
      other_tracking: 1,
    });
  });
});
