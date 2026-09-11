// bootstrap.test.mjs — first-trigger behavior:
//   * no reachable Firefox on the configured endpoint → fx_status reports the
//     state (no error) and the other tools return the 3-option decision payload
//   * a reachable Firefox on the configured endpoint → tools return the
//     browser-detected decision (attach via fx_connect / launch new / other);
//     nothing attaches until fx_connect commits the endpoint
//   * a held instance that drops the handshake → busy-other-client decision
//     (no raw errors)
//   * fx_launch starts a stand-in "firefox" whose listener port comes ONLY from
//     the profile user.js prefs (no launch flag exists), attaches to it, and
//     fx_shutdown stops exactly that pid
//   * FX_MCP_AUTO_LAUNCH=1 skips the question and boots the instance inline
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startFakeMarionette } from './helpers/fake_marionette.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'src', 'server.mjs');
const fakeFirefox = path.join(here, 'helpers', 'fake_firefox.mjs');

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

function startServer(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = [];
    const stderr = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      let out = d, nl;
      while ((nl = out.indexOf('\n')) >= 0) { lines.push(out.slice(0, nl).trim()); out = out.slice(nl + 1); }
    });
    child.stderr.on('data', (d) => stderr.push(String(d)));
    const rpc = (obj) => new Promise((r) => {
      const t0 = Date.now();
      const tick = () => {
        const i = lines.findIndex((L) => { try { return JSON.parse(L).id === obj.id; } catch { return false; } });
        if (i >= 0) { r(JSON.parse(lines.splice(i, 1)[0])); return; }
        if (Date.now() - t0 > 20000) { r(null); return; }
        setTimeout(tick, 25);
      };
      tick();
      child.stdin.write(JSON.stringify(obj) + '\n');
    });
    setTimeout(() => resolve({ child, rpc, stderr, lines }), 300);
  });
}

const toolText = (resp) => {
  assert.ok(resp, 'no response (timeout)');
  assert.ok(resp.result, 'no result');
  return resp.result.content[0].text;
};
const toolErr = (resp, re) => {
  const t = toolText(resp);
  assert.equal(resp.result.isError, true, 'expected isError: ' + t);
  assert.match(t, re);
  return t;
};
const stop = async (s) => {
  s.child.stdin.end();
  await new Promise((r) => setTimeout(r, 300));
  if (!s.child.killed) s.child.kill('SIGKILL');
};

test('no browser: fx_status reports the decision, tools return the 3-option payload, fx_shutdown refuses', async () => {
  const dead = await freePort();
  const s = await startServer({ FX_MARIONETTE_HOST: '127.0.0.1', FX_MARIONETTE_PORT: String(dead) });
  try {
    // fx_status: structured state, NOT an error
    const r0 = await s.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fx_status', arguments: {} } });
    assert.equal(r0.result.isError, false, 'fx_status is a status report: ' + JSON.stringify(r0));
    const st = JSON.parse(toolText(r0));
    assert.equal(st.connected, false);
    assert.equal(st.probe, 'nothing-listening');
    assert.equal(st.endpoint.port, dead);
    assert.ok(st.bootstrap && st.bootstrap.question, 'question present');
    assert.equal(st.bootstrap.options.length, 3);
    assert.deepEqual(st.bootstrap.options.map((o) => o.tool), ['fx_launch', 'fx_connect', null]);
    assert.match(st.bootstrap.options[0].do, /user\.js/);
    assert.ok(st.bootstrap.instruction, 'decision payload carries the relay-to-user instruction');
    assert.equal(st.launched.length, 0);

    // a real browser tool: isError + need_bootstrap with the same options
    const r1 = await s.rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fx_page', arguments: {} } });
    assert.equal(r1.result.isError, true);
    const p = JSON.parse(toolText(r1));
    assert.equal(p.need_bootstrap, true);
    assert.equal(p.ok, false);
    assert.equal(p.endpoint.port, dead);
    assert.equal(p.options.length, 3);
    assert.ok(p.instruction, 'decision payload carries the relay-to-user instruction');
    assert.match(toolErr(r1, /fx_launch/), /fx_connect/);

    // fx_shutdown: nothing launched yet → refuses
    const r2 = await s.rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fx_shutdown', arguments: {} } });
    assert.match(toolErr(r2, /no fx_launch-managed instance/), /stays yours|never touched|only browsers started/i);
  } finally {
    await stop(s);
  }
});

