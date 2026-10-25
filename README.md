# Runtime Signal Bus

Lightweight shared runtime services for SillyTavern third-party extensions:

- Context readiness (`waitForContext`)
- Viewport semantic signals (`layout`, `keyboard`)
- Shared event fanout subscriptions
- Ordered fetch interceptor pipeline
- Shared rAF scheduler helpers
- DOM wait helper for element readiness

## API

```js
const bus = window.STRuntimeBus;
```

### `bus.waitForContext(options?)`

Wait until `SillyTavern.getContext()` and event bus metadata are available.

### `bus.viewport.subscribe(mode, handler)`

- `mode`: `'all' | 'layout' | 'keyboard'`
- Returns unsubscribe function.

### `bus.events.subscribe(eventKey, handler)`

Subscribes to normalized SillyTavern event keys.

### `bus.fetch.registerInterceptor(spec)`

Register ordered fetch interceptors with `priority`.
Returns unregister function.

Version 1.1 adds optional `reqCtx.getRequestJson()` and
`reqCtx.releaseRequestJson()` inside fetch hooks. Request observers can share a
single lazy read-only parse of a string body, and body replacement invalidates
the cached value. The cache is released before the network wait and on exit.
Neither request streams nor response streams are read by the helper.

An already installed bus is preserved under later fetch wrappers. Consumers can
feature-detect `bus.fetch.preservesOuterWrappers === true`; older versions should
keep a standalone fallback when registration would re-wrap another extension.
See [API_CONTRACT_V1.md](API_CONTRACT_V1.md) for the full compatibility contract.

### `bus.scheduler.coalesce(key, handler)`

Schedule one coalesced `requestAnimationFrame` callback per key.

### `bus.scheduler.createRafCoalesced(handler)`

Create a reusable rAF-coalesced wrapper for bursty callbacks.

### `bus.dom.waitForElement(selector, options?)`

Resolve once a selector exists under `document` (or optional `root`).

## Notes

- Designed as a soft dependency; consumers should keep fallback logic.
- Extension loads early (`loading_order: 0`) so consumers can bind quickly.

## Tests

```sh
node --test tests/*.test.cjs
```
