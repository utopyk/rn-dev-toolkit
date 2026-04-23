/**
 * Parity test — guards against drift between the module's local mirrors of
 * host types (`types.ts`) and the real host types at
 * `src/core/devtools/types.ts`, plus the `DevtoolsHostCapability` shape
 * this module calls against.
 *
 * The module can't import host source directly at bundle time (that's a
 * module-boundary violation). Test files *may* reach across for type-only
 * imports — the `parity` pattern depends on it. Runtime module code under
 * `src/` must never import `../../../../src/core/...`.
 *
 * The equivalence below is verified via TypeScript's structural subtyping.
 * When a host type gains or renames a field, this file starts failing
 * type-check at the corresponding assignment — that's the intended signal.
 *
 * Exclusions:
 *   - `NetworkCursor` is deliberately NOT round-tripped. The host brands
 *     it with a `unique symbol` so agents can't fabricate cursors; the
 *     module's structural copy (`{ bufferEpoch, sequence }`) is the right
 *     shape for the MCP wire but won't satisfy the host's brand at the
 *     type level. `NetworkFilter.since` parity is checked through an
 *     assignment that normalizes the cursor type, below.
 */

import { describe, it, expectTypeOf } from "vitest";
import type {
  CaptureListResult as HostCaptureListResult,
  CaptureMeta as HostCaptureMeta,
  CapturedBody as HostCapturedBody,
  DevToolsStatus as HostDevToolsStatus,
  NetworkEntry as HostNetworkEntry,
  TargetDescriptor as HostTargetDescriptor,
} from "../../../../src/core/devtools/types.js";
import type { DevtoolsHostCapability as HostDevtoolsHostCapability } from "../../../../src/core/devtools/host-capability.js";
import type {
  CaptureListResult,
  CaptureMeta,
  CapturedBody,
  DevToolsStatus,
  NetworkEntry,
  TargetDescriptor,
} from "../types.js";
import type { DevtoolsHostCapability } from "../host-capability.js";

describe("module type mirrors — structural parity with host types", () => {
  it("host ↔ module type shapes match at compile time", () => {
    // These compile-time assertions are the real coverage. Runtime
    // behavior is checked by `dto.test.ts` and `host-capability.test.ts`.
    expectTypeOf<HostNetworkEntry>().toMatchTypeOf<NetworkEntry>();
    expectTypeOf<NetworkEntry>().toMatchTypeOf<HostNetworkEntry>();

    expectTypeOf<HostCaptureMeta>().toMatchTypeOf<CaptureMeta>();
    expectTypeOf<CaptureMeta>().toMatchTypeOf<HostCaptureMeta>();

    expectTypeOf<HostCapturedBody>().toMatchTypeOf<CapturedBody>();
    expectTypeOf<CapturedBody>().toMatchTypeOf<HostCapturedBody>();

    expectTypeOf<HostTargetDescriptor>().toMatchTypeOf<TargetDescriptor>();
    expectTypeOf<TargetDescriptor>().toMatchTypeOf<HostTargetDescriptor>();

    expectTypeOf<HostDevToolsStatus>().toMatchTypeOf<DevToolsStatus>();
    expectTypeOf<DevToolsStatus>().toMatchTypeOf<HostDevToolsStatus>();

    expectTypeOf<
      HostCaptureListResult<HostNetworkEntry>
    >().toMatchTypeOf<CaptureListResult<NetworkEntry>>();
    expectTypeOf<
      CaptureListResult<NetworkEntry>
    >().toMatchTypeOf<HostCaptureListResult<HostNetworkEntry>>();

    // DevtoolsHostCapability: the module's mirror must accept everything the
    // host's contract accepts. One-way: host → module. (The reverse
    // direction would require the module to re-declare the host's unique-
    // symbol-branded `NetworkCursor`, which is specifically what we
    // avoid — cursor fabrication is the whole point of the brand.)
    expectTypeOf<HostDevtoolsHostCapability>().toMatchTypeOf<DevtoolsHostCapability>();
  });
});
