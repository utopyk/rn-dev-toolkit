import { describe, expect, it } from 'vitest';
import { asSessionId, type SessionId } from '../../../src/core/identifiers.js';
import {
  findRunnableSessionForProfile,
  planSessionReconcile,
  type ListedSession,
} from '../sessions.js';

// Unit coverage of the SessionsWatcher's pure reconcile planner — the
// part that carries every edge case (classification of external vs own
// sessions, the single-flight guard against double-observe, teardown on
// disappearance, and the observe cap). Kept side-effect-free so it pins
// here without an IpcClient or a live daemon.

function sid(s: string): SessionId {
  return asSessionId(s);
}

function listed(
  id: string,
  status = 'running',
  profileName: string | null = 'agent',
): ListedSession {
  return { sessionId: sid(id), profileName, worktreeKey: 'wt', status };
}

type OwnRec = { sessionId: SessionId; observed: boolean; instanceId: string };
function ownMap(...recs: OwnRec[]): Map<SessionId, OwnRec> {
  return new Map(recs.map((r) => [r.sessionId, r]));
}

const MAX = 4;

describe('planSessionReconcile', () => {
  it('observes a brand-new external session', () => {
    const plan = planSessionReconcile([listed('s-ext')], {
      ownSessions: ownMap(),
      inFlight: new Set(),
      maxObserved: MAX,
    });
    expect(plan.toObserve.map((s) => s.sessionId)).toEqual([sid('s-ext')]);
    expect(plan.toTeardown).toEqual([]);
    expect(plan.dropped).toBe(0);
  });

  it('never observes our own GUI-created sessions (set difference on sessionId)', () => {
    const plan = planSessionReconcile([listed('s-gui')], {
      ownSessions: ownMap({ sessionId: sid('s-gui'), observed: false, instanceId: 'main-8081' }),
      inFlight: new Set(),
      maxObserved: MAX,
    });
    expect(plan.toObserve).toEqual([]);
    expect(plan.toTeardown).toEqual([]);
  });

  it('never re-observes a session already being observed', () => {
    const plan = planSessionReconcile([listed('s-ext')], {
      ownSessions: ownMap({ sessionId: sid('s-ext'), observed: true, instanceId: 'agent-s-ext' }),
      inFlight: new Set(),
      maxObserved: MAX,
    });
    expect(plan.toObserve).toEqual([]);
    expect(plan.toTeardown).toEqual([]);
  });

  it('single-flight: a session mid-attach is excluded from toObserve (no duplicate)', () => {
    const plan = planSessionReconcile([listed('s-ext')], {
      ownSessions: ownMap(),
      inFlight: new Set([sid('s-ext')]),
      maxObserved: MAX,
    });
    expect(plan.toObserve).toEqual([]);
  });

  it('tears down an observed session that vanished from the list (agent stopped it)', () => {
    const plan = planSessionReconcile([], {
      ownSessions: ownMap({ sessionId: sid('s-ext'), observed: true, instanceId: 'agent-s-ext' }),
      inFlight: new Set(),
      maxObserved: MAX,
    });
    expect(plan.toTeardown).toEqual([sid('s-ext')]);
    expect(plan.toObserve).toEqual([]);
  });

  it('tears down an observed session whose status went stopped/stopping', () => {
    const plan = planSessionReconcile([listed('s-ext', 'stopping')], {
      ownSessions: ownMap({ sessionId: sid('s-ext'), observed: true, instanceId: 'agent-s-ext' }),
      inFlight: new Set(),
      maxObserved: MAX,
    });
    expect(plan.toTeardown).toEqual([sid('s-ext')]);
  });

  it('does NOT tear down our own GUI session just because it is stopping', () => {
    // Teardown is observe-only; a GUI tab closing is handled by instances:remove.
    const plan = planSessionReconcile([listed('s-gui', 'stopping')], {
      ownSessions: ownMap({ sessionId: sid('s-gui'), observed: false, instanceId: 'main-8081' }),
      inFlight: new Set(),
      maxObserved: MAX,
    });
    expect(plan.toTeardown).toEqual([]);
  });

  it('skips external sessions that are already stopped/stopping (don’t observe a corpse)', () => {
    const plan = planSessionReconcile([listed('s-dead', 'stopped'), listed('s-go', 'starting')], {
      ownSessions: ownMap(),
      inFlight: new Set(),
      maxObserved: MAX,
    });
    expect(plan.toObserve.map((s) => s.sessionId)).toEqual([sid('s-go')]);
  });

  it('respects the observe cap and reports the dropped count (no silent truncation)', () => {
    const all = [listed('a'), listed('b'), listed('c'), listed('d'), listed('e'), listed('f')];
    const plan = planSessionReconcile(all, {
      ownSessions: ownMap(),
      inFlight: new Set(),
      maxObserved: 4,
    });
    expect(plan.toObserve).toHaveLength(4);
    expect(plan.dropped).toBe(2);
  });

  it('counts existing observed + in-flight against the cap budget', () => {
    // 2 already observed (still in the list, so NOT torn down) + 1
    // in-flight → only 1 slot left of 4. Two fresh candidates → observe
    // 1, drop 1.
    const plan = planSessionReconcile(
      [listed('o1'), listed('o2'), listed('x'), listed('y')],
      {
        ownSessions: ownMap(
          { sessionId: sid('o1'), observed: true, instanceId: 'agent-o1' },
          { sessionId: sid('o2'), observed: true, instanceId: 'agent-o2' },
        ),
        inFlight: new Set([sid('inflight')]),
        maxObserved: 4,
      },
    );
    expect(plan.toObserve).toHaveLength(1);
    expect(plan.dropped).toBe(1);
  });

  it('mixed: tears down a gone observe AND observes a new external in one pass', () => {
    const plan = planSessionReconcile([listed('s-new')], {
      ownSessions: ownMap(
        { sessionId: sid('s-gone'), observed: true, instanceId: 'agent-s-gone' },
        { sessionId: sid('s-gui'), observed: false, instanceId: 'main-8081' },
      ),
      inFlight: new Set(),
      maxObserved: MAX,
    });
    expect(plan.toTeardown).toEqual([sid('s-gone')]);
    expect(plan.toObserve.map((s) => s.sessionId)).toEqual([sid('s-new')]);
  });
});

