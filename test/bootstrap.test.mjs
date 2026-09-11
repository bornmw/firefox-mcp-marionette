// bootstrap.test.mjs — first-trigger bootstrap behavior:
//   * no reachable Firefox on the configured endpoint → fx_status reports the
//     state (no error) and the other tools return the 3-option decision payload
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
    assert.equal(st.launched.length, 0);

    // a real browser tool: isError + need_bootstrap with the same options
    const r1 = await s.rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fx_page', arguments: {} } });
    assert.equal(r1.result.isError, true);
    const p = JSON.parse(toolText(r1));
    assert.equal(p.need_bootstrap, true);
    assert.equal(p.ok, false);
    assert.equal(p.endpoint.port, dead);
    assert.equal(p.options.length, 3);
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
    assert.ok(fs.existsSync(path.join(l.profile, '.marionette-mcp-launched.json')), 'state file written');

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
