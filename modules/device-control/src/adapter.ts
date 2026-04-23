// Common device adapter interface. Both android (adb) and ios
// (xcrun simctl) adapters satisfy this so the tool layer is a thin
// dispatch over a map of udid → platform → adapter.
//
// Coordinate system: all (x, y) values are DEVICE pixels, matching what
// `adb shell screencap` and `simctl io ... screenshot` return. Agents
// that scale screenshots for vision models are responsible for the
// inverse transform before calling tap/swipe — the adapters don't
// know the renderer's display density.

export type Platform = "android" | "ios";
export type DeviceState = "booted" | "unavailable" | "unknown";

export interface Device {
  udid: string;
  name: string;
  platform: Platform;
  state: DeviceState;
  /** iOS only — `iOS 17.4` etc. */
  runtime?: string;
  /** Android only — api level. */
  apiLevel?: number;
}

export interface DeviceAdapter {
  readonly platform: Platform;

  /** Always resolves — "adb not installed" returns an empty list + sets a warning on result. */
  list(): Promise<ListOutcome>;

  screenshot(udid: string): Promise<{ pngBase64: string }>;

  tap(udid: string, x: number, y: number): Promise<void>;

  swipe(
    udid: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number,
  ): Promise<void>;

  typeText(udid: string, text: string): Promise<void>;

  launchApp(udid: string, appId: string): Promise<void>;

  logsTail(udid: string, lines: number): Promise<{ lines: string[] }>;

  installApp?(udid: string, path: string): Promise<void>;

  uninstallApp(udid: string, appId: string): Promise<void>;
}

export type ListOutcome =
  | { kind: "ok"; devices: Device[] }
  | {
      kind: "unavailable";
      reason: string;
    };
