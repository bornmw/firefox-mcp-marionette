#!/usr/bin/env node
// Live regression test for the generic form primitives (fx_form/fx_field/fx_answer/fx_scroll).
// Requires a user-launched `firefox --marionette` (default port 2828).
// NOTE: Marionette serves one active client at a time — if another firefox-mcp-marionette
// (e.g. a running opencode session) holds the browser socket, this test's connection
// will be refused. Run it when no other client is attached, or restart the browser first.
// Usage:
//   node scripts/e2e-forms.mjs [port]
// It navigates the active tab to an ephemeral test page, so expect the tab to be left on it.
import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || process.env.FX_MARIONETTE_PORT || 2828);
const TEST_HTML = path.join(os.tmpdir(), 'firefox-mcp-marionette-form-test-' + process.pid + '.html');

fs.writeFileSync(TEST_HTML, `<!doctype html>
<html><head><meta charset="utf-8"><title>MCP Form Test</title>
<style>
body{font:14px/1.5 sans-serif;margin:0}
#nav{position:fixed;top:0;left:0;right:0;height:56px;background:#f3f4f6;border-bottom:1px solid #ddd;padding:12px 20px;z-index:9}
.wrap{max-width:640px;margin:80px auto 60px;padding:0 20px}
.q{margin:28px 0;padding:14px;border:1px solid #e5e7eb;border-radius:8px}
.q p{font-weight:600;margin:0 0 10px}
label{display:block;margin:8px 0}
button{margin-right:8px;padding:6px 18px;border:1px solid #9ca3af;border-radius:6px;background:#e5e7eb;cursor:pointer}
button[aria-pressed="true"]{background:#059669;color:#fff;border-color:#059669}
textarea,input,select{padding:6px 8px;border:1px solid #9ca3af;border-radius:6px;width:300px}
#submitbtn{margin-top:30px;padding:10px 24px;background:#059669;color:#fff;border:none;border-radius:6px}
</style></head>
<body>
<div id="nav">FAKE FIXED NAV — covers content until scrolled</div>
<div class="wrap">
<h1>Test Form</h1>
<p>Filler block number one, here to push the total page text beyond the context cap so that the page wrapper is never mistaken for a question container. More words so that it definitely exceeds the limit.</p>
<p>Filler block number two, continuing the padding strategy with additional neutral sentences that carry no form meaning whatsoever and exist only to inflate the surrounding text volume.</p>
<section>
<h2>Personal</h2>
<label>Full Name<input id="name" type="text" placeholder="your name"></label>
<label>Work Email<input id="email" type="email" placeholder="a@b.c"></label>
<label>Password<input id="pw" type="password"></label>
 <label>Role<select id="role">
 <option value="j1">Junior</option><option value="s1">Senior</option><option value="st1">Staff</option>
 </select></label>
 <label>Digit id probe<input id="0123abc-def" type="text" placeholder="digit-leading id"></label>
 <label>Notes<textarea id="notes" rows="2"></textarea></label>
</section>
 <div class="q" id="q-mgr">
 <p>Are you a manager team lead?</p>
 <button type="button" aria-pressed="false" data-g="mgr" onclick="grpPick(this,'mgr')">Yes</button>
 <button type="button" aria-pressed="false" data-g="mgr" onclick="grpPick(this,'mgr')">No</button>
 </div>
 <div class="q" id="q-ver">
 <p>Which platform version is in production?</p>
 <label><input type="radio" name="ver" data-reg="ver" id="v1">Stable</label>
 <label><input type="radio" name="ver" data-reg="ver" id="v2">Current</label>
 <label><input type="radio" name="ver" data-reg="ver" id="v3">Nightly</label>
 </div>
<div class="q" id="q-city">
<p>In which cities do you plan to live?</p>
<label><input type="checkbox" name="city" id="c-denver">Denver</label>
<label><input type="checkbox" name="city" id="c-nyc">New York City</label>
<label><input type="checkbox" name="city" id="c-austin">Austin</label>
</div>
<div class="q" id="q-cm">
<p>Preferred contact method?</p>
<label><input type="radio" name="cm" id="r-email">Email</label>
<label><input type="radio" name="cm" id="r-phone">Phone</label>
</div>
<section>
<h2>Documents</h2>
<label>CV<input type="file" id="cv"></label>
</section>
<div style="height:2000px"></div>
<button id="submitbtn" type="button">Submit Test</button>
</div>
 <script>
function grpPick(btn, g){
  document.querySelectorAll('button[data-g="'+g+'"]').forEach(function(b){ b.setAttribute('aria-pressed','false'); });
  btn.setAttribute('aria-pressed','true');
}
// Framework state that only registers on a REAL change event (like Ashby's
// form state: DOM checked !== form state when set programmatically).
window.__reg = {};
document.querySelectorAll('input[data-reg]').forEach(function(inp){
  inp.addEventListener('change', function(){
    window.__reg[inp.dataset.reg] = inp.checked ? (inp.closest('label').textContent || '').trim() : '';
  });
});
document.getElementById('v2').checked = true; // stale direct DOM set: __reg.ver stays unset
</script>
</body></html>`);

