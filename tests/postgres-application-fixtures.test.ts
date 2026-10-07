import { afterAll, describe, expect, it } from "bun:test";
import { createDatabase } from "../src/db/client";
import { requireOwnedTestDatabase } from "./helpers/test-database";
import { seedApplicationFixtures } from "../scripts/testing/fixtures";

const database = createDatabase(await requireOwnedTestDatabase());
afterAll(() => database.close());
describe("declared application fixture preconditions", () => {
  it("creates repeatable attempt-scoped accounts, specialties, connection states and a saved plan", async () => {
    const first = await seedApplicationFixtures("fixture-contract");
    const second = await seedApplicationFixtures("fixture-contract");
    // Compare identity/state without exposing credentials in test assertion output.
    for (const name of Object.keys(
      first.accounts,
    ) as (keyof typeof first.accounts)[])
      expect(second.accounts[name].authUid).toBe(first.accounts[name].authUid);
    expect(second.pendingConnectionId).toBe(first.pendingConnectionId);
    expect(second.activeConnectionId).toBe(first.activeConnectionId);
    expect(second.savedPlanId).toBe(first.savedPlanId);
    const profiles =
      await database.client`select locked_role, accepted_terms_version from user_profiles where auth_uid = ${first.accounts.new.authUid}`;
    expect(profiles[0]?.locked_role).toBeNull();
    expect(profiles[0]?.accepted_terms_version).toBeNull();
    const pending =
      await database.client`select status from connections where id = ${first.pendingConnectionId}`;
    const active =
      await database.client`select status from connections where id = ${first.activeConnectionId}`;
    expect(pending[0]?.status).toBe("pending_confirmation");
    expect(active[0]?.status).toBe("active");
    const targetConnections = await database.client`
      select id
      from connections
      where professional_auth_uid = ${first.accounts.coach.authUid}
        and student_auth_uid = ${first.accounts.student.authUid}
        and specialty = 'fitness_coach'
    `;
    expect(targetConnections).toHaveLength(0);
    const targetSpecialty = await database.client`
      select is_active
      from professional_specialties
      where professional_auth_uid = ${first.accounts.coach.authUid}
        and specialty = 'fitness_coach'
    `;
    expect([...targetSpecialty]).toEqual([{ is_active: true }]);
    const targetInvite = await database.client`
      select id, status
      from invite_codes
      where professional_auth_uid = ${first.accounts.coach.authUid}
        and specialty = 'fitness_coach'
        and status = 'active'
    `;
    expect(targetInvite).toHaveLength(1);
    const plan =
      await database.client`select sessions from training_plans where id = ${first.savedPlanId}`;
    expect(plan[0]?.sessions).toEqual(first.draft.sessions);
    const entitlements =
      await database.client`select auth_uid from subscription_entitlement_snapshots where auth_uid = ${first.accounts.coach.authUid}`;
    expect(entitlements).toHaveLength(0);
  }, 30_000);
});
