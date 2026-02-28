# Runtime Signal Bus API Contract v1

Version: `1.0.0`  
Status: Active

## Stability

- `window.STRuntimeBus.version` exists and is a string.
- All v1 methods are browser-runtime only and must not require build tooling.
- Consumers must treat the bus as optional and keep fallback behavior.

## Public Surface (v1)

- `waitForContext(options?) -> Promise<{ context, eventTypes }>`
- `viewport.getState() -> ViewportState`
- `viewport.subscribe(mode, handler) -> unsubscribe`
- `events.getKnownEvents() -> string[]`
- `events.subscribe(eventKey, handler) -> unsubscribe`
- `fetch.registerInterceptor(spec) -> unregister`
- `fetch.getChainInfo() -> FetchChainInfo`
- `scheduler.coalesce(key, handler) -> void`
- `scheduler.createRafCoalesced(handler) -> function`
- `dom.waitForElement(selector, options?) -> Promise<Element>`
- `getDiagnostics() -> object`
- `selfTest() -> { ok, failures, diagnostics }`

## Compatibility Guarantees

1. Existing v1 function names are not removed in v1.x.
2. Event key names returned by `events.getKnownEvents()` remain stable in v1.x.
3. Fetch interceptor ordering remains `priority asc`, then registration order.
4. `viewport.subscribe('layout', ...)` only emits on meaningful width changes.

## Reserved Internal Fields

- `__destroy` is reserved for hot-reload teardown and is not a consumer API contract.

## Upgrade Notes (v2 planning)

- If any breaking change is required, publish as `window.STRuntimeBusV2` first.
- Keep v1 shim for one release cycle after v2 introduction.
