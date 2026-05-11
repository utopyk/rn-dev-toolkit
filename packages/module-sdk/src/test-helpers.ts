// Phase H1j — test infrastructure for module authors who write
// hook-aware code. Two helpers, both intentionally lean:
//
//   - `runHookInProcess` invokes an `fn`-form hook handler and captures
//     its result, error, and duration without spawning a subprocess.
//     Useful for unit-testing module-author code that registers an
//     `fn` entry against a built-in's contribution point.
//
//   - `MockHookRuntime<TFires>` is a typed sink that records `fire`
//     calls into a public `fires` array. H5+ runtime exposes a
//     `host.fireHook(slot, payload)` surface to in-process modules;
//     wherever that lands, `MockHookRuntime` is the test double
//     module authors can drop in.
//
// Both ship via `@rn-dev/module-sdk` (re-exported from `index.ts`)
// because the alternative — making module authors hand-roll the same
// scaffolding — would lock them out of the typed-payload surface
// `HookContracts` provides. By declaring the slot-payload map as a
// generic parameter, the SDK avoids a circular dep on `@rn-dev/config`
// (which imports from this package).

// ---------------------------------------------------------------------------
// runHookInProcess
// ---------------------------------------------------------------------------

export interface RunHookInProcessInput<P, R> {
  /** The handler to invoke. Same shape as a registered fn entry. */
  fn: (payload: P) => R | Promise<R>;
  /** Payload passed to the handler. */
  payload: P;
  /** Wall-clock timeout. Defaults to 30s. */
  timeoutMs?: number;
}

export type RunHookInProcessOutcome = "ok" | "threw" | "timeout";

export interface RunHookInProcessResult<R> {
  outcome: RunHookInProcessOutcome;
  /** Set when `outcome === "ok"`. */
  result?: R;
  /** Set when `outcome === "threw"` or `outcome === "timeout"`. */
  error?: Error;
  durationMs: number;
}

export async function runHookInProcess<P, R>(
  input: RunHookInProcessInput<P, R>,
): Promise<RunHookInProcessResult<R>> {
  const start = Date.now();
  const timeoutMs = input.timeoutMs ?? 30_000;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  try {
    const result = await Promise.race([
      Promise.resolve(input.fn(input.payload)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(
            new Error(`runHookInProcess timed out after ${timeoutMs}ms`),
          );
        }, timeoutMs);
      }),
    ]);
    return {
      outcome: "ok",
      result,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      outcome: timedOut ? "timeout" : "threw",
      error: err instanceof Error ? err : new Error(String(err)),
      durationMs: Date.now() - start,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// MockHookRuntime
// ---------------------------------------------------------------------------

/**
 * Recorded fire entry. The `slot` and `payload` types are inferred
 * from the generic `TFires` map so consumers get full payload-shape
 * inference at the assertion site.
 */
export interface MockHookFire<
  TFires extends Record<string, unknown>,
  K extends keyof TFires & string = keyof TFires & string,
> {
  slot: K;
  payload: TFires[K];
  ts: number;
}

/**
 * Drop-in test double for the host's hook-fire surface.
 *
 * Module authors typically parameterize on their own
 * `HookContracts`-shaped type so the assertions get full inference:
 *
 * ```ts
 * type MyContracts = { 'mymod/pre': { src: string }; 'mymod/post': void };
 * const runtime = new MockHookRuntime<MyContracts>();
 * runtime.fire('mymod/pre', { src: '/tmp/x' });
 * expect(runtime.firesFor('mymod/pre')).toHaveLength(1);
 * ```
 *
 * Empty `TFires` (the default) is intentionally permissive — the mock
 * is useful even before a module is fully typed up.
 */
export class MockHookRuntime<
  TFires extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Public for assertion convenience. Mutable; tests may `reset()`. */
  readonly fires: MockHookFire<TFires>[] = [];
  private now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  fire<K extends keyof TFires & string>(
    slot: K,
    payload: TFires[K],
  ): void {
    this.fires.push({
      slot,
      payload,
      ts: this.now(),
    } as MockHookFire<TFires>);
  }

  /** Filtered view — `fires` for a specific slot only. */
  firesFor<K extends keyof TFires & string>(
    slot: K,
  ): Array<MockHookFire<TFires, K>> {
    return this.fires.filter((f): f is MockHookFire<TFires, K> => f.slot === slot);
  }

  /** Wipe the recorded log. Useful in `beforeEach`. */
  reset(): void {
    this.fires.length = 0;
  }
}
