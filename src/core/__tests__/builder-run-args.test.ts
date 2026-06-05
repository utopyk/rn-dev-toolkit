// Unit coverage for `composeRunArgs` — the pure CLI-boundary mapping
// from BuildOptions to `react-native run-<platform>` argv. This is the
// part that has produced real bugs (`--configuration` vs `--mode`, and
// Android product-flavor projects failing with an ambiguous-variant
// error because no `--mode`/`--appIdSuffix` was passed). Kept pure so it
// can be asserted without spawning gradle/xcodebuild.

import { describe, it, expect } from "vitest";
import { composeRunArgs, type BuildOptions } from "../builder.js";

const base: BuildOptions = {
  projectRoot: "/repo",
  platform: "ios",
  port: 8081,
  variant: "debug",
};

describe("composeRunArgs — iOS", () => {
  it("emits run-ios with port + verbose and a udid when deviceId is set", () => {
    const args = composeRunArgs({ ...base, deviceId: "00008130-ABC" });
    expect(args).toEqual([
      "run-ios",
      "--port",
      "8081",
      "--verbose",
      "--no-packager",
      "--udid",
      "00008130-ABC",
    ]);
  });

  it("maps configuration to --mode (not --configuration) and passes --scheme", () => {
    const args = composeRunArgs({
      ...base,
      scheme: "Acme",
      configuration: "Debug",
    });
    expect(args).toContain("--scheme");
    expect(args).toContain("Acme");
    expect(args).toContain("--mode");
    expect(args).toContain("Debug");
    expect(args).not.toContain("--configuration");
  });

  it("falls back to --mode Release for a release variant with no explicit configuration", () => {
    const args = composeRunArgs({ ...base, variant: "release" });
    expect(args.join(" ")).toContain("--mode Release");
  });

  it("ignores appIdSuffix on iOS", () => {
    const args = composeRunArgs({ ...base, appIdSuffix: "beta" });
    expect(args).not.toContain("--appIdSuffix");
  });
});

describe("composeRunArgs — Android (acme product-flavor case)", () => {
  const android: BuildOptions = { ...base, platform: "android" };

  it("emits the full acme betaDebug invocation with an assemble-only task", () => {
    const args = composeRunArgs({
      ...android,
      port: 8090,
      deviceId: "R5CX23WBLKE",
      configuration: "betaDebug",
      appIdSuffix: "beta",
    });
    expect(args).toEqual([
      "run-android",
      "--port",
      "8090",
      "--verbose",
      "--no-packager",
      "--deviceId",
      "R5CX23WBLKE",
      "--mode",
      "betaDebug",
      "--tasks",
      "assembleBetaDebug",
      "--appIdSuffix",
      "beta",
    ]);
  });

  it("maps configuration to --mode for Android too (product-flavor variant)", () => {
    const args = composeRunArgs({ ...android, configuration: "productionDebug" });
    expect(args.join(" ")).toContain("--mode productionDebug");
  });

  it("uses an assemble-only gradle task (not install<Variant>) to avoid install-on-all-devices", () => {
    const args = composeRunArgs({ ...android, configuration: "betaDebug" });
    // The gradle install<Variant> task installs on every connected device,
    // disrupting other sessions. We assemble instead; RN CLI's
    // installAndLaunchOnDevice does the device-scoped install.
    expect(args.join(" ")).toContain("--tasks assembleBetaDebug");
  });

  it("does not pass --appIdSuffix when none is set", () => {
    const args = composeRunArgs({ ...android, configuration: "betaDebug" });
    expect(args).not.toContain("--appIdSuffix");
  });

  it("preserves the legacy --variant release fallback when no configuration is given", () => {
    const args = composeRunArgs({ ...android, variant: "release" });
    expect(args.join(" ")).toContain("--variant release");
    expect(args).not.toContain("--mode");
  });

  it("uses --deviceId (not --udid) on Android", () => {
    const args = composeRunArgs({ ...android, deviceId: "emulator-5554" });
    expect(args).toContain("--deviceId");
    expect(args).not.toContain("--udid");
  });
});
