// server.test.mjs — integration: spawn the real MCP server (stdio) against a
// fake Marionette, exercise JSON-RPC plumbing + tools over the wire.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeMarionette } from './helpers/fake_marionette.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'src', 'server.mjs');

let fake;
let child;
const lines = [];
const stderr = [];

const rpc = (obj) => new Promise((resolve) => {
  const t0 = Date.now();
  const tick = () => {
    const i = lines.findIndex((L) => { try { return JSON.parse(L).id === obj.id; } catch { return false; } });
    if (i >= 0) { resolve(JSON.parse(lines.splice(i, 1)[0])); return; }
    if (Date.now() - t0 > 15000) { resolve(null); return; }
    setTimeout(tick, 25);
  };
  tick();
  child.stdin.write(JSON.stringify(obj) + '\n');
});

const toolText = (resp, tool) => {
  assert.ok(resp, 'no response (timeout)');
  assert.ok(resp.result, 'no result');
  assert.equal(resp.result.isError, false, 'tool failed: ' + JSON.stringify(resp.result) + ' | stderr: ' + stderr.slice(-6).join('\n'));
  return resp.result.content[0].text;
};
const toolErr = (resp, re) => {
  assert.ok(resp, 'no response (timeout)');
  assert.equal(resp.result.isError, true, 'expected isError: ' + JSON.stringify(resp.result));
  assert.match(resp.result.content[0].text, re);
  return resp.result.content[0].text;
};

before(async () => {
  fake = await startFakeMarionette();
  child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      FX_MARIONETTE_HOST: '127.0.0.1',
      FX_MARIONETTE_PORT: String(fake.port),
      FX_MCP_FILE_ROOTS: '/tmp/firefox-mcp-marionette-test-roots',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
    let nl;
    while ((nl = out.indexOf('\n')) >= 0) { lines.push(out.slice(0, nl).trim()); out = out.slice(nl + 1); }
  });
  child.stderr.on('data', (d) => stderr.push(String(d)));
  await new Promise((r) => setTimeout(r, 300)); // let the server boot
});

after(async () => {
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 300));
  if (!child.killed) child.kill('SIGKILL');
  await fake.stop();
});

test('initialize returns server identity and echoes protocol version', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  assert.ok(r, 'no response');
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.equal(r.result.serverInfo.name, 'firefox-mcp-marionette');
  assert.ok(r.version === undefined && r.result.serverInfo.version, 'version reported');
});

test('tools/list exposes the full tool table', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = r.result.tools.map((t) => t.name);
  assert.equal(names.length, 29, names.join(','));
  for (const n of ['fx_status', 'fx_launch', 'fx_shutdown', 'fx_connect', 'fx_navigate', 'fx_snapshot', 'fx_click', 'fx_type', 'fx_select', 'fx_toggle', 'fx_upload', 'fx_form', 'fx_field', 'fx_answer', 'fx_scroll', 'fx_gates', 'fx_links', 'fx_extract', 'fx_search', 'fx_eval', 'fx_wait', 'fx_screenshot', 'fx_cookies']) {
    assert.ok(names.includes(n), 'missing tool ' + n);
  }
  for (const t of r.result.tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false);
  }
  const fe = r.result.tools.find((t) => t.name === 'fx_eval');
  assert.equal(fe.inputSchema.properties.wait_ms.type, 'number', 'fx_eval.wait_ms (Promise await)');
  assert.match(fe.description, /awaited/);
  const fs = r.result.tools.find((t) => t.name === 'fx_screenshot');
  assert.match(fs.description, /full-page/i);
  const ff = r.result.tools.find((t) => t.name === 'fx_form');
  assert.match(ff.description, /groups/i, 'fx_form documents choice-group aggregation');
  const fa = r.result.tools.find((t) => t.name === 'fx_answer');
  assert.match(fa.description, /toggle cycle/);
  assert.match(fa.description, /self-heals/);
  const fg = r.result.tools.find((t) => t.name === 'fx_gates');
  assert.ok(fg, 'fx_gates tool present');
  assert.match(fg.description, /consent/i);
  assert.match(fg.description, /attestation/i);
  const fc = r.result.tools.find((t) => t.name === 'fx_click');
  assert.match(fc.description, /obscur/);
});

