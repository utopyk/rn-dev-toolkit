// Tool handlers for device-control. Pure: every adapter lookup goes
// through the supplied `getAdapter(platform)` so tests inject stubs.
//
// Wire-format contract — every tool returns plain JSON-clonable values;
// MCP `structuredContent` wraps them unchanged. Screenshots return
// base64 PNG rather than raw bytes so the MCP layer doesn't need to
// negotiate a binary channel.

import type { DeviceAdapter, Device, Platform } from "./adapter.js";

export interface ToolDeps {
  getAdapter: (platform: Platform) => DeviceAdapter | null;
  /** List-only cache to avoid double-listing when install-apk/launch/tap are invoked. */
  resolveUdid?: (udid: string) => Promise<Platform | null>;
  /** Swap in a mock logger for tests. */
  log?: (
    level: "info" | "warn" | "error",
    message: string,
    data?: Record<string, unknown>,
  ) => void;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface ListArgs {
  platform?: "android" | "ios" | "both";
}

export interface ListResult {
  devices: Device[];
  warnings: Array<{ platform: Platform; reason: string }>;
}

export async function list(args: ListArgs, deps: ToolDeps): Promise<ListResult> {
  const target = args.platform ?? "both";
  const platforms: Platform[] =
    target === "android" ? ["android"] : target === "ios" ? ["ios"] : ["android", "ios"];

  const devices: Device[] = [];
  const warnings: ListResult["warnings"] = [];
  for (const p of platforms) {
    const adapter = deps.getAdapter(p);
    if (!adapter) {
      warnings.push({ platform: p, reason: `no adapter registered for ${p}` });
      continue;
    }
    const outcome = await adapter.list();
    if (outcome.kind === "ok") {
      devices.push(...outcome.devices);
    } else {
      warnings.push({ platform: p, reason: outcome.reason });
    }
  }
  return { devices, warnings };
}

// ---------------------------------------------------------------------------
// Platform dispatch — route a udid to its adapter
// ---------------------------------------------------------------------------

async function adapterFor(
  udid: string,
  deps: ToolDeps,
): Promise<DeviceAdapter> {
  const platform = await resolvePlatform(udid, deps);
  if (!platform) {
    throw new Error(
      `device "${udid}" is not currently connected on any known platform`,
    );
  }
  const adapter = deps.getAdapter(platform);
  if (!adapter) {
    throw new Error(`no adapter for resolved platform "${platform}"`);
  }
  return adapter;
}

async function resolvePlatform(
  udid: string,
  deps: ToolDeps,
): Promise<Platform | null> {
  if (deps.resolveUdid) return deps.resolveUdid(udid);
  // Fallback: ask each adapter's list and match. Cheap for the handful
  // of devices a laptop typically has; heavier calls can inject a
  // `resolveUdid` cache.
  for (const p of ["android", "ios"] as const) {
    const adapter = deps.getAdapter(p);
    if (!adapter) continue;
    const outcome = await adapter.list();
    if (outcome.kind !== "ok") continue;
    if (outcome.devices.some((d) => d.udid === udid)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// screenshot / tap / swipe / type / launch / logs / install / uninstall
// ---------------------------------------------------------------------------

export interface ScreenshotArgs {
  udid: string;
}

export async function screenshot(
  args: ScreenshotArgs,
  deps: ToolDeps,
): Promise<{ pngBase64: string }> {
  const adapter = await adapterFor(args.udid, deps);
  return adapter.screenshot(args.udid);
}

export interface TapArgs {
  udid: string;
  x: number;
  y: number;
}

export async function tap(
  args: TapArgs,
  deps: ToolDeps,
): Promise<{ ok: true }> {
  const adapter = await adapterFor(args.udid, deps);
  await adapter.tap(args.udid, args.x, args.y);
  return { ok: true };
}

export interface SwipeArgs {
  udid: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  durationMs?: number;
}

export async function swipe(
  args: SwipeArgs,
  deps: ToolDeps,
): Promise<{ ok: true }> {
  const adapter = await adapterFor(args.udid, deps);
  await adapter.swipe(args.udid, args.x1, args.y1, args.x2, args.y2, args.durationMs ?? 200);
  return { ok: true };
}

export interface TypeTextArgs {
  udid: string;
  text: string;
}

export async function typeText(
  args: TypeTextArgs,
  deps: ToolDeps,
): Promise<{ ok: true }> {
  const adapter = await adapterFor(args.udid, deps);
  await adapter.typeText(args.udid, args.text);
  return { ok: true };
}

export interface LaunchAppArgs {
  udid: string;
  applicationId?: string;
  bundleId?: string;
}

export async function launchApp(
  args: LaunchAppArgs,
  deps: ToolDeps,
): Promise<{ ok: true }> {
  const adapter = await adapterFor(args.udid, deps);
  const appId = resolveAppId(adapter, args, "launch-app");
  await adapter.launchApp(args.udid, appId);
  return { ok: true };
}

export interface LogsTailArgs {
  udid: string;
  lines?: number;
}

export async function logsTail(
  args: LogsTailArgs,
  deps: ToolDeps,
): Promise<{ lines: string[] }> {
  const adapter = await adapterFor(args.udid, deps);
  return adapter.logsTail(args.udid, args.lines ?? 200);
}

export interface InstallApkArgs {
  udid: string;
  apkPath: string;
}

export async function installApk(
  args: InstallApkArgs,
  deps: ToolDeps,
): Promise<{ ok: true }> {
  const adapter = await adapterFor(args.udid, deps);
  if (adapter.platform !== "android" || !adapter.installApp) {
    throw new Error("install-apk is only available on Android devices");
  }
  await adapter.installApp(args.udid, args.apkPath);
  return { ok: true };
}

export interface UninstallAppArgs {
  udid: string;
  applicationId?: string;
  bundleId?: string;
}

export async function uninstallApp(
  args: UninstallAppArgs,
  deps: ToolDeps,
): Promise<{ ok: true }> {
  const adapter = await adapterFor(args.udid, deps);
  const appId = resolveAppId(adapter, args, "uninstall-app");
  await adapter.uninstallApp(args.udid, appId);
  return { ok: true };
}

/**
 * Pick the right app identifier field for the adapter's platform and
 * throw a platform-specific error when it's missing. Shared between
 * launchApp + uninstallApp (Phase 10 P2-9 — Simplicity P1-5 from
 * Phase 7 review).
 */
function resolveAppId(
  adapter: DeviceAdapter,
  args: { applicationId?: string; bundleId?: string },
  toolName: string,
): string {
  const appId =
    adapter.platform === "android" ? args.applicationId : args.bundleId;
  if (!appId) {
    throw new Error(
      adapter.platform === "android"
        ? `${toolName} requires { applicationId } for Android devices`
        : `${toolName} requires { bundleId } for iOS devices`,
    );
  }
  return appId;
}
