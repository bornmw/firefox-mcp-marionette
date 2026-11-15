// marionette.test.mjs — Marionette client against the fake wire-protocol server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Marionette } from '../src/marionette.mjs';
import { startFakeMarionette } from './helpers/fake_marionette.mjs';

async function withClient(fn) {
  const fake = await startFakeMarionette();
  const m = new Marionette({ port: fake.port, helloWaitMs: 50, log: () => {} });
  try {
    await fn(m, fake);
  } finally {
    if (m.sock && !m.sock.destroyed) m.sock.destroy();
    await fake.stop();
  }
}

test('connect + hello + NewSession (strict capability accepted)', async () => {
  await withClient(async (m, fake) => {
    await m.connect();
    await m.init();
    assert.equal(m.sessionId, 'fake-sess-1');
    assert.equal(m.hello.marionetteProtocol, 3);
    const sess = fake.state.frames.find((f) => f[2] === 'WebDriver:NewSession');
    assert.deepEqual(sess[3], { strictFileInteractability: true });
  });
});

test('cmd round-trip: GetTitle', async () => {
  await withClient(async (m) => {
    await m.connect();
    const title = await m.cmd('WebDriver:GetTitle');
    assert.equal(title.value, 'Fake Page');
  });
});

test('cmd auto-opens session on first use', async () => {
  await withClient(async (m) => {
    const title = await m.cmd('WebDriver:GetTitle'); // no explicit connect/init
    assert.equal(title.value, 'Fake Page');
    assert.ok(m.sessionId);
  });
});

test('non-ascii command text stays framing-safe (regression: length desync)', async () => {
  await withClient(async (m, fake) => {
    await m.connect();
    const text = 'café \ue000BASE64\ue001Ω';
    await m.cmd('WebDriver:ElementSendKeys', { id: 'el-x', text });
    assert.deepEqual(fake.state.violations, [], 'fake server must see no framing violations');
    const f = fake.state.frames.find((x) => x[2] === 'WebDriver:ElementSendKeys');
    assert.equal(f[3].text, text, 'payload must round-trip exactly after ascii-escape/JSON');
  });
});

test('protocol error rejects with message', async () => {
  await withClient(async (m) => {
    await m.connect();
    await m.init();
    await assert.rejects(m.cmd('WebDriver:BoomError'), /something failed/);
  });
});

test('socket loss rejects in-flight command', async () => {
  const fake = await startFakeMarionette();
  const m = new Marionette({ port: fake.port, helloWaitMs: 50, log: () => {} });
  try {
    await m.connect();
    await m.init();
    const inflight = m.cmd('WebDriver:GetTitle');
    fake.closeAll(); // destroy sockets synchronously before any response can be delivered
    await assert.rejects(inflight, /connection lost/);
  } finally {
    if (m.sock && !m.sock.destroyed) m.sock.destroy();
    await fake.stop();
  }
});

test('command timeout: a never-answered command rejects, poisons, then auto-reconnects', async () => {
  const fake = await startFakeMarionette();
  const m = new Marionette({ port: fake.port, helloWaitMs: 50, commandTimeoutMs: 300, log: () => {} });
  try {
    await m.connect();
    await m.init();
    assert.ok(m.sessionId, 'started with a live session');
    fake.state.hang = true; // the "browser" now never answers
    const t0 = Date.now();
    await assert.rejects(m.send('WebDriver:GetTitle'), /command timeout/);
    assert.ok(Date.now() - t0 >= 250, 'timeout should fire near commandTimeoutMs');
    assert.ok(!m.sock || m.sock.destroyed, 'socket destroyed after timeout');
    assert.equal(m.sessionId, null, 'session cleared after timeout');
    fake.state.hang = false;
    const title = await m.cmd('WebDriver:GetTitle'); // auto-reconnects fresh
    assert.equal(title.value, 'Fake Page');
    assert.ok(m.sessionId, 'reconnected with a fresh session');
  } finally {
    if (m.sock && !m.sock.destroyed) m.sock.destroy();
    await fake.stop();
  }
});

