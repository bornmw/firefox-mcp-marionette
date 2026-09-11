#!/usr/bin/env node
// e2e-shadow.mjs — live checks for v0.5.0 shadow-DOM (deep) behaviors against a
// real Marionette browser: deep snapshot refs, in-page shadow click/type,
// nested shadow boundaries, shadow form fields + choice groups, deep gates.
// A `firefox --marionette` instance must already listen on the port.
// Usage: node scripts/e2e-shadow.mjs [port]   (default 2829)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || process.env.FX_MARIONETTE_PORT || 2829);
const TEST_HTML = '/tmp/firefox-mcp-marionette/e2e_shadow.html';

fs.mkdirSync(path.dirname(TEST_HTML), { recursive: true });
fs.writeFileSync(TEST_HTML, `<!doctype html>
<html><head><meta charset="utf-8"><title>Shadow E2E</title>
<style>body{font:14px/1.4 system-ui;margin:24px} button{margin:6px 6px 6px 0;padding:6px 14px}</style>
</head>
<body>
<h1>Shadow E2E page</h1>
<button id="lightBtn">Light button</button>
<input id="ltxt" type="text" placeholder="light input" />
<shadow-modal id="modal"></shadow-modal>
<script>
window.__light = 0;
document.getElementById('lightBtn').addEventListener('click', function(){ window.__light++; });
class ShadowModal extends HTMLElement {
  constructor(){
    super();
    var sr = this.attachShadow({ mode: 'open' });
    sr.innerHTML =
      '<div id="cwrap"><button id="scounter">Clicked: <span id="sn">0</span></button></div>' +
      '<div id="wrap">' +
      '<div id="head">Shadow dialog: confirmation prompt</div>' +
      '<div id="q1"><span>Shadow question: Do you agree to the shadow terms?</span>' +
      '<div id="yn"><button class="yn">Yes</button><button class="yn">No</button></div>' +
      '<span id="ynstate">unanswered</span></div>' +
      '<div id="nf"><label>Name <input id="sname" type="text" placeholder="shadow name"></label></div>' +
      '<div id="nc"><label><input id="sagree" type="checkbox" /> I agree to the privacy notice.</label></div>' +
      '<nested-host id="nested"></nested-host>' +
      '<span id="appear"></span>' +
      '</div>';
    sr.querySelector('#scounter').addEventListener('click', function(){
      var n = sr.querySelector('#sn');
      n.textContent = String(+n.textContent + 1);
      if (+n.textContent >= 2) sr.querySelector('#appear').textContent = 'shadow-ok';
    });
    var picked = null;
    Array.prototype.forEach.call(sr.querySelectorAll('#yn .yn'), function(b){
      b.addEventListener('click', function(){
        picked = b.textContent;
        sr.querySelector('#ynstate').textContent = 'picked:' + b.textContent;
      });
    });
  }
}
var nestedHostCount = 0;
class NestedHost extends HTMLElement {
  connectedCallback(){
    if (nestedHostCount++) return;
    window.__nested = 0;
    var sr2 = this.attachShadow({ mode: 'open' });
    sr2.innerHTML = '<div><button id="nbtn">Deeply nested button</button></div>';
    sr2.querySelector('#nbtn').addEventListener('click', function(){ window.__nested = 1; });
  }
}
customElements.define('shadow-modal', ShadowModal);
customElements.define('nested-host', NestedHost);
</script>
</body>
</html>
`);

