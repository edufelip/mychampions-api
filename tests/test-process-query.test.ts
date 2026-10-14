import { describe, expect, it } from "bun:test";
import {
  interpretProcessQuery,
  queryOwnedProcess,
} from "../scripts/testing/process-query";

describe("process-query integrity before startup, signalling and cleanup", () => {
  it("only an explicit absent PID establishes absence", () => {
    expect(
      interpretProcessQuery({ exitCode: 1, stdout: "", stderr: "" }),
    ).toBeUndefined();
    for (const result of [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: " \n", stderr: "" },
      {
        exitCode: 0,
        stdout: "Mon Sep 28 21:00:00 2026",
        stderr: "query warning",
      },
      { exitCode: 1, stdout: "", stderr: "permission denied" },
      { exitCode: 2, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "a process", stderr: "" },
    ])
      expect(() => interpretProcessQuery(result)).toThrow("ambiguous");
  });
  it("reads the real current process identity and rejects malformed query inputs", async () => {
    expect(await queryOwnedProcess(process.pid, "lstart")).toBeTruthy();
    expect(await queryOwnedProcess(process.pid, "command")).toContain("bun");
    expect(await queryOwnedProcess(process.pid, "stat")).toBeTruthy();
    await expect(queryOwnedProcess(0, "lstart")).rejects.toThrow("PID");
    await expect(
      queryOwnedProcess(process.pid, "invalid" as "stat"),
    ).rejects.toThrow("field");
  });
  it("observes a separate child alive and then absent after its awaited exit", async () => {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "-e", "await Bun.sleep(60000)"],
      { stdout: "ignore", stderr: "ignore" },
    );
    try {
      expect(await queryOwnedProcess(child.pid, "lstart")).toBeTruthy();
    } finally {
      child.kill("SIGTERM");
      await child.exited;
    }
    expect(await queryOwnedProcess(child.pid, "lstart")).toBeUndefined();
  });
});
