/**
 * Parity test — guards against drift between the module's local type
 * mirrors (`types.ts`, `host-capability.ts`) and the real host types at
 * `src/core/redux/`. Test files may type-only-import across the boundary;
 * runtime module code under `src/` must never.
 *
 * Verified via TypeScript structural subtyping: when a host type gains or
 * renames a field, the corresponding assertion fails type-check.
 */

import { describe, it, expectTypeOf } from "vitest";
import type {
  RedactionMode as HostRedactionMode,
  ReduxActionRecord as HostReduxActionRecord,
  ReduxActionsFilter as HostReduxActionsFilter,
  ReduxActionsResult as HostReduxActionsResult,
  ReduxCursor as HostReduxCursor,
  ReduxMeta as HostReduxMeta,
  ReduxStateResult as HostReduxStateResult,
  ReduxStatus as HostReduxStatus,
} from "../../../../src/core/redux/types.js";
import type { ReduxHostCapability as HostReduxHostCapability } from "../../../../src/core/redux/host-capability.js";
import type {
  RedactionMode,
  ReduxActionRecord,
  ReduxActionsFilter,
  ReduxActionsResult,
  ReduxCursor,
  ReduxMeta,
  ReduxStateResult,
  ReduxStatus,
} from "../types.js";
import type { ReduxHostCapability } from "../host-capability.js";

describe("module type mirrors — structural parity with host redux types", () => {
  it("host ↔ module type shapes match at compile time", () => {
    expectTypeOf<HostReduxActionRecord>().toMatchTypeOf<ReduxActionRecord>();
    expectTypeOf<ReduxActionRecord>().toMatchTypeOf<HostReduxActionRecord>();

    expectTypeOf<HostReduxMeta>().toMatchTypeOf<ReduxMeta>();
    expectTypeOf<ReduxMeta>().toMatchTypeOf<HostReduxMeta>();

    expectTypeOf<HostReduxCursor>().toMatchTypeOf<ReduxCursor>();
    expectTypeOf<ReduxCursor>().toMatchTypeOf<HostReduxCursor>();

    expectTypeOf<HostReduxActionsFilter>().toMatchTypeOf<ReduxActionsFilter>();
    expectTypeOf<ReduxActionsFilter>().toMatchTypeOf<HostReduxActionsFilter>();

    expectTypeOf<HostReduxActionsResult>().toMatchTypeOf<ReduxActionsResult>();
    expectTypeOf<ReduxActionsResult>().toMatchTypeOf<HostReduxActionsResult>();

    expectTypeOf<HostReduxStateResult>().toMatchTypeOf<ReduxStateResult>();
    expectTypeOf<ReduxStateResult>().toMatchTypeOf<HostReduxStateResult>();

    expectTypeOf<HostReduxStatus>().toMatchTypeOf<ReduxStatus>();
    expectTypeOf<ReduxStatus>().toMatchTypeOf<HostReduxStatus>();

    expectTypeOf<HostRedactionMode>().toEqualTypeOf<RedactionMode>();
  });

  it("the capability method surface matches (incl. the redaction-input arg)", () => {
    // Host capability is a superset-or-equal of what the module calls.
    expectTypeOf<HostReduxHostCapability>().toMatchTypeOf<ReduxHostCapability>();
    expectTypeOf<ReduxHostCapability>().toMatchTypeOf<HostReduxHostCapability>();
  });
});
