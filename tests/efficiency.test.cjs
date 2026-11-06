const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const source = readFileSync(require('node:path').join(__dirname, '..', 'index.js'), 'utf8');

function runtime() {
    const listeners = new Map();
    const rafQueue = [];
    let rafCalls = 0;
    const window = {
        fetch: async () => Response.json({ ok: true }),
        addEventListener(type, fn) { listeners.set(type, fn); },
        removeEventListener(type) { listeners.delete(type); },
        innerWidth: 1000,
        innerHeight: 800,
    };
    const sandbox = vm.createContext({ window, URL, console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame(fn) { rafCalls++; rafQueue.push(fn); return rafCalls; },
        cancelAnimationFrame() {} });
    const arrayPrototype = vm.runInContext('Array.prototype', sandbox);
    const nativeSort = arrayPrototype.sort;
    let sorts = 0;
    arrayPrototype.sort = function (...args) { sorts++; return nativeSort.apply(this, args); };
    vm.runInContext(source, sandbox);
    return {
        window,
        bus: window.STRuntimeBus,
        sorts: () => sorts,
        rafCalls: () => rafCalls,
        resize(width) { window.innerWidth = width; listeners.get('resize')(); },
        flushFrame() { for (const fn of rafQueue.splice(0)) fn(); },
    };
}

test('interceptor order is sorted once and only again after register or unregister', async () => {
    const r = runtime();
    const remove = r.bus.fetch.registerInterceptor({ id: 'a' });
    r.bus.fetch.registerInterceptor({ id: 'b' });
    for (let i = 0; i < 5; i++) await r.window.fetch('/x');
    assert.equal(r.sorts(), 1, 'five fetches share one ordering');
    r.bus.getDiagnostics();
    r.bus.fetch.getChainInfo();
    assert.equal(r.sorts(), 1);
    remove();
    await r.window.fetch('/x');
    await r.window.fetch('/x');
    assert.equal(r.sorts(), 2, 'unregister invalidates once');
    r.bus.fetch.registerInterceptor({ id: 'c' });
    await r.window.fetch('/x');
    assert.equal(r.sorts(), 3, 'register invalidates once');
});

test('priority ascending, then registration order; a re-registered id goes last among its ties', async () => {
    const r = runtime();
    const seen = [];
    const spec = id => ({ id, requestObserve() { seen.push(id); } });
    const removeFirst = r.bus.fetch.registerInterceptor({ ...spec('tie-1'), priority: 50 });
    r.bus.fetch.registerInterceptor({ ...spec('tie-2'), priority: 50 });
    r.bus.fetch.registerInterceptor({ ...spec('default') });
    r.bus.fetch.registerInterceptor({ ...spec('early'), priority: -1 });
    r.bus.fetch.registerInterceptor({ ...spec('tie-3'), priority: 50 });
    await r.window.fetch('/x');
    assert.deepEqual(seen, ['early', 'tie-1', 'tie-2', 'tie-3', 'default']);
    assert.deepEqual([...r.bus.fetch.getChainInfo().interceptorIds], seen);
    removeFirst();
    r.bus.fetch.registerInterceptor({ ...spec('tie-1'), priority: 50 });
    seen.length = 0;
    await r.window.fetch('/x');
    assert.deepEqual(seen, ['early', 'tie-2', 'tie-3', 'tie-1', 'default']);
});

test('register and unregister during a fetch leave that fetch on its starting list', async () => {
    const r = runtime();
    const seen = [];
    const hooks = id => ({
        id,
        requestObserve() { seen.push(`${id}:observe`); },
        requestTransform() { seen.push(`${id}:transform`); },
        responseObserve() { seen.push(`${id}:response`); },
    });
    let removeB;
    r.bus.fetch.registerInterceptor({ id: 'mutator', priority: 0, requestObserve() {
        removeB();
        r.bus.fetch.registerInterceptor({ ...hooks('late'), priority: 1 });
    } });
    removeB = r.bus.fetch.registerInterceptor(hooks('b'));
    await r.window.fetch('/x');
    assert.deepEqual(seen, ['b:observe', 'b:transform', 'b:response']);
    assert.deepEqual([...r.bus.fetch.getChainInfo().interceptorIds], ['mutator', 'late']);
});

test('a fetch started mid-mutation sees the new list while the older fetch keeps its own', async () => {
    const r = runtime();
    const seen = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    r.bus.fetch.registerInterceptor({ id: 'slow', async requestObserve(ctx) {
        if (ctx.url === '/older') await gate;
    }, responseObserve(ctx) { seen.push(`slow:${ctx.url}`); } });
    const older = r.window.fetch('/older');
    await Promise.resolve();
    r.bus.fetch.registerInterceptor({ id: 'added', responseObserve(ctx) { seen.push(`added:${ctx.url}`); } });
    await r.window.fetch('/newer');
    release();
    await older;
    assert.deepEqual(seen, ['slow:/newer', 'added:/newer', 'slow:/older']);
});

test('destroy drops the cached order', async () => {
    const r = runtime();
    r.bus.fetch.registerInterceptor({ id: 'a' });
    await r.window.fetch('/x');
    assert.deepEqual([...r.bus.getDiagnostics().fetchInterceptorIds], ['a']);
    r.bus.__destroy();
    assert.deepEqual([...r.bus.getDiagnostics().fetchInterceptorIds], []);
});

test('resize with no viewport subscribers schedules no frame and leaves the baseline alone', () => {
    const r = runtime();
    r.resize(1100);
    r.resize(1200);
    assert.equal(r.rafCalls(), 0);
    const payloads = [];
    r.bus.viewport.subscribe('layout', payload => payloads.push(payload));
    r.resize(1205);
    assert.equal(r.rafCalls(), 1);
    r.flushFrame();
    assert.equal(payloads.length, 1, 'baseline stayed at 1000, as when the idle flush returned early');
    assert.equal(payloads[0].widthChanged, true);
});

test('viewport frames coalesce while subscribed and stop after the last unsubscribe', () => {
    const r = runtime();
    const payloads = [];
    const unsubscribe = r.bus.viewport.subscribe('all', payload => payloads.push(payload));
    r.resize(1100);
    r.resize(1200);
    assert.equal(r.rafCalls(), 1);
    r.flushFrame();
    assert.equal(payloads.length, 1);
    r.resize(1300);
    unsubscribe();
    r.flushFrame();
    assert.equal(payloads.length, 1, 'an already queued frame still honours the subscriber check');
    const framesBefore = r.rafCalls();
    r.resize(1400);
    assert.equal(r.rafCalls(), framesBefore);
});