const child = spawn(process.execPath, [path.join(here, '..', 'src', 'server.mjs')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, FX_MARIONETTE_PORT: String(port) },
});
let childErr = '';
child.stderr.on('data', (d) => { childErr += d; });
let idc = 0;
const pending = new Map();
let stdBuf = '';
child.stdout.on('data', (d) => {
  // carry partial lines across chunks (a JSON-RPC line can split over pipe reads)
  stdBuf += String(d);
  let nl;
  while ((nl = stdBuf.indexOf('\n')) >= 0) {
    const line = stdBuf.slice(0, nl).trim();
    stdBuf = stdBuf.slice(nl + 1);
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.id != null && pending.has(o.id)) { pending.get(o.id)(o); pending.delete(o.id); }
  }
});
function rpc(method, params) {
  const id = ++idc;
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('timeout on ' + method + ' — server stderr: ' + childErr.slice(-800))), 30000);
    pending.set(id, (o) => { clearTimeout(to); res(o); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const text = (r) => (r.result && r.result.content ? r.result.content.map((c) => c.text).join('\n') : JSON.stringify(r));
const call = (name, args) => rpc('tools/call', { name, arguments: args || {} });

let fails = 0;
let done = 0;
async function check(label, r, expect) {
  const t = text(r);
  const isErr = !!(r.result && r.result.isError);
  let ok;
  try { ok = !!(await expect(t, isErr)); } catch (e) { ok = false; label += ' [expect crashed: ' + e.message + ']'; }
  done++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (ok ? '' : '\n      ' + t.slice(0, 600)));
  if (!ok) fails++;
}
const refOf = (snapText, marker) => {
  const m = snapText.split('\n').find((l) => l.includes(marker) && /^\d+\.\s\[/.test(l));
  if (!m) return null;
  return Number(m.slice(0, m.indexOf('.')));
};
const evalJs = (js) => call('fx_eval', { js }).then((r) => {
  const t = text(r);
  if (!t.startsWith('{')) return 'ERR:' + t.slice(0, 200);
  let o; try { o = JSON.parse(t); } catch { return 'ERR:' + t.slice(0, 200); }
  return o.r;
});

try {
  const list = await rpc('tools/list', {});
  const schema = (name) => list.result.tools.find((t) => t.name === name).inputSchema.properties;
  await check('tools/list: 27 tools; fx_snapshot/fx_form gained deep param', { result: { content: [{ text: '' }] } }, (t, e) => {
    if (e) return false;
    const names = list.result.tools.map((t) => t.name);
    return names.length === 27 && schema('fx_snapshot').deep && schema('fx_form').deep && schema('fx_click').ref;
  });

  await call('fx_navigate', { url: 'file://' + TEST_HTML });
  await new Promise((r) => setTimeout(r, 900));

  const snapLight = await call('fx_snapshot', { deep: false });
  await check('fx_snapshot: deep=false excludes shadow controls', { result: { content: [{ text: text(snapLight) }] } }, (t) => t.includes('Light button') && !t.includes('Clicked: 0') && !t.includes('SHADOW'));

  // NOTE: a fresh fx_snapshot REPLACES the ref table — take the deep snapshot LAST
  // and derive every ref from it (stale refs die with "unknown ref").
  const snap = await call('fx_snapshot', {});
  const st = text(snap);
  await check('fx_snapshot: deep (default) enumerates light + shadow + nested-shadow controls', { result: { content: [{ text: st }] } }, (t) =>
    t.includes('Light button') && t.includes('SHADOW') && t.includes('Clicked: 0') && t.includes('Deeply nested button') && t.includes('shadow name'));

  const rCount = refOf(st, 'Clicked: 0');
  await check('fx_snapshot: shadow counter button got a ref', { result: { content: [{ text: String(rCount) }] } }, (t, e) => !e && t !== 'null' && Number(t) > 0);

  await check('fx_click: shadow ref click fires the shadow handler in-page', { result: { content: [{ text: 'x' }] } }, async (t) => {
    const r = await call('fx_click', { ref: rCount });
    const v = await evalJs(`document.getElementById('modal').shadowRoot.querySelector('#sn').textContent`);
    return !!(r.result && !r.result.isError) && v === '1';
  });

  const rNested = refOf(st, 'Deeply nested button');
  await check('fx_click: NESTED shadow boundary (host inside shadow root) click works', { result: { content: [{ text: 'x' }] } }, async (t) => {
    const r = await call('fx_click', { ref: rNested });
    const v = await evalJs(`document.getElementById('modal').shadowRoot.querySelector('#nested').shadowRoot.querySelector('#nbtn').textContent + '/' + window.__nested`);
    return !!(r.result && !r.result.isError) && v === 'Deeply nested button/1';
  });

  await check('fx_click: shadow counter second click -> shadow-only text exists', { result: { content: [{ text: 'x' }] } }, async () => {
    await call('fx_click', { ref: rCount });
    const v = await evalJs(`document.getElementById('modal').shadowRoot.querySelector('#sn').textContent`);
    return v === '2';
  });

  await check('fx_wait: text hidden in shadow is found', await call('fx_wait', { text: 'shadow-ok', timeout_ms: 4000 }), (t) => {
    const o = JSON.parse(t);
    return o.ok === true;
  });

  const form = await call('fx_form', {});
  const fobj = JSON.parse(text(form));
  const shName = fobj.fields.find((f) => f.placeholder === 'shadow name' || (f.label || '').includes('Name') && f.sh);
  const shAgree = fobj.fields.find((f) => f.sh && (f.label || f.ctx || '').includes('agree to the privacy notice'));
  await check('fx_form: shadow fields enumerated (input + checkbox), flagged sh', { result: { content: [{ text: JSON.stringify(fobj) }] } }, () => {
    return !!(shName && shName.sh) && !!(shAgree && shAgree.sh && /checkbox/.test(shAgree.type || ''));
  });

  await check('fx_field: type into shadow input by label (native setter + events)', await call('fx_field', { label: 'Name', value: 'Oleg Mikheev' }), (t) => {
    const o = JSON.parse(t);
    return o.ok === true && o.confirmed === 'Oleg Mikheev' && o.via === 'shadow';
  });

  const gatesBefore = await call('fx_gates', {});
  await check('fx_gates: shadow consent checkbox surfaced and flagged', JSON.parse(text(gatesBefore)), () => {
    const o = JSON.parse(text(gatesBefore));
    const all = [...(o.uncheckedConsent || []), ...(o.checkedConsent || [])].map((b) => b.text).join('|');
    return all.includes('agree to the privacy notice');
  });

  await check('fx_field: shadow checkbox on -> off reaches wanted state', { result: { content: [{ text: 'x' }] } }, async () => {
    const a = JSON.parse(text(await call('fx_field', { label: 'I agree to the privacy notice', value: 'on' })));
    const b = JSON.parse(text(await call('fx_field', { label: 'I agree to the privacy notice', value: 'off' })));
    if (a.ok === true && a.state === 'on' && b.ok === true && b.state === 'off') return true;
    return false;
  });

  await check('fx_answer: shadow Yes/No group answered by question text (in-page click)', { result: { content: [{ text: 'x' }] } }, async () => {
    const r = JSON.parse(text(await call('fx_answer', { question: 'shadow terms', choice: 'Yes' })));
    const v = await evalJs(`document.getElementById('modal').shadowRoot.querySelector('#ynstate').textContent`);
    return r.ok === true && v === 'picked:Yes';
  });

  await check('fx_type: shadow input value set (clear-then-type)', { result: { content: [{ text: 'x' }] } }, async () => {
    const r = JSON.parse(text(await call('fx_type', { ref: refOf(st, 'ph="shadow name"') || refOf(st, 'shadow name'), text: 'Overwrite' })));
    const v = await evalJs(`document.getElementById('modal').shadowRoot.querySelector('#sname').value`);
    return r.ok === true && v === 'Overwrite';
  });

  await check('light regression: driver click + fx_type on light controls still work', { result: { content: [{ text: 'x' }] } }, async () => {
    const s2 = text(await call('fx_snapshot', {}));
    const rl = refOf(s2, 'Light button');
    const rc = await call('fx_click', { ref: rl });
    await call('fx_type', { selector: '#ltxt', text: 'hi' });
    const v1 = await evalJs(`window.__light`);
    const v2 = await evalJs(`document.getElementById('ltxt').value`);
    return !!(rc.result && !rc.result.isError) && v1 === 1 && v2 === 'hi';
  });

  if (fails) console.error('\nstderr tail:\n' + childErr.slice(-1000));
  console.log('\n' + (fails ? 'FAIL ' : 'PASS ') + (done - fails) + '/' + done);
  child.kill('SIGTERM');
  process.exit(fails ? 1 : 0);
} catch (e) {
  console.error('FATAL', e.message, '\nstderr tail:\n' + childErr.slice(-1000));
  child.kill('SIGTERM');
  process.exit(2);
}
