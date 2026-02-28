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

### `bus.scheduler.coalesce(key, handler)`

Schedule one coalesced `requestAnimationFrame` callback per key.

### `bus.scheduler.createRafCoalesced(handler)`

Create a reusable rAF-coalesced wrapper for bursty callbacks.

### `bus.dom.waitForElement(selector, options?)`

Resolve once a selector exists under `document` (or optional `root`).

## Notes

- Designed as a soft dependency; consumers should keep fallback logic.
- Extension loads early (`loading_order: 0`) so consumers can bind quickly.
