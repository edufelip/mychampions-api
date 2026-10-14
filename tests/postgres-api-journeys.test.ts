import { afterAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createDatabase } from '../src/db/client';
import {
  loadTestManifest,
  requireOwnedTestDatabase,
} from './helpers/test-database';
import { startOwnedApiServer } from './helpers/test-api-server';

// FR-101/111/112/120/121; BR-213/215/283; TC-213/214/270/278/291A.
const database = createDatabase(await requireOwnedTestDatabase());
let server: Awaited<ReturnType<typeof startOwnedApiServer>> | undefined;
afterAll(async () => {
  await server?.stop();
  await database.close();
});
type Session = {
  accessToken: string;
  refreshToken: string;
  profile: { authUid: string };
};
type Plan = {
  id: string;
  name: string;
  sessions: {
    id: string;
    name: string;
    notes: string;
    items: {
      id: string;
      name: string;
      quantity: string;
      notes: string;
      exerciseId: string;
    }[];
  }[];
};
async function request<T>(
  method: string,
  route: string,
  body?: unknown,
  session?: Session
) {
  if (!server) throw new Error('API not started');
  const response = await fetch(`${server.origin}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(session ? { authorization: `Bearer ${session.accessToken}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : null) as T,
  };
}
async function createAccount(name: string, role: 'student' | 'professional') {
  const run = loadTestManifest().runId;
  const email = `${name}-${run}@example.test`;
  const password = 'Owned-QA-Pass123!';
  // Create-account never issues a session (ET-75): it answers 202 for both new and
  // already-registered emails, so the journey signs in separately.
  const created = await request<{ status: string }>(
    'POST',
    '/auth/email/create-account',
    {
      email,
      displayName: `QA ${name}`,
      password,
      sessionMode: 'bearer',
    }
  );
  expect(created.status).toBe(202);
  expect(created.body).toEqual({ status: 'accepted' });
  const response = await request<Session>('POST', '/auth/email/sign-in', {
    email,
    password,
    sessionMode: 'bearer',
  });
  expect(response.status).toBe(201);
  const session = response.body;
  expect((await request('PATCH', '/me/role', { role }, session)).status).toBe(
    200
  );
  expect(
    (
      await request(
        'PATCH',
        '/me/terms',
        { acceptedTermsVersion: 'v1' },
        session
      )
    ).status
  ).toBe(200);
  return session;
}

