import { afterAll, beforeEach, describe, expect, it } from 'bun:test';

import {
  ConnectionAlreadyExistsError,
  ConnectionForbiddenError,
  ConnectionNotFoundError,
  InviteCodeNotFoundError,
  InvalidConnectionTransitionError,
  PendingConnectionAlreadyExistsError,
  PendingConnectionCapReachedError,
} from '../src/connections/repository';
import { PostgresConnectionRepository } from '../src/connections/postgres-repository';
import { createDatabase } from '../src/db/client';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://mychampions_local:mychampions_local_password@localhost:15432/mychampions_server_local';

const database = createDatabase(databaseUrl);
let nextGeneratedCode = 'NUT999';
const repository = new PostgresConnectionRepository(database.db, {
  generateInviteCode: () => nextGeneratedCode,
});

async function seedInviteCode(input: {
  id?: string;
  professionalAuthUid?: string;
  specialty?: 'nutritionist' | 'fitness_coach';
  codeValue?: string;
  status?: 'active' | 'rotated' | 'revoked';
}) {
  await database.client`
    insert into invite_codes (
      id,
      professional_auth_uid,
      specialty,
      code_value,
      status,
      created_at,
      updated_at,
      rotated_at
    ) values (
      ${input.id ?? input.specialty ?? 'nutritionist'},
      ${input.professionalAuthUid ?? 'professional-1'},
      ${input.specialty ?? 'nutritionist'},
      ${input.codeValue ?? 'NUT123'},
      ${input.status ?? 'active'},
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      null
    )
  `;
}

beforeEach(async () => {
  nextGeneratedCode = 'NUT999';
  await database.client`
    truncate table
      connections,
      invite_codes,
      nutrition_plans,
      training_plans,
      connection_invite_guards,
      pending_students,
      pending_student_slots,
      tracking_access,
      active_specialties,
      subscription_entitlement_snapshots
  `;
});

afterAll(async () => {
  await database.close();
});

