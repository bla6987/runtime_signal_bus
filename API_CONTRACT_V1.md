# Runtime Signal Bus API Contract v1

Version: `1.1.0`

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

## Optional request JSON helper (v1.1)

Fetch request hooks may feature-detect `typeof reqCtx.getRequestJson === 'function'`.
Calling it synchronously returns the parsed JSON value of the current string
`reqCtx.options.body`, or `null` for an absent, non-string, or invalid JSON body.
It never consumes `Request` objects, streams, FormData, or the response body.

The parsed value is shared **read-only** between request hooks. To change a body,
return replacement `options` with a newly serialized body; do not mutate the
shared parsed object. Changing the body string invalidates the lazy cache, even
when a hook changes `reqCtx.options.body` directly. Identical body strings may
reuse the same parse. The cache is released after request transforms, before the
network wait, and on all exit paths. An async request hook that sends its own
request before returning can call optional `reqCtx.releaseRequestJson()` earlier.
This only clears the cache; a later getter call reparses the current body.
Response hooks can call the helper again,
but that is a fresh parse: prefer retaining only the small metadata they need.

Consumers must keep their own local parsing fallback for v1.0 buses and must
continue working without a bus. Hook order and response ownership are unchanged;
the helper does not buffer or clone any response stream.

v1.1 also exposes `fetch.preservesOuterWrappers === true`: registering another
interceptor preserves an already installed bus underneath a later fetch wrapper.
Inactive old bus wrappers forward to their original fetch after unregister or
teardown, including in-flight requests. On older buses, consumers should use a
standalone wrapper if `getChainInfo().installed` is true but the outermost fetch
is no longer marked `__fetchInterceptorName === 'runtime_signal_bus'`. Replacing
fetch entirely without calling the previous function bypasses every inner
interceptor; the bus does not override such replacements automatically.

## Reserved Internal Fields

- `__destroy` is reserved for hot-reload teardown and is not a consumer API contract.

## Upgrade Notes (v2 planning)

- If any breaking change is required, publish as `window.STRuntimeBusV2` first.
- Keep v1 shim for one release cycle after v2 introduction.
