import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPanelHost} from '../panel-host.js';

// A small DOM fixture keeps lifecycle/race tests runnable with node --test and
// models the queued close event (the important difference from a sync mock).
function fixture({visibilityHook = () => {}} = {}) {
  const frames = new Map(), closeEvents = [], resizes = [], mutations = [], visibility = [], visibilityModes = [];
  let sequence = 0, active = true, ensures = 0;
  class Surface extends EventTarget {
    counts = new Map();
    addEventListener(name, fn, options) { super.addEventListener(name, fn, options); this.counts.set(name, (this.counts.get(name) || 0) + 1); }
    removeEventListener(name, fn, options) { super.removeEventListener(name, fn, options); this.counts.set(name, Math.max(0, (this.counts.get(name) || 0) - 1)); }
  }
  class Element extends Surface {
    attrs = new Map(); nodeType = 1; namespaceURI = 'http://www.w3.org/1999/xhtml'; isConnected = true; parentElement = null; focuses = 0;
    rect = {left: 44, top: 80, width: 350, height: 700};
    constructor() {
      super(); this.ownerDocument = doc;
      this.style = {
        setProperty: (name, value, priority) => {
          const values = this.styles(); values.set(name, value + (priority ? ' !' + priority : ''));
          this.attrs.set('style', [...values].map(([key, v]) => key + ': ' + v + ';').join(' '));
        },
        getPropertyValue: name => (this.styles().get(name) || '').replace(/ !important$/, '')
      };
      this.classList = {
        add: (...values) => { const set = this.classes(); values.forEach(v => set.add(v)); this.attrs.set('class', [...set].join(' ')); },
        remove: (...values) => { const set = this.classes(); values.forEach(v => set.delete(v)); this.attrs.set('class', [...set].join(' ')); },
        contains: name => this.classes().has(name)
      };
    }
    classes() { return new Set((this.attrs.get('class') || '').split(/\s+/).filter(Boolean)); }
    styles() { return new Map((this.attrs.get('style') || '').split(';').filter(Boolean).map(item => { const at = item.indexOf(':'); return [item.slice(0, at).trim(), item.slice(at + 1).trim()]; })); }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    setAttribute(name, value) { this.attrs.set(name, value); }
    removeAttribute(name) { this.attrs.delete(name); }
    getBoundingClientRect() { return {...this.rect}; }
    getRootNode({composed = false} = {}) { return composed ? (this.isConnected ? this.ownerDocument : this) : (this.root || this.ownerDocument); }
    focus() { this.focuses++; }
  }
  const doc = new Surface(); doc.documentElement = new Surface();
  const win = new Surface(); Object.assign(win, {
    document: doc, Node: Element, HTMLElement: Element, visualViewport: new Surface(),
    requestAnimationFrame: fn => { const id = ++sequence; frames.set(id, fn); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class { constructor(fn) { this.fn = fn; this.nodes = []; resizes.push(this); } observe(node) { this.nodes.push(node); } disconnect() { this.disconnected = true; } },
    MutationObserver: class { constructor(fn) { this.fn = fn; this.nodes = []; mutations.push(this); } observe(node) { this.nodes.push(node); } disconnect() { this.disconnected = true; } }
  });
  const panel = new Element(), frame = new Element(), anchor = new Element(), body = new Element();
  panel.parentElement = body; frame.parentElement = panel;
  panel.open = false; panel.shows = 0;
  panel.show = () => { panel.shows++; panel.open = true; };
  panel.showModal = () => { throw Error('host must never use a modal'); };
  panel.close = () => { if (!panel.open) return; panel.open = false; closeEvents.push(() => panel.dispatchEvent(new Event('close'))); };
  panel.setAttribute('class', 'floating user-phone');
  panel.setAttribute('style', 'left: 20px; width: 320px;');
  frame.setAttribute('style', 'width: 344px; transform: scale(0.9);');
  const host = createPanelHost({win, isActive: () => active, ensurePanel: () => ensures++, getPanel: () => panel, getFrame: () => frame, visibility: (on, preserveView = true) => { visibility.push(on); visibilityModes.push({on, preserveView}); visibilityHook(on); }});
  return {host, panel, frame, anchor, win, doc, frames, resizes, mutations, visibility, visibilityModes,
    get ensures() { return ensures; },
    deactivate: () => active = false,
    makeElement: () => new Element(),
    flushClose: () => { while (closeEvents.length) closeEvents.shift()(); },
    flushFrames: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); }
  };
}

test('host exposes only a frozen presentation mount API', () => {
  const {host} = fixture();
  assert.deepEqual(Object.keys(host.api), ['mount']);
  assert.ok(Object.isFrozen(host.api));
});