describe('PostgresConnectionRepository', () => {
  it('allocates pending invite guard and one reusable student slot when invite codes are submitted', async () => {
    await seedInviteCode({ codeValue: 'NUT123', specialty: 'nutritionist', id: 'nutritionist' });
    await seedInviteCode({ codeValue: 'FIT123', specialty: 'fitness_coach', id: 'fitness_coach' });

    const nutritionConnection = await repository.submitInviteCode({
      code: 'NUT123',
      studentAuthUid: 'student-1',
    });
    const fitnessConnection = await repository.submitInviteCode({
      code: 'FIT123',
      studentAuthUid: 'student-1',
    });

    const guardRows = await database.client`
      select id, connection_id, professional_auth_uid, student_auth_uid, specialty, status
      from connection_invite_guards
      order by specialty
    `;
    expect([...guardRows]).toEqual([
      {
        id: 'professional-1_student-1_fitness_coach',
        connection_id: fitnessConnection.id,
        professional_auth_uid: 'professional-1',
        student_auth_uid: 'student-1',
        specialty: 'fitness_coach',
        status: 'pending_confirmation',
      },
      {
        id: 'professional-1_student-1_nutritionist',
        connection_id: nutritionConnection.id,
        professional_auth_uid: 'professional-1',
        student_auth_uid: 'student-1',
        specialty: 'nutritionist',
        status: 'pending_confirmation',
      },
    ]);

    const pendingRows = await database.client`
      select professional_auth_uid, student_auth_uid, slot_id, nutritionist_connection_id, fitness_coach_connection_id
      from pending_students
    `;
    expect(pendingRows[0]).toEqual({
      professional_auth_uid: 'professional-1',
      student_auth_uid: 'student-1',
      slot_id: 'slot_01',
      nutritionist_connection_id: nutritionConnection.id,
      fitness_coach_connection_id: fitnessConnection.id,
    });

    const slotRows = await database.client`
      select professional_auth_uid, slot_id, student_auth_uid
      from pending_student_slots
      where professional_auth_uid = 'professional-1'
    `;
    expect([...slotRows]).toEqual([
      {
        professional_auth_uid: 'professional-1',
        slot_id: 'slot_01',
        student_auth_uid: 'student-1',
      },
    ]);
  });

  it('releases confirmed pending invite state and writes active tracking access', async () => {
    await database.client`
      insert into connections (
        id,
        status,
        canceled_reason,
        specialty,
        professional_auth_uid,
        student_auth_uid,
        source_invite_code_id,
        source_invite_code_value,
        created_at,
        updated_at,
        ended_at
      ) values
        (
          'confirm-tracking',
          'pending_confirmation',
          null,
          'nutritionist',
          'professional-1',
          'student-1',
          'nutritionist',
          'NUT123',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          null
        ),
        (
          'other-pending',
          'pending_confirmation',
          null,
          'fitness_coach',
          'professional-1',
          'student-1',
          'fitness_coach',
          'FIT123',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          null
        )
    `;
    await database.client`
      insert into connection_invite_guards (
        id,
        connection_id,
        professional_auth_uid,
        student_auth_uid,
        specialty,
        status,
        created_at,
        updated_at
      ) values (
        'professional-1_student-1_nutritionist',
        'confirm-tracking',
        'professional-1',
        'student-1',
        'nutritionist',
        'pending_confirmation',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      )
    `;
    await database.client`
      insert into pending_students (
        id,
        professional_auth_uid,
        student_auth_uid,
        slot_id,
        nutritionist_connection_id,
        fitness_coach_connection_id,
        created_at,
        updated_at
      ) values (
        'professional-1_student-1',
        'professional-1',
        'student-1',
        'slot_01',
        'confirm-tracking',
        'other-pending',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      )
    `;
    await database.client`
      insert into pending_student_slots (
        id,
        professional_auth_uid,
        slot_id,
        student_auth_uid,
        updated_at
      ) values (
        'professional-1_slot_01',
        'professional-1',
        'slot_01',
        'student-1',
        '2026-01-01T00:00:00.000Z'
      )
    `;

    await repository.confirmPendingConnection({
      connectionId: 'confirm-tracking',
      professionalAuthUid: 'professional-1',
    });

    const guardRows = await database.client`
      select id from connection_invite_guards where id = 'professional-1_student-1_nutritionist'
    `;
    expect(guardRows).toHaveLength(0);

    const pendingRows = await database.client`
      select nutritionist_connection_id, fitness_coach_connection_id
      from pending_students
      where id = 'professional-1_student-1'
    `;
    expect(pendingRows[0]).toEqual({
      nutritionist_connection_id: null,
      fitness_coach_connection_id: 'other-pending',
    });

    const slotRows = await database.client`
      select student_auth_uid
      from pending_student_slots
      where id = 'professional-1_slot_01'
    `;
    expect(slotRows[0].student_auth_uid).toBe('student-1');

    const accessRows = await database.client`
      select student_auth_uid, professional_auth_uid, specialty, connection_id, status
      from tracking_access
      where id = 'student-1_nutritionist_professional-1'
    `;
    expect(accessRows[0]).toEqual({
      student_auth_uid: 'student-1',
      professional_auth_uid: 'professional-1',
      specialty: 'nutritionist',
      connection_id: 'confirm-tracking',
      status: 'active',
    });

    const activeRows = await database.client`
      select student_auth_uid, professional_auth_uid, specialty, connection_id, status
      from active_specialties
      where id = 'student-1_nutritionist'
    `;
    expect(activeRows[0]).toEqual({
      student_auth_uid: 'student-1',
      professional_auth_uid: 'professional-1',
      specialty: 'nutritionist',
      connection_id: 'confirm-tracking',
      status: 'active',
    });
  });

  it('releases pending invite state and writes ended tracking access when ending a pending connection', async () => {
    await database.client`
      insert into connections (
        id,
        status,
        canceled_reason,
        specialty,
        professional_auth_uid,
        student_auth_uid,
        source_invite_code_id,
        source_invite_code_value,
        created_at,
        updated_at,
        ended_at
      ) values (
        'end-pending-tracking',
        'pending_confirmation',
        null,
        'fitness_coach',
        'professional-1',
        'student-1',
        'fitness_coach',
        'FIT123',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        null
      )
    `;
    await database.client`
      insert into connection_invite_guards (
        id,
        connection_id,
        professional_auth_uid,
        student_auth_uid,
        specialty,
        status,
        created_at,
        updated_at
      ) values (
        'professional-1_student-1_fitness_coach',
        'end-pending-tracking',
        'professional-1',
        'student-1',
        'fitness_coach',
        'pending_confirmation',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      )
    `;
    await database.client`
      insert into pending_students (
        id,
        professional_auth_uid,
        student_auth_uid,
        slot_id,
        nutritionist_connection_id,
        fitness_coach_connection_id,
        created_at,
        updated_at
      ) values (
        'professional-1_student-1',
        'professional-1',
        'student-1',
        'slot_01',
        null,
        'end-pending-tracking',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      )
    `;
    await database.client`
      insert into pending_student_slots (
        id,
        professional_auth_uid,
        slot_id,
        student_auth_uid,
        updated_at
      ) values (
        'professional-1_slot_01',
        'professional-1',
        'slot_01',
        'student-1',
        '2026-01-01T00:00:00.000Z'
      )
    `;

    await repository.endConnection({
      connectionId: 'end-pending-tracking',
      authUid: 'professional-1',
    });

    const guardRows = await database.client`
      select id from connection_invite_guards where id = 'professional-1_student-1_fitness_coach'
    `;
    expect(guardRows).toHaveLength(0);

    const pendingRows = await database.client`
      select nutritionist_connection_id, fitness_coach_connection_id
      from pending_students
      where id = 'professional-1_student-1'
    `;
    expect(pendingRows[0]).toEqual({
      nutritionist_connection_id: null,
      fitness_coach_connection_id: null,
    });

    const slotRows = await database.client`
      select student_auth_uid
      from pending_student_slots
      where id = 'professional-1_slot_01'
    `;
    expect(slotRows[0].student_auth_uid).toBeNull();

    const accessRows = await database.client`
      select student_auth_uid, professional_auth_uid, specialty, connection_id, status
      from tracking_access
      where id = 'student-1_fitness_coach_professional-1'
    `;
    expect(accessRows[0]).toEqual({
      student_auth_uid: 'student-1',
      professional_auth_uid: 'professional-1',
      specialty: 'fitness_coach',
      connection_id: 'end-pending-tracking',
      status: 'ended',
    });

    const activeRows = await database.client`
      select student_auth_uid, professional_auth_uid, specialty, connection_id, status
      from active_specialties
      where id = 'student-1_fitness_coach'
    `;
    expect(activeRows[0]).toEqual({
      student_auth_uid: 'student-1',
      professional_auth_uid: 'professional-1',
      specialty: 'fitness_coach',
      connection_id: 'end-pending-tracking',
      status: 'ended',
    });
  });

  it('keeps another active specialty sentinel when ending an older active connection', async () => {
    await database.client`
      insert into connections (
        id,
        status,
        canceled_reason,
        specialty,
        professional_auth_uid,
        student_auth_uid,
        source_invite_code_id,
        source_invite_code_value,
        created_at,
        updated_at,
        ended_at
      ) values (
        'end-old-active',
        'active',
        null,
        'nutritionist',
        'professional-1',
        'student-1',
        'nutritionist',
        'NUT123',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        null
      )
    `;
    await database.client`
      insert into active_specialties (
        id,
        student_auth_uid,
        professional_auth_uid,
        specialty,
        connection_id,
        status,
        updated_at
      ) values (
        'student-1_nutritionist',
        'student-1',
        'professional-current',
        'nutritionist',
        'current-active',
        'active',
        '2026-01-01T00:00:00.000Z'
      )
    `;

    await repository.endConnection({
      connectionId: 'end-old-active',
      authUid: 'student-1',
    });

    const accessRows = await database.client`
      select connection_id, status
      from tracking_access
      where id = 'student-1_nutritionist_professional-1'
    `;
    expect(accessRows[0]).toEqual({
      connection_id: 'end-old-active',
      status: 'ended',
    });

    const activeRows = await database.client`
      select connection_id, professional_auth_uid, status
      from active_specialties
      where id = 'student-1_nutritionist'
    `;
    expect(activeRows[0]).toEqual({
      connection_id: 'current-active',
      professional_auth_uid: 'professional-current',
      status: 'active',
    });
  });

  it('archives active self-managed nutrition plans when confirming a nutritionist connection', async () => {
    await database.client`
      insert into connections (
        id,
        status,
        canceled_reason,
        specialty,
        professional_auth_uid,
        student_auth_uid,
        source_invite_code_id,
        source_invite_code_value,
        created_at,
        updated_at,
        ended_at
      ) values (
        'confirm-plan-lifecycle',
        'pending_confirmation',
        null,
        'nutritionist',
        'professional-1',
        'student-1',
        'nutritionist',
        'NUT123',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        null
      )
    `;
    await database.client`
      insert into nutrition_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        created_at,
        updated_at
      ) values
        (
          'self-managed-active',
          'student-1',
          null,
          'self_managed',
          false,
          false,
          'Current self managed',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z'
        ),
        (
          'self-managed-already-archived',
          'student-1',
          null,
          'self_managed',
          true,
          false,
          'Already archived',
          '2026-01-01T00:00:00.000Z',
          '2026-01-03T00:00:00.000Z'
        ),
        (
          'assigned-active',
          'student-1',
          'professional-1',
          'assigned',
          false,
          false,
          'Assigned plan',
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z'
        )
    `;
    await database.client`
      insert into training_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        created_at,
        updated_at
      ) values (
        'training-self-managed-active',
        'student-1',
        null,
        'self_managed',
        false,
        false,
        'Training self managed',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z'
      )
    `;

    await repository.confirmPendingConnection({
      connectionId: 'confirm-plan-lifecycle',
      professionalAuthUid: 'professional-1',
    });

    const nutritionRows = await database.client`
      select id, is_archived, lifecycle_connection_id
      from nutrition_plans
      order by id
    `;
    expect([...nutritionRows]).toEqual([
      {
        id: 'assigned-active',
        is_archived: false,
        lifecycle_connection_id: null,
      },
      {
        id: 'self-managed-active',
        is_archived: true,
        lifecycle_connection_id: 'confirm-plan-lifecycle',
      },
      {
        id: 'self-managed-already-archived',
        is_archived: true,
        lifecycle_connection_id: null,
      },
    ]);

    const trainingRows = await database.client`
      select id, is_archived, lifecycle_connection_id
      from training_plans
      where id = 'training-self-managed-active'
    `;
    expect(trainingRows[0]).toEqual({
      id: 'training-self-managed-active',
      is_archived: false,
      lifecycle_connection_id: null,
    });
  });

  it('archives assigned training plans and restores the latest self-managed training plan when ending a fitness connection', async () => {
    await database.client`
      insert into connections (
        id,
        status,
        canceled_reason,
        specialty,
        professional_auth_uid,
        student_auth_uid,
        source_invite_code_id,
        source_invite_code_value,
        created_at,
        updated_at,
        ended_at
      ) values (
        'end-plan-lifecycle',
        'active',
        null,
        'fitness_coach',
        'professional-1',
        'student-1',
        'fitness_coach',
        'FIT123',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        null
      )
    `;
    await database.client`
      insert into training_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        created_at,
        updated_at,
        lifecycle_connection_id
      ) values
        (
          'assigned-active',
          'student-1',
          'professional-1',
          'assigned',
          false,
          false,
          'Assigned by current professional',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          null
        ),
        (
          'assigned-other-professional',
          'student-1',
          'professional-2',
          'assigned',
          false,
          false,
          'Assigned by another professional',
          '2026-01-01T00:00:00.000Z',
          '2026-01-03T00:00:00.000Z',
          null
        ),
        (
          'self-managed-older',
          'student-1',
          null,
          'self_managed',
          true,
          false,
          'Older self managed',
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          'end-plan-lifecycle'
        ),
        (
          'self-managed-latest',
          'student-1',
          null,
          'self_managed',
          true,
          false,
          'Latest self managed',
          '2026-01-01T00:00:00.000Z',
          '2026-01-05T00:00:00.000Z',
          'end-plan-lifecycle'
        ),
        (
          'self-managed-other-connection',
          'student-1',
          null,
          'self_managed',
          true,
          false,
          'Different lifecycle owner',
          '2026-01-01T00:00:00.000Z',
          '2026-01-06T00:00:00.000Z',
          'other-connection'
        )
    `;
    await database.client`
      insert into nutrition_plans (
        id,
        student_auth_uid,
        owner_professional_uid,
        source_kind,
        is_archived,
        is_draft,
        name,
        created_at,
        updated_at
      ) values (
        'nutrition-assigned-active',
        'student-1',
        'professional-1',
        'assigned',
        false,
        false,
        'Nutrition assigned',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z'
      )
    `;

    await repository.endConnection({
      connectionId: 'end-plan-lifecycle',
      authUid: 'student-1',
    });

    const trainingRows = await database.client`
      select id, is_archived, lifecycle_connection_id
      from training_plans
      order by id
    `;
    expect([...trainingRows]).toEqual([
      {
        id: 'assigned-active',
        is_archived: true,
        lifecycle_connection_id: 'end-plan-lifecycle',
      },
      {
        id: 'assigned-other-professional',
        is_archived: false,
        lifecycle_connection_id: null,
      },
      {
        id: 'self-managed-latest',
        is_archived: false,
        lifecycle_connection_id: 'end-plan-lifecycle',
      },
      {
        id: 'self-managed-older',
        is_archived: true,
        lifecycle_connection_id: 'end-plan-lifecycle',
      },
      {
        id: 'self-managed-other-connection',
        is_archived: true,
        lifecycle_connection_id: 'other-connection',
      },
    ]);

    const nutritionRows = await database.client`
      select id, is_archived, lifecycle_connection_id
      from nutrition_plans
      where id = 'nutrition-assigned-active'
    `;
    expect(nutritionRows[0]).toEqual({
      id: 'nutrition-assigned-active',
      is_archived: false,
      lifecycle_connection_id: null,
    });
  });

  it('ends a connection for either participant', async () => {
    await database.client`
      insert into connections (
        id,
        status,
        canceled_reason,
        specialty,
        professional_auth_uid,
        student_auth_uid,
        source_invite_code_id,
        source_invite_code_value,
        created_at,
        updated_at,
        ended_at
      ) values
        (
          'active-student-side',
          'active',
          null,
          'nutritionist',
          'professional-1',
          'student-1',
          'nutritionist',
          'NUT123',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          null
        ),
        (
          'pending-professional-side',
          'pending_confirmation',
          null,
          'fitness_coach',
          'professional-2',
          'student-2',
          'fitness_coach',
          'FIT123',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          null
        )
    `;

    const studentEnded = await repository.endConnection({
      connectionId: 'active-student-side',
      authUid: 'student-1',
    });
    const professionalEnded = await repository.endConnection({
      connectionId: 'pending-professional-side',
      authUid: 'professional-2',
    });

    expect(studentEnded).toMatchObject({
      id: 'active-student-side',
      status: 'ended',
      canceledReason: null,
      professionalAuthUid: 'professional-1',
      studentAuthUid: 'student-1',
      specialty: 'nutritionist',
    });
    expect(studentEnded.endedAt).toEqual(expect.any(String));
    expect(professionalEnded).toMatchObject({
      id: 'pending-professional-side',
      status: 'ended',
      canceledReason: null,
      professionalAuthUid: 'professional-2',
      studentAuthUid: 'student-2',
      specialty: 'fitness_coach',
    });
    expect(professionalEnded.endedAt).toEqual(expect.any(String));

    const rows = await database.client`
      select id, status, ended_at
      from connections
      order by id
    `;
    expect([...rows]).toEqual([
      expect.objectContaining({
        id: 'active-student-side',
        status: 'ended',
      }),
      expect.objectContaining({
        id: 'pending-professional-side',
        status: 'ended',
      }),
    ]);
    expect(rows[0].ended_at).not.toBeNull();
    expect(rows[1].ended_at).not.toBeNull();
  });

  it('rejects invalid connection end attempts', async () => {
    await database.client`
      insert into connections (
        id,
        status,
        canceled_reason,
        specialty,
        professional_auth_uid,
        student_auth_uid,
        source_invite_code_id,
        source_invite_code_value,
        created_at,
        updated_at,
        ended_at
      ) values (
        'active-1',
        'active',
        null,
        'nutritionist',
        'professional-1',
        'student-1',
        'nutritionist',
        'NUT123',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        null
      )
    `;

    await expect(repository.endConnection({
      connectionId: 'missing',
      authUid: 'student-1',
    })).rejects.toBeInstanceOf(ConnectionNotFoundError);

    await expect(repository.endConnection({
      connectionId: 'active-1',
      authUid: 'other-user',
    })).rejects.toBeInstanceOf(ConnectionForbiddenError);
  });

  it('confirms a pending connection for the owning professional', async () => {
    await database.client`
      insert into connections (
        id,
        status,
        canceled_reason,
        specialty,
        professional_auth_uid,
        student_auth_uid,
        source_invite_code_id,
        source_invite_code_value,
        created_at,
        updated_at,
        ended_at
      ) values (
        'pending-1',
        'pending_confirmation',
        null,
        'nutritionist',
        'professional-1',
        'student-1',
        'nutritionist',
        'NUT123',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        null
      )
    `;

    const connection = await repository.confirmPendingConnection({
      connectionId: 'pending-1',
      professionalAuthUid: 'professional-1',
    });

    expect(connection).toMatchObject({
      id: 'pending-1',
      status: 'active',
      canceledReason: null,
      professionalAuthUid: 'professional-1',
      studentAuthUid: 'student-1',
      specialty: 'nutritionist',
      endedAt: null,
    });

    const rows = await database.client`
      select status, canceled_reason, ended_at
      from connections
      where id = 'pending-1'
    `;
    expect(rows[0].status).toBe('active');
    expect(rows[0].canceled_reason).toBeNull();
    expect(rows[0].ended_at).toBeNull();
  });

  it('requires an active professional entitlement before activating an 11th unique student', async () => {
    for (let index = 1; index <= 10; index += 1) {
      await database.client`
        insert into connections (
          id,
          status,
          canceled_reason,
          specialty,
          professional_auth_uid,
          student_auth_uid,
          source_invite_code_id,
          source_invite_code_value,
          created_at,
          updated_at,
          ended_at
        ) values (
          ${`active-${index}`},
          'active',
          null,
          'nutritionist',
          'professional-1',
          ${`student-${index}`},
          'nutritionist',
          'NUT123',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          null
        )
      `;
    }
    await database.client`
      insert into connections (
        id,
        status,
        canceled_reason,
        specialty,
        professional_auth_uid,
        student_auth_uid,
        source_invite_code_id,
        source_invite_code_value,
        created_at,
        updated_at,
        ended_at
      ) values (
        'pending-11',
        'pending_confirmation',
        null,
        'fitness_coach',
        'professional-1',
        'student-11',
        'fitness_coach',
        'FIT123',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        null
      )
    `;

    await expect(repository.confirmPendingConnection({
      connectionId: 'pending-11',
      professionalAuthUid: 'professional-1',
    })).rejects.toThrow('Professional subscription required.');

    const rows = await database.client`
      select status
      from connections
      where id = 'pending-11'
    `;
    expect(rows[0].status).toBe('pending_confirmation');
  });

  it('allows activating an 11th unique student when professional entitlement is active', async () => {
    for (let index = 1; index <= 10; index += 1) {
      await database.client`
        insert into connections (
          id,
          status,
          canceled_reason,
          specialty,
          professional_auth_uid,
          student_auth_uid,
          source_invite_code_id,
          source_invite_code_value,
          created_at,
          updated_at,
          ended_at
        ) values (
          ${`active-${index}`},
          'active',
          null,
          'nutritionist',
          'professional-1',
          ${`student-${index}`},
          'nutritionist',
          'NUT123',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          null
        )
      `;
    }
    await database.client`
      insert into subscription_entitlement_snapshots (
        auth_uid,
        professional_entitlement_status,
        ai_entitlement_status,
        active_student_count,
        source,
        observed_at,
        updated_at
      ) values (
        'professional-1',
        'active',
        'lapsed',
        10,
        'revenuecat',
        '2026-07-03T16:45:00.000Z',
        '2026-07-03T16:45:00.000Z'
      )
    `;
    await database.client`
      insert into connections (
        id,
        status,
        canceled_reason,
        specialty,
        professional_auth_uid,
        student_auth_uid,
        source_invite_code_id,
        source_invite_code_value,
        created_at,
        updated_at,
        ended_at
      ) values (
        'pending-11',
        'pending_confirmation',
        null,
        'fitness_coach',
        'professional-1',
        'student-11',
        'fitness_coach',
        'FIT123',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        null
      )
    `;

    const connection = await repository.confirmPendingConnection({
      connectionId: 'pending-11',
      professionalAuthUid: 'professional-1',
    });

    expect(connection).toMatchObject({
      id: 'pending-11',
      status: 'active',
      professionalAuthUid: 'professional-1',
      studentAuthUid: 'student-11',
    });
  });

  it('does not require entitlement when confirming a second specialty for an already active student at cap', async () => {
    for (let index = 1; index <= 10; index += 1) {
      await database.client`
        insert into connections (
          id,
          status,
          canceled_reason,
          specialty,
          professional_auth_uid,
          student_auth_uid,
          source_invite_code_id,
          source_invite_code_value,
          created_at,
          updated_at,
          ended_at
        ) values (
          ${`active-${index}`},
          'active',
          null,
          'nutritionist',
          'professional-1',
          ${`student-${index}`},
          'nutritionist',
          'NUT123',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          null
        )
      `;
    }
    await database.client`
      insert into connections (
        id,
        status,
        canceled_reason,
        specialty,
        professional_auth_uid,
        student_auth_uid,
        source_invite_code_id,
        source_invite_code_value,
        created_at,
        updated_at,
        ended_at
      ) values (
        'pending-second-specialty',
        'pending_confirmation',
        null,
        'fitness_coach',
        'professional-1',
        'student-10',
        'fitness_coach',
        'FIT123',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        null
      )
    `;

    const connection = await repository.confirmPendingConnection({
      connectionId: 'pending-second-specialty',
      professionalAuthUid: 'professional-1',
    });

    expect(connection).toMatchObject({
      id: 'pending-second-specialty',
      status: 'active',
      professionalAuthUid: 'professional-1',
      studentAuthUid: 'student-10',
    });
  });

  it('rejects invalid pending confirmation attempts', async () => {
    await database.client`
      insert into connections (
        id,
        status,
        canceled_reason,
        specialty,
        professional_auth_uid,
        student_auth_uid,
        source_invite_code_id,
        source_invite_code_value,
        created_at,
        updated_at,
        ended_at
      ) values
        (
          'pending-1',
          'pending_confirmation',
          null,
          'nutritionist',
          'professional-1',
          'student-1',
          'nutritionist',
          'NUT123',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          null
        ),
        (
          'active-1',
          'active',
          null,
          'fitness_coach',
          'professional-1',
          'student-2',
          'fitness_coach',
          'FIT123',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          null
        ),
        (
          'active-duplicate',
          'active',
          null,
          'nutritionist',
          'professional-9',
          'student-1',
          'nutritionist',
          'OLD123',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          null
        )
    `;

    await expect(repository.confirmPendingConnection({
      connectionId: 'missing',
      professionalAuthUid: 'professional-1',
    })).rejects.toBeInstanceOf(ConnectionNotFoundError);

    await expect(repository.confirmPendingConnection({
      connectionId: 'pending-1',
      professionalAuthUid: 'professional-2',
    })).rejects.toBeInstanceOf(ConnectionForbiddenError);

    await expect(repository.confirmPendingConnection({
      connectionId: 'active-1',
      professionalAuthUid: 'professional-1',
    })).rejects.toBeInstanceOf(InvalidConnectionTransitionError);

    await expect(repository.confirmPendingConnection({
      connectionId: 'pending-1',
      professionalAuthUid: 'professional-1',
    })).rejects.toBeInstanceOf(ConnectionAlreadyExistsError);
  });

  it('lets exactly one concurrent confirm win and runs side effects for that winner only', async () => {
    await database.client`
      insert into connections (
        id,
        status,
        canceled_reason,
        specialty,
        professional_auth_uid,
        student_auth_uid,
        source_invite_code_id,
        source_invite_code_value,
        created_at,
        updated_at,
        ended_at
      ) values (
        'pending-race',
        'pending_confirmation',
        null,
        'nutritionist',
        'professional-1',
        'student-1',
        'nutritionist',
        'NUT123',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        null
      )
    `;
    await database.client`
      insert into connection_invite_guards (
        id,
        connection_id,
        professional_auth_uid,
        student_auth_uid,
        specialty,
        status,
        created_at,
        updated_at
      ) values (
        'professional-1_student-1_nutritionist',
        'pending-race',
        'professional-1',
        'student-1',
        'nutritionist',
        'pending_confirmation',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      )
    `;

    // Fire 5 near-simultaneous confirms at the same pending connection, exactly
    // as the field repro did (2x 200, 3x 409 before the fix). Each attempt
    // gets its own dedicated postgres-js connection (pre-warmed with a no-op
    // query first) so the 5 "read status" queries genuinely race across
    // separate DB sessions instead of being serialized by a shared pool or by
    // V8 microtask ordering — a same-process, same-connection Promise.all
    // does not reproduce this bug because the pool tends to complete each
    // request's full read-check-write sequence before the next one starts.
    const attempts = 5;
    const lanes = Array.from({ length: attempts }, () => {
      const laneDb = createDatabase(databaseUrl);
      return { repository: new PostgresConnectionRepository(laneDb.db), close: laneDb.close };
    });
    await Promise.all(lanes.map((lane) => lane.repository.listForAuthUid('warmup')));

    const results = await Promise.allSettled(
      lanes.map((lane) =>
        lane.repository.confirmPendingConnection({
          connectionId: 'pending-race',
          professionalAuthUid: 'professional-1',
        })
      )
    );
    await Promise.all(lanes.map((lane) => lane.close()));

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(attempts - 1);
    for (const result of rejected) {
      if (result.status === 'rejected') {
        // A loser rejects because the atomic UPDATE it raced to run affected
        // zero rows (InvalidConnectionTransitionError), or — if it reaches the
        // pre-existing activeConflicts read after the winner has already
        // committed — because that read now finds this same connection as an
        // "active conflict" against itself (ConnectionAlreadyExistsError).
        // Both are 409s and, critically, neither runs the confirm side effects.
        expect(
          result.reason instanceof InvalidConnectionTransitionError ||
            result.reason instanceof ConnectionAlreadyExistsError
        ).toBe(true);
      }
    }

    const rows = await database.client`
      select status, updated_at from connections where id = 'pending-race'
    `;
    expect(rows[0].status).toBe('active');

    // The once-only side effect chain must have released the pending invite
    // guard exactly once, not once per request that reached the write.
    const guardRows = await database.client`
      select id from connection_invite_guards where id = 'professional-1_student-1_nutritionist'
    `;
    expect(guardRows).toHaveLength(0);

    const trackingRows = await database.client`
      select status from tracking_access where connection_id = 'pending-race'
    `;
    expect(trackingRows).toHaveLength(1);
    expect(trackingRows[0].status).toBe('active');
  });

  it('gets the active invite code or creates one for the professional specialty', async () => {
    nextGeneratedCode = 'FIT999';

    const created = await repository.getOrCreateActiveInviteCode({
      professionalAuthUid: 'professional-1',
      specialty: 'fitness_coach',
    });

    expect(created).toMatchObject({
      id: 'professional-1_fitness_coach',
      professionalAuthUid: 'professional-1',
      specialty: 'fitness_coach',
      codeValue: 'FIT999',
      status: 'active',
      rotatedAt: null,
      expiresAt: null,
    });

    nextGeneratedCode = 'FIT000';
    const existing = await repository.getOrCreateActiveInviteCode({
      professionalAuthUid: 'professional-1',
      specialty: 'fitness_coach',
    });

    expect(existing.codeValue).toBe('FIT999');
    const rows = await database.client`
      select code_value, status
      from invite_codes
      where professional_auth_uid = 'professional-1' and specialty = 'fitness_coach'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].code_value).toBe('FIT999');
    expect(rows[0].status).toBe('active');
  });

  it('rotates the active invite code and cancels pending connections created from the old code', async () => {
    await seedInviteCode({ codeValue: 'NUT123' });
    await database.client`
      insert into connections (
        id,
        status,
        canceled_reason,
        specialty,
        professional_auth_uid,
        student_auth_uid,
        source_invite_code_id,
        source_invite_code_value,
        created_at,
        updated_at,
        ended_at
      ) values
        (
          'pending-old-code',
          'pending_confirmation',
          null,
          'nutritionist',
          'professional-1',
          'student-1',
          'nutritionist',
          'NUT123',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          null
        ),
        (
          'pending-other-code',
          'pending_confirmation',
          null,
          'nutritionist',
          'professional-1',
          'student-2',
          'nutritionist',
          'OTHER123',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          null
        )
    `;
    await database.client`
      insert into connection_invite_guards (
        id,
        connection_id,
        professional_auth_uid,
        student_auth_uid,
        specialty,
        status,
        created_at,
        updated_at
      ) values (
        'professional-1_student-1_nutritionist',
        'pending-old-code',
        'professional-1',
        'student-1',
        'nutritionist',
        'pending_confirmation',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      )
    `;
    await database.client`
      insert into pending_students (
        id,
        professional_auth_uid,
        student_auth_uid,
        slot_id,
        nutritionist_connection_id,
        fitness_coach_connection_id,
        created_at,
        updated_at
      ) values (
        'professional-1_student-1',
        'professional-1',
        'student-1',
        'slot_01',
        'pending-old-code',
        null,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      )
    `;
    await database.client`
      insert into pending_student_slots (
        id,
        professional_auth_uid,
        slot_id,
        student_auth_uid,
        updated_at
      ) values (
        'professional-1_slot_01',
        'professional-1',
        'slot_01',
        'student-1',
        '2026-01-01T00:00:00.000Z'
      )
    `;
    nextGeneratedCode = 'NUT999';

    const rotated = await repository.rotateInviteCode({
      professionalAuthUid: 'professional-1',
      specialty: 'nutritionist',
    });

    expect(rotated).toMatchObject({
      id: 'nutritionist',
      professionalAuthUid: 'professional-1',
      specialty: 'nutritionist',
      codeValue: 'NUT999',
      status: 'active',
      expiresAt: null,
    });
    expect(rotated.rotatedAt).toEqual(expect.any(String));

    const inviteRows = await database.client`
      select code_value, status, rotated_at
      from invite_codes
      where id = 'nutritionist'
    `;
    expect(inviteRows[0].code_value).toBe('NUT999');
    expect(inviteRows[0].status).toBe('active');
    expect(inviteRows[0].rotated_at).not.toBeNull();

    const connectionRows = await database.client`
      select id, status, canceled_reason, ended_at
      from connections
      order by id
    `;
    expect([...connectionRows]).toEqual([
      expect.objectContaining({
        id: 'pending-old-code',
        status: 'ended',
        canceled_reason: 'code_rotated',
      }),
      expect.objectContaining({
        id: 'pending-other-code',
        status: 'pending_confirmation',
        canceled_reason: null,
      }),
    ]);
    expect(connectionRows[0].ended_at).not.toBeNull();

    const guardRows = await database.client`
      select id from connection_invite_guards where id = 'professional-1_student-1_nutritionist'
    `;
    expect(guardRows).toHaveLength(0);

    const pendingRows = await database.client`
      select nutritionist_connection_id, fitness_coach_connection_id
      from pending_students
      where id = 'professional-1_student-1'
    `;
    expect(pendingRows[0]).toEqual({
      nutritionist_connection_id: null,
      fitness_coach_connection_id: null,
    });

    const slotRows = await database.client`
      select student_auth_uid
      from pending_student_slots
      where id = 'professional-1_slot_01'
    `;
    expect(slotRows[0].student_auth_uid).toBeNull();
  });

  it('lists student and professional side connections for an auth uid', async () => {
    await database.client`
      insert into connections (
        id,
        status,
        canceled_reason,
        specialty,
        professional_auth_uid,
        student_auth_uid,
        source_invite_code_id,
        source_invite_code_value,
        created_at,
        updated_at,
        ended_at
      ) values
        (
          'student-side',
          'active',
          null,
          'nutritionist',
          'professional-1',
          'uid-1',
          'nutritionist',
          'NUT123',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          null
        ),
        (
          'professional-side',
          'pending_confirmation',
          null,
          'fitness_coach',
          'uid-1',
          'student-2',
          'fitness_coach',
          'FIT123',
          '2026-01-03T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          null
        ),
        (
          'unrelated',
          'active',
          null,
          'nutritionist',
          'professional-3',
          'student-3',
          null,
          null,
          '2026-01-05T00:00:00.000Z',
          '2026-01-06T00:00:00.000Z',
          null
        )
    `;

    const connections = await repository.listForAuthUid('uid-1');

    expect(connections.map((connection) => connection.id).sort()).toEqual([
      'professional-side',
      'student-side',
    ]);
    expect(connections).toContainEqual(expect.objectContaining({
      id: 'student-side',
      status: 'active',
      canceledReason: null,
      specialty: 'nutritionist',
      professionalAuthUid: 'professional-1',
      studentAuthUid: 'uid-1',
      sourceInviteCodeValue: 'NUT123',
    }));
  });

  it('creates a pending connection from an active invite code', async () => {
    await seedInviteCode({});

    const connection = await repository.submitInviteCode({
      code: ' nut123 ',
      studentAuthUid: 'student-1',
    });

    expect(connection).toMatchObject({
      status: 'pending_confirmation',
      canceledReason: null,
      specialty: 'nutritionist',
      professionalAuthUid: 'professional-1',
      studentAuthUid: 'student-1',
      sourceInviteCodeId: 'nutritionist',
      sourceInviteCodeValue: 'NUT123',
    });

    const rows = await database.client`
      select id, status, specialty, professional_auth_uid, student_auth_uid
      from connections
      where student_auth_uid = 'student-1'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('pending_confirmation');
  });

  it('rejects missing or inactive invite codes', async () => {
    await seedInviteCode({ codeValue: 'OLD123', status: 'rotated' });

    await expect(repository.submitInviteCode({
      code: 'OLD123',
      studentAuthUid: 'student-1',
    })).rejects.toBeInstanceOf(InviteCodeNotFoundError);
  });

  it('rejects active and pending duplicate connections for the same professional student and specialty', async () => {
    await seedInviteCode({});
    await repository.submitInviteCode({
      code: 'NUT123',
      studentAuthUid: 'student-1',
    });

    await expect(repository.submitInviteCode({
      code: 'NUT123',
      studentAuthUid: 'student-1',
    })).rejects.toBeInstanceOf(PendingConnectionAlreadyExistsError);

    await database.client`
      update connections
      set status = 'active'
      where student_auth_uid = 'student-1'
    `;

    await expect(repository.submitInviteCode({
      code: 'NUT123',
      studentAuthUid: 'student-1',
    })).rejects.toBeInstanceOf(ConnectionAlreadyExistsError);
  });

  it('rejects a new unique pending student above the professional cap', async () => {
    await seedInviteCode({});
    for (let index = 1; index <= 10; index += 1) {
      await database.client`
        insert into connections (
          id,
          status,
          canceled_reason,
          specialty,
          professional_auth_uid,
          student_auth_uid,
          source_invite_code_id,
          source_invite_code_value,
          created_at,
          updated_at,
          ended_at
        ) values (
          ${`pending-${index}`},
          'pending_confirmation',
          null,
          'nutritionist',
          'professional-1',
          ${`student-${index}`},
          'nutritionist',
          'NUT123',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          null
        )
      `;
    }

    await expect(repository.submitInviteCode({
      code: 'NUT123',
      studentAuthUid: 'student-11',
    })).rejects.toBeInstanceOf(PendingConnectionCapReachedError);
  });
});
