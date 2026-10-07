import { createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createDatabase } from '../../src/db/client';
import {
  LocalEmailAuthGateway,
  EmailAuthGatewayError,
} from '../../src/auth/email-auth';
import { PostgresProfileRepository } from '../../src/profile/postgres-repository';
import { PostgresProfessionalSpecialtyRepository } from '../../src/professional/postgres-specialty-repository';
import { PostgresConnectionRepository } from '../../src/connections/postgres-repository';
import { PostgresPlanRepository } from '../../src/plans/postgres-plan-repository';
import {
  loadTestManifest,
  requireOwnedTestDatabase,
} from '../../tests/helpers/test-database';
import { assertTestDocument } from './document-validation';

type AccountName =
  | 'new'
  | 'student'
  | 'coach'
  | 'unrelated-student'
  | 'unrelated-coach'
  | 'pending-student'
  | 'active-student';
type FixtureAccount = {
  email: string;
  password: string;
  authUid: string;
  role: 'student' | 'professional' | null;
};
export type ApplicationFixtures = {
  schemaVersion: 1;
  runId: string;
  scope: string;
  accounts: Record<AccountName, FixtureAccount>;
  pendingConnectionId: string;
  activeConnectionId: string;
  savedPlanId: string;
  draft: {
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
};

// Preconditions only. Test actions must still use the UI/public API.
export async function seedApplicationFixtures(
  scope: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ApplicationFixtures> {
  if (!/^[a-z0-9-]{1,32}$/.test(scope))
    throw new Error('Invalid fixture attempt scope');
  const manifest = loadTestManifest(env);
  const database = createDatabase(
    await requireOwnedTestDatabase('DATABASE_URL', env)
  );
  const fixturePath = path.join(
    path.dirname(env.MC_TEST_MANIFEST!),
    `fixtures-${scope}.private.json`
  );
  let previous: ApplicationFixtures | undefined;
  try {
    previous = JSON.parse(await readFile(fixturePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (
    previous &&
    (previous.runId !== manifest.runId || previous.scope !== scope)
  )
    throw new Error('Fixture ownership mismatch');
  if (previous) assertTestDocument('application-fixtures-v1', previous);
  const gateway = new LocalEmailAuthGateway(database.db);
  const profiles = new PostgresProfileRepository(database.db);
  const specialties = new PostgresProfessionalSpecialtyRepository(database.db);
  const connections = new PostgresConnectionRepository(database.db);
  const plans = new PostgresPlanRepository(database.db);
  const names: AccountName[] = [
    'new',
    'student',
    'coach',
    'unrelated-student',
    'unrelated-coach',
    'pending-student',
    'active-student',
  ];
  const accounts = {} as Record<AccountName, FixtureAccount>;
  try {
    for (const name of names) {
      const email = `${name}-${scope}-${manifest.runId}@example.test`;
      const password =
        previous?.accounts[name].password ??
        `QA-${createHmac('sha256', env.MC_TEST_OWNER_TOKEN!).update(`${scope}:${name}`).digest('hex').slice(0, 24)}!`;
      let identity;
      try {
        identity = await gateway.createAccount({
          email,
          password,
          displayName: `QA ${name}`,
        });
      } catch (error) {
        if (
          !(error instanceof EmailAuthGatewayError) ||
          error.code !== 'duplicate_email'
        )
          throw error;
        identity = await gateway.signIn({ email, password });
      }
      await profiles.upsertFromSession({
        authUid: identity.authUid,
        emailNormalized: email,
        displayName: `QA ${name}`,
      });
      const role =
        name === 'new'
          ? null
          : name.includes('coach')
            ? 'professional'
            : 'student';
      if (role) {
        await profiles.lockRole(identity.authUid, role);
        await profiles.setAcceptedTermsVersion(identity.authUid, 'v1');
      }
      if (role === 'professional')
        await specialties.addOrReactivate({
          professionalAuthUid: identity.authUid,
          specialty: 'fitness_coach',
        });
      accounts[name] = { email, password, authUid: identity.authUid, role };
    }
    const coach = accounts.coach.authUid;
    const invite = await connections.getOrCreateActiveInviteCode({
      professionalAuthUid: coach,
      specialty: 'fitness_coach',
    });
    const connectionIds = {} as Record<'pending' | 'active', string>;
    for (const status of ['pending', 'active'] as const) {
      const student = accounts[`${status}-student`].authUid;
      let connection = (await connections.listForAuthUid(student)).find(
        (row) =>
          row.professionalAuthUid === coach && row.specialty === 'fitness_coach'
      );
      connection ??= await connections.submitInviteCode({
        code: invite.codeValue,
        studentAuthUid: student,
      });
      if (status === 'active' && connection.status === 'pending_confirmation')
        connection = await connections.confirmPendingConnection({
          connectionId: connection.id,
          professionalAuthUid: coach,
        });
      if (
        connection.status !==
        (status === 'active' ? 'active' : 'pending_confirmation')
      )
        throw new Error(
          'Fixture state changed; use a new attempt scope instead of mutating tested data'
        );
      connectionIds[status] = connection.id;
    }
    const draft = {
      name: `QA ${scope} Training`,
      sessions: [
        {
          id: 'qa-session',
          name: 'Upper',
          notes: 'Controlled',
          items: [
            {
              id: 'qa-item',
              name: 'QA Exercise',
              quantity: '3x8',
              notes: 'RPE 7',
              exerciseId: '00000000-0000-4000-8000-000000000001',
            },
          ],
        },
      ],
    };
    let plan = (
      await plans.listPredefinedForOwner({ ownerProfessionalUid: coach })
    ).find((row) => row.name === draft.name);
    plan ??= await plans.createTrainingPlanDetail({
      authUid: coach,
      name: draft.name,
      mode: 'professional_library',
    });
    await plans.updateTrainingPlanDetail({
      authUid: coach,
      planId: plan.id,
      ...draft,
    });
    const fixtures: ApplicationFixtures = {
      schemaVersion: 1,
      runId: manifest.runId,
      scope,
      accounts,
      pendingConnectionId: connectionIds.pending,
      activeConnectionId: connectionIds.active,
      savedPlanId: plan.id,
      draft,
    };
    assertTestDocument('application-fixtures-v1', fixtures);
    await writeFile(fixturePath, JSON.stringify(fixtures, null, 2), {
      mode: 0o600,
    });
    return fixtures;
  } finally {
    await database.close();
  }
}
