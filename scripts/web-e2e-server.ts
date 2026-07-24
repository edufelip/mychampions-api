import { createApp } from '../src/app';
import { EmailAuthGatewayError, type EmailAuthIdentity } from '../src/auth/email-auth';
import type { ConnectionRepository } from '../src/connections/repository';
import { readConfig } from '../src/config';
import type { WaterLogRepository } from '../src/nutrition/water-log-repository';
import type { PlanRepository } from '../src/plans/plan-repository';
import { ProfileConflictError, ProfileNotFoundError, type Profile, type ProfileRepository } from '../src/profile/repository';

const port = Number.parseInt(process.env.PORT ?? '3401', 10);
const webOrigin = process.env.WEB_E2E_ORIGIN ?? 'http://127.0.0.1:8082';
const profiles = new Map<string, Profile>();
const accounts = new Map<string, EmailAuthIdentity & { password: string }>();

function unsupportedDomainMutation(): never {
  throw new Error('web_e2e_domain_mutation_not_supported');
}

const connectionRepository: ConnectionRepository = {
  async listForAuthUid() {
    return [];
  },
  async getOrCreateActiveInviteCode() {
    return unsupportedDomainMutation();
  },
  async rotateInviteCode() {
    return unsupportedDomainMutation();
  },
  async submitInviteCode() {
    return unsupportedDomainMutation();
  },
  async confirmPendingConnection() {
    return unsupportedDomainMutation();
  },
  async endConnection() {
    return unsupportedDomainMutation();
  },
};

const waterLogRepository: WaterLogRepository = {
  async logIntake() {
    return unsupportedDomainMutation();
  },
  async listForOwner() {
    return [];
  },
  async getGoalContext() {
    return {
      studentGoalMl: null,
      nutritionistGoalMl: null,
      hasActiveNutritionistAssignment: false,
    };
  },
};

const planReadRepository = {
  async listForAuthUid() {
    return [];
  },
  async listPredefinedForOwner() {
    return [];
  },
} satisfies Pick<PlanRepository, 'listForAuthUid' | 'listPredefinedForOwner'>;

const planRepository = new Proxy(planReadRepository as PlanRepository, {
  get(target, property, receiver) {
    if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
    return unsupportedDomainMutation;
  },
});

function authUidForEmail(email: string): string {
  return `web_e2e_${Buffer.from(email).toString('base64url')}`;
}

const profileRepository: ProfileRepository = {
  async upsertFromSession(input) {
    const existing = profiles.get(input.authUid);
    const now = new Date().toISOString();
    const profile: Profile = {
      authUid: input.authUid,
      displayName: input.displayName,
      emailNormalized: input.emailNormalized,
      lockedRole: existing?.lockedRole ?? null,
      acceptedTermsVersion: existing?.acceptedTermsVersion ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    profiles.set(input.authUid, profile);
    return profile;
  },
  async findByAuthUid(authUid) {
    return profiles.get(authUid) ?? null;
  },
  async lockRole(authUid, role) {
    const current = profiles.get(authUid);
    if (!current) throw new ProfileNotFoundError('profile_not_found');
    if (current.lockedRole && current.lockedRole !== role) {
      throw new ProfileConflictError('role_already_locked');
    }
    const next = { ...current, lockedRole: role, updatedAt: new Date().toISOString() };
    profiles.set(authUid, next);
    return next;
  },
  async setAcceptedTermsVersion(authUid, acceptedTermsVersion) {
    const current = profiles.get(authUid);
    if (!current) throw new ProfileNotFoundError('profile_not_found');
    const next = { ...current, acceptedTermsVersion, updatedAt: new Date().toISOString() };
    profiles.set(authUid, next);
    return next;
  },
  async deleteByAuthUid(authUid) {
    profiles.delete(authUid);
  },
};

const app = createApp({
  config: readConfig({
    APP_VARIANT: 'dev',
    NODE_ENV: 'test',
    PORT: String(port),
    WEB_ALLOWED_ORIGINS: webOrigin,
  }),
  profileRepository,
  connectionRepository,
  planRepository,
  waterLogRepository,
  emailAuthGateway: {
    async createAccount(input) {
      const email = input.email.trim().toLowerCase();
      if (accounts.has(email)) {
        throw new EmailAuthGatewayError('duplicate_email', 'Email is already registered.');
      }
      const identity = {
        authUid: authUidForEmail(email),
        displayName: input.displayName,
        email,
        emailVerified: true,
      };
      accounts.set(email, { ...identity, password: input.password });
      return identity;
    },
    async signIn(input) {
      const account = accounts.get(input.email.trim().toLowerCase());
      if (!account || account.password !== input.password) {
        throw new EmailAuthGatewayError('invalid_credentials', 'Invalid email or password.');
      }
      return account;
    },
  },
});

app.listen(port);
console.log(`MyChampions web E2E server listening on http://127.0.0.1:${port}`);