test('fx_launch writes the port into user.js prefs, starts the instance, attaches; fx_shutdown stops it', async () => {
  const dead = await freePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fxmcp-test-'));
  const s = await startServer({
    FX_MARIONETTE_HOST: '127.0.0.1',
    FX_MARIONETTE_PORT: String(dead),
    FX_MCP_FIREFOX_BIN: process.execPath + ' ' + fakeFirefox,
    FX_MCP_PROFILE_DIR: root,
  });
  let pid;
  try {
    // first trigger of a browser tool with AUTO_LAUNCH off → the question
    const rq = await s.rpc({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'fx_navigate', arguments: { url: 'about:blank' } } });
    assert.equal(rq.result.isError, true, 'asks before launching when auto-launch is off');
    assert.match(toolText(rq), /need_bootstrap/);

    // user picks option 1
    const r1 = await s.rpc({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'fx_launch', arguments: {} } });
    const l = JSON.parse(toolText(r1));
    assert.equal(r1.result.isError, false, 'fx_launch: ' + toolText(r1));
    assert.equal(l.started, 'new-instance');
    assert.ok(l.pid > 1, 'pid recorded');
    assert.ok(Number.isInteger(l.port) && l.port > 1, 'a new port was chosen');
    assert.notEqual(l.port, dead, 'new port differs from the configured one');
    pid = l.pid;

    // the port must exist in the profile PREFERENCES (the only channel to it)
    const userJs = fs.readFileSync(path.join(l.profile, 'user.js'), 'utf8');
    assert.match(userJs, /user_pref\("marionette\.enabled", true\)/);
    assert.match(userJs, new RegExp('user_pref\\("marionette\\.port", ' + l.port + '\\)'));
    assert.ok(fs.existsSync(path.join(l.profile, '.firefox-mcp-marionette-launched.json')), 'state file written');

    // now attached to the new endpoint; commands reach the fake browser
    const st = JSON.parse(toolText(await s.rpc({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'fx_status', arguments: {} } })));
    assert.equal(st.connected, true);
    assert.equal(st.endpoint.port, l.port);
    assert.equal(st.launchedCurrent, true);
    const pg = JSON.parse(toolText(await s.rpc({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'fx_page', arguments: {} } })));
    assert.match(pg.url, /fake\.test/);

    // re-launching the same port reuses the recorded instance (no second pid)
    const r2 = await s.rpc({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'fx_launch', arguments: { port: l.port } } });
    const l2 = JSON.parse(toolText(r2));
    assert.equal(l2.started, 'reused-launched');
    assert.equal(l2.pid, pid);

    // stop exactly the launched pid
    const r3 = await s.rpc({ jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'fx_shutdown', arguments: { port: l.port } } });
    const sd = JSON.parse(toolText(r3));
    assert.equal(sd.stopped, true);
    assert.equal(sd.pid, pid);
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 200)); } catch { alive = false; }
    }
    assert.equal(alive, false, 'launched process is dead after fx_shutdown');

    // second shutdown: stale record cleared, no error
    const r4 = await s.rpc({ jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'fx_shutdown', arguments: { port: l.port } } });
    assert.match(JSON.parse(toolText(r4)).note, /already gone/);
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    await stop(s);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FX_MCP_AUTO_LAUNCH skips the question and runs the call against the new instance', async () => {
  const dead = await freePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fxmcp-test-'));
  const s = await startServer({
    FX_MARIONETTE_HOST: '127.0.0.1',
    FX_MARIONETTE_PORT: String(dead),
    FX_MCP_AUTO_LAUNCH: '1',
    FX_MCP_FIREFOX_BIN: process.execPath + ' ' + fakeFirefox,
    FX_MCP_PROFILE_DIR: root,
  });
  let pid;
  try {
    const r1 = await s.rpc({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'fx_page', arguments: {} } });
    assert.equal(r1.result.isError, false, 'auto-launch: the call succeeds: ' + toolText(r1));
    const o = JSON.parse(toolText(r1));
    assert.ok(o.auto_started && o.auto_started.port > 1, 'auto_started reported');
    assert.match(o.url, /fake\.test/);
    pid = o.auto_started.pid;
    const userJs = fs.readFileSync(path.join(o.auto_started.profile, 'user.js'), 'utf8');
    assert.match(userJs, new RegExp('user_pref\\("marionette\\.port", ' + o.auto_started.port + '\\)'));
    const r2 = await s.rpc({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'fx_shutdown', arguments: { port: o.auto_started.port } } });
    assert.equal(JSON.parse(toolText(r2)).stopped, true);
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    await stop(s);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('running browser detected: nothing auto-attaches; fx_connect commits, then calls run', async () => {
  const fake = await startFakeMarionette(0);
  const s = await startServer({
    FX_MARIONETTE_HOST: '127.0.0.1',
    FX_MARIONETTE_PORT: String(fake.port),
  });
  try {
    // fx_status only probes: detects the live browser without opening a session
    const r0 = await s.rpc({ jsonrpc: '2.0', id: 50, method: 'tools/call', params: { name: 'fx_status', arguments: {} } });
    assert.equal(r0.result.isError, false, 'fx_status is a status report: ' + toolText(r0));
    const st = JSON.parse(toolText(r0));
    assert.equal(st.connected, false, 'probe must not open a session');
    assert.equal(st.probe, 'browser-detected');
    assert.equal(st.detected.port, fake.port);
    assert.deepEqual(st.bootstrap.options.map((o) => o.tool), ['fx_connect', 'fx_launch', null]);

    // a regular browser tool must ask, not attach on its own
    const r1 = await s.rpc({ jsonrpc: '2.0', id: 51, method: 'tools/call', params: { name: 'fx_page', arguments: {} } });
    assert.equal(r1.result.isError, true, 'asks instead of attaching: ' + toolText(r1));
    const p = JSON.parse(toolText(r1));
    assert.equal(p.need_bootstrap, true);
    assert.equal(p.probe, 'browser-detected');
    assert.equal(p.detected.port, fake.port);
    assert.ok(p.question, 'question present');
    assert.ok(p.instruction, 'decision payload carries the relay-to-user instruction');
    assert.ok(!fake.state.frames.some((f) => f && f[2] === 'WebDriver:NewSession'), 'no session opened without approval');

    // user picks "attach to the detected browser" → endpoint committed
    const r2 = await s.rpc({ jsonrpc: '2.0', id: 52, method: 'tools/call', params: { name: 'fx_connect', arguments: {} } });
    assert.equal(r2.result.isError, false, 'fx_connect: ' + toolText(r2));
    const c = JSON.parse(toolText(r2));
    assert.equal(c.ok, true);
    assert.equal(c.session, 'fake-sess-1');

    // committed: the same call now runs without another question
    const r3 = await s.rpc({ jsonrpc: '2.0', id: 53, method: 'tools/call', params: { name: 'fx_page', arguments: {} } });
    assert.equal(r3.result.isError, false, toolText(r3));
    assert.match(toolText(r3), /fake\.test/);
    const st2 = JSON.parse(toolText(await s.rpc({ jsonrpc: '2.0', id: 54, method: 'tools/call', params: { name: 'fx_status', arguments: {} } })));
    assert.equal(st2.connected, true);
    assert.equal(st2.session, 'fake-sess-1');
  } finally {
    fake.closeAll();
    await fake.stop();
    await stop(s);
  }
});

