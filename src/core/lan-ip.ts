import os from "node:os";

/**
 * Resolve the host machine's primary non-loopback IPv4 address — the
 * address a physical device on the same Wi-Fi reaches the dev server at.
 *
 * This mirrors the IP that `react-native-xcode.sh` bakes into `ip.txt`
 * for iOS, so the Android `set-bundler` hook and the iOS bake agree on
 * "the host's LAN IP". The Android dev-server-host (`debug_http_host`)
 * is set to `<thisIP>:<metroPort>` so the device connects over Wi-Fi
 * instead of the USB `adb reverse` tunnel — surviving brief USB drops.
 *
 * Heuristic, in order:
 *   1. `en0` (the canonical Wi-Fi / primary interface on macOS).
 *   2. the first non-internal, non-link-local IPv4 on any interface.
 * Link-local (169.254.x) and loopback are skipped — a device can't reach
 * the dev server on those. Returns `null` when no external IPv4 exists
 * (offline / Wi-Fi down) so callers degrade (keep `adb reverse`) instead
 * of baking a bogus host.
 */
export function resolveLanIp(
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string | null {
  const usableIPv4 = (info: os.NetworkInterfaceInfo): boolean =>
    // Node 18+ reports `family` as the string "IPv4"; some older/edge
    // builds use the number 4. Accept both rather than assume.
    (info.family === "IPv4" || (info.family as unknown) === 4) &&
    !info.internal &&
    !info.address.startsWith("169.254.");

  const firstUsable = (name: string): string | null => {
    for (const info of ifaces[name] ?? []) {
      if (usableIPv4(info)) return info.address;
    }
    return null;
  };

  const preferred = firstUsable("en0");
  if (preferred) return preferred;

  for (const name of Object.keys(ifaces)) {
    const addr = firstUsable(name);
    if (addr) return addr;
  }
  return null;
}
