import { useEffect, useCallback } from 'react';

type IpcInvokeFn = <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>;

/**
 * Subscribe to an IPC channel from the main process.
 * Falls back to no-op when running outside Electron (plain browser).
 *
 * The payload type is generic; callers pass the concrete type of their handler
 * so use-sites don't need inline casts from `any`.
 */
export function useIpcOn<T = unknown>(
  channel: string,
  handler: (payload: T) => void,
): void {
  useEffect(() => {
    if (!window.rndev) return;
    // The bridge fans out raw ipcRenderer args; we pick the first and hand it
    // off to the typed handler. Every existing caller passes a single payload
    // object — if multi-arg channels ever appear we can overload here.
    const wrapped = (...args: unknown[]): void => {
      handler(args[0] as T);
    };
    window.rndev.on(channel, wrapped);
    return () => {
      window.rndev?.off(channel, wrapped);
    };
  }, [channel, handler]);
}

/**
 * Returns a typed invoke function for sending commands to the main process.
 * Falls back to `{ ok: true }` cast to T when outside Electron (so the browser
 * preview doesn't crash — it still yields a resolved promise).
 */
export function useIpcInvoke(): IpcInvokeFn {
  return useCallback(
    <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => {
      if (!window.rndev) {
        // Stub mode — preview outside Electron. Log so the renderer author
        // notices missing handlers instead of getting silent empty objects.
        // eslint-disable-next-line no-console
        console.log(`[ipc-stub] invoke: ${channel}`, ...args);
        return Promise.resolve({ ok: true } as T);
      }
      return window.rndev.invoke(channel, ...args) as Promise<T>;
    },
    [],
  );
}