test('mount uses the existing non-modal dialog and iframe, then restores exact styles', () => {
  const f = fixture(); let notifications = 0;
  const saved = [f.panel.getAttribute('class'), f.panel.getAttribute('style'), f.frame.getAttribute('style')];
  const parent = f.frame.parentElement;
  const lease = f.host.api.mount(f.anchor, {onClose: () => notifications++});
  assert.equal(f.host.hosted, true);
  assert.equal(f.panel.open, true);
  assert.equal(f.panel.shows, 1);
  assert.equal(f.frame.parentElement, parent);
  assert.equal(f.panel.style.getPropertyValue('left'), '44px');
  assert.equal(f.panel.style.getPropertyValue('height'), '700px');
  assert.equal(f.panel.style.getPropertyValue('z-index'), '2147483200');
  assert.equal(f.frame.style.getPropertyValue('width'), '100%');
  assert.equal(f.panel.classList.contains('floating'), false);
  lease.focus(); assert.equal(f.frame.focuses, 1);
  lease.release(); lease.release();
  assert.equal(f.host.hosted, false); assert.equal(f.panel.open, false);
  assert.deepEqual([f.panel.getAttribute('class'), f.panel.getAttribute('style'), f.frame.getAttribute('style')], saved);
  f.flushClose(); assert.equal(notifications, 0);
  assert.deepEqual(f.visibility, [true, false]);
  assert.ok(f.resizes.every(observer => observer.disconnected));
  assert.ok(f.mutations.every(observer => observer.disconnected));
  assert.equal(f.win.counts.get('resize'), 0); assert.equal(f.win.counts.get('scroll'), 0);
  assert.equal(f.win.visualViewport.counts.get('resize'), 0);
});

test('mount rejects invalid, detached, foreign or zero-size slots without retiring the current lease', () => {
  const f = fixture(); f.host.api.mount(f.anchor);
  const invalid = [{}, null, f.makeElement(), f.makeElement(), f.makeElement()];
  invalid[2].isConnected = false; invalid[3].ownerDocument = {}; invalid[4].rect.width = 0;
  for (const anchor of invalid) assert.throws(() => f.host.api.mount(anchor), /槽位/);
  assert.throws(() => f.host.api.mount(f.anchor, {onClose: 3}), /onClose/);
  assert.equal(f.ensures, 1); assert.equal(f.host.hosted, true); assert.equal(f.panel.open, true);
});

test('an adopted slot retains its iframe realm prototype but is accepted in the parent document', () => {
  const parent = fixture(), child = fixture(), adopted = child.anchor;
  adopted.ownerDocument = parent.doc;
  assert.equal(adopted instanceof parent.win.HTMLElement, false);
  const lease = parent.host.api.mount(adopted);
  assert.equal(parent.host.hosted, true); assert.equal(parent.panel.open, true);
  lease.release(); parent.flushClose();
});

test('replacing a lease notifies its old owner once and ignores its queued close event', () => {
  const f = fixture(); let old = 0, latest = 0;
  const first = f.host.api.mount(f.anchor, {onClose: () => old++});
  const second = f.host.api.mount(f.anchor, {onClose: () => latest++});
  first.release(); first.sync(); first.focus(); f.flushClose();
  assert.equal(old, 1); assert.equal(latest, 0); assert.equal(f.panel.open, true); assert.equal(f.host.hosted, true);
  second.release(); f.flushClose(); assert.equal(latest, 0);
});

test('an old queued close event cannot consume a later external close notification', () => {
  const f = fixture(); let latest = 0;
  f.host.api.mount(f.anchor).release();
  f.host.api.mount(f.anchor, {onClose: () => latest++});
  f.panel.close(); f.flushClose();
  assert.equal(latest, 1); assert.equal(f.host.hosted, false);
});

test('phone UI close notifies once and permits ordinary reuse of the same iframe', () => {
  const f = fixture(); let closed = 0;
  const lease = f.host.api.mount(f.anchor, {onClose: () => closed++});
  f.panel.close(); f.flushClose(); lease.release();
  assert.equal(closed, 1); assert.equal(f.host.hosted, false);
  f.panel.show(); f.flushClose();
  assert.equal(f.panel.open, true); assert.equal(f.frame.parentElement, f.panel);
});

test('geometry follows explicit sync, observer, viewport, and ancestor scroll events', () => {
  const f = fixture(); const lease = f.host.api.mount(f.anchor);
  f.anchor.rect.left = 65; lease.sync(); assert.equal(f.panel.style.getPropertyValue('left'), '65px');
  f.anchor.rect.height = 610; f.resizes[0].fn(); f.flushFrames(); assert.equal(f.panel.style.getPropertyValue('height'), '610px');
  f.anchor.rect.top = 32; f.win.visualViewport.dispatchEvent(new Event('scroll')); f.flushFrames(); assert.equal(f.panel.style.getPropertyValue('top'), '32px');
  f.anchor.rect.left = 80; f.win.dispatchEvent(new Event('scroll')); f.flushFrames(); assert.equal(f.panel.style.getPropertyValue('left'), '80px');
});

