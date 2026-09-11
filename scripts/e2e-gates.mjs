#!/usr/bin/env node
// e2e-gates.mjs — live checks for v0.4.0 behaviors against a real Marionette
// browser (any `firefox --marionette`): material-style hidden inputs,
// fx_click obscuring overlay retry, fx_answer label fallback + wrapper
// delegation, fx_gates consent/attestation audit.
// Usage: node scripts/e2e-gates.mjs [port]   (default 2829)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || process.env.FX_MARIONETTE_PORT || 2829);
const TEST_HTML = '/tmp/firefox-mcp-marionette/e2e_gates.html';

fs.mkdirSync(path.dirname(TEST_HTML), { recursive: true });
fs.writeFileSync(TEST_HTML, `<!doctype html>
<html><head><meta charset="utf-8"><title>Gates E2E</title>
<style>
 body { font: 14px/1.4 system-ui; margin: 24px; }
 .q { margin: 28px 0; border-top: 1px solid #ddd; padding-top: 16px; }
 .row { position: relative; display: flex; align-items: center; gap: 10px; height: 34px; cursor: pointer; padding: 0 4px; }
 .row .box { width: 18px; height: 18px; border: 2px solid #9ca3af; border-radius: 4px; flex: 0 0 auto; }
 .row input { position: absolute; left: 4px; top: 8px; width: 14px; height: 14px; pointer-events: none; }
 .standalone { position: relative; display: inline-flex; align-items: center; gap: 10px; cursor: default; }
 .standalone .box { width: 18px; height: 18px; border: 2px solid #9ca3af; border-radius: 4px; }
 .standalone input { position: absolute; left: 2px; top: 7px; width: 14px; height: 14px; pointer-events: none; }
 #overlay label { position: relative; display: flex; align-items: center; gap: 10px; height: 34px; cursor: pointer; }
 #overlay input { position: absolute; left: 10px; top: 10px; width: 14px; height: 14px; pointer-events: none; }
 #overlay .box { position: absolute; left: 6px; top: 6px; width: 22px; height: 22px; border: 2px solid #6b7280; border-radius: 4px; }
 .consent { margin-top: 30px; padding: 16px; border: 1px solid #e5e7eb; border-radius: 8px; }
 .consent label { display: block; margin: 10px 0; }
 .snackbar { position: fixed; left: 16px; bottom: 16px; background: #312e2b; color: #eee; padding: 10px 14px; border-radius: 6px; }
</style>
</head>
<body>
<div class="q" id="fbq">
  <ul style="margin:0;padding:0">
    <li class="row" id="fbRow">
      <span><span><span><span><span><span><input type="checkbox" id="fb1"></span></span></span></span></span></span><span class="box"></span>
      Hard-fallback row: I choose not to disclose
    </li>
  </ul>
</div>
<div class="q" id="standalone">
  <p>Standalone control (input hidden under its own chrome)</p>
  <label class="standalone" style="display:inline-flex"><input type="checkbox" id="sa1"><span class="box"></span>Standalone row option</label>
</div>
<div class="q" id="overlay">
  <label>
    <input type="checkbox" id="ovCb"><span class="box"></span>
    Overlay-gated row (input hidden under its own chrome)
  </label>
</div>
<div class="consent" id="consent">
  <label><input type="checkbox" id="agreetos">I agree to the terms of service and privacy policy.</label>
  <label><input type="checkbox" id="certify">I hereby certify that, to the best of my knowledge, the provided information is true and accurate.</label>
  <label><input type="checkbox" id="attest" checked>I acknowledge the attestation of accuracy.</label>
  <label><input type="checkbox" id="news">Subscribe to our newsletter</label>
  <button id="applyBtn" disabled style="margin-top:14px;padding:8px 22px">Apply</button>
</div>
<div class="snackbar" id="banner">Consent is required in order to continue</div>
<script>
// Framework-style delegation on the li row (as in the real VSI component):
// the hidden input's state only changes when the row itself is really clicked.
window.__fb = false;
document.getElementById('fbRow').addEventListener('click', function (e) {
  if (e.target && e.target.id === 'fb1') return;
  var cb = document.getElementById('fb1');
  cb.checked = !cb.checked;
  window.__fb = cb.checked;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
});
</script>
</body></html>
`);

const child = spawn(process.execPath, [path.join(here, '..', 'src', 'server.mjs')], {
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
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (ok ? '' : '\n      ' + t.slice(0, 500)));
  if (!ok) fails++;
}

