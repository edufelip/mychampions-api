import {
  OWNED_SESSION_AUTH_RATE_LIMIT_MAX,
  validateOwnedWebOrigins,
} from "./owned-runtime";
import { assertTestDocument } from "./document-validation";

export type SessionRequest =
  | { id: string; op: "seed" | "snapshot"; scope: string }
  | { id: string; op: "connection-snapshot"; scope: string }
  | { id: string; op: "restart"; attempt: string }
  | { id: string; op: "stop" };

export function parseSessionOptions(args: string[]) {
  const origins: string[] = [];
  let deadlineMs = 600_000;
  let deadlineSpecified = false;
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (args[i] === "--web-origin" && value) origins.push(value);
    else if (
      args[i] === "--deadline-ms" &&
      !deadlineSpecified &&
      /^\d+$/.test(value ?? "") &&
      Number(value) >= 1000 &&
      Number(value) <= 3_600_000
    ) {
      deadlineMs = Number(value);
      deadlineSpecified = true;
    } else throw new Error("Invalid owned session arguments");
  }
  return { webOrigins: validateOwnedWebOrigins(origins), deadlineMs };
}

/**
 * Runtime options for a browser/native owned session. Sessions always need the
 * real client checkout, and their API gets the raised owned-session auth rate
 * limit because one journey signs in repeatedly through one loopback IP.
 */
export function ownedSessionRuntimeOptions(
  options: ReturnType<typeof parseSessionOptions>,
) {
  return {
    webOrigins: options.webOrigins,
    authRateLimitMax: OWNED_SESSION_AUTH_RATE_LIMIT_MAX,
    clientCheckout: "required" as const,
  };
}

export function parseSessionRequest(value: unknown): SessionRequest {
  try {
    assertTestDocument("session-request-v1", value);
  } catch {
    throw new Error("Invalid owned session request");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid owned session request");
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !/^[a-z0-9-]{1,48}$/.test(row.id))
    throw new Error("Invalid owned session request ID");
  const keys = Object.keys(row).sort().join(",");
  if (row.op === "stop" && keys === "id,op") return { id: row.id, op: "stop" };
  if (
    (row.op === "seed" || row.op === "snapshot") &&
    keys === "id,op,scope" &&
    typeof row.scope === "string" &&
    /^[a-z0-9-]{1,32}$/.test(row.scope)
  )
    return { id: row.id, op: row.op, scope: row.scope };
  if (
    row.op === "connection-snapshot" &&
    keys === "id,op,scope" &&
    typeof row.scope === "string" &&
    /^[a-z0-9-]{1,32}$/.test(row.scope)
  )
    return { id: row.id, op: "connection-snapshot", scope: row.scope };
  if (
    row.op === "restart" &&
    keys === "attempt,id,op" &&
    typeof row.attempt === "string" &&
    /^[a-z0-9-]{1,48}$/.test(row.attempt)
  )
    return { id: row.id, op: "restart", attempt: row.attempt };
  throw new Error("Invalid owned session operation or fields");
}
