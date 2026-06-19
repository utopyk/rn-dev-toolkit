/**
 * Parity test — guards against drift between this module's local mirrors
 * of the host types (`types.ts`, `host-capability.ts`) and the real host
 * types at `src/core/device-logs/`.
 *
 * Runtime module code under `src/` must never import
 * `../../../../src/core/...` (bundling boundary). Test files *may*
 * reach across for type-only imports — the parity pattern depends on it.
 */

import { describe, it, expectTypeOf } from "vitest";
import type {
  DeviceLogLine as HostDeviceLogLine,
  DeviceLogLevel as HostDeviceLogLevel,
  DeviceLogSource as HostDeviceLogSource,
  DeviceLogsCursor as HostDeviceLogsCursor,
  DeviceLogsFilter as HostDeviceLogsFilter,
  DeviceLogsListResult as HostDeviceLogsListResult,
  DeviceLogsMeta as HostDeviceLogsMeta,
  DeviceLogsStatus as HostDeviceLogsStatus,
  DeviceLogsTap as HostDeviceLogsTap,
  TapStatus as HostTapStatus,
} from "../../../../src/core/device-logs/types.js";
import type { DeviceLogsHostCapability as HostDeviceLogsHostCapability } from "../../../../src/core/device-logs/host-capability.js";
import type {
  DeviceLogLine,
  DeviceLogLevel,
  DeviceLogSource,
  DeviceLogsCursor,
  DeviceLogsFilter,
  DeviceLogsListResult,
  DeviceLogsMeta,
  DeviceLogsStatus,
  DeviceLogsTap,
  TapStatus,
} from "../types.js";
import type { DeviceLogsHostCapability } from "../host-capability.js";

describe("module type mirrors — structural parity with host types", () => {
  it("host ↔ module type shapes match at compile time", () => {
    expectTypeOf<HostDeviceLogLine>().toMatchTypeOf<DeviceLogLine>();
    expectTypeOf<DeviceLogLine>().toMatchTypeOf<HostDeviceLogLine>();

    expectTypeOf<HostDeviceLogLevel>().toMatchTypeOf<DeviceLogLevel>();
    expectTypeOf<DeviceLogLevel>().toMatchTypeOf<HostDeviceLogLevel>();

    expectTypeOf<HostDeviceLogSource>().toMatchTypeOf<DeviceLogSource>();
    expectTypeOf<DeviceLogSource>().toMatchTypeOf<HostDeviceLogSource>();

    expectTypeOf<HostDeviceLogsCursor>().toMatchTypeOf<DeviceLogsCursor>();
    expectTypeOf<DeviceLogsCursor>().toMatchTypeOf<HostDeviceLogsCursor>();

    expectTypeOf<HostDeviceLogsFilter>().toMatchTypeOf<DeviceLogsFilter>();
    expectTypeOf<DeviceLogsFilter>().toMatchTypeOf<HostDeviceLogsFilter>();

    expectTypeOf<HostDeviceLogsMeta>().toMatchTypeOf<DeviceLogsMeta>();
    expectTypeOf<DeviceLogsMeta>().toMatchTypeOf<HostDeviceLogsMeta>();

    expectTypeOf<HostDeviceLogsStatus>().toMatchTypeOf<DeviceLogsStatus>();
    expectTypeOf<DeviceLogsStatus>().toMatchTypeOf<HostDeviceLogsStatus>();

    expectTypeOf<HostDeviceLogsListResult>().toMatchTypeOf<DeviceLogsListResult>();
    expectTypeOf<DeviceLogsListResult>().toMatchTypeOf<HostDeviceLogsListResult>();

    expectTypeOf<HostDeviceLogsTap>().toMatchTypeOf<DeviceLogsTap>();
    expectTypeOf<DeviceLogsTap>().toMatchTypeOf<HostDeviceLogsTap>();

    expectTypeOf<HostTapStatus>().toMatchTypeOf<TapStatus>();
    expectTypeOf<TapStatus>().toMatchTypeOf<HostTapStatus>();

    expectTypeOf<HostDeviceLogsHostCapability>().toMatchTypeOf<DeviceLogsHostCapability>();
    expectTypeOf<DeviceLogsHostCapability>().toMatchTypeOf<HostDeviceLogsHostCapability>();
  });
});
