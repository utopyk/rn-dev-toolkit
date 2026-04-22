import { describe, expect, it } from "vitest";
import { PanelSenderRegistry } from "../panel-sender-registry.js";
import type { WebContents } from "electron";

// WebContents is a runtime Electron class — we only need identity, so
// a plain object plays the same role in unit tests.
function fakeContents(): WebContents {
  return {} as unknown as WebContents;
}

describe("PanelSenderRegistry", () => {
  it("trusted host senders resolve to kind='host' and can address any moduleId", () => {
    const reg = new PanelSenderRegistry();
    const host = fakeContents();
    reg.trustHostSender(host);

    expect(reg.resolve(host)).toEqual({ kind: "host" });
    expect(reg.canAddress(host, "any-module")).toBe(true);
    expect(reg.canAddress(host, "another")).toBe(true);
  });

  it("panel senders resolve to their registered moduleId", () => {
    const reg = new PanelSenderRegistry();
    const panel = fakeContents();
    reg.registerPanel(panel, "device-control");

    expect(reg.resolve(panel)).toEqual({
      kind: "panel",
      moduleId: "device-control",
    });
  });

  it("panel senders can ONLY address their own moduleId", () => {
    const reg = new PanelSenderRegistry();
    const panel = fakeContents();
    reg.registerPanel(panel, "device-control");

    expect(reg.canAddress(panel, "device-control")).toBe(true);
    expect(reg.canAddress(panel, "other-module")).toBe(false);
  });

  it("unknown senders resolve to null and cannot address anything", () => {
    const reg = new PanelSenderRegistry();
    const stranger = fakeContents();

    expect(reg.resolve(stranger)).toBeNull();
    expect(reg.canAddress(stranger, "any")).toBe(false);
  });

  it("trusted + panel sets are independent — registering both keeps host precedence", () => {
    const reg = new PanelSenderRegistry();
    const dual = fakeContents();
    // Order of registration shouldn't matter for the resolve contract;
    // host precedence is what's tested.
    reg.registerPanel(dual, "should-be-ignored");
    reg.trustHostSender(dual);

    expect(reg.resolve(dual)).toEqual({ kind: "host" });
    expect(reg.canAddress(dual, "anything")).toBe(true);
  });
});