test('fresh session: a running browser is probed, and tools ask before attaching', async () => {
  // fx_status is probe-only while no endpoint is committed: it detects the live
  // fake (running on the configured port from `before`) without opening a session
  const r0 = await rpc({ jsonrpc: '2.0', id: 300, method: 'tools/call', params: { name: 'fx_status', arguments: {} } });
  const st = JSON.parse(toolText(r0));
  assert.equal(st.connected, false, 'probe must not open a session: ' + toolText(r0));
  assert.equal(st.probe, 'browser-detected');
  assert.equal(st.detected.port, fake.port);
  assert.deepEqual(st.bootstrap.options.map((o) => o.tool), ['fx_connect', 'fx_launch', null]);

  // a browser tool must NOT attach on its own — it returns the decision instead
  const r1 = await rpc({ jsonrpc: '2.0', id: 301, method: 'tools/call', params: { name: 'fx_navigate', arguments: { url: 'https://example.test/' } } });
  assert.equal(r1.result.isError, true, r1.result.content[0].text);
  const p = JSON.parse(r1.result.content[0].text);
  assert.equal(p.need_bootstrap, true);
  assert.equal(p.probe, 'browser-detected');
  assert.ok(p.instruction, 'decision payload carries the relay-to-user instruction');

  // user picks option 1 → fx_connect commits the endpoint; same call class runs from then on
  const r2 = await rpc({ jsonrpc: '2.0', id: 302, method: 'tools/call', params: { name: 'fx_connect', arguments: {} } });
  const c = JSON.parse(toolText(r2));
  assert.equal(c.ok, true, toolText(r2));
  assert.equal(c.session, 'fake-sess-1');
  assert.equal(c.endpoint.port, fake.port);
});

test('fx_status reaches the browser through the fake', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fx_status', arguments: {} } });
  const t = toolText(r);
  assert.match(t, /"connected": true/);
  assert.match(t, /fake-sess-1/);
  assert.match(t, /Fake Page/);
});

test('fx_navigate + fx_page', async () => {
  const r1 = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'fx_navigate', arguments: { url: 'https://example.test/' } } });
  assert.match(toolText(r1), /"ok": true/);
  const r2 = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'fx_page', arguments: {} } });
  const t = toolText(r2);
  assert.match(t, /https:\/\/fake\.test\//);
});

test('fx_snapshot renders numbered refs', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'fx_snapshot', arguments: {} } });
  const t = toolText(r);
  assert.match(t, /#Form\n1\. \[input:text #name ph="Full name"\]/, t);
  assert.ok(t.includes('#pw'), t);
  assert.ok(t.includes('"Go"'), t);
});

test('fx_click resolves refs through FindElement (W3C ref unwrap)', async () => {
  await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'fx_snapshot', arguments: {} } });
  const r = await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'fx_click', arguments: { ref: 3 } } });
  assert.match(toolText(r), /"ok": true/);
  const f = fake.state.frames.find((x) => x[2] === 'WebDriver:FindElement');
  assert.equal(f[3].using, 'xpath');
});

test('fx_click with CSS selector uses W3C "css selector" using-value', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 19, method: 'tools/call', params: { name: 'fx_click', arguments: { selector: '#searchFilter_salaryBucketV2' } } });
  assert.match(toolText(r), /"ok": true/);
  const f = [...fake.state.frames].reverse().find((x) => x[2] === 'WebDriver:FindElement');
  assert.equal(f[3].using, 'css selector', 'gecko rejects bare "css" as a using-value');
  assert.equal(f[3].value, '#searchFilter_salaryBucketV2');
});

test('fx_type sends clear+keys and stays framing-safe with unicode', async () => {
  await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'fx_snapshot', arguments: {} } });
  const text = 'Jürgen 🎯\ue000';
  const r = await rpc({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'fx_type', arguments: { ref: 1, text } } });
  assert.match(toolText(r), /"ok": true/);
  assert.deepEqual(fake.state.violations, [], 'unicode typing must not desync framing: ' + JSON.stringify(fake.state.violations));
  const keys = [...fake.state.frames].reverse().find((x) => x[2] === 'WebDriver:ElementSendKeys');
  assert.equal(keys[3].text, text);
});

test('fx_click rewrites a digit-leading #id selector to [id="…"]', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'fx_click', arguments: { selector: '#56d78818-a3c3-4010-ad4c-c03bf11a09bf' } } });
  const t = toolText(r);
  const f = [...fake.state.frames].reverse().find((x) => x[2] === 'WebDriver:FindElement');
  assert.equal(f[3].value, '[id="56d78818-a3c3-4010-ad4c-c03bf11a09bf"]', 'digit-leading id must reach the driver in attr form');
  assert.match(t, /"used": "\[id=/);
});

