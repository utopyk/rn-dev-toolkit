# Native network capture — what's required

**Date:** 2026-06-19
**Status:** Research / not implemented

The Network panel today only sees requests that flow through React
Native's JS networking layer. The user asked: "what is required" to see
native requests. This note answers that, lays out the options, and
recommends an order.

## Current capture pipeline

The whole network capture story today is **CDP `Network.*` over the
Hermes inspector** ([src/core/devtools/network-tap.ts](../../src/core/devtools/network-tap.ts)).

Concretely:

1. The daemon's DevTools service opens a CDP WebSocket to the Hermes
   inspector for the target app.
2. The host issues `Network.enable` and receives `Network.requestWillBeSent`,
   `responseReceived`, `dataReceived`, `loadingFinished`, `loadingFailed`
   events as the app makes requests.
3. `NetworkTap` reduces those into `NetworkEntry` rows in a ring buffer.
4. `devtools-network__list` / `get` tools serve the buffer to the panel + MCP.

The events come from **React Native's `Networking` module**
(`RCTNetworking` on iOS, `Networking.java` / OkHttp wrapper on Android) —
the same code path used by `fetch`, `XMLHttpRequest`, and `WebSocket`
issued from JS.

## What's NOT captured

Anything that doesn't go through `RCTNetworking`:

- **`NSURLSession.shared.dataTask(...)`** called directly from native
  code (iOS).
- **OkHttp clients constructed inside third-party SDKs** (Android) —
  many SDKs ship their own `OkHttpClient` instance.
- **Firebase Analytics / Crashlytics / Remote Config** — uses
  Firebase's own transport.
- **Sentry** — uses its own transport for envelopes.
- **Image loaders** (RN's `<Image>` source is fetched via
  `RCTImageLoader` which uses `NSURLSessionDataTask` or OkHttp; this
  doesn't bridge through RCTNetworking and is invisible to CDP).
- **Native crash reporters, push notification SDKs, in-app
  analytics SDKs.**
- **Direct C/C++ HTTP libs** (libcurl, etc.) — extremely rare in RN
  apps, but possible.

The Hermes inspector has no visibility into native sockets it doesn't
own — there's no hook the JS runtime can offer to see them.

## Options

### Option A — Local HTTP/HTTPS proxy

A local proxy server bound to a free port; dev builds get pointed at it
via the OS system proxy on macOS or `adb reverse` + system proxy on
Android.

**Mechanics:**

- For HTTP: trivial. URLSession / OkHttp will honor the system proxy
  if the app doesn't override it.
- For HTTPS: need a local CA cert installed + trusted on the device
  (iOS: System Settings → Profile → Trust; Android 7+: app's
  Network Security Config must opt-in to user CAs). The proxy MITMs
  every TLS connection by signing per-host certs with the local CA.
- If the app pins certs (acme uses TrustKit / a custom pinner — we
  should check), the proxy is invisible to it; pinning blocks MITM.
  We'd need a build-time toggle that disables pinning in dev builds, or
  add the proxy CA to the pinned set in dev configurations.

**Pros:**

- Captures EVERYTHING — native, JS, third-party SDKs, all in one stream.
- No app changes beyond opt-in dev pin config.
- Cross-platform (Charles/Proxyman exist precisely because this
  pattern works).

**Cons:**

- HTTPS handshake is intrusive; cert pinning has to be tamed.
- CA install is a manual step the first time (one-time per device).
- System proxy state must be cleaned up on disconnect / crash.
- Some networking corners (UDP, WebSocket-Secure, HTTP/3) need extra
  handling.

**Effort:** medium-high. Most of the work is in the proxy + CA UX, not
the integration.

### Option B — Native module link-time injection (Flipper Network style)

A small native library that swizzles `NSURLSession` on iOS and adds an
`Interceptor` to OkHttp on Android, forwarding intercepted requests to
the daemon over the existing daemon socket.

**Mechanics:**

- iOS: swizzle `NSURLSessionDataTask`'s lifecycle methods (or use
  `URLProtocol` registration) to clone request/response.