describe('findRunnableSessionForProfile', () => {
  // Powers the `startRealServices` short-circuit that prevents the
  // duplicate "GUI primary tab + agent observer tab" against the same
  // session — the bug a user surfaced when the GUI rendered two tabs on
  // port 8090 after the agent booted its default-profile session via MCP.

  it('returns the running session that matches the profile name', () => {
    const found = findRunnableSessionForProfile(
      [
        listed('s-other', 'running', 'ios-sim'),
        listed('s-match', 'running', 'android-emu-5554'),
      ],
      'android-emu-5554',
    );
    expect(found?.sessionId).toBe(sid('s-match'));
  });

  it('returns null when no session has that profile name', () => {
    const found = findRunnableSessionForProfile(
      [listed('s-1', 'running', 'ios-sim')],
      'android-emu-5554',
    );
    expect(found).toBeNull();
  });

  it('returns null when an empty list is passed', () => {
    expect(findRunnableSessionForProfile([], 'android-emu-5554')).toBeNull();
  });

  it('skips stopped/stopping sessions even when the profile matches', () => {
    const found = findRunnableSessionForProfile(
      [
        listed('s-dead', 'stopped', 'android-emu-5554'),
        listed('s-leaving', 'stopping', 'android-emu-5554'),
      ],
      'android-emu-5554',
    );
    expect(found).toBeNull();
  });

  it('accepts non-terminal statuses (starting, running) without restricting to "running"', () => {
    // The daemon emits `starting` for a session that has booted but whose
    // services are still warming up. We should still treat it as a match,
    // not race the GUI into creating a primary tab while it boots.
    const found = findRunnableSessionForProfile(
      [listed('s-warm', 'starting', 'android-emu-5554')],
      'android-emu-5554',
    );
    expect(found?.sessionId).toBe(sid('s-warm'));
  });

  it('returns the first matching session when several share the profile name', () => {
    // Multi-session for the same profile is allowed by the daemon. The
    // short-circuit picks the first non-terminal one — the sessionsWatcher
    // surfaces the rest as their own 🤖 tabs on later ticks.
    const found = findRunnableSessionForProfile(
      [
        listed('s-1', 'running', 'android-emu-5554'),
        listed('s-2', 'running', 'android-emu-5554'),
      ],
      'android-emu-5554',
    );
    expect(found?.sessionId).toBe(sid('s-1'));
  });
});
