import { describe, expect, it } from "bun:test";
import {
  parseSessionOptions,
  parseSessionRequest,
} from "../scripts/testing/session-protocol";

describe("private owned session protocol preflight", () => {
  it("allows exact loopback web origins and a bounded caller deadline", () => {
    expect(
      parseSessionOptions([
        "--web-origin",
        "http://127.0.0.1:42001",
        "--deadline-ms",
        "90000",
      ]),
    ).toEqual({ webOrigins: ["http://127.0.0.1:42001"], deadlineMs: 90000 });
    expect(parseSessionOptions([]).deadlineMs).toBe(600000);
  });
  for (const origin of [
    "https://127.0.0.1:42001",
    "http://localhost:42001",
    "http://example.com:42001",
    "http://127.0.0.1:42001/path",
    "http://name:secret@127.0.0.1:42001",
    "http://127.0.0.1:80",
    "*",
  ])
    it(`rejects unsafe origin ${origin} before acquisition`, () =>
      expect(() => parseSessionOptions(["--web-origin", origin])).toThrow(
        "loopback",
      ));
  it("rejects missing, unknown, duplicate and unbounded arguments", () => {
    for (const args of [
      ["--web-origin"],
      ["--other", "yes"],
      ["--deadline-ms", "0"],
      ["--deadline-ms", "3600001"],
      ["--deadline-ms", "1000ms"],
      ["--deadline-ms", "1000", "--deadline-ms", "2000"],
    ])
      expect(() => parseSessionOptions(args)).toThrow("Invalid");
  });
  it("accepts only named seed, snapshot, connection-snapshot, restart and stop operations", () => {
    expect(
      parseSessionRequest({ id: "request-1", op: "seed", scope: "auth-1" }),
    ).toEqual({ id: "request-1", op: "seed", scope: "auth-1" });
    expect(
      parseSessionRequest({
        id: "request-2",
        op: "restart",
        attempt: "durability-1",
      }),
    ).toEqual({ id: "request-2", op: "restart", attempt: "durability-1" });
    expect(
      parseSessionRequest({
        id: "request-4",
        op: "snapshot",
        scope: "training-1",
      }),
    ).toEqual({ id: "request-4", op: "snapshot", scope: "training-1" });
    expect(
      parseSessionRequest({
        id: "request-5",
        op: "connection-snapshot",
        scope: "connection-1",
      }),
    ).toEqual({
      id: "request-5",
      op: "connection-snapshot",
      scope: "connection-1",
    });
    expect(parseSessionRequest({ id: "request-3", op: "stop" })).toEqual({
      id: "request-3",
      op: "stop",
    });
  });
  it("rejects missing IDs, path traversal, arbitrary SQL and unexpected fields", () => {
    for (const request of [
      null,
      [],
      {},
      { id: "../escape", op: "stop" },
      { id: "one", op: "seed", scope: "../escape" },
      { id: "one", op: "restart", attempt: "../escape" },
      { id: "one", op: "sql", query: "delete from profiles" },
      { id: "one", op: "snapshot", scope: "../escape" },
      {
        id: "one",
        op: "snapshot",
        scope: "training-1",
        query: "select * from profiles",
      },
      { id: "one", op: "snapshot", scope: "training-1", authUid: "foreign" },
      {
        id: "one",
        op: "connection-snapshot",
        scope: "connection-1",
        phase: "pending_confirmation",
      },
      { id: "one", op: "stop", extra: true },
    ])
      expect(() => parseSessionRequest(request)).toThrow("Invalid");
  });
});