test('connect() to a closed port yields an actionable launch hint', async () => {
  // grab a definitely-free loopback port, then release it
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  await new Promise((r) => setTimeout(r, 50)); // let the listener fully free the port
  const m = new Marionette({ host: '127.0.0.1', port, helloWaitMs: 20, log: () => {} });
  await assert.rejects(m.connect(), (e) => {
    assert.match(e.message, /nothing is listening on 127\.0\.0\.1:/);
    assert.ok(e.message.includes('marionette.port=' + port), 'hint explains how to set the custom port: ' + e.message);
    return true;
  });
});

test('send() without a socket rejects cleanly', async () => {
  const m = new Marionette({ port: 1, log: () => {} });
  await assert.rejects(m.send('WebDriver:GetTitle'), /not connected/);
});

test('send(): privileged-scope failure navigates to about:blank and retries once', async () => {
  await withClient(async (m, fake) => {
    await m.connect();
    await m.init();
    fake.state.privilegedOnce = new Set(['WebDriver:GetTitle']);
    const title = await m.send('WebDriver:GetTitle');
    assert.equal(title.value, 'Fake Page', 'retried command must succeed');
    const navs = fake.state.frames.filter((f) => f[2] === 'WebDriver:Navigate');
    assert.equal(navs.length, 1, 'exactly one recovery navigation');
    assert.deepEqual(navs[0][3], { url: 'about:blank' });
    const titles = fake.state.frames.filter((f) => f[2] === 'WebDriver:GetTitle');
    assert.equal(titles.length, 2, 'original attempt + one retry');
  });
});

test('send(): persistent privileged-scope failure is not retried forever', async () => {
  await withClient(async (m, fake) => {
    await m.connect();
    await m.init();
    fake.state.privilegedAlways = true;
    await assert.rejects(m.send('WebDriver:GetTitle'), /privileged scope/);
    const navs = fake.state.frames.filter((f) => f[2] === 'WebDriver:Navigate');
    assert.equal(navs.length, 1, 'single recovery navigation, then the error propagates');
    const titles = fake.state.frames.filter((f) => f[2] === 'WebDriver:GetTitle');
    assert.equal(titles.length, 2, 'no retry loop');
  });
});

test('send(): NewSession privileged-scope error is not recovered (no session to navigate)', async () => {
  await withClient(async (m, fake) => {
    await m.connect();
    fake.state.newSessionScopeErrorOnce = true;
    await assert.rejects(m.send('WebDriver:NewSession', {}), /privileged scope/);
    assert.equal(fake.state.frames.filter((f) => f[2] === 'WebDriver:Navigate').length, 0, 'no navigation before a session exists');
  });
});

test('send(): non-privileged errors are rethrown unchanged (no recovery)', async () => {
  await withClient(async (m, fake) => {
    await m.connect();
    await m.init();
    await assert.rejects(m.send('WebDriver:BoomError'), /something failed/);
    assert.equal(fake.state.frames.filter((f) => f[2] === 'WebDriver:Navigate').length, 0, 'unrelated errors must not trigger navigation');
  });
});

test('init(): non-web initial tab is redirected to about:blank (default initialPage)', async () => {
  await withClient(async (m, fake) => {
    fake.state.currentUrl = 'about:home';
    await m.connect();
    await m.init();
    const nav = fake.state.frames.find((f) => f[2] === 'WebDriver:Navigate');
    assert.ok(nav, 'normalization navigation issued');
    assert.deepEqual(nav[3], { url: 'about:blank' });
  });
});

test('init(): web initial tab is left untouched', async () => {
  await withClient(async (m, fake) => {
    fake.state.currentUrl = 'https://fake.test/';
    await m.connect();
    await m.init();
    assert.equal(fake.state.frames.find((f) => f[2] === 'WebDriver:Navigate'), undefined, 'no navigation for a web initial tab');
  });
});

test('init(): initialPage=newtab never redirects', async () => {
  await withClient(async (m, fake) => {
    m.initialPage = 'newtab';
    fake.state.currentUrl = 'about:home';
    await m.connect();
    await m.init();
    assert.equal(fake.state.frames.find((f) => f[2] === 'WebDriver:Navigate'), undefined, 'opt-out leaves the initial tab untouched');
  });
});