test('browser held by another client (handshake dropped) → busy-other-client decision, not a raw error', async () => {
  // Stand-in for a Marionette instance already held by another client:
  // accepts the TCP connection, then closes it without sending the hello.
  const busySocks = new Set();
  const busy = net.createServer((sock) => {
    busySocks.add(sock);
    sock.on('close', () => busySocks.delete(sock));
    setTimeout(() => { try { sock.end(); } catch { /* gone */ } }, 50);
  });
  await new Promise((r) => busy.listen(0, '127.0.0.1', r));
  const s = await startServer({
    FX_MARIONETTE_HOST: '127.0.0.1',
    FX_MARIONETTE_PORT: String(busy.address().port),
  });
  try {
    const r = await s.rpc({ jsonrpc: '2.0', id: 60, method: 'tools/call', params: { name: 'fx_page', arguments: {} } });
    assert.equal(r.result.isError, true);
    const p = JSON.parse(toolText(r));
    assert.equal(p.need_bootstrap, true);
    assert.equal(p.probe, 'busy-other-client');
    assert.match(p.question, /another active client/i);
    assert.equal(p.options[1].tool, 'fx_connect');
    assert.ok(p.instruction, 'decision payload carries the relay-to-user instruction');

    // fx_status reports the same state, still not an error
    const st = JSON.parse(toolText(await s.rpc({ jsonrpc: '2.0', id: 61, method: 'tools/call', params: { name: 'fx_status', arguments: {} } })));
    assert.equal(st.connected, false);
    assert.equal(st.probe, 'busy-other-client');
  } finally {
    for (const sock of [...busySocks]) { try { sock.destroy(); } catch { /* gone */ } }
    await new Promise((r) => busy.close(r));
    await stop(s);
  }
});