try {
  const list = await rpc('tools/list', {});
  const names = list.result.tools.map((t) => t.name);
  check('tools/list: 27 tools incl. fx_gates + fx_connect + read tools', { result: { content: [{ text: names.join(',') }] } }, (t) => ['fx_form', 'fx_field', 'fx_answer', 'fx_scroll', 'fx_gates', 'fx_connect', 'fx_links', 'fx_extract', 'fx_search'].every((n) => t.includes(n)) && t.split(',').length === 27);

  await call('fx_navigate', { url: 'file://' + TEST_HTML });
  await new Promise((r) => setTimeout(r, 700));

  check('fx_gates: consent/attestation audit', await call('fx_gates', {}), (t, e) => {
    if (e) return false;
    const o = JSON.parse(t);
    const unc = (o.uncheckedConsent || []).map((b) => b.text).join(' | ');
    const chk = (o.checkedConsent || []).map((b) => b.text).join(' | ');
    const other = (o.otherUnchecked || []).map((b) => b.text).join(' | ');
    const btns = (o.disabledButtons || []).map((b) => b.text).join('|');
    return unc.includes('terms of service') && unc.includes('hereby certify')
      && chk.includes('attestation of accuracy')
      && other.includes('newsletter') && !unc.includes('newsletter')
      && btns === 'Apply'
      && (o.banners || []).join('|').includes('Consent is required in order to continue');
  });

  check('fx_form: control rows resolve labels (closest label + row fallback)', await call('fx_form', {}), (t, e) => {
    if (e) return false;
    const o = JSON.parse(t);
    const lbl = (x) => (x.label || '');
    const sa = (o.fields || []).find((x) => x.type === 'checkbox' && lbl(x) === 'Standalone row option');
    const fb = (o.fields || []).find((x) => x.type === 'checkbox' && lbl(x) === 'fb1');
    // standalone resolves via closest-label; fb1 must stay UNREADABLE (deep span
    // nesting + li, not a label) -> falls back to its id.
    return !!(sa && fb) && fb.label === 'fb1';
  });

  const rb = (id) => call('fx_eval', { js: 'return String(document.getElementById("' + id + '").checked);' });
  const rbVal = (r) => { try { return JSON.parse(text(r)).r; } catch { return text(r); } };

  check('fx_answer: hidden input under own chrome -> overlay retry, state on', await call('fx_answer', { question: 'standalone', choice: 'Standalone row option' }), (t, e) => !e && t.includes('"ok": true') && t.includes('"state": "on"') && /overlay/.test(t) && !t.includes('"fallback": true'));
  check('fx_answer: standalone input actually toggled', await rb('sa1'), (t) => rbVal({ result: { content: [{ text: t }] } }) === 'true');

  check('fx_answer: unreadable option self-heals to wrapper (no-option fallback)', await call('fx_answer', { question: 'Hard-fallback row', choice: 'I choose not to disclose' }), (t, e) => !e && t.includes('"ok": true') && t.includes('"state": "on"') && t.includes('"fallback": true') && /fallback:(li|label)/.test(t));
  check('fx_answer: real click on the li row reached the hidden input (framework-registered)', await call('fx_eval', { js: 'return "dom=" + String(document.getElementById(\'fb1\').checked) + ",fw=" + String(window.__fb);' }), (t) => t.includes('dom=true') && t.includes('fw=true'));

  check('fx_field: label-resolved checkbox toggles off via overlay', await call('fx_field', { label: 'standalone row option', value: 'off' }), (t, e) => !e && t.includes('"ok": true'));
  check('fx_field: standalone input actually toggled off', await rb('sa1'), (t) => rbVal({ result: { content: [{ text: t }] } }) === 'false');

  check('fx_click: obscured hidden input -> overlay-top retry', await call('fx_click', { selector: '#ovCb' }), (t, e) => !e && t.includes('"ok": true') && /overlay-top:(widget|ancestor)/.test(t));
  check('fx_click retry actually toggled the hidden input', await rb('ovCb'), (t) => rbVal({ result: { content: [{ text: t }] } }) === 'true');

  check('fx_gates after interaction: still reports the unchecked gates', await call('fx_gates', {}), (t, e) => {
    if (e) return false;
    const o = JSON.parse(t);
    const unc = (o.uncheckedConsent || []).map((b) => b.text).join(' | ');
    return unc.includes('terms of service') && (o.disabledButtons || []).some((b) => b.text === 'Apply');
  });
} catch (e) {
  fails++;
  console.log('FAIL  harness exception:', e.message, '\n      server stderr tail:', childErr.split('\n').slice(-5).join(' | '));
}

child.stdin.end();
await new Promise((r) => setTimeout(r, 300));
if (child.exitCode === null) child.kill();
console.log(fails ? 'E2E-GATES FAIL (' + fails + '/' + done + ')' : 'E2E-GATES OK (' + done + ' checks)');
process.exit(fails ? 1 : 0);