test('a slot removed within a shadow root closes the phone and cleans observers', () => {
  const f = fixture(); let closed = 0;
  const shadow = {host: f.makeElement()}; f.anchor.root = shadow;
  f.host.api.mount(f.anchor, {onClose: () => closed++});
  assert.ok(f.mutations[0].nodes.includes(shadow));
  f.anchor.isConnected = false; f.mutations[0].fn(); f.flushFrames(); f.flushClose();
  assert.equal(closed, 1); assert.equal(f.panel.open, false); assert.equal(f.frames.size, 0);
});

test('hidden slots, removed panels and a disabled plugin close the lease', () => {
  for (const invalidate of [f => f.anchor.rect.height = 0, f => f.panel.isConnected = false, f => f.deactivate()]) {
    const f = fixture(); let closed = 0; const lease = f.host.api.mount(f.anchor, {onClose: () => closed++});
    invalidate(f); lease.sync(); f.flushClose(); assert.equal(closed, 1); assert.equal(f.host.hosted, false);
  }
});

test('plugin dispose notifies and makes retained API references unusable', () => {
  const f = fixture(); let closed = 0;
  f.host.api.mount(f.anchor, {onClose: () => closed++}); f.host.dispose(); f.host.dispose(); f.flushClose();
  assert.equal(closed, 1); assert.equal(f.panel.open, false);
  assert.throws(() => f.host.api.mount(f.anchor), /未启用/);
  assert.equal(f.panel.counts.get('close'), 0);
  assert.equal(f.frame.counts.get('load'), 0);
});

test('a throwing internal leave hook cannot interrupt external close notification or plugin disposal', () => {
  for (const end of [f => { f.panel.close(); f.flushClose(); }, f => f.host.dispose()]) {
    const f = fixture({visibilityHook: on => { if (!on) throw Error('internal app leave failed'); }});
    let closed = 0;
    f.host.api.mount(f.anchor, {onClose: () => closed++});
    assert.doesNotThrow(() => end(f));
    assert.equal(closed, 1); assert.equal(f.host.hosted, false); assert.equal(f.panel.open, false);
    assert.equal(f.panel.classList.contains('floating'), true);
    assert.ok(f.mutations.every(observer => observer.disconnected));
    assert.doesNotThrow(() => f.host.dispose());
    assert.equal(f.frame.counts.get('load'), 0);
  }
});

test('a phone loaded after quick release synchronizes hidden visibility and preserves its view', () => {
  const f = fixture(); f.host.api.mount(f.anchor).release(); f.flushClose();
  // Models the iframe installing stTtsPanelVisibility only after the Shell
  // already released it. Its load callback must report the actual closed panel.
  f.frame.dispatchEvent(new Event('load'));
  assert.deepEqual(f.visibilityModes.at(-1), {on: false, preserveView: true});
  assert.equal(f.panel.open, false); assert.equal(f.host.hosted, false);
  const lease = f.host.api.mount(f.anchor);
  f.frame.dispatchEvent(new Event('load'));
  assert.deepEqual(f.visibilityModes.at(-1), {on: true, preserveView: true});
  lease.release(); f.flushClose();
  // The same iframe can still finish/reload after an ordinary native reopen.
  f.panel.show(); f.frame.dispatchEvent(new Event('load'));
  assert.deepEqual(f.visibilityModes.at(-1), {on: true, preserveView: true});
  f.host.dispose(); const events = f.visibility.length;
  f.frame.dispatchEvent(new Event('load'));
  assert.equal(f.visibility.length, events);
});

test('a failed dialog show restores presentation and reports a synchronous mount error', () => {
  const f = fixture(); const style = f.panel.getAttribute('style');
  f.panel.show = () => { throw Error('cannot show'); };
  assert.throws(() => f.host.api.mount(f.anchor), /cannot show/);
  assert.equal(f.panel.getAttribute('style'), style); assert.equal(f.host.hosted, false);
});

test('reentrant mount or a throwing onClose cannot prevent releasing the old owner', () => {
  const f = fixture(); let reentrant = false;
  f.host.api.mount(f.anchor, {onClose: () => { assert.throws(() => f.host.api.mount(f.anchor), /正在交接/); reentrant = true; throw Error('owner failed'); }});
  const lease = f.host.api.mount(f.anchor); f.flushClose();
  assert.equal(reentrant, true); assert.equal(f.host.hosted, true); assert.equal(f.panel.open, true);
  lease.release();
});
