(function () {
    'use strict';

    const EXTENSION_NAME = 'runtime_signal_bus';
    const VERSION = '1.1.0';

    const CONTEXT_POLL_INTERVAL_MS = 100;
    const CONTEXT_TIMEOUT_MS = 15000;
    const VIEWPORT_LAYOUT_THRESHOLD_PX = 20;
    const VIEWPORT_HEIGHT_THRESHOLD_PX = 10;
    const KEYBOARD_THRESHOLD_PX = 80;

    const KNOWN_EVENT_KEYS = Object.freeze([
        'APP_READY',
        'CHAT_CHANGED',
        'MESSAGE_SENT',
        'MESSAGE_RECEIVED',
        'GENERATION_STARTED',
        'GENERATION_AFTER_COMMANDS',
        'GENERATION_STOPPED',
        'GENERATION_ENDED',
        'GENERATE_AFTER_DATA',
        'CHARACTER_MESSAGE_RENDERED',
        'USER_MESSAGE_RENDERED',
    ]);

    const state = {
        context: null,
        eventTypes: null,
        contextPollTimer: null,
        contextWaiters: [],
        viewportLast: null,
        layoutBaseline: null,
        keyboardBaseline: null,
        viewportRaf: null,
        destroyed: false,
        viewportRafPending: false,
        viewportSubscribers: new Set(),
        eventSubscriptions: new Map(),
        fetchInterceptors: new Map(),
        orderedFetchInterceptors: null,
        fetchRegistrationSeq: 0,
        fetchWrapped: false,
        previousFetch: null,
        wrappedFetch: null,
        schedulerByKey: new Map(),
        destroyers: [],
    };

    for (const key of KNOWN_EVENT_KEYS) {
        state.eventSubscriptions.set(key, {
            handlers: new Set(),
            attached: false,
            eventName: null,
            boundHandler: null,
            boundEventSource: null,
            bindingPromise: null,
        });
    }

    function safeNow() {
        return Date.now();
    }

    function safePerformanceNow() {
        if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
            return performance.now();
        }
        return safeNow();
    }

    function resolveRequestUrl(target) {
        try {
            if (typeof target === 'string') return target;
            if (typeof URL !== 'undefined' && target instanceof URL) return target.href;
            if (target && typeof target.url === 'string') return target.url;
        } catch {
            // ignore
        }
        return '';
    }

    function safeGetContext() {
        try {
            if (!globalThis.SillyTavern?.getContext) return null;
            const context = globalThis.SillyTavern.getContext();
            if (!context) return null;
            const eventTypes = context.eventTypes || context.event_types;
            if (!context.eventSource || !eventTypes) return null;
            return { context, eventTypes };
        } catch {
            return null;
        }
    }

    function settleContextWaiters() {
        if (!state.contextWaiters.length) return;

        const ready = safeGetContext();
        if (ready) {
            state.context = ready.context;
            state.eventTypes = ready.eventTypes;
            const waiters = state.contextWaiters.splice(0, state.contextWaiters.length);
            for (const waiter of waiters) {
                waiter.resolve({ context: state.context, eventTypes: state.eventTypes });
            }
            if (state.contextPollTimer) {
                clearInterval(state.contextPollTimer);
                state.contextPollTimer = null;
            }
            ensurePendingEventBindings();
            return;
        }

        const now = safeNow();
        const stillWaiting = [];
        for (const waiter of state.contextWaiters) {
            if (now >= waiter.deadlineMs) {
                waiter.reject(Object.assign(new Error('SillyTavern context timed out'), { code: 'CONTEXT_TIMEOUT' }));
            } else {
                stillWaiting.push(waiter);
            }
        }
        state.contextWaiters = stillWaiting;

        if (!state.contextWaiters.length && state.contextPollTimer) {
            clearInterval(state.contextPollTimer);
            state.contextPollTimer = null;
        }
    }

    function ensureContextPolling() {
        if (state.contextPollTimer) return;
        state.contextPollTimer = setInterval(settleContextWaiters, CONTEXT_POLL_INTERVAL_MS);
        settleContextWaiters();
    }

    function waitForContext(options = {}) {
        const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : CONTEXT_TIMEOUT_MS;
        const ready = safeGetContext();
        if (ready) {
            state.context = ready.context;
            state.eventTypes = ready.eventTypes;
            return Promise.resolve(ready);
        }

        return new Promise((resolve, reject) => {
            state.contextWaiters.push({
                resolve,
                reject,
                deadlineMs: safeNow() + Math.max(100, timeoutMs),
            });
            ensureContextPolling();
        });
    }

    function getVisualViewportHeight() {
        const vv = globalThis.window?.visualViewport;
        if (!vv || typeof vv.height !== 'number') return null;
        return vv.height;
    }

    function getViewportSnapshot() {
        const width = Number(globalThis.window?.innerWidth || 0);
        const height = Number(globalThis.window?.innerHeight || 0);
        const visualHeight = getVisualViewportHeight();
        const keyboardGap = visualHeight == null ? 0 : Math.max(0, height - visualHeight);
        return {
            width,
            height,
            visualHeight,
            keyboardOpenLikely: keyboardGap >= KEYBOARD_THRESHOLD_PX,
            ts: safeNow(),
        };
    }

    function getViewportStateWithDiff() {
        const current = getViewportSnapshot();
        const prev = state.viewportLast;
        const layout = state.layoutBaseline || prev;
        const keyboard = state.keyboardBaseline || prev;
        const widthDelta = prev ? Math.abs(current.width - layout.width) : 0;
        const heightDelta = prev ? Math.abs(current.height - keyboard.height) : 0;
        const visualDelta = prev && prev.visualHeight != null && current.visualHeight != null
            ? Math.abs(current.visualHeight - keyboard.visualHeight)
            : 0;

        current.widthChanged = widthDelta >= VIEWPORT_LAYOUT_THRESHOLD_PX;
        current.heightChanged = heightDelta >= VIEWPORT_HEIGHT_THRESHOLD_PX || visualDelta >= VIEWPORT_HEIGHT_THRESHOLD_PX;
        current.keyboardStateChanged = prev ? current.keyboardOpenLikely !== prev.keyboardOpenLikely : false;
        current.visualHeightChanged = visualDelta >= VIEWPORT_HEIGHT_THRESHOLD_PX;

        if (current.widthChanged) state.layoutBaseline = current;
        if (current.heightChanged || current.visualHeightChanged || current.keyboardStateChanged) state.keyboardBaseline = current;
        state.viewportLast = current;
        return current;
    }

    function flushViewportSignals() {
        state.viewportRafPending = false;
        if (state.destroyed) return;
        if (!state.viewportSubscribers.size) return;

        const payload = getViewportStateWithDiff();
        for (const sub of [...state.viewportSubscribers]) {
            const { mode, handler } = sub;
            const shouldEmit = mode === 'all'
                || (mode === 'layout' && payload.widthChanged)
                || (mode === 'keyboard' && (payload.keyboardStateChanged || payload.visualHeightChanged));
            if (!shouldEmit) continue;
            try {
                handler(payload);
            } catch (error) {
                console.error(`[${EXTENSION_NAME}] viewport subscriber error`, error);
            }
        }
    }

    function queueViewportFlush() {
        if (state.viewportRafPending || !state.viewportSubscribers.size) return;
        state.viewportRafPending = true;
        state.viewportRaf = requestAnimationFrame(flushViewportSignals);
    }

    function bindViewportListeners() {
        const onViewportChange = () => queueViewportFlush();

        globalThis.window?.addEventListener('resize', onViewportChange);
        state.destroyers.push(() => {
            globalThis.window?.removeEventListener('resize', onViewportChange);
        });

        if (globalThis.window?.visualViewport) {
            globalThis.window.visualViewport.addEventListener('resize', onViewportChange);
            state.destroyers.push(() => {
                globalThis.window?.visualViewport?.removeEventListener('resize', onViewportChange);
            });
        }

        state.viewportLast = getViewportSnapshot();
        state.layoutBaseline = state.keyboardBaseline = state.viewportLast;
    }

    function viewportGetState() {
        const snapshot = getViewportSnapshot();
        const prev = state.viewportLast || snapshot;
        return {
            ...snapshot,
            widthChanged: Math.abs(snapshot.width - prev.width) >= VIEWPORT_LAYOUT_THRESHOLD_PX,
            heightChanged: Math.abs(snapshot.height - prev.height) >= VIEWPORT_HEIGHT_THRESHOLD_PX,
        };
    }

    function viewportSubscribe(mode, handler) {
        if (typeof handler !== 'function') {
            throw new Error('viewport.subscribe requires a handler');
        }
        const normalizedMode = mode || 'all';
        if (normalizedMode !== 'all' && normalizedMode !== 'layout' && normalizedMode !== 'keyboard') {
            throw new Error(`Unsupported viewport subscription mode: ${normalizedMode}`);
        }

        const sub = { mode: normalizedMode, handler };
        state.viewportSubscribers.add(sub);
        return () => {
            state.viewportSubscribers.delete(sub);
        };
    }

    async function emitEventToHandlers(eventKey, args) {
        const entry = state.eventSubscriptions.get(eventKey);
        if (!entry) return;
        if (eventKey === 'APP_READY') entry.replayArgs = args;
        for (const handler of [...entry.handlers]) {
            try {
                await handler(...args);
            } catch (error) {
                console.error(`[${EXTENSION_NAME}] event handler error`, eventKey, error);
            }
        }
    }

    function detachEventBinding(entry) {
        if (!entry) return;
        const eventSource = entry.boundEventSource;
        const eventName = entry.eventName;
        const boundHandler = entry.boundHandler;
        try {
            if (entry.attached && eventSource && eventName && boundHandler) {
                if (typeof eventSource.off === 'function') {
                    eventSource.off(eventName, boundHandler);
                } else if (typeof eventSource.removeListener === 'function') {
                    eventSource.removeListener(eventName, boundHandler);
                }
            }
        } catch {
            // ignore detach errors
        } finally {
            entry.attached = false;
            entry.eventName = null;
            entry.boundHandler = null;
            entry.boundEventSource = null;
        }
    }

    function ensureEventBinding(eventKey) {
        const entry = state.eventSubscriptions.get(eventKey);
        if (!entry || entry.attached) return Promise.resolve();
        if (entry.bindingPromise) return entry.bindingPromise;

        const bindingPromise = (async () => {
            const ready = await waitForContext().catch(() => null);
            if (!ready || entry.attached || entry.handlers.size === 0) return;

            const { context, eventTypes } = ready;
            if (!context?.eventSource || typeof context.eventSource.on !== 'function') return;

            const eventName = eventTypes[eventKey];
            if (!eventName) return;
            if (entry.attached || entry.handlers.size === 0) return;

            entry.eventName = eventName;
            entry.boundHandler = (...args) => emitEventToHandlers(eventKey, args);
            entry.boundEventSource = context.eventSource;
            context.eventSource.on(eventName, entry.boundHandler);
            entry.attached = true;
        })().finally(() => {
            if (entry.bindingPromise === bindingPromise) {
                entry.bindingPromise = null;
            }
        });

        entry.bindingPromise = bindingPromise;
        return bindingPromise;
    }

    function ensurePendingEventBindings() {
        for (const [eventKey, entry] of state.eventSubscriptions.entries()) {
            if (entry.handlers.size > 0 && !entry.attached) {
                void ensureEventBinding(eventKey);
            }
        }
    }

    function eventSubscribe(eventKey, handler) {
        if (typeof handler !== 'function') {
            throw new Error('events.subscribe requires a handler');
        }
        if (!state.eventSubscriptions.has(eventKey)) {
            throw new Error(`Unknown event key: ${eventKey}`);
        }

        const entry = state.eventSubscriptions.get(eventKey);
        entry.handlers.add(handler);
        if (eventKey === 'APP_READY' && entry.replayArgs) {
            Promise.resolve().then(() => { if (entry.handlers.has(handler)) return handler(...entry.replayArgs); }).catch(error => console.error(`[${EXTENSION_NAME}] replay error`, error));
        }
        if (!entry.attached) {
            void ensureEventBinding(eventKey);
        }

        let unsubscribed = false;
        return () => {
            if (unsubscribed) return;
            unsubscribed = true;
            entry.handlers.delete(handler);
            if (entry.handlers.size === 0) {
                detachEventBinding(entry);
            }
        };
    }

    // Rebuilt, never mutated: an in-flight fetch keeps iterating the list it started with.
    function getOrderedInterceptors() {
        if (!state.orderedFetchInterceptors) {
            state.orderedFetchInterceptors = [...state.fetchInterceptors.values()].sort((a, b) => {
                if (a.priority !== b.priority) return a.priority - b.priority;
                return a.seq - b.seq;
            });
        }
        return state.orderedFetchInterceptors;
    }

    function ensureFetchWrapped() {
        // A later extension may wrap our installed function. Keep that chain:
        // wrapping it again would run our observers twice or recurse through a
        // mutable previousFetch. New registrations use the existing live map.
        if (state.fetchWrapped && state.wrappedFetch) return;
        if (typeof globalThis.window?.fetch !== 'function') {
            throw new Error('window.fetch is unavailable');
        }

        const previousFetch = globalThis.window.fetch.bind(globalThis.window);
        state.previousFetch = previousFetch;

        const wrappedFetch = async function (target, options) {
            // An outer extension can still hold an old wrapper after teardown.
            // Such wrappers become transparent and keep their own stable base.
            if (state.wrappedFetch !== wrappedFetch || !state.fetchWrapped) return previousFetch(target, options);
            const interceptors = getOrderedInterceptors();
            if (!interceptors.length) {
                return previousFetch(target, options);
            }

            const reqCtx = {
                target,
                options,
                url: resolveRequestUrl(target),
                ts: safeNow(),
                perfTs: safePerformanceNow(),
                meta: {},
                shortCircuitResponse: null,
                baseFetch: (nextTarget, nextOptions) => previousFetch(nextTarget, nextOptions),
            };
            // Optional v1.1 API: one read-only parse per body during request hooks.
            // Do not clone/read Request bodies: that would consume or tee a stream.
            let parsedBody;
            let parsedJson = null;
            let hasParsedBody = false;
            const releaseRequestJson = () => {
                parsedBody = undefined;
                parsedJson = null;
                hasParsedBody = false;
            };
            reqCtx.getRequestJson = () => {
                const body = reqCtx.options?.body;
                if (!hasParsedBody || body !== parsedBody) {
                    releaseRequestJson();
                    parsedBody = body;
                    hasParsedBody = true;
                    if (typeof body === 'string') {
                        try { parsedJson = JSON.parse(body); } catch { /* non-JSON */ }
                    }
                }
                return parsedJson;
            };
            reqCtx.releaseRequestJson = releaseRequestJson;

            let resCtx = null;
            try {
                for (const interceptor of interceptors) {
                    if (typeof interceptor.requestObserve === 'function') {
                        await interceptor.requestObserve(reqCtx);
                    }
                }

                for (const interceptor of interceptors) {
                    if (typeof interceptor.requestTransform !== 'function') continue;
                    const patch = await interceptor.requestTransform(reqCtx);
                    if (!patch || typeof patch !== 'object') continue;
                    if (Object.prototype.hasOwnProperty.call(patch, 'target')) {
                        reqCtx.target = patch.target;
                        reqCtx.url = resolveRequestUrl(reqCtx.target);
                    }
                    if (Object.prototype.hasOwnProperty.call(patch, 'options')) reqCtx.options = patch.options;
                    if (Object.prototype.hasOwnProperty.call(patch, 'shortCircuitResponse')) reqCtx.shortCircuitResponse = patch.shortCircuitResponse;
                    if (Object.prototype.hasOwnProperty.call(patch, 'meta') && patch.meta && typeof patch.meta === 'object') {
                        reqCtx.meta = { ...reqCtx.meta, ...patch.meta };
                    }
                }
                reqCtx.url = resolveRequestUrl(reqCtx.target);

                // Consumers retain compact metadata, not the parsed prompt. The
                // cache need not survive a potentially minutes-long generation.
                releaseRequestJson();
                const response = reqCtx.shortCircuitResponse
                    ? await Promise.resolve(reqCtx.shortCircuitResponse)
                    : await previousFetch(reqCtx.target, reqCtx.options);

                resCtx = {
                    request: reqCtx,
                    response,
                    target: reqCtx.target,
                    options: reqCtx.options,
                    url: reqCtx.url,
                    ts: safeNow(),
                    perfTs: safePerformanceNow(),
                };

                for (const interceptor of interceptors) {
                    if (typeof interceptor.responseTransform !== 'function') continue;
                    const nextResponse = await interceptor.responseTransform(resCtx);
                    if (nextResponse !== undefined) {
                        resCtx.response = nextResponse;
                    }
                }

                for (const interceptor of interceptors) {
                    if (typeof interceptor.responseObserve === 'function') {
                        await interceptor.responseObserve(resCtx);
                    }
                }

                return resCtx.response;
            } catch (error) {
                const errCtx = {
                    request: reqCtx,
                    response: resCtx?.response || null,
                    target: reqCtx.target,
                    options: reqCtx.options,
                    url: reqCtx.url,
                    error,
                    ts: safeNow(),
                    perfTs: safePerformanceNow(),
                };

                for (const interceptor of interceptors) {
                    if (typeof interceptor.errorObserve !== 'function') continue;
                    try {
                        await interceptor.errorObserve(errCtx);
                    } catch (errorObserveError) {
                        console.error(`[${EXTENSION_NAME}] fetch errorObserve failure`, errorObserveError);
                    }
                }

                throw error;
            } finally {
                releaseRequestJson();
            }
        };

        try {
            Object.defineProperty(wrappedFetch, '__fetchInterceptorName', {
                value: EXTENSION_NAME,
                configurable: true,
            });
            Object.defineProperty(wrappedFetch, '__prevFetch', {
                value: state.previousFetch,
                configurable: true,
            });
        } catch {
            // Non-fatal metadata assignment failure.
        }

        globalThis.window.fetch = wrappedFetch;
        state.wrappedFetch = wrappedFetch;
        state.fetchWrapped = true;

    }

    function maybeUnwrapFetch() {
        if (state.fetchInterceptors.size > 0) return;
        if (!state.fetchWrapped || !state.previousFetch) return;
        if (globalThis.window?.fetch === state.wrappedFetch) {
            globalThis.window.fetch = state.previousFetch;
        }
        state.fetchWrapped = false;
        state.previousFetch = null;
        state.wrappedFetch = null;
    }

    function fetchRegisterInterceptor(spec = {}) {
        const id = typeof spec.id === 'string' ? spec.id.trim() : '';
        if (!id) {
            throw new Error('fetch.registerInterceptor requires a non-empty id');
        }
        if (state.fetchInterceptors.has(id)) {
            throw new Error(`fetch interceptor id already registered: ${id}`);
        }

        const priority = Number.isFinite(Number(spec.priority)) ? Number(spec.priority) : 100;
        ensureFetchWrapped();

        const interceptor = {
            id,
            priority,
            seq: state.fetchRegistrationSeq++,
            requestObserve: typeof spec.requestObserve === 'function' ? spec.requestObserve : null,
            requestTransform: typeof spec.requestTransform === 'function' ? spec.requestTransform : null,
            responseTransform: typeof spec.responseTransform === 'function' ? spec.responseTransform : null,
            responseObserve: typeof spec.responseObserve === 'function' ? spec.responseObserve : null,
            errorObserve: typeof spec.errorObserve === 'function' ? spec.errorObserve : null,
        };

        state.fetchInterceptors.set(id, interceptor);
        state.orderedFetchInterceptors = null;

        return () => {
            if (state.fetchInterceptors.get(id) !== interceptor) return;
            state.fetchInterceptors.delete(id);
            state.orderedFetchInterceptors = null;
            maybeUnwrapFetch();
        };
    }

    function fetchGetChainInfo() {
        const interceptorIds = getOrderedInterceptors().map(x => x.id);
        return {
            installed: state.fetchWrapped,
            interceptorIds,
            wrappedFetchName: (() => {
                try {
                    return String(globalThis.window.fetch?.name || '(anonymous)');
                } catch {
                    return '(unknown)';
                }
            })(),
        };
    }

    function getDiagnostics() {
        return {
            version: VERSION,
            viewportSubscribers: state.viewportSubscribers.size,
            eventSubscribers: (() => {
                const counts = {};
                for (const [key, entry] of state.eventSubscriptions.entries()) {
                    counts[key] = entry.handlers.size;
                }
                return counts;
            })(),
            fetchInterceptorIds: getOrderedInterceptors().map(x => x.id),
            fetchWrapped: state.fetchWrapped,
        };
    }

    function selfTest() {
        const failures = [];
        if (typeof waitForContext !== 'function') failures.push('waitForContext missing');
        if (typeof viewportSubscribe !== 'function') failures.push('viewport.subscribe missing');
        if (typeof eventSubscribe !== 'function') failures.push('events.subscribe missing');
        if (typeof fetchRegisterInterceptor !== 'function') failures.push('fetch.registerInterceptor missing');
        if (typeof schedulerCoalesce !== 'function') failures.push('scheduler.coalesce missing');
        if (typeof domWaitForElement !== 'function') failures.push('dom.waitForElement missing');
        return {
            ok: failures.length === 0,
            failures,
            diagnostics: getDiagnostics(),
        };
    }

    function schedulerCoalesce(key, handler) {
        const normalizedKey = String(key || 'default');
        if (typeof handler !== 'function') return;
        if (state.schedulerByKey.has(normalizedKey)) return;

        const rafId = requestAnimationFrame(() => {
            state.schedulerByKey.delete(normalizedKey);
            try {
                handler();
            } catch (error) {
                console.error(`[${EXTENSION_NAME}] scheduler error (${normalizedKey})`, error);
            }
        });
        state.schedulerByKey.set(normalizedKey, rafId);
    }

    function schedulerCreateRafCoalesced(handler) {
        if (typeof handler !== 'function') {
            throw new Error('scheduler.createRafCoalesced requires a handler');
        }
        let rafId = null;
        let latestArgs = [];
        const cancel = () => { if (rafId != null) cancelAnimationFrame(rafId); rafId = null; latestArgs = []; };
        state.destroyers.push(cancel);
        return (...args) => {
            if (state.destroyed) return;
            latestArgs = args;
            if (rafId != null) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                handler(...latestArgs);
            });
        };
    }

    function domWaitForElement(selector, options = {}) {
        const root = options.root && options.root.querySelector ? options.root : document;
        const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 10000;
        const existing = root.querySelector(selector);
        if (existing) return Promise.resolve(existing);

        return new Promise((resolve, reject) => {
            const observer = new MutationObserver(() => {
                const node = root.querySelector(selector);
                if (!node) return;
                observer.disconnect();
                if (timerId) clearTimeout(timerId);
                forget();
                resolve(node);
            });

            const destroyWaiter = () => { observer.disconnect(); clearTimeout(timerId); reject(Object.assign(new Error('Runtime bus destroyed'), { code: 'BUS_DESTROYED' })); };
            state.destroyers.push(destroyWaiter);
            const forget = () => { const index = state.destroyers.indexOf(destroyWaiter); if (index >= 0) state.destroyers.splice(index, 1); };
            observer.observe(root === document ? document.documentElement : root, {
                attributes: true,
                childList: true,
                subtree: true,
            });

            const timerId = setTimeout(() => {
                observer.disconnect();
                forget();
                reject(Object.assign(new Error(`Timed out waiting for selector: ${selector}`), { code: 'WAIT_TIMEOUT' }));
            }, Math.max(50, timeoutMs));
        });
    }

    function destroyPreviousBusIfPresent() {
        const previous = globalThis.window?.STRuntimeBus;
        if (!previous || typeof previous.__destroy !== 'function') return;
        try {
            previous.__destroy();
        } catch (error) {
            console.warn(`[${EXTENSION_NAME}] Previous bus destroy failed`, error);
        }
    }

    function destroy() {
        state.destroyed = true;
        if (state.viewportRaf != null) cancelAnimationFrame(state.viewportRaf);
        if (state.contextPollTimer) {
            clearInterval(state.contextPollTimer);
            state.contextPollTimer = null;
        }
        for (const waiter of state.contextWaiters.splice(0, state.contextWaiters.length)) {
            waiter.reject(Object.assign(new Error('Runtime bus destroyed'), { code: 'BUS_DESTROYED' }));
        }
        for (const teardown of state.destroyers.splice(0, state.destroyers.length)) {
            try {
                teardown();
            } catch {
                // ignore teardown errors
            }
        }
        state.viewportSubscribers.clear();
        for (const entry of state.eventSubscriptions.values()) {
            detachEventBinding(entry);
            entry.handlers.clear();
            entry.bindingPromise = null;
            entry.boundEventSource = null;
        }
        state.fetchInterceptors.clear();
        state.orderedFetchInterceptors = null;
        state.fetchRegistrationSeq = 0;
        for (const rafId of state.schedulerByKey.values()) {
            cancelAnimationFrame(rafId);
        }
        state.schedulerByKey.clear();
        maybeUnwrapFetch();
    }

    destroyPreviousBusIfPresent();
    bindViewportListeners();
    state.destroyers.push(() => {
        state.fetchInterceptors.clear();
        state.orderedFetchInterceptors = null;
        maybeUnwrapFetch();
    });

    globalThis.window.STRuntimeBus = {
        version: VERSION,
        waitForContext,
        viewport: {
            getState: viewportGetState,
            subscribe: viewportSubscribe,
        },
        events: {
            subscribe: eventSubscribe,
            getKnownEvents: () => [...KNOWN_EVENT_KEYS],
        },
        fetch: {
            registerInterceptor: fetchRegisterInterceptor,
            getChainInfo: fetchGetChainInfo,
            preservesOuterWrappers: true,
        },
        scheduler: {
            coalesce: schedulerCoalesce,
            createRafCoalesced: schedulerCreateRafCoalesced,
        },
        dom: {
            waitForElement: domWaitForElement,
        },
        getDiagnostics,
        selfTest,
        __destroy: destroy,
    };

    console.log(`[${EXTENSION_NAME}] Loaded v${VERSION}`);
})();