const child = child_process.spawn(process.execPath, [path.join(here, '..', 'src', 'server.mjs')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, FX_MARIONETTE_PORT: String(port) },
});
let childErr = '';
child.stderr.on('data', (d) => { childErr += d; });
let idc = 0;
const pending = new Map();
child.stdout.on('data', (d) => {
  let buf = String(d);
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.id != null && pending.has(o.id)) { pending.get(o.id)(o); pending.delete(o.id); }
  }
});
function rpc(method, params) {
  const id = ++idc;
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('timeout on ' + method)), 25000);
    pending.set(id, (o) => { clearTimeout(to); res(o); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const text = (r) => (r.result && r.result.content ? r.result.content.map((c) => c.text).join('\n') : JSON.stringify(r));
const call = (name, args) => rpc('tools/call', { name, arguments: args || {} });

let fails = 0;
let done = 0;
function check(label, r, expect) {
  const t = text(r);
  const isErr = !!(r.result && r.result.isError);
  const ok = expect(t, isErr);
  done++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (ok ? '' : '\n      ' + t.slice(0, 400)));
  if (!ok) fails++;
}

try {
  const list = await rpc('tools/list', {});
  const names = list.result.tools.map((t) => t.name);
  check('tools/list: 27 tools incl. 4 form primitives + fx_gates + fx_connect + read tools', { result: { content: [{ text: names.join(',') }] } }, (t) => ['fx_form', 'fx_field', 'fx_answer', 'fx_scroll', 'fx_gates', 'fx_connect', 'fx_links', 'fx_extract', 'fx_search'].every((n) => t.includes(n)) && t.split(',').length === 27);

  await call('fx_navigate', { url: 'file://' + TEST_HTML });
  await sleep(800);

  check('fx_form: labels, options, password mask, file field', await call('fx_form', {}), (t, e) => !e && t.includes('Full Name') && t.includes('Denver') && t.includes('Junior') && t.includes('CV') && t.includes('-pw-'));
  check('fx_field: text by index (real keystrokes)', await call('fx_field', { index: 1, value: 'Test User' }), (t) => t.includes('"confirmed": "Test User"'));
  check('fx_field: text by label', await call('fx_field', { label: 'Work Email', value: 'test@example.com' }), (t, e) => !e && t.includes('"confirmed": "test@example.com"'));
  check('fx_answer: button group (aria-pressed)', await call('fx_answer', { question: 'manager team lead', choice: 'Yes' }), (t) => t.includes('"ok": true') && t.includes('"state": "on"'));
  check('fx_answer: checkbox option', await call('fx_answer', { question: 'cities do you plan to live', choice: 'New York City' }), (t) => t.includes('"ok": true') && t.includes('"state": "on"'));
  check('fx_answer: radio option', await call('fx_answer', { question: 'contact method', choice: 'Phone' }), (t) => t.includes('"ok": true') && t.includes('"state": "on"'));
  check('fx_field: select by option value', await call('fx_field', { id: 'role', value: 's1' }), (t) => t.includes('"confirmed": "s1"'));
  check('fx_scroll: element under long page', await call('fx_scroll', { selector: '#submitbtn' }), (t) => t.includes('ok:'));
  check('neg: fx_answer unknown question', await call('fx_answer', { question: 'zzz-not-there', choice: 'Yes' }), (t, e) => e && t.includes('no-question'));
  check('neg: fx_field bogus index', await call('fx_field', { index: 999 }), (t, e) => e && t.includes('field index not found'));
  check('neg: fx_field file input -> fx_upload hint', await call('fx_field', { id: 'cv', value: 'x' }), (t, e) => e && t.includes('fx_upload'));
  check('fx_eval: awaits a Promise-returning body', await call('fx_eval', { js: 'return new Promise(function (r) { setTimeout(function () { r("settled-e2e"); }, 250); });' }), (t, e) => !e && t.includes('"awaited": true') && t.includes('settled-e2e'));
  check('fx_eval: errors when the Promise never settles', await call('fx_eval', { js: 'return new Promise(function () {});', wait_ms: 400 }), (t, e) => e && t.includes('did not settle within 400 ms'));
  check('fx_type: digit-leading #id auto-rewritten to [id="…"]', await call('fx_type', { selector: '#0123abc-def', text: 'digit-ok' }), (t, e) => !e && /"used": "\[id=\\"0123abc-def\\"\]/.test(t));
  check('fx_form: aggregated choice groups (context per group)', await call('fx_form', {}), (t, e) => {
    if (e) return false;
    const o = JSON.parse(t);
    const g = (o.groups || []).map((x) => x.ctx).join('|');
    return o.groups && o.groups.length >= 3 && g.includes('platform version') && g.includes('plan to live') && g.includes('contact method');
  });
  check('fx_answer: exclusive group, stale pre-selected radio -> toggle cycle ok', await call('fx_answer', { question: 'platform version', choice: 'Current' }), (t, e) => !e && t.includes('"ok": true') && t.includes('toggle'));
  check('fx_answer: toggle cycle registered the framework state (__reg)', await call('fx_eval', { js: 'return window.__reg && window.__reg.ver;' }), (t) => t.includes('Current'));
  check('fx_snapshot: label captured as lbl=', await call('fx_snapshot', {}), (t) => t.includes('lbl="Full Name"'));
  const shot = '/tmp/firefox-mcp-marionette/e2e_full.png';
  check('fx_screenshot: full-page PNG (IHDR height beyond viewport)', await call('fx_screenshot', { path: shot }), (t) => {
    try { const b = fs.readFileSync(shot); return b.length > 100 && b.readUInt32BE(16) > 0 && b.readUInt32BE(20) > 1500; } catch { return false; }
  });
  const rb = await call('fx_eval', { js: `return ['name='+document.getElementById('name').value,'email='+document.getElementById('email').value,'role='+document.getElementById('role').value,'nyc='+document.getElementById('c-nyc').checked,'phone='+document.getElementById('r-phone').checked,'mgrYes='+(document.querySelector('button[data-g="mgr"][aria-pressed="true"]')||{}).textContent,'digit='+document.getElementById('0123abc-def').value].join('|');` });
  check('readback: final state on page', rb, (t) => t.includes('name=Test User') && t.includes('email=test@example.com') && t.includes('role=s1') && t.includes('nyc=true') && t.includes('phone=true') && t.includes('mgrYes=Yes') && t.includes('digit=digit-ok'));
} catch (e) {
  fails++;
  console.log('FAIL  harness exception:', e.message, '\n      server stderr tail:', childErr.split('\n').slice(-5).join(' | '));
}

child.stdin.end();
await sleep(300);
if (child.exitCode === null) child.kill();
fs.rmSync(TEST_HTML, { force: true });
console.log(fails ? 'E2E-FORMS FAIL (' + fails + '/' + (done + 1) + ')' : 'E2E-FORMS OK (' + done + ' checks)');
process.exit(fails ? 1 : 0);
