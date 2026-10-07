import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export type ProcessField = "lstart" | "command" | "stat";
export function interpretProcessQuery(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): string | undefined {
  const value = result.stdout.trim();
  if (result.exitCode === 1 && !value && !result.stderr.trim())
    return undefined;
  if (result.exitCode !== 0 || !value || result.stderr.trim())
    throw new Error("Process identity query is ambiguous; recovery retained");
  return value;
}

// A successful but empty query must never be interpreted as a dead owned PID.
export async function queryOwnedProcess(pid: number, field: ProcessField) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid > 2147483647)
    throw new Error("Invalid process query PID");
  if (!["lstart", "command", "stat"].includes(field))
    throw new Error("Invalid process query field");
  try {
    const result = await execute("ps", ["-p", String(pid), "-o", `${field}=`], {
      timeout: 5000,
      maxBuffer: 65536,
    });
    return interpretProcessQuery({ exitCode: 0, ...result });
  } catch (error) {
    const result = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    if (
      result.code === 1 &&
      typeof result.stdout === "string" &&
      typeof result.stderr === "string"
    )
      return interpretProcessQuery({
        exitCode: 1,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    throw new Error("Process identity query failed; recovery retained");
  }
}
