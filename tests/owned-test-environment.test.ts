import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";

import { createApp } from "../src/app";
import { InMemoryPasswordResetService } from "../src/auth/password-reset";
import { readConfig } from "../src/config";
import type { ProfileRepository } from "../src/profile/repository";
import {
  buildOwnedTestEnvironment,
  OWNED_SESSION_AUTH_RATE_LIMIT_MAX,
  validateOwnedAuthRateLimitMax,
} from "../scripts/testing/owned-runtime";
import {
  ownedSessionRuntimeOptions,
  parseSessionOptions,
} from "../scripts/testing/session-protocol";

const runId = "0123456789abcdef01234567";
const targets = {
  DATABASE_URL: `mc_test_${runId}`,
  FOOD_CATALOG_DATABASE_URL: `mc_test_${runId}_food`,
  EXERCISE_CATALOG_DATABASE_URL: `mc_test_${runId}_exercise`,
};

function ownedEnvironment(authRateLimitMax?: number) {
  return buildOwnedTestEnvironment({
    base: {
      PATH: "/usr/bin",
      HOME: "/home/owned",
      // Never copied: only PATH and HOME come from the caller.
      DATABASE_URL: "postgres://developer@127.0.0.1:15432/mychampions",
      REVENUECAT_SECRET_API_KEY: "developer-secret",
    },
    manifestPath: `/owned/.qa/runtime/${runId}/manifest.json`,
    ownerToken: "owner-token",
    password: "owned-password",
    port: 54_321,
    targets,
    webOrigins: ["http://127.0.0.1:42001"],
    authRateLimitMax,
  });
}

function profileRepository(): ProfileRepository {
  return {
    async upsertFromSession(input) {
      return {
        authUid: input.authUid,
        displayName: input.displayName,
        emailNormalized: input.emailNormalized,
        lockedRole: "student",
        acceptedTermsVersion: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
    },
    async findByAuthUid() {
      return null;
    },
    async lockRole() {
      throw new Error("not implemented");
    },
    async setAcceptedTermsVersion() {
      throw new Error("not implemented");
    },
    async deleteByAuthUid() {},
  };
}

// Sign in `count` times from one loopback client, as a native journey does.
async function devSessionStatuses(env: NodeJS.ProcessEnv, count: number) {
  const app = createApp({
    config: readConfig(env),
    profileRepository: profileRepository(),
    passwordResetService: new InMemoryPasswordResetService(),
  });
  const statuses: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const response = await app.handle(
      new Request("http://127.0.0.1/auth/dev/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-real-ip": "127.0.0.1",
        },
        body: JSON.stringify({
          email: `owned-journey-${index}@example.test`,
          displayName: "Owned Journey",
        }),
      }),
    );
    statuses.push(response.status);
  }
  return statuses;
}

describe("owned test environment", () => {
  it("passes only owned database URLs and blank provider credentials", () => {
    const env = ownedEnvironment();
    expect(env.DATABASE_URL).toBe(
      `postgres://mc_test:owned-password@127.0.0.1:54321/mc_test_${runId}`,
    );
    expect(env.FOOD_CATALOG_DATABASE_URL).toEndWith(`/mc_test_${runId}_food`);
    expect(env.EXERCISE_CATALOG_DATABASE_URL).toEndWith(
      `/mc_test_${runId}_exercise`,
    );
    expect(env.REVENUECAT_SECRET_API_KEY).toBe("");
    expect(env.GCS_BUCKET).toBe("");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.WEB_ALLOWED_ORIGINS).toBe("http://127.0.0.1:42001");
  });

  it("keeps the production auth rate limit for the integration runner", async () => {
    const env = ownedEnvironment();
    expect(Object.hasOwn(env, "AUTH_RATE_LIMIT_MAX")).toBe(false);
    expect(readConfig(env).authRateLimitMax).toBe(20);
    const statuses = await devSessionStatuses(env, 21);
    expect(statuses.slice(0, 20).every((status) => status === 201)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it("raises the auth rate limit for owned browser/native sessions only", async () => {
    const options = ownedSessionRuntimeOptions(
      parseSessionOptions(["--web-origin", "http://127.0.0.1:42001"]),
    );
    expect(options).toEqual({
      webOrigins: ["http://127.0.0.1:42001"],
      authRateLimitMax: OWNED_SESSION_AUTH_RATE_LIMIT_MAX,
      clientCheckout: "required",
    });
    const env = ownedEnvironment(options.authRateLimitMax);
    expect(env.AUTH_RATE_LIMIT_MAX).toBe(
      String(OWNED_SESSION_AUTH_RATE_LIMIT_MAX),
    );
    expect(readConfig(env).authRateLimitMax).toBe(
      OWNED_SESSION_AUTH_RATE_LIMIT_MAX,
    );
    // Well past the production budget of 20 from the same loopback IP.
    const statuses = await devSessionStatuses(env, 40);
    expect(statuses.every((status) => status === 201)).toBe(true);
  });

  it("rejects an invalid owned auth rate limit before acquisition", () => {
    for (const value of [0, -1, 1.5, 100_001, Number.NaN])
      expect(() => validateOwnedAuthRateLimitMax(value)).toThrow(
        "Owned auth rate limit",
      );
    expect(validateOwnedAuthRateLimitMax(100_000)).toBe(100_000);
  });

  it("keeps the owned session limit out of production code and config", async () => {
    const root = path.resolve(import.meta.dir, "..");
    const sources = (await readdir(path.join(root, "src"), { recursive: true }))
      .filter((file) => file.endsWith(".ts"))
      .map((file) => path.join(root, "src", file));
    for (const file of sources) {
      const source = await readFile(file, "utf8");
      expect(source).not.toContain("scripts/testing");
      expect(source).not.toContain("OWNED_SESSION_AUTH_RATE_LIMIT_MAX");
    }
    expect(await readFile(path.join(root, ".env.example"), "utf8")).toContain(
      "AUTH_RATE_LIMIT_MAX=20\n",
    );
  });
});