describe('real HTTP auth/plan/connection durability', () => {
  it('persists public API actions across restart, isolates assignment copies and denies unrelated access', async () => {
    server = await startOwnedApiServer('journeys-first');
    const firstPid = server.pid;
    const coach = await createAccount('coach', 'professional');
    const student = await createAccount('student', 'student');
    const unrelated = await createAccount('unrelated', 'student');
    expect(
      (
        await request(
          'POST',
          '/professional/specialties',
          { specialty: 'fitness_coach' },
          coach
        )
      ).status
    ).toBe(201);
    const created = await request<{ plan: Plan }>(
      'POST',
      '/plans/training',
      { name: 'QA Durable Plan', mode: 'professional_library' },
      coach
    );
    expect(created.status).toBe(201);
    const planId = created.body.plan.id;
    const sessions: Plan['sessions'] = [
      {
        id: 'qa-session-1',
        name: 'Upper',
        notes: 'Controlled',
        items: [
          {
            id: 'qa-item-1',
            name: 'QA Exercise',
            quantity: '3x8',
            notes: 'RPE 7',
            exerciseId: '00000000-0000-4000-8000-000000000001',
          },
        ],
      },
    ];
    const saved = await request<{ plan: Plan }>(
      'PATCH',
      `/plans/training/${planId}`,
      { name: 'QA Durable Plan', sessions },
      coach
    );
    expect(saved.status).toBe(200);
    expect(saved.body.plan.sessions).toEqual(sessions);
    const before = [
      ...(await database.client`select name, sessions from training_plans where id = ${planId}`),
    ];
    expect(before[0]?.sessions).toEqual(sessions);

    // Validation failure is a supported API retry path, distinct from transport fault injection.
    expect(
      (
        await request(
          'PATCH',
          `/plans/training/${planId}`,
          { name: '', sessions: [] },
          coach
        )
      ).status
    ).toBe(422);
    expect([
      ...(await database.client`select name, sessions from training_plans where id = ${planId}`),
    ]).toEqual(before);
    expect(
      (
        await request(
          'PATCH',
          `/plans/training/${planId}`,
          { name: 'QA Durable Plan', sessions },
          coach
        )
      ).status
    ).toBe(200);
    const [count] =
      await database.client`select count(*)::int as count from training_plans where id = ${planId}`;
    expect(count?.count).toBe(1);

    const invite = await request<{ inviteCode: { codeValue: string } }>(
      'GET',
      '/professional/invite-codes/fitness_coach',
      undefined,
      coach
    );
    expect(invite.status).toBe(200);
    const submitted = await request<{ connectionId: string; status: string }>(
      'POST',
      '/connections/invite-submissions',
      { code: invite.body.inviteCode.codeValue },
      student
    );
    expect(submitted.status).toBe(201);
    expect(submitted.body.status).toBe('pending_confirmation');
    const connectionId = submitted.body.connectionId;
    const [pending] =
      await database.client`select status from connections where id = ${connectionId}`;
    expect(pending?.status).toBe('pending_confirmation');
    expect(
      (
        await request(
          'POST',
          `/connections/${connectionId}/confirm`,
          {},
          unrelated
        )
      ).status
    ).toBe(403);
    const [stillPending] =
      await database.client`select status from connections where id = ${connectionId}`;
    expect(stillPending?.status).toBe('pending_confirmation');
    expect(
      (await request('POST', `/connections/${connectionId}/confirm`, {}, coach))
        .status
    ).toBe(200);
    const [active] =
      await database.client`select status from connections where id = ${connectionId}`;
    expect(active?.status).toBe('active');
    const assigned = await request<{ assignedCount: number }>(
      'POST',
      `/plans/predefined/${planId}/bulk-assign`,
      { studentUids: [student.profile.authUid] },
      coach
    );
    expect(assigned.status).toBe(200);
    expect(assigned.body.assignedCount).toBe(1);
    const copies = [
      ...(await database.client`select id, name, sessions from training_plans where student_auth_uid = ${student.profile.authUid} and source_kind = 'assigned'`),
    ];
    expect(copies).toHaveLength(1);
    const copyId = copies[0]!.id;
    expect(copies[0]!.sessions).toEqual(sessions);
    expect(
      (
        await request(
          'PATCH',
          `/plans/training/${planId}`,
          { name: 'QA Edited Template', sessions: [] },
          coach
        )
      ).status
    ).toBe(200);
    expect([
      ...(await database.client`select id, name, sessions from training_plans where id = ${copyId}`),
    ]).toEqual(copies);
    expect(
      (await request('GET', `/plans/training/${planId}`, undefined, unrelated))
        .status
    ).toBe(404);
    expect(
      (
        await request(
          'PATCH',
          `/plans/training/${copyId}`,
          { name: 'Unauthorized', sessions: [] },
          unrelated
        )
      ).status
    ).toBe(404);
    expect(
      (
        await request(
          'PATCH',
          `/plans/training/${copyId}`,
          { name: 'Student edit' },
          student
        )
      ).status
    ).toBe(403);
    expect([
      ...(await database.client`select id, name, sessions from training_plans where id = ${copyId}`),
    ]).toEqual(copies);

    await server.stop();
    server = await startOwnedApiServer('journeys-restarted');
    expect(server.pid).not.toBe(firstPid);
    const restored = await request<{ plan: Plan }>(
      'GET',
      `/plans/training/${planId}`,
      undefined,
      coach
    );
    expect(restored.status).toBe(200);
    expect(restored.body.plan.name).toBe('QA Edited Template');
    const copiedRead = await request<{ plan: Plan }>(
      'GET',
      `/plans/training/${copyId}`,
      undefined,
      student
    );
    expect(copiedRead.status).toBe(200);
    expect(copiedRead.body.plan.sessions).toEqual(sessions);
    const refreshed = await request<Session>('POST', '/auth/session/refresh', {
      refreshToken: student.refreshToken,
      sessionMode: 'bearer',
    });
    expect(refreshed.status).toBe(200);
    expect(
      (
        await request('POST', '/auth/session/refresh', {
          refreshToken: student.refreshToken,
          sessionMode: 'bearer',
        })
      ).status
    ).toBe(401);
    expect(
      (
        await request(
          'POST',
          '/auth/session/sign-out',
          { refreshToken: refreshed.body.refreshToken },
          refreshed.body
        )
      ).status
    ).toBe(204);
    expect(
      (
        await request('POST', '/auth/session/refresh', {
          refreshToken: refreshed.body.refreshToken,
          sessionMode: 'bearer',
        })
      ).status
    ).toBe(401);
    await writeFile(
      path.join(
        path.dirname(process.env.MC_TEST_MANIFEST!),
        'journey-evidence.json'
      ),
      JSON.stringify(
        {
          result: 'passed',
          requirementReferences: [
            'TC-213',
            'TC-214',
            'TC-270',
            'TC-278',
            'TC-291A',
          ],
          planId,
          copyId,
          connectionId,
          firstServerPid: firstPid,
          restartedServerPid: server.pid,
          assignedContentHash: createHash('sha256')
            .update(JSON.stringify(copies))
            .digest('hex'),
          auth: 'local-email-public-route-postgres',
          persistence: 'postgres',
          validationRetry: '422 then 200; one plan row',
          accessDenial:
            '404 unrelated / 403 read-only student; unchanged persisted copy',
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
  }, 30_000);
});
