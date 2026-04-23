/**
 * Parity test — guards against drift between this module's local mirrors
 * of the host types (`types.ts`) and the real host types at
 * `src/core/metro-logs/types.ts`, plus the `MetroLogsHostCapability`
 * shape this module calls against.
 *
 * Runtime module code under `src/` must never import
 * `../../../../src/core/...` (bundling boundary). Test files *may*
 * reach across for type-only imports — the parity pattern depends on it.
 */

import { describe, it, expectTypeOf } from "vitest";
import type {
  MetroLogLine as HostMetroLogLine,
  MetroLogsCursor as HostMetroLogsCursor,
  MetroLogsFilter as HostMetroLogsFilter,
  MetroLogsListResult as HostMetroLogsListResult,
  MetroLogsMeta as HostMetroLogsMeta,
  MetroLogsStatus as HostMetroLogsStatus,
  MetroLogStream as HostMetroLogStream,
  ProcessStatus as HostProcessStatus,
} from "../../../../src/core/metro-logs/types.js";
import type { MetroLogsHostCapability as HostMetroLogsHostCapability } from "../../../../src/core/metro-logs/host-capability.js";
import type {
  MetroLogLine,
  MetroLogsCursor,
  MetroLogsFilter,
  MetroLogsListResult,
  MetroLogsMeta,
  MetroLogsStatus,
  MetroLogStream,
  ProcessStatus,
} from "../types.js";
import type { MetroLogsHostCapability } from "../host-capability.js";

describe("module type mirrors — structural parity with host types", () => {
  it("host ↔ module type shapes match at compile time", () => {
    expectTypeOf<HostMetroLogLine>().toMatchTypeOf<MetroLogLine>();
    expectTypeOf<MetroLogLine>().toMatchTypeOf<HostMetroLogLine>();

    expectTypeOf<HostMetroLogsCursor>().toMatchTypeOf<MetroLogsCursor>();
    expectTypeOf<MetroLogsCursor>().toMatchTypeOf<HostMetroLogsCursor>();

    expectTypeOf<HostMetroLogsFilter>().toMatchTypeOf<MetroLogsFilter>();
    expectTypeOf<MetroLogsFilter>().toMatchTypeOf<HostMetroLogsFilter>();

    expectTypeOf<HostMetroLogsMeta>().toMatchTypeOf<MetroLogsMeta>();
    expectTypeOf<MetroLogsMeta>().toMatchTypeOf<HostMetroLogsMeta>();

    expectTypeOf<HostMetroLogsStatus>().toMatchTypeOf<MetroLogsStatus>();
    expectTypeOf<MetroLogsStatus>().toMatchTypeOf<HostMetroLogsStatus>();

    expectTypeOf<HostMetroLogsListResult>().toMatchTypeOf<MetroLogsListResult>();
    expectTypeOf<MetroLogsListResult>().toMatchTypeOf<HostMetroLogsListResult>();

    expectTypeOf<HostMetroLogStream>().toMatchTypeOf<MetroLogStream>();
    expectTypeOf<MetroLogStream>().toMatchTypeOf<HostMetroLogStream>();

    expectTypeOf<HostProcessStatus>().toMatchTypeOf<ProcessStatus>();
    expectTypeOf<ProcessStatus>().toMatchTypeOf<HostProcessStatus>();

    // Host ↔ module capability — bidirectional. Metro-logs has no
    // branded cursor (unlike devtools' unique-symbol NetworkCursor) so
    // we can assert both directions safely.
    expectTypeOf<HostMetroLogsHostCapability>().toMatchTypeOf<MetroLogsHostCapability>();
    expectTypeOf<MetroLogsHostCapability>().toMatchTypeOf<HostMetroLogsHostCapability>();
  });
});