test('fx_click keeps a valid #id selector untouched', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'fx_click', arguments: { selector: '#searchFilter_salaryBucketV2' } } });
  toolText(r);
  const f = [...fake.state.frames].reverse().find((x) => x[2] === 'WebDriver:FindElement');
  assert.equal(f[3].value, '#searchFilter_salaryBucketV2');
});

test('fx_click rejects unsupported CSS (:has) with an actionable hint', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'fx_click', arguments: { selector: 'form button:has(> span)' } } });
  const t = toolErr(r, /CSS selector rejected/);
  assert.match(t, /:has\(\) is not supported/);
});

test('fx_eval awaits a Promise-returning body via the two-phase protocol', async () => {
  fake.state.mode = 'evalok';
  fake.state.pollCount = 0;
  const r = await rpc({ jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'fx_eval', arguments: { js: 'return (async () => { await new Promise((rr) => setTimeout(rr, 5)); return 42; })();' } } });
  const t = toolText(r);
  assert.match(t, /"r": 42/);
  assert.match(t, /"awaited": true/);
  const evals = fake.state.frames.filter((f) => f[2] === 'WebDriver:ExecuteScript');
  assert.ok(evals.some((f) => String(f[3].script).includes('__fxeval__')), 'wrapper frame sent');
  assert.ok(evals.some((f) => String(f[3].script).includes('__fxpoll__')), 'poll frame sent');
});

test('fx_eval errors with a clear message when the Promise never settles', async () => {
  fake.state.mode = 'evalhanging';
  fake.state.pollCount = 0;
  const r = await rpc({ jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'fx_eval', arguments: { js: 'return new Promise(() => {});', wait_ms: 400 } } });
  toolErr(r, /did not settle within 400 ms/);
});

test('fx_upload rejects paths outside allowed roots', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'fx_upload', arguments: { ref: 1, path: '/etc/passwd' } } });
  toolErr(r, /outside allowed roots/);
});

test('fx_upload accepts a path under the allowed root', async () => {
  const dir = '/tmp/firefox-mcp-marionette-test-roots';
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'upload.csv');
  fs.writeFileSync(file, 'a,b\n1,2\n');
  await rpc({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'fx_snapshot', arguments: {} } });
  const r = await rpc({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'fx_upload', arguments: { ref: 1, path: file } } });
  const t = toolText(r);
  assert.match(t, /"uploaded": "upload\.csv"/, t);
  fs.rmSync(file);
});

test('fx_screenshot writes a file under an allowed root', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'fx_screenshot', arguments: { path: '/tmp/firefox-mcp-marionette-test-roots/shot.png' } } });
  const t = toolText(r);
  assert.match(t, /shot\.png/);
  assert.ok(fs.existsSync('/tmp/firefox-mcp-marionette-test-roots/shot.png'));
});

test('fx_wait on visible text resolves quickly', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'fx_wait', arguments: { text: 'anything', timeout_ms: 3000 } } });
  assert.match(toolText(r), /"ok": true/);
});

test('fx_answer self-heals to a wrapper click when option labels are unreadable (no-option)', async () => {
  fake.state.answerFindSeq = [
    { error: 'no-option', options: [''], ctx: 'Black or African AmericanOrigins in any of the Black racial groups of Africa.' },
  ];
  fake.state.answerFallback = { marker: 'xpath:/html/body/li[3]', text: 'I choose not to disclose', tag: 'LI' };
  fake.state.answerReread = 'on';
  const r = await rpc({ jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'fx_answer', arguments: { question: 'Black or African American', choice: 'I choose not to disclose' } } });
  const t = toolText(r);
  assert.match(t, /"ok": true/);
  assert.match(t, /"fallback": true/);
  assert.match(t, /fallback:LI/);
  assert.match(t, /wrapper fallback/);
  const nBefore = fake.state.frames.filter((f) => f[2] === 'WebDriver:ElementClick').length;
  assert.ok(nBefore >= 1, 'fallback click went through the real driver');
});

test('fx_answer surfaces a fallback failure instead of a raw no-option error', async () => {
  fake.state.answerFindSeq = [{ error: 'no-option', options: [], ctx: 'some question' }];
  fake.state.answerFallback = { error: 'no-fallback-option' };
  const r = await rpc({ jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'fx_answer', arguments: { question: 'some question', choice: 'Nope' } } });
  const txt = toolErr(r, /no-option/);
  assert.match(txt, /no-fallback-option/);
});