- Android: install an `Interceptor` into the app's `OkHttpClient`
  instances — covers OkHttp transports, which is most of them.
- Module installs itself at app startup. Requires the app's gradle/
  Podfile to include the rn-dev native plugin (which we could ship via
  the auto-link mechanism RN already uses).

**Pros:**

- Hermetic to the app. No system proxy state. No CA install.
- Doesn't trip cert pinning (we sit inside the TLS-trusted code path).
- Production-safe path: the plugin can be a no-op in release builds.

**Cons:**

- Requires the app to LINK the lib at build time → users must change
  their app, even if minimally (Podfile/build.gradle entry).
- Per-platform native code to maintain.
- `URLSession` swizzling has corner cases (background sessions,
  ephemeral configurations).
- Doesn't help with apps that don't use OkHttp (rare on Android).

**Effort:** high — real native code on both platforms.

### Option C — Defer to external tooling (Charles/Proxyman)

Document the gap. Tell users to point dev builds at Charles when they
need native traffic.

**Pros:** zero work.

**Cons:** breaks the rn-dev "everything in one place" promise; the
user has to learn another tool; data lives outside the daemon ring so
it can't be queried via MCP.

### Option D — Custom JS-layer hooks (insufficient on its own)

`global.fetch = wrap(global.fetch)` + XHR monkey-patch + WebSocket
wrapper. Catches JS-originated traffic only. Doesn't help with the
actual gap. Mentioned for completeness.

## Recommendation

For the agent-native promise (everything-in-one-place + MCP queryable),
the right architecture is **Option B — native module link-time
injection**. It's the cleanest pin-compatible story, doesn't require CA
infrastructure, and matches how Flipper solved it.

**Practical order:**

1. **Now:** label the limitation in the panel + the module description.
   Users seeing "only JS-side requests visible" up front sets correct
   expectations.
2. **Short term (1-2 days):** ship Option A as an *optional* mode for
   teams comfortable with system proxy + CA install. Charles-style
   experience inside rn-dev. Disable cert pinning in dev builds via a
   small documented Android Network Security Config + iOS `ATS`
   exception pattern.
3. **Medium term (1-2 weeks):** Option B — `@rn-dev/native-net-tap`
   module that ships an iOS framework + Android library + RN package
   metadata. The same daemon ring fills from both sources; entries get
   a `source: "cdp" | "native"` tag (the type already accommodates this
   via the `source` field in `NetworkEntry`).

Avoid Option C unless we punt on the feature entirely.

## Where the work lands

If we do A:

- New module `modules/network-proxy/` (or capability under
  `devtools-network`) that owns the proxy lifecycle.
- New host capability for system-proxy + CA install flow.
- Panel needs a "Native via proxy" toggle + setup wizard.

If we do B:

- New module `modules/native-net-tap/` with iOS + Android subprojects.
- Per-session daemon endpoint that the native lib connects to (already
  doable over the existing per-session adb-reverse infrastructure on
  Android; iOS needs a localhost connection over USB/WiFi — rn-dev
  already wires that for Metro).
- Tap reduces incoming native events into `NetworkEntry` with
  `source: "native"` and pushes into the same ring as CDP. The list +
  detail UI we just built works as-is (the source field is already
  shown in the detail pane).

## Open questions

- Does acme pin certs in dev builds today? (Affects Option A
  viability.) Check `ios/Acme/SSLPinning.swift` and
  `android/app/src/main/res/xml/network_security_config.xml` if they
  exist.
- Are we OK requiring app-side gradle/Podfile changes for Option B?
  (Per CLAUDE.md the goal is "agents can run/inspect acme without
  changing the app" — Option B violates this. Option A doesn't.)
- For agent-native parity: MCP needs the same `source: "native"`
  visibility. Both options preserve the existing tool surface.
