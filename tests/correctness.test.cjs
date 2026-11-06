const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
// The host's event emitter; set SILLYTAVERN_DIR if your SillyTavern checkout lives elsewhere.
const sillyTavernDir = process.env.SILLYTAVERN_DIR || path.resolve(__dirname, '../../../../source_projects/SillyTavern');
const host = fs.readFileSync(path.join(sillyTavernDir, 'public/lib/eventemitter.js'), 'utf8').replace('export { EventEmitter }', '');
const results = [];
const noop = () => {};
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function setup() {
  const rafs = new Map(), timers = new Map(), intervals = new Map(), listeners = new Map(), observers = [];
  let id = 0, nativeCalls = 0, matched = null;
  const c = { console: {log:noop,debug:noop,warn:noop,error:noop,trace:noop}, URL, performance, Date, localStorage:{getItem:()=>null} };
  c.window = c; c.innerWidth = 1000; c.innerHeight = 800;
  c.fetch = async (target, options) => { nativeCalls++; return {target, options, native:true}; };
  c.addEventListener = (name, f) => { if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(f); };
  c.removeEventListener = (name, f) => listeners.get(name)?.delete(f);
  c.requestAnimationFrame = f => { rafs.set(++id,f);return id; };
  c.cancelAnimationFrame = i => rafs.delete(i);
  c.setTimeout = f => { timers.set(++id,f);return id; };
  c.clearTimeout = i => timers.delete(i);
  c.setInterval = f => { intervals.set(++id,f);return id; };
  c.clearInterval = i => intervals.delete(i);
  c.document = { documentElement:{}, querySelector:()=>matched };
  c.MutationObserver = class { constructor(cb){this.cb=cb;this.connected=false;observers.push(this)} observe(node,options){this.connected=true;this.options=options} disconnect(){this.connected=false} };
  vm.createContext(c); vm.runInContext(host,c);
  const events = new c.EventEmitter(['app_ready']);
  c.SillyTavern={getContext:()=>({eventSource:events,eventTypes:{APP_READY:'app_ready',GENERATE_AFTER_DATA:'after_data'}})};
  vm.runInContext(source,c);
  return {c,bus:c.STRuntimeBus,events,observers,timers,rafs,nativeCalls:()=>nativeCalls,match:x=>matched=x,
    flush(){const q=[...rafs.values()];rafs.clear();q.forEach(f=>f())}, resize(width){c.innerWidth=width;for(const f of listeners.get('resize')||[])f();this.flush()}};
}

const {test} = require('node:test');
test('awaits async event listeners in order and catches rejections', async () => {
 const h=setup(), trace=[];
 h.bus.events.subscribe('GENERATE_AFTER_DATA', async value => { await Promise.resolve(); value.text='new'; trace.push('first'); });
 h.bus.events.subscribe('GENERATE_AFTER_DATA', value => trace.push(value.text));
 await tick(); const payload={text:'old'}; await h.events.emit('after_data',payload);
 assert.deepEqual(trace,['first','new']); h.bus.__destroy();
});
test('late APP_READY subscribers receive exactly one replay', async () => {
 const h=setup(); let first=0, late=0;
 h.bus.events.subscribe('APP_READY',()=>first++); await tick(); await h.events.emit('app_ready');
 h.bus.events.subscribe('APP_READY',()=>late++); await tick();
 assert.equal(first,1); assert.equal(late,1); h.bus.__destroy();
});
test('small resizes accumulate against the last layout signal', () => {
 const h=setup(); let count=0; h.bus.viewport.subscribe('layout',()=>count++);
 for(let width=1005;width<=1200;width+=5) h.resize(width);
 assert.equal(count,10); h.bus.__destroy();
});
test('old interceptor cleanup cannot unregister its replacement', () => {
 const h=setup(); const old=h.bus.fetch.registerInterceptor({id:'x'});old();h.bus.fetch.registerInterceptor({id:'x'});old();
 assert.equal(h.bus.fetch.getChainInfo().interceptorIds.length,1);h.bus.__destroy();
});
test('destruction cancels reusable callbacks and rejects DOM waiters', async () => {
 const h=setup();let called=false;h.bus.scheduler.createRafCoalesced(()=>called=true)();
 const pending=h.bus.dom.waitForElement('.ready'); assert.equal(h.observers[0].options.attributes,true);
 const rejected=assert.rejects(pending,error=>error.code==='BUS_DESTROYED');h.bus.__destroy();h.flush();await rejected;
 assert.equal(called,false);assert.equal(h.observers[0].connected,false);
});
