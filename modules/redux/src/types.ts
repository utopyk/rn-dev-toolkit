/**
 * Type mirrors for the Redux capture payloads the host returns via
 * `ctx.host.capability<ReduxHostCapability>("redux")`. Duplicates the
 * host's `src/core/redux/types.ts` intentionally — module packages cannot
 * import host source (bundling boundary). `__tests__/parity.test.ts`
 * asserts shape equivalence so drift surfaces at vitest time.
 */

export type RedactionMode = "mcp-redacted" | "full";

export interface ReduxActionRecord {
  readonly sequence: number;
  readonly at: number;
  readonly type: string;
  readonly payload: unknown;
  readonly diff: unknown;
}

export interface ReduxCursor {
  readonly bufferEpoch: number;
  readonly sequence: number;
}

export interface ReduxActionsFilter {
  typeFilter?: string;
  since?: ReduxCursor;
  limit?: number;
}

export type IngestStatus = "bound" | "deferred" | "stopped" | "disabled";

export interface ReduxMeta {
  readonly sessionKey: string;
  readonly bufferEpoch: number;
  readonly oldestSequence: number;
  readonly lastEventSequence: number;
  readonly totalActionsReceived: number;
  readonly evictedCount: number;
  readonly truncatedCount: number;
  readonly hasState: boolean;
  readonly redactionMode: RedactionMode;
  readonly ingestStatus: IngestStatus;
  readonly ingestError: string;
}

export interface ReduxActionsResult {
  readonly entries: readonly ReduxActionRecord[];
  readonly cursorDropped: boolean;
  readonly meta: ReduxMeta;
}

export interface ReduxStateResult {
  readonly value: unknown;
  readonly path: string;
  readonly present: boolean;
  readonly meta: ReduxMeta;
}

export interface ReduxStatus {
  readonly meta: ReduxMeta;
  readonly bufferSize: number;
  readonly bufferCapacity: number;
}
