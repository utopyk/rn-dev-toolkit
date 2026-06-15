import { describe, it, expect } from "vitest";
import type os from "node:os";
import { resolveLanIp } from "../lan-ip.js";

// Build a minimal NetworkInterfaceInfo. `family` is the string "IPv4"
// on Node 18+ (what this project runs).
function v4(address: string, internal = false): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  };
}
function v6(address: string): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: "ffff:ffff:ffff:ffff::",
    family: "IPv6",
    mac: "00:00:00:00:00:00",
    internal: false,
    scopeid: 0,
    cidr: `${address}/64`,
  };
}

describe("resolveLanIp", () => {
  it("prefers en0's non-internal IPv4", () => {
    const ip = resolveLanIp({
      lo0: [v4("127.0.0.1", true)],
      en0: [v6("fe80::1"), v4("192.168.1.83")],
      en5: [v4("10.0.0.5")],
    });
    expect(ip).toBe("192.168.1.83");
  });

  it("falls back to the first usable IPv4 on another interface when en0 has none", () => {
    const ip = resolveLanIp({
      lo0: [v4("127.0.0.1", true)],
      en5: [v4("10.0.0.5")],
    });
    expect(ip).toBe("10.0.0.5");
  });

  it("skips loopback and link-local (169.254) addresses", () => {
    const ip = resolveLanIp({
      lo0: [v4("127.0.0.1", true)],
      en0: [v4("169.254.234.24")], // link-local only on en0
      en6: [v4("192.168.50.10")],
    });
    expect(ip).toBe("192.168.50.10");
  });

  it("returns null when there is no external IPv4 (offline)", () => {
    expect(resolveLanIp({ lo0: [v4("127.0.0.1", true)] })).toBeNull();
    expect(resolveLanIp({})).toBeNull();
  });

  it("ignores IPv6 addresses", () => {
    expect(resolveLanIp({ en0: [v6("2600:1700::1")] })).toBeNull();
  });
});
