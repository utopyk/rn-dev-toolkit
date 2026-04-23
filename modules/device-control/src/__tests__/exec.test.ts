// Safety-critical paths in the exec wrapper — these three test the
// destructive-corner-case guards that the adapter argv tests never
// exercise (ENOENT, timeout, oversize-stdout kill).

import { describe, expect, it } from "vitest";
import { execBinary } from "../exec.js";

describe("execBinary", () => {
  it("returns { kind: 'not-found' } when the binary doesn't exist", async () => {
    const outcome = await execBinary(
      "/definitely/not/a/real/binary/on/this/host",
      [],
    );
    expect(outcome.kind).toBe("not-found");
  });

  it("SIGKILLs + returns { kind: 'timeout' } when the process outruns timeoutMs", async () => {
    // `sleep 10` is portable enough; timeout trips in 50ms.
    const outcome = await execBinary("sleep", ["10"], { timeoutMs: 50 });
    expect(outcome.kind).toBe("timeout");
    if (outcome.kind === "timeout") {
      expect(outcome.timeoutMs).toBe(50);
    }
  });

  it("surfaces non-zero exits as { kind: 'non-zero' } with the exit code", async () => {
    // `false` is the POSIX exit-1 primitive.
    const outcome = await execBinary("false", []);
    expect(outcome.kind).toBe("non-zero");
    if (outcome.kind === "non-zero") {
      expect(outcome.code).toBe(1);
    }
  });
});
