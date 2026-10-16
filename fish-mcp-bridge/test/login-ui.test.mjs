import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the shipped UI without a browser, network, external protocol handler, or real credentials.
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const BRIDGE_KEY = 'fixture-bridge-key-only';
const authorizationURL = host => {
  const u = new URL('https://' + host + '/oauth/authorize');
  for (const [name, value] of Object.entries({response_type: 'code', client_id: 'fixture-client',
    redirect_uri: 'http://127.0.0.1:3789/oauth/callback', state: 'fixture-state-not-a-real-login',
    code_challenge: 'fixture-challenge-not-a-real-verifier', code_challenge_method: 'S256',
    resource: 'https://api.fish.audio/mcp', scope: 'speech:read speech:generate'})) u.searchParams.set(name, value);
  return u.href;
};

function element(id) {
  const attributes = new Map(), listeners = new Map(), classes = new Set();
  const el = {id, value: '', textContent: '', disabled: false, hidden: id === 'edge-login',
    classList: {toggle(name, force) {if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name);}},
    addEventListener(type, listener) {listeners.set(type, listener);},
    setAttribute(name, value) {attributes.set(name, String(value));},
    getAttribute(name) {return attributes.get(name) ?? null;},
    removeAttribute(name) {attributes.delete(name);},
    hasAttribute(name) {return attributes.has(name);},
    async click() {assert.equal(this.disabled, false, id + ' must be enabled'); await listeners.get('click')?.({preventDefault() {}});}
  };
  Object.defineProperty(el, 'href', {get() {return attributes.get('href') ?? '';}, set(value) {attributes.set('href', String(value));}});
  return el;
}

async function harness() {
  const ids = ['key', 'endpoint', 'template', 'message', 'status', 'stats', 'config', 'refresh', 'login',
    'prepare-edge', 'edge-login', 'open-edge', 'logout', 'tools', 'catalog', 'detected', 'save',
    'copy', 'generate', 'text', 'voice', 'language', 'model', 'emotion', 'audio', 'audio-info'];
  const elements = new Map(ids.map(id => [id, element(id)]));
  const requests = [], navigations = [], replies = [], storage = new Map();
  const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
  const context = vm.createContext({URL, URLSearchParams, JSON,
    document: {getElementById: id => elements.get(id) ?? null, activeElement: null},
    location: {hash: '#key=' + BRIDGE_KEY, origin: 'http://127.0.0.1:38991', pathname: '/', assign: value => navigations.push(value)},
    history: {replaceState() {}},
    sessionStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)},
    navigator: {clipboard: {writeText() {assert.fail('Login must not write to the clipboard');}}},
    fetch: async (path, init) => {
      requests.push({path, init});
      if (path === '/admin/status') return json({authorized: false, connected: false, queued: 0, cached: 0, pendingJobs: 0, config: {}});
      if (path === '/admin/login') {
        const next = replies.shift();
        if (next instanceof Error) throw next;
        assert(next, 'Each mocked login needs a queued response');
        return next;
      }
      if (path === '/admin/logout') return json({clearedLocalAuthorization: true});
      assert.fail('Unexpected request; the UI test never accesses a network service');
    }
  });
  vm.runInContext(source, context, {filename: 'public/app.js'});
  // Let the initial mocked status request settle before testing a user action.
  await new Promise(resolve => setImmediate(resolve));
  return {el: id => elements.get(id), requests, navigations, replies, json};
}

for (const host of ['fish.audio', 'api.fish.audio']) {
  test('Edge login prepares the complete official ' + host + ' URL without navigating (LOCAL MOCK)', async () => {
    const h = await harness(), url = authorizationURL(host);
    assert.equal(h.el('edge-login').hidden, true);
    h.replies.push(h.json({url})); await h.el('prepare-edge').click();
    assert.equal(h.el('edge-login').hidden, false);
    assert.equal(h.el('open-edge').getAttribute('href'), 'microsoft-edge:' + new URL(url).href);
    assert.equal(h.el('open-edge').href.includes(BRIDGE_KEY), false);
    assert.deepEqual(h.navigations, [], 'Preparing an Edge link must never open or navigate a browser');
    const login = h.requests.filter(r => r.path === '/admin/login');
    assert.equal(login.length, 1); assert.equal(login[0].init.method, 'POST');
    assert.equal(login[0].init.headers.Authorization, 'Bearer ' + BRIDGE_KEY);
    assert.equal(login[0].init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(login[0].init.body), {});
  });
}

test('Repeated preparation preserves the same pending OAuth parameters (LOCAL MOCK)', async () => {
  const h = await harness(), url = authorizationURL('fish.audio');
  h.replies.push(h.json({url}), h.json({url}));
  await h.el('prepare-edge').click(); const first = h.el('open-edge').href;
  await h.el('prepare-edge').click();
  assert.equal(h.el('open-edge').href, first);
  const actual = new URL(first.slice('microsoft-edge:'.length)), expected = new URL(url);
  assert.deepEqual([...actual.searchParams], [...expected.searchParams]);
  assert.deepEqual(h.navigations, []);
});

for (const [name, url] of [
  ['plain HTTP', 'http://fish.audio/oauth/authorize'],
  ['a lookalike hostname', 'https://fish.audio.attacker.invalid/authorize'],
  ['a non-approved subdomain', 'https://login.fish.audio/authorize'],
  ['a hostname suffix', 'https://notfish.audio/authorize'],
  ['embedded username', 'https://user@fish.audio/authorize'],
  ['embedded password', 'https://user:password@fish.audio/authorize'],
  ['script scheme', 'javascript:alert(1)'],
  ['an invalid URL', 'not a URL']
]) {
  test('Edge login rejects ' + name + ' and removes the previous link (LOCAL MOCK)', async () => {
    const h = await harness();
    h.replies.push(h.json({url: authorizationURL('fish.audio')}), h.json({url}));
    await h.el('prepare-edge').click(); assert.equal(h.el('edge-login').hidden, false);
    await h.el('prepare-edge').click();
    assert.equal(h.el('edge-login').hidden, true);
    assert.equal(h.el('open-edge').getAttribute('href'), null);
    assert(h.el('message').textContent.length > 0);
    assert.deepEqual(h.navigations, []);
  });
}

for (const kind of ['network', 'HTTP']) {
  test('A failed ' + kind + ' preparation removes the previous Edge link (LOCAL MOCK)', async () => {
    const h = await harness();
    h.replies.push(h.json({url: authorizationURL('fish.audio')}), kind === 'network'
      ? new TypeError('Synthetic network failure') : h.json({error: {message: 'Synthetic login failure'}}, 502));
    await h.el('prepare-edge').click(); await h.el('prepare-edge').click();
    assert.equal(h.el('edge-login').hidden, true);
    assert.equal(h.el('open-edge').getAttribute('href'), null);
    assert.equal(h.el('prepare-edge').disabled, false);
    assert.deepEqual(h.navigations, []);
  });
}

test('Clearing local authorization also removes the prepared Edge link (LOCAL MOCK)', async () => {
  const h = await harness(); h.replies.push(h.json({url: authorizationURL('fish.audio')}));
  await h.el('prepare-edge').click(); await h.el('logout').click();
  assert.equal(h.el('edge-login').hidden, true);
  assert.equal(h.el('open-edge').getAttribute('href'), null);
  assert.equal(h.requests.filter(r => r.path === '/admin/logout').length, 1);
  assert.deepEqual(h.navigations, []);
});
