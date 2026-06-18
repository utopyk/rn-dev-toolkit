# @rn-dev-modules/redux

Agent-native Redux inspection for rn-dev. Stream a React Native app's
dispatched actions + state to the rn-dev daemon, readable by agents (MCP
`redux__*` tools) and humans (the Electron "Redux" panel) — redacted by
default.

Two halves:

- **Host module** (this package, `dist/`) — buffers the action/state stream
  per session and exposes it. Loaded by the rn-dev host like any module.
- **App-side enhancer** (`enhancer.ts`) — a tiny, zero-dependency Redux
  store enhancer you add to the app in development. It streams to the
  daemon over a websocket on `metroPort + 4000`, derived automatically from
  the Metro dev-server URL the app loaded from.

## Tools (MCP)

| Tool | What |
|---|---|
| `redux__status` | ring size, whether state is captured, redaction mode |
| `redux__state { path? }` | current state (or a slice at `auth.session` / `routes[0].name`) |
| `redux__actions { typeFilter?, since?, limit? }` | recent actions + per-action diffs (tail with `since`) |
| `redux__action { sequence }` | one action's payload + diff |
| `redux__clear` | drop the ring + bump the epoch |

## Wiring the enhancer (app side)

Vendor `enhancer.ts` into the app (e.g. `src/dev/rn-dev-redux-enhancer.ts`),
then add it to the store **in development only**.

Legacy `createStore` (Redux 4):

```ts
import { rnDevReduxEnhancer } from './dev/rn-dev-redux-enhancer'
const enhancers = [applyMiddleware(...mw)]
if (__DEV__) enhancers.push(rnDevReduxEnhancer())
const store = createStore(reducer, preloadedState, compose(...enhancers))
```

Redux Toolkit `configureStore`:

```ts
import { rnDevReduxEnhancer } from './dev/rn-dev-redux-enhancer'
configureStore({
  reducer,
  enhancers: (getDefault) =>
    __DEV__ ? getDefault().concat(rnDevReduxEnhancer()) : getDefault(),
})
```

It is fail-open: no WebSocket, no dev-server URL, or a production build →
it returns the store untouched and never affects the app.

## Redaction (default-on)

The host redacts before anything reaches an agent. Per-project config at
`~/.rn-dev/modules/redux/config.json`:

```json
{
  "whitelist": ["ui", "navigation"],
  "blacklist": ["*accountCode*"],
  "mode": "mcp-redacted"
}
```

- `mode: "mcp-redacted"` (default) — agents get structure-only (keys +
  types); `"full"` reveals values (still honoring the blacklist).
- `whitelist` — state path prefixes revealed in full to agents.
- `blacklist` — key globs always redacted, even inside a whitelisted slice.
  EXTENDS a built-in default list (tokens, passwords, cards, email, phone…)
  that is always applied.

For the strictest shops, pass `redact` to `rnDevReduxEnhancer({ redact })`
to strip values on-device before they leave the app at all.
