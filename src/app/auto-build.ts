import type { DaemonSession } from "./client/session.js";
import type { Profile } from "../core/types.js";

/**
 * Trigger a `builder/build` for each platform listed by the profile,
 * unless the profile is in "quick" mode.
 *
 * Lives in its own leaf module (no TUI/React imports) so the Electron
 * entrypoint can import it without dragging the TUI's Ink/OpenTUI tree
 * into the electron tsconfig graph. The TUI start-flow re-exports it
 * under its original name for backwards-compatibility.
 *
 * Why call this immediately after a session attaches:
 * - dirty/clean/ultra-clean modes expect a fresh build after Metro is
 *   up; `boot.ts` only sets up infrastructure.
 * - quick mode skips builds — the user's installed app connects to
 *   Metro directly.
 * - The 200ms timeout matches the TUI's pre-13.3 race window so
 *   `useEffect` listeners on `instance:build:*` channels subscribe
 *   before the daemon starts emitting events.
 */
export function triggerBuildsIfNeeded(
  session: DaemonSession,
  profile: Profile,
  projectRoot: string,
): void {
  if (profile.mode === "quick") return;

  const platformsToBuild: Array<"ios" | "android"> =
    profile.platform === "both"
      ? ["ios", "android"]
      : [profile.platform as "ios" | "android"];

  setTimeout(() => {
    for (const plat of platformsToBuild) {
      const devId =
        plat === "ios" ? profile.devices?.ios : profile.devices?.android;
      void session.builder.build({
        projectRoot: profile.worktree ?? projectRoot,
        platform: plat,
        deviceId: devId ?? undefined,
        port: profile.metroPort,
        variant: profile.buildVariant,
        env: profile.env,
        // Configuration is profile-driven on both platforms (it maps to
        // RN CLI's `--mode`): the iOS Xcode configuration or the Android
        // Gradle variant. `scheme` is iOS-only (Xcode schemes);
        // `appIdSuffix` is Android-only (applicationIdSuffix flavors,
        // e.g. acme beta → com.acme.beta).
        ...(profile.configuration ? { configuration: profile.configuration } : {}),
        ...(plat === "ios"
          ? { ...(profile.scheme ? { scheme: profile.scheme } : {}) }
          : {
              ...(profile.appIdSuffix ? { appIdSuffix: profile.appIdSuffix } : {}),
              // Forward the auto-bundler opt-out only when set; undefined
              // means "default on" at the Builder (Android device builds).
              ...(profile.autoBundler !== undefined
                ? { autoBundler: profile.autoBundler }
                : {}),
            }),
      });
    }
  }, 200);
}