test('fx_answer on a readable group still uses the primary path (no fallback)', async () => {
  fake.state.answerFindSeq = [
    { ctx: 'q', option: 'Yes', kind: 'input', marker: 'xpath:/html/body/input[9]', state: 'off', single: true, alts: [], options: ['Yes', 'No'] },
    { ctx: 'q', option: 'Yes', kind: 'input', marker: 'xpath:/html/body/input[9]', state: 'on', single: true, alts: [], options: ['Yes', 'No'] },
  ];
  const r = await rpc({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'fx_answer', arguments: { question: 'q', choice: 'Yes' } } });
  const t = toolText(r);
  assert.match(t, /"ok": true/);
  assert.doesNotMatch(t, /"fallback": true/);
  assert.match(t, /"via": "element"/);
});

test('fx_click retries on the obscuring topmost element of the same widget', async () => {
  fake.state.clickFailOnce = true;
  fake.state.clickTop = { mode: 'ancestor', marker: 'xpath:/html/body/div[1]' };
  const r = await rpc({ jsonrpc: '2.0', id: 43, method: 'tools/call', params: { name: 'fx_click', arguments: { selector: '#go' } } });
  const t = toolText(r);
  assert.match(t, /"ok": true/);
  assert.match(t, /overlay-top:ancestor/);
  const clicks = fake.state.frames.filter((f) => f[2] === 'WebDriver:ElementClick');
  assert.ok(clicks.length >= 2, 'original click + topmost retry');
});

test('fx_click reports a blocked topmost element with an actionable hint', async () => {
  fake.state.clickFailOnce = true;
  fake.state.clickTop = { mode: 'blocked', top: 'DIV.modal-backdrop' };
  const r = await rpc({ jsonrpc: '2.0', id: 44, method: 'tools/call', params: { name: 'fx_click', arguments: { selector: '#go' } } });
  const txt = toolErr(r, /topmost: DIV\.modal-backdrop/);
  assert.match(txt, /fx_scroll|fx_eval/);
});

test('fx_click rethrows non-obscuring click errors unchanged', async () => {
  fake.state.clickErrorOnce = 'Message: something else entirely';
  const r = await rpc({ jsonrpc: '2.0', id: 45, method: 'tools/call', params: { name: 'fx_click', arguments: { selector: '#go' } } });
  toolErr(r, /something else entirely/);
});

test('fx_gates reports consent checkboxes, disabled buttons, and banners', async () => {
  fake.state.gates = {
    boxes: [
      { i: 1, checked: false, req: 0, gate: 1, text: 'I hereby certify that, to the best of my knowledge, the provided information is true and accurate.', m: 'xpath:/html/body/input[1]' },
      { i: 2, checked: false, req: 0, gate: 0, text: 'Subscribe to newsletter', m: 'xpath:/html/body/input[2]' },
      { i: 3, checked: true, req: 0, gate: 1, text: 'I agree to the terms of service.', m: 'xpath:/html/body/input[3]' },
    ],
    disabledButtons: [{ text: 'Apply', m: 'xpath:/html/body/button[9]' }],
    banners: ['Attestation is required in order to continue'],
  };
  const r = await rpc({ jsonrpc: '2.0', id: 46, method: 'tools/call', params: { name: 'fx_gates', arguments: {} } });
  const t = toolText(r);
  assert.match(t, /"uncheckedConsent"/);
  assert.match(t, /hereby certify/i);
  assert.match(t, /"checkedConsent"/);
  assert.match(t, /terms of service/i);
  assert.match(t, /"otherUnchecked"/);
  assert.match(t, /newsletter/i);
  assert.match(t, /"disabledButtons"/);
  assert.match(t, /"text": "Apply"/);
  assert.match(t, /Attestation is required/);
});

test('unknown tool and unknown method produce isError results', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'fx_nope', arguments: {} } });
  toolErr(r, /unknown tool/);
  const r2 = await rpc({ jsonrpc: '2.0', id: 17, method: 'bogus/method' });
  toolErr(r2, /unsupported method/);
});

test('notifications produce no response line', async () => {
  const before = lines.length;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(lines.length, before);
});

test('fx_links lists anchors and rejects unsupported CSS', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 70, method: 'tools/call', params: { name: 'fx_links', arguments: {} } });
  const o = JSON.parse(toolText(r));
  assert.equal(o.count, 2);
  assert.ok(o.links.every((l) => typeof l.href === 'string' && l.href.startsWith('http')), 'absolute hrefs');
  const r2 = await rpc({ jsonrpc: '2.0', id: 71, method: 'tools/call', params: { name: 'fx_links', arguments: { selector: ':has(x)' } } });
  toolErr(r2, /CSS selector rejected/);
});

