// Host-side Android auto-bundler.
//
// After a successful Android device build+install, point the app at the
// daemon's Metro dev server over Wi-Fi (LAN IP:port) by writing the RN
// `debug_http_host` SharedPreference on the debuggable package. Android's
// default transport for a USB-attached device is the `adb reverse`
// tunnel, which dies the instant the cable blips; a baked-in Wi-Fi host
// survives that. The reverse tunnel stays in place too, so this is
// purely additive — if Wi-Fi is unreachable the app falls back to it.
//
// iOS needs none of this: react-native-xcode.sh bakes the LAN IP into
// `ip.txt` in the .app at build time, so physical devices already reach
// Metro over Wi-Fi (see the device-control iOS adapter's setBundler).
//
// The adb sequence here is intentionally identical to
// `modules/device-control/src/android-adapter.ts` setBundler — keep the
// two in sync. They can't share code: the module runs as an isolated
// subprocess that bundles its own deps, while this runs inside the host
// bundle. The shared surface is small + pure.

import { spawn } from "node:child_process";
import { resolveLanIp } from "./lan-ip.js";

/**
 * Injectable adb runner: resolves with the command's stdout. When
 * `input` is provided it is piped to the process stdin (used to write a
 * file on-device via `cat >` without arg-escaping the payload).
 */
export type AdbRunner = (
  argv: readonly string[],
  input?: string,
) => Promise<string>;

const APP_ID_RE = /^[A-Za-z0-9._-]+$/;

export interface AutoBundlerOptions {
  /** adb device serial (the build's deviceId). */
  deviceId: string;
  /** Installed package id, e.g. `com.acme.beta`. */
  appId: string;
  /** Metro dev-server port the daemon owns for this session. */
  port: number;
}

export interface AutoBundlerResult {
  /** True when the device-side pref was written. */
  applied: boolean;
  /** Human-readable outcome for the build output panel. */
  detail: string;
}

export interface AutoBundlerDeps {
  /** Override the adb runner (tests). Defaults to a real `adb` spawn. */
  runAdb?: AdbRunner;
  /** Override LAN-IP resolution (tests). Defaults to `resolveLanIp`. */
  resolveHost?: () => string | null;
}

/**
 * Extract the launched Android package from RN CLI / `am start` output.
 * run-android's launch step runs `am start -n <pkg>/<activity>`, and `am`
 * echoes `Starting: Intent { cmp=<pkg>/<activity> }` on stdout. That line
 * carries the EXACT installed applicationId (base + any
 * applicationIdSuffix), so it's the most reliable source — more reliable
 * than re-deriving it from gradle flavors. Returns null when no launch
 * line is present (e.g. a build-only run), in which case the caller skips
 * the auto-bundler and leaves the adb reverse tunnel doing its job.
 */
export function extractAndroidPackage(output: string): string | null {
  const m = output.match(/cmp=([A-Za-z0-9._]+)\/[A-Za-z0-9._$]+/);
  return m ? m[1]! : null;
}

/**
 * Merge a `debug_http_host` entry into an Android SharedPreferences XML
 * `<map>` without clobbering the app's other prefs. Replaces the value if
 * the key exists, inserts before `</map>` otherwise, and synthesizes a
 * minimal valid prefs file when there is none.
 *
 * Kept identical to the device-control module's copy — see file header.
 */
export function upsertDebugHttpHost(
  existingXml: string,
  hostPort: string,
): string {
  const entry = `<string name="debug_http_host">${hostPort}</string>`;
  const trimmed = existingXml.trim();
  if (!trimmed || !trimmed.includes("<map")) {
    return `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    ${entry}\n</map>`;
  }
  const keyRe = /<string name="debug_http_host">[^<]*<\/string>/;
  if (keyRe.test(trimmed)) return trimmed.replace(keyRe, entry);
  return trimmed.replace("</map>", `    ${entry}\n</map>`);
}

/**
 * Point an Android device at the daemon's Metro over Wi-Fi. Best-effort:
 * returns `{ applied: false }` (rather than throwing) when there's no LAN
 * IP to advertise, and throws only on an unsafe appId or a hard adb
 * failure mid-write — the Builder catches that and keeps the build green.
 */
export async function applyAndroidBundler(
  opts: AutoBundlerOptions,
  deps: AutoBundlerDeps = {},
): Promise<AutoBundlerResult> {
  const { deviceId, appId, port } = opts;
  // appId comes from build output (the package am launched), but it lands
  // in a shell string via run-as — reject anything that isn't a plain
  // bundle id rather than trust it blindly.
  if (!APP_ID_RE.test(appId)) {
    throw new Error(`applyAndroidBundler: refusing unsafe appId "${appId}"`);
  }
  const host = (deps.resolveHost ?? resolveLanIp)();
  if (!host) {
    return {
      applied: false,
      detail: "no LAN IP resolved (offline?); kept the adb reverse tunnel",
    };
  }
  const runAdb = deps.runAdb ?? spawnAdb;
  const prefsPath = `shared_prefs/${appId}_preferences.xml`;
  const value = `${host}:${port}`;

  // Read existing prefs (absent before first launch), merge our key in,
  // write back via run-as + stdin, then force-stop so the next launch
  // re-reads. run-as only works on debuggable builds — fine, dev only.
  let existing = "";
  try {
    existing = await runAdb([
      "-s", deviceId, "exec-out", "run-as", appId, "cat", prefsPath,
    ]);
  } catch {
    existing = "";
  }
  const merged = upsertDebugHttpHost(existing, value);
  await runAdb(
    [
      "-s", deviceId, "shell",
      `run-as ${appId} sh -c 'mkdir -p shared_prefs && cat > ${prefsPath}'`,
    ],
    merged,
  );
  await runAdb(["-s", deviceId, "shell", "am", "force-stop", appId]);
  return { applied: true, detail: `debug_http_host=${value} (${appId})` };
}

/** Real adb runner — spawns `adb`, captures stdout, pipes `input` if set. */
function spawnAdb(argv: readonly string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("adb", [...argv], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    proc.stderr?.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `adb exited with code ${code}`));
    });
    if (input !== undefined) proc.stdin?.write(input);
    proc.stdin?.end();
  });
}
