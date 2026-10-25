const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const source = readFileSync(require('node:path').join(__dirname, '..', 'index.js'), 'utf8');

function runtime(fetch = async () => Response.json({ ok: true })) {
    let parses = 0;
    const window = { fetch, addEventListener() {}, removeEventListener() {}, innerWidth: 1000, innerHeight: 800 };
    const sandbox = vm.createContext({ window, URL, console: { log() {}, warn() {}, error() {} },
        JSON: { stringify: JSON.stringify, parse: value => { parses++; return JSON.parse(value); } },
        setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame() {}, cancelAnimationFrame() {} });
    vm.runInContext(source, sandbox);
    return { window, bus: window.STRuntimeBus, parses: () => parses };
}

test('unused parser does no work; request and response streams remain caller owned', async () => {
    const original = Response.json({ answer: 'still readable' });
    const r = runtime(async () => original);
    r.bus.fetch.registerInterceptor({ id: 'no-parse', requestObserve() {} });
    const request = new Request('https://example.test', { method: 'POST', body: '{"large":"prompt"}' });
    assert.equal(await r.window.fetch(request), original);
    assert.equal(r.parses(), 0);
    assert.equal(request.bodyUsed, false);
    assert.equal(await original.text(), '{"answer":"still readable"}');
});

test('one parse is shared across hooks and invalidated by transformed or directly replaced body', async () => {
    const r = runtime();
    let first;
    r.bus.fetch.registerInterceptor({ id: 'observe', requestObserve(ctx) { first = ctx.getRequestJson(); } });
    r.bus.fetch.registerInterceptor({ id: 'change', priority: 10, requestTransform(ctx) {
        assert.equal(ctx.getRequestJson(), first);
        return { options: { ...ctx.options, body: '{"version":2}' } };
    } });
    r.bus.fetch.registerInterceptor({ id: 'after-change', priority: 20, requestTransform(ctx) {
        assert.equal(ctx.getRequestJson().version, 2);
        assert.notEqual(ctx.getRequestJson(), first);
        ctx.options.body = '{"version":3}';
        assert.equal(ctx.getRequestJson().version, 3);
    } });
    await r.window.fetch('/generation', { method: 'POST', body: '{"version":1}' });
    assert.equal(r.parses(), 3);
});

test('cache is released before network wait and after errors; early release is supported', async () => {
    let context;
    let r;
    r = runtime(async () => {
        assert.equal(r.parses(), 2);
        context.getRequestJson(); // The previous hook cache must have been released.
        assert.equal(r.parses(), 3);
        throw new Error('network unavailable');
    });
    r.bus.fetch.registerInterceptor({ id: 'parse', requestObserve(ctx) {
        context = ctx;
        const first = ctx.getRequestJson();
        ctx.releaseRequestJson();
        assert.notEqual(ctx.getRequestJson(), first);
    } });
    await assert.rejects(r.window.fetch('/generation', { body: '{"version":1}' }), /network unavailable/);
    context.getRequestJson();
    assert.equal(r.parses(), 4, 'finally releases the error-path cache');
});

test('invalid JSON is cached; unsupported bodies are never read or cloned', async () => {
    const r = runtime();
    r.bus.fetch.registerInterceptor({ id: 'parse', requestObserve(ctx) {
        assert.equal(ctx.getRequestJson(), null);
        assert.equal(ctx.getRequestJson(), null);
    } });
    await r.window.fetch('/generation', { body: 'not JSON' });
    await r.window.fetch({ url: '/generation', clone() { throw new Error('must not clone'); } });
    await r.window.fetch('/generation', { body: new ReadableStream() });
    assert.equal(r.parses(), 1);
});

test('short-circuit and response transforms preserve existing ordered pipeline', async () => {
    const r = runtime(() => { throw new Error('must not reach network'); });
    const order = [];
    const first = Response.json({ version: 1 });
    const final = Response.json({ version: 2 });
    r.bus.fetch.registerInterceptor({ id: 'later', priority: 80, responseObserve(ctx) {
        order.push('observe');
        assert.equal(ctx.response, final);
    } });
    r.bus.fetch.registerInterceptor({ id: 'earlier', priority: 40,
        requestTransform: () => ({ shortCircuitResponse: first }),
        responseTransform(ctx) { order.push('transform'); assert.equal(ctx.response, first); return final; },
    });
    assert.equal(await r.window.fetch('/generation', { body: '{}' }), final);
    assert.deepEqual(order, ['transform', 'observe']);
    assert.equal(final.bodyUsed, false);
});

test('later fetch wrappers and unregister/re-register cycles never recurse or double observe', async () => {
    let network = 0;
    const r = runtime(async () => { network++; return Response.json({ ok: true }); });
    const observations = [];
    const removeFirst = r.bus.fetch.registerInterceptor({ id: 'first', requestObserve() { observations.push('first'); } });
    const inner = r.window.fetch;
    const outer = async (...args) => { await Promise.resolve(); return inner(...args); };
    r.window.fetch = outer;
    const removeSecond = r.bus.fetch.registerInterceptor({ id: 'second', requestObserve() { observations.push('second'); } });
    assert.equal(r.window.fetch, outer, 'preserve the outer extension wrapper');
    await r.window.fetch('/generation');
    assert.deepEqual(observations, ['first', 'second']);
    removeFirst(); removeSecond();
    await r.window.fetch('/generation');
    r.bus.fetch.registerInterceptor({ id: 'third', requestObserve() { observations.push('third'); } });
    await r.window.fetch('/generation');
    assert.deepEqual(observations, ['first', 'second', 'third']);
    assert.equal(network, 3);
});

test('unregister during an awaited hook keeps its in-flight base fetch available', async () => {
    const r = runtime();
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    const remove = r.bus.fetch.registerInterceptor({ id: 'waiting', async requestTransform(ctx) {
        await wait;
        return { shortCircuitResponse: await ctx.baseFetch(ctx.target, ctx.options) };
    } });
    const pending = r.window.fetch('/generation');
    remove();
    release();
    assert.deepEqual(await (await pending).json(), { ok: true });
});