test('fx_extract returns structured rows (fields and text mode)', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 72, method: 'tools/call', params: { name: 'fx_extract', arguments: { selector: 'div.item', fields: { title: 'h3', blurb: 'text' } } } });
  const o = JSON.parse(toolText(r));
  assert.equal(o.count, 2);
  assert.equal(o.rows[0].title, 'Row one');
  assert.equal(o.rows[0].blurb, 'Body text one');
  const r2 = await rpc({ jsonrpc: '2.0', id: 73, method: 'tools/call', params: { name: 'fx_extract', arguments: {} } });
  const o2 = JSON.parse(toolText(r2));
  assert.ok(o2.rows.every((row) => typeof row.text === 'string'), 'no-fields mode returns text');
});

test('fx_search returns structured results; resolve follows links', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 74, method: 'tools/call', params: { name: 'fx_search', arguments: { query: 'robotics grants', max: 2 } } });
  const o = JSON.parse(toolText(r));
  assert.equal(o.engine, 'google');
  assert.ok(typeof o.url === 'string' && o.url.startsWith('http'), 'results page url reported');
  assert.equal(o.count, 2);
  assert.equal(o.results[0].title, 'Result one');
  assert.ok(o.results[0].link.startsWith('http'));
  assert.equal(o.results[0].resolvedUrl, undefined, 'no resolve without resolve:true');
  const r2 = await rpc({ jsonrpc: '2.0', id: 75, method: 'tools/call', params: { name: 'fx_search', arguments: { query: 'robotics grants', max: 2, resolve: true } } });
  const o2 = JSON.parse(toolText(r2));
  assert.equal(o2.results[0].resolvedUrl, 'https://fake.test/', 'resolve reports the final URL after following the redirect');
  assert.ok(o2.results[0].resolvedTitle, 'resolve reports the final page title');
});

test('fx_search rejects unknown engine and unsupported container CSS', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 76, method: 'tools/call', params: { name: 'fx_search', arguments: { query: 'x', engine: 'yahoo' } } });
  toolErr(r, /unknown engine/);
  const r2 = await rpc({ jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'fx_search', arguments: { query: 'x', container: ':has(a)' } } });
  toolErr(r2, /CSS selector rejected/);
});

test('fx_connect re-points the MCP at a different endpoint at runtime', async () => {
  const fake2 = await startFakeMarionette();
  try {
    const r = await rpc({ jsonrpc: '2.0', id: 60, method: 'tools/call', params: { name: 'fx_connect', arguments: { port: fake2.port } } });
    const o = JSON.parse(toolText(r));
    assert.equal(o.ok, true);
    assert.equal(o.endpoint.port, fake2.port, 'endpoint re-pointed to the new fake');
    assert.equal(o.configured.port, fake.port, 'configured endpoint is still the original');
    // a subsequent command must now run against the NEW endpoint
    const r2 = await rpc({ jsonrpc: '2.0', id: 61, method: 'tools/call', params: { name: 'fx_page', arguments: {} } });
    assert.equal(JSON.parse(toolText(r2)).url, 'https://fake.test/');
    // non-loopback host is rejected
    const r3 = await rpc({ jsonrpc: '2.0', id: 62, method: 'tools/call', params: { name: 'fx_connect', arguments: { host: '8.8.8.8' } } });
    toolErr(r3, /loopback/);
    // restore the original endpoint for any following tests
    const r4 = await rpc({ jsonrpc: '2.0', id: 63, method: 'tools/call', params: { name: 'fx_connect', arguments: { port: fake.port } } });
    assert.equal(JSON.parse(toolText(r4)).endpoint.port, fake.port);
  } finally {
    // If an earlier assertion aborted, the MCP server may still hold a socket to
    // fake2 (fx_connect re-pointed it) — server.close() would wait on it forever.
    // Destroy leftovers first (same pattern as the socket-loss test).
    fake2.closeAll();
    await fake2.stop();
  }
});

test('stdin EOF terminates the server cleanly', () =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const onExit = (code) => {
      clearTimer();
      if (Date.now() - t0 < 10000 && code === 0) resolve();
      else reject(new Error('exit code ' + code));
    };
    const timer = setTimeout(() => reject(new Error('server did not exit on stdin EOF')), 10000);
    const clearTimer = () => clearTimeout(timer);
    child.once('exit', onExit);
    child.stdin.end();
  }));
