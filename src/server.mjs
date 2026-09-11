#!/usr/bin/env node
// server.mjs — Model Context Protocol server (stdio) that drives a Firefox with
// Marionette (firefox --marionette, default port 2828) via its native wire
// protocol.
//
// ATTACH-FIRST: it connects to an instance that exists. When the first browser
// call of a session finds no reachable Firefox, the tool does not fail with a
// raw ECONNREFUSED — it returns a bootstrap decision (fx_launch a new dedicated
// instance / fx_connect to an existing one / the user's own direction) that the
// agent relays to the user.
//
// MCP transport: newline-delimited JSON-RPC 2.0 on stdin/stdout; stderr = logs.
// Zero runtime dependencies (Node >= 20).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { Marionette } from './marionette.mjs';
import { unwrapElementRef } from './protocol.mjs';
import { EVAL_WRAP, EVAL_POLL } from './evalwrap.mjs';

const HOST = process.env.FX_MARIONETTE_HOST || '127.0.0.1';
const PORT = Number(process.env.FX_MARIONETTE_PORT || 2828);
const FILE_ROOTS = (process.env.FX_MCP_FILE_ROOTS || '/tmp').split(',').map((s) => s.trim()).filter(Boolean);
// Bootstrap (first-trigger) launch settings. fx_launch/autolaunch create a DEDICATED
// profile and set the port via user.js PREFS — there is no --marionette-port CLI flag.
function defaultProfileRoot() { try { return path.join(os.homedir(), '.mozilla', 'firefox'); } catch { return '/tmp/marionette-mcp-profiles'; } }
const PROFILE_ROOT = process.env.FX_MCP_PROFILE_DIR || defaultProfileRoot();
const AUTO_LAUNCH = /^(1|true|yes)$/i.test(process.env.FX_MCP_AUTO_LAUNCH || '');
const FIREFOX_BIN = process.env.FX_MCP_FIREFOX_BIN || ''; // "cmd [args]" — e.g. a test stand-in

const log = (...a) => process.stderr.write(new Date().toISOString() + ' ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');

let VERSION = '0.0.0';
try {
  VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || VERSION;
} catch { /* dev checkouts without package.json */ }

const M = new Marionette({ host: HOST, port: PORT, commandTimeoutMs: Number(process.env.FX_MCP_CMD_TIMEOUT_MS || 120000), log });
let snapshotRefs = [];

// ---------------- element helpers ----------------
function resolveElRef(args) {
  const p = { ...(args || {}) };
  if (p.ref != null) {
    const ref = Number(p.ref);
    const entry = snapshotRefs[ref - 1];
    if (!entry) throw new Error('ref ' + ref + ' unknown — run fx_snapshot again');
    delete p.ref;
    if (String(entry.k || '').endsWith(':sh')) { p.shadow = entry.x; return p; } // sh:<path> marker
    p.using = p.using || 'xpath';
    p.value = entry.x;
  }
  if (!p.using || !p.value) {
    if (p.selector) { p.value = p.selector; p.using = p.using || 'css selector'; }
    else throw new Error('need ref (from fx_snapshot) or selector');
    delete p.selector;
  }
  return p;
}

async function findEl(using, value) {
  // accepts (using, value) or a single {using, value} ref object
  if (using && typeof using === 'object' && using.using) { value = using.value; using = using.using; }
  if (using === 'shadow') throw new Error('shadow-root element (sh marker) — the driver cannot target it; use fx_click/fx_type/fx_field/fx_answer, which handle it in-page');
  const r = await M.cmd('WebDriver:FindElement', { using, value });
  return unwrapElementRef(r.value);
}

// Marker usable inside page scripts: "#id" (css), "xpath:…", or "sh:<path>"
// (shadow-root element — resolvable in-page only, never by the driver).
function refMarker(a) {
  if (a.ref != null) {
    const e = snapshotRefs[Number(a.ref) - 1];
    if (!e) throw new Error('ref ' + a.ref + ' unknown — run fx_snapshot again');
    if (String(e.k || '').endsWith(':sh')) return e.x; // 'sh:<path>'
    return e.css ? e.css : 'xpath:' + e.x;
  }
  if (a.selector) {
    if (a.selector.startsWith('xpath:')) return a.selector;
    if (a.selector.startsWith('/')) return 'xpath:' + a.selector;
    return hardenCss(a.selector);
  }
  throw new Error('need ref (from fx_snapshot) or selector');
}

// Element-resolution snippet shared by the in-page interaction scripts (defined
// below only once DEEP_UTIL exists, so sh: markers resolve in-page too).

async function execJs(code, args) {
  const r = await M.cmd('WebDriver:ExecuteScript', { script: code, args: args || [] });
  return r.value;
}

// A CSS `#id` whose id is not a valid bare identifier (starts with a digit, e.g.
// Ashby's UUID ids) is rejected by querySelector; rewrite to the quoted attr form.
function hardenCss(sel) {
  if (typeof sel !== 'string') return sel;
  const m = sel.match(/^#([^{,\s]+)$/);
  if (m && /^-?\d/.test(m[1])) return '[id="' + m[1].replace(/"/g, '\\"') + '"]';
  return sel;
}

// Cheap in-page validation of a CSS selector before FindElement, so unsupported
// syntax (e.g. :has(), rejected by Gecko's querySelector) yields an actionable
// error instead of a raw driver exception.
async function checkCss(sel) {
  const r = await execJs(`/*__csscheck__*/
try { document.querySelector(arguments[0]); return 'ok'; } catch (e) { return 'bad:' + (e && e.message ? String(e.message) : String(e)); }`, [sel]);
  const s = String(r == null ? 'ok' : r);
  if (s.slice(0, 4) === 'bad:') {
    throw new Error('CSS selector rejected by the page: ' + s.slice(4).slice(0, 100) +
      ' — the browser does not support all CSS (e.g. :has() is not supported); use [attr="…"]/.class/xpath forms, or fx_form/fx_field/fx_answer by label');
  }
}

// Hit-test probe for the fx_click obscuring fallback: sample points inside the
// target's box and inspect what elementFromPoint returns at the first hit.
//   clear    — the target (or its descendant) is on top: the driver click should work
//   ancestor — a same-widget ancestor sits on top (Material button overlay, an
//              li/label over a visually-hidden input): return ITS marker
//   widget   — a sibling/overlay inside the closest common widget: return ITS marker
//   blocked  — unrelated element on top: report it
const CLICK_TOP_JS = `/*__clicktop__*/
const s=arguments[0]; const el=(s.indexOf('xpath:')===0)?document.evaluate(s.slice(6),document,null,9,null).singleNodeValue:document.querySelector(s);
if(!el) return { error: 'el-gone' };
var r=el.getBoundingClientRect();
var pts=[[.5,.5],[.3,.5],[.7,.5],[.5,.35],[.5,.65],[.3,.35],[.7,.65],[.5,.8],[.5,.2]];
function wOf(n){ return n && n.closest ? n.closest('button,[role=button],label,li,a,select') : null; }
for(var i=0;i<pts.length;i++){
  var x=r.left+r.width*pts[i][0], y=r.top+r.height*pts[i][1];
  var top=document.elementFromPoint(x,y);
  if(!top) continue;
  if(top===el || el.contains(top)) return { mode: 'clear' };
  if(top.contains(el)){
    var w1=wOf(el), w2=wOf(top);
    if(!w1 || !w2 || w1===w2 || w2.contains(w1)) return { mode: 'ancestor', marker: (top.id?'#'+CSS.escape(top.id):'xpath:'+__xp(top)) };
    return { mode: 'blocked', top: (top.tagName||'?')+'.'+String(top.className||'').slice(0,60) };
  }
  var w1b=wOf(el), w2b=wOf(top);
  if(w1b && w2b && w1b===w2b) return { mode: 'widget', marker: (top.id?'#'+CSS.escape(top.id):'xpath:'+__xp(top)) };
  return { mode: 'blocked', top: (top.tagName||'?')+'.'+String(top.className||'').slice(0,60) };
}
return { mode: 'blocked', hint: 'no sample point resolved' };
`;

// Two-phase fx_eval: the wrapper (src/evalwrap.mjs) runs the user body in-page
// (expression first, function-body fallback) and reports {ok|err|pend}; a
// pending Promise settles into window.__fxr and is polled.

function allowedPath(abs) {
  return FILE_ROOTS.some((r0) => abs === r0 || abs.startsWith(r0 + path.sep));
}

// ---------------- shadow-DOM (deep) support ----------------
// Elements inside OPEN shadow roots are invisible to document.querySelector and
// to driver FindElement (css/xpath never cross a shadow boundary). They get an
// "sh:<path>" marker: a tag[idx] chain from <html> that hops through each
// shadowRoot -> host boundary; __deepResolve walks the same segments back.
// Closed shadow roots (el.shadowRoot === null) are unreachable by ANY means and
// are never enumerated. The driver cannot click/type inside shadow, so shadow
// markers are interacted with in-page via the full pointer/mouse event sequence
// (synthetic events — the proven path for hue-web-style web components).
const DEEP_UTIL = `
function __xp(el){ if(!el||el.nodeType!==1) return ''; var p=[]; var n=el; while(n&&n.nodeType===1){ var t=n.tagName.toLowerCase(); var s=n.parentElement?Array.prototype.filter.call(n.parentElement.children,c=>c.tagName===n.tagName):[n]; p.unshift(t+'['+(s.indexOf(n)+1)+']'); n=n.parentElement;} return '/'+p.join('/'); }
function __deepMark(el){
  var steps=[],n=el,g=0,inShadow=false;
  while(n&&g++<64){
    var par=n.parentElement;
    if(par){
      var sibs=Array.prototype.filter.call(par.children,function(c){return c.tagName===n.tagName;});
      steps.unshift(n.tagName.toLowerCase()+'['+(sibs.indexOf(n)+1)+']');
      n=par;continue;
    }
    var rn=n.getRootNode?n.getRootNode():n;
    if(rn&&rn.nodeType===11){
      inShadow=true;
      var host=rn.host;if(!host)break;
      var hp=host.parentElement;if(!hp)break;
      var hs=Array.prototype.filter.call(hp.children,function(c){return c.tagName===host.tagName;});
      steps.unshift(host.tagName.toLowerCase()+'['+(hs.indexOf(host)+1)+']');
      n=hp;continue;
    }
    break;
  }
  if(!inShadow||!steps.length)return null;
  if(steps[0].slice(0,4)!=='html')steps.unshift('html[1]');
  return 'sh:'+steps.join('/');
}
// Resolve an "sh:<path>" marker: a light-child walk cannot reconstruct shadow
// segments (segments are tag+idx relative to EACH element's own parent, and the
// light/shadow ancestor chains stitch at host boundaries at different depths),
// so instead we collect every light+shadow element and return the one whose
// own __deepMark signature equals p (exact, collision-free for a live tree).
function __deepResolve(p){
  if(typeof p!=='string'||p.indexOf('sh:')!==0)return null;
  var all=[];
  (function collect(root,depth){
    if(!root||depth>12)return;
    var els;try{els=root.querySelectorAll('*');}catch(e){return;}
    for(var i=0;i<els.length;i++){
      all.push(els[i]);
      if(els[i].shadowRoot)collect(els[i].shadowRoot,depth+1);
    }
  })(document,0);
  for(var k=0;k<all.length;k++){
    if(__deepMark(all[k])===p)return all[k];
  }
  return null;
}
// Collect elements matching sel inside the OPEN shadow roots of root (recursing
// into nested shadow trees); light-DOM matches are NOT included.
function __deepShadowQ(root,sel,out,depth){
  out=out||[];depth=depth||0;
  if(!root||depth>12)return out;
  var all;try{all=root.querySelectorAll('*');}catch(e){return out;}
  for(var i=0;i<all.length;i++){
    var sr=all[i].shadowRoot;
    if(!sr)continue;
    var m;try{m=sr.querySelectorAll(sel);}catch(e){continue;}
    for(var j=0;j<m.length;j++)out.push(m[j]);
    __deepShadowQ(sr,sel,out,depth+1);
  }
  return out;
}
function __allMatch(root,sel){
  var out=[];
  var light;try{light=root.querySelectorAll(sel);for(var i=0;i<light.length;i++)out.push(light[i]);}catch(e){}
  __deepShadowQ(root,sel,out,0);
  return out;
}
`;

// Resolves a marker in-page: sh:<path> (shadow root) | xpath:… | css selector.
const EL0 = DEEP_UTIL + `const s=arguments[0]; const el=(s.indexOf('sh:')===0)?__deepResolve(s):((s.indexOf('xpath:')===0)?document.evaluate(s.slice(6),document,null,9,null).singleNodeValue:document.querySelector(s));`;

const SNAPSHOT_JS = DEEP_UTIL + `
return (function (deep) {
  function xp(el) {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1) {
      const tag = n.tagName.toLowerCase();
      const sibs = n.parentElement ? Array.prototype.filter.call(n.parentElement.children, (c) => c.tagName === n.tagName) : [n];
      parts.unshift(tag + '[' + (sibs.indexOf(n) + 1) + ']');
      n = n.parentElement;
    }
    return '/' + parts.join('/');
  }
  const out = [];
  let i = 1;
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.type !== 'hidden' && getComputedStyle(el).visibility !== 'hidden';
  };
  const seen = new Set();
  document.querySelectorAll('h1,h2,h3').forEach((h) => {
    out.push({ i: i++, k: 'h', x: xp(h), t: (h.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 90) });
    if (out.length >= 140) return;
  });
  const sel = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=combobox],[role=switch],[role=option],[role=menuitem],[onclick],[tabindex]';
  const addRow = (el, sh) => {
    const v = sh ? (el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 && el.getClientRects().length > 0 && el.type !== 'hidden') : vis(el);
    if (!v || (el.offsetParent === null && !sh && el.getClientRects().length === 0)) return;
    const x = sh ? __deepMark(el) : xp(el);
    if (!x) return;
    if (seen.has(x)) return;
    seen.add(x);
    const kind = el.tagName.toLowerCase() + (el.type ? ':' + el.type : '');
    let txt = el.innerText || el.getAttribute('aria-label') || el.placeholder || '';
    txt = (txt || '').trim().replace(/\\s+/g, ' ').slice(0, 70);
    const css = sh ? '' : (el.id && document.querySelector('#' + CSS.escape(el.id)) === el ? '#' + CSS.escape(el.id) : '');
    let lbl = '';
    if (!sh && el.id) { var lEl0 = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (lEl0 && (lEl0.textContent || '').trim()) lbl = (lEl0.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 90); }
    if (!lbl && el.closest) { var wL = el.closest('label'); if (wL) { var wt = (wL.textContent || '').trim(); if (wt) lbl = wt.replace(/\\s+/g, ' ').slice(0, 90); } }
    out.push({
      i: i++, k: kind + (sh ? ':sh' : ''), x, t: txt, css,
      id: sh ? '' : (el.id || ''),
      l: lbl,
      ph: el.placeholder || '',
      al: el.getAttribute('aria-label') || '',
      val: el.type === 'password' ? '-pw-' : String(el.value ?? '').slice(0, 30),
      sel: el.checked === true ? '*' : '',
      dis: el.disabled ? '!' : ''
    });
  };
  document.querySelectorAll(sel).forEach((el) => {
    addRow(el, false);
    if (out.length >= 140) return;
  });
  if (deep) __deepShadowQ(document, sel, null, 0).forEach((el) => {
    if (out.length >= 140) return;
    addRow(el, true);
  });
  return out;
})(!!arguments[0])
`;

function fmtSnapshot(rows) {
  if (!Array.isArray(rows)) throw new Error('snapshot script returned ' + typeof rows);
  snapshotRefs = rows.filter((r) => r.k !== 'h');
  const lines = [];
  let n = 0;
  for (const r of rows) {
    if (r.k === 'h') { lines.push('#' + r.t); continue; }
    n++;
    const bits = [r.k];
    if (String(r.k || '').endsWith(':sh')) bits.push('SHADOW');
    if (r.id) bits.push('#' + r.id);
    if (r.l) bits.push('lbl=' + JSON.stringify(r.l));
    if (r.al) bits.push('aria=' + JSON.stringify(r.al));
    if (r.ph) bits.push('ph=' + JSON.stringify(r.ph));
    if (r.val) bits.push('val=' + JSON.stringify(r.val));
    if (r.sel) bits.push('checked');
    if (r.dis) bits.push('DISABLED');
    if (r.t) bits.push('"' + r.t + '"');
    lines.push(n + '. [' + bits.join(' ') + ']');
  }
  return lines.join('\n');
}

async function pageInfo() {
  const r = await M.cmd('WebDriver:ExecuteScript', {
    script: 'return JSON.stringify({webdriver: navigator.webdriver, url: location.href, title: document.title, ready: document.readyState});',
    args: [],
  });
  return JSON.parse(r.value);
}

// Bounded wait until the document reaches readyState 'complete' (used after
// navigating to external pages, e.g. following a search-result redirect).
async function waitForComplete(ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const rs = await execJs('return document.readyState;', []);
      if (rs === 'complete') return;
    } catch { /* page switching — keep polling */ }
    if (Date.now() - t0 > ms) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

// Search-engine presets: DATA, not logic. Selectors are swappable per call
// (container/title/snippet args) because engines change their DOM (Google's
// result rows moved from div.g to div.MjjYud) and new engines get added.
const SEARCH_ENGINES = {
  google: { url: (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q) + '&hl=en', container: 'div.MjjYud, div.g', title: 'h3', snippet: 'div[data-sncf="1"], div.VwiC3b' },
  bing: { url: (q) => 'https://www.bing.com/search?q=' + encodeURIComponent(q), container: 'li.b_algo', title: 'h2 > a', snippet: 'div.b_caption > p, .b_lineclamp3, p' },
  duckduckgo: { url: (q) => 'https://duckduckgo.com/html/?q=' + encodeURIComponent(q), container: 'table.webresult', title: 'h2 > a', snippet: '.result-snippet' },
};

// ---------------- generic form primitives ----------------
// Page scripts are plain (non-ES-module) scripts run via WebDriver:ExecuteScript.
// They must return a JSON-serializable value and receive parameters via arguments[].
const XP_JS = `function __xp(el){ if(!el||el.nodeType!==1) return ''; const p=[]; let n=el; while(n&&n.nodeType===1){ const t=n.tagName.toLowerCase(); const s=n.parentElement?Array.prototype.filter.call(n.parentElement.children,c=>c.tagName===n.tagName):[n]; p.unshift(t+'['+(s.indexOf(n)+1)+']'); n=n.parentElement;} return '/'+p.join('/'); }`;



const DEEP_CLICK_JS = DEEP_UTIL + `
return (function(m){
  var el=__deepResolve(arguments[0]);
  if(!el)return 'sh-gone';
  try{el.scrollIntoView({block:'center',behavior:'instant'});}catch(e){}
  var r=el.getBoundingClientRect();
  var p={bubbles:true,cancelable:true,view:window,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0};
  el.dispatchEvent(new MouseEvent('pointerdown',p));
  el.dispatchEvent(new MouseEvent('mousedown',p));
  el.dispatchEvent(new MouseEvent('pointerup',p));
  el.dispatchEvent(new MouseEvent('mouseup',p));
  el.dispatchEvent(new MouseEvent('click',p));
  return 'ok';
})(arguments[0]);
`;

// Deep type into a shadow-root control: text/textarea = native value setter +
// input/change events; checkbox/radio = full pointer click (toggles); select =
// option match (value or label) + change event. Returns the resulting value.
const DEEP_TYPE_JS = DEEP_UTIL + `
return (function(m,txt,keep){
  var el=__deepResolve(arguments[0]);
  if(!el)return 'sh-gone';
  try{el.scrollIntoView({block:'center',behavior:'instant'});}catch(e){}
  if(el.focus)el.focus();
  if(el.type==='checkbox'||el.type==='radio'){
    var r=el.getBoundingClientRect();
    var p={bubbles:true,cancelable:true,view:window,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0};
    el.dispatchEvent(new MouseEvent('pointerdown',p));
    el.dispatchEvent(new MouseEvent('mousedown',p));
    el.dispatchEvent(new MouseEvent('pointerup',p));
    el.dispatchEvent(new MouseEvent('mouseup',p));
    el.dispatchEvent(new MouseEvent('click',p));
    return el.checked?'on':'off';
  }
  if(el.tagName==='SELECT'){
    var opts=el.options,i;
    for(i=0;i<opts.length;i++){if(opts[i].value===txt)break;if((opts[i].textContent||'').trim()===txt)break;}
    if(i>=opts.length)return 'no-option:'+txt;
    el.selectedIndex=i;
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return String(el.value);
  }
  var proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement;
  var d=Object.getOwnPropertyDescriptor(proto.prototype,'value');
  if(keep&&d&&d.set)d.set.call(el,el.value+txt);
  else if(d&&d.set){d.set.call(el,''); if(txt)d.set.call(el,txt);}
  else{el.value=keep?(el.value+txt):txt;}
  el.dispatchEvent(new Event('input',{bubbles:true}));
  el.dispatchEvent(new Event('change',{bubbles:true}));
  return String(el.value);
})(arguments[0],arguments[1],arguments[2]);
`;

const DEEP_SCROLL_JS = DEEP_UTIL + `
return (function(m){
  var el=__deepResolve(arguments[0]);
  if(!el)return 'sh-gone';
  el.scrollIntoView({block:'center',behavior:'instant'});
  return 'ok:'+Math.round(el.getBoundingClientRect().top);
})(arguments[0]);
`;

// Enumerate visible form fields (light + open shadow roots when deep).
// args: [max, onlyIndex, id, labelQuery(lowercase), rootSelector, deep]
// Returns: array of {i,tag,type,id,name,label,ph,ctx,dis,req,sh?,val?,on?,files?,options?,m(marker)}
const FIELD_JS = DEEP_UTIL + `
return (function(){
  var max=Number(arguments[0])||80, only=Number(arguments[1])||0, id=arguments[2]||'', lq=(arguments[3]||'').toLowerCase(), rc=arguments[4]||'', deep=!!arguments[5];
  function norm(s){ return (s==null?'':String(s)).trim().replace(/\\s+/g,' '); }
  function vis(el){ var r=el.getBoundingClientRect(); return r.width>0 && r.height>0 && el.type!=='hidden' && (el.offsetParent!==null || el.getClientRects().length>0); }
  function labelOf(el){ var rt=el.getRootNode?el.getRootNode():document; if(el.id&&rt.querySelectorAll){ var ll=rt.querySelectorAll('label[for="'+CSS.escape(el.id)+'"]')[0]; if(ll && norm(ll.textContent)) return norm(ll.textContent).slice(0,120); } var wl=el.closest?el.closest('label'):null; if(wl){ var wt=norm(wl.textContent); if(wt) return wt.slice(0,120); } var al=el.getAttribute('aria-label'); if(al && norm(al)) return norm(al).slice(0,120); if(el.type==='radio'||el.type==='checkbox'){ var w=el.parentElement, g=0; while(w && g<6){ var n=w.querySelectorAll?w.querySelectorAll('input[type=radio],input[type=checkbox]').length:99; var t=norm(w.textContent); if(n===1 && t.length>=2 && t.length<=160) return t.slice(0,120); w=w.parentElement; g++; } } return ''; }
  function ctxOf(el){ var t=el.parentElement, g=0; while(t && g<7){ var c=norm(t.textContent); if(c.length>=15 && c.length<=600) return c.slice(0,160); t=t.parentElement; g++; } return ''; }
  function markerOf(el){ var dm=__deepMark(el); if(dm) return dm; if(el.id){ var m='#'+CSS.escape(el.id); try{ if(document.querySelector(m)===el) return m; }catch(e){} } return 'xpath:'+__xp(el); }
  var scope = rc ? (document.querySelector(rc) || document) : document;
  var fields=[];
  function addF(el, sh){
    if(!el) return;
    if(!vis(el)) return;
    var f={ i: fields.length+1, tag: el.tagName.toLowerCase(), type: el.type||'', id: el.id||'', name: el.name||'', label: labelOf(el), ph: el.placeholder||'', ctx: ctxOf(el), dis: el.disabled?1:0, req: el.required?1:0, m: markerOf(el), sh: sh?1:0 };
    if(el.type==='file'){ f.files = Array.prototype.slice.call(el.files||[]).map(function(x){ return x.name; }); }
    else if(el.tagName==='SELECT'){ f.val = String(el.value); f.options = Array.prototype.slice.call(el.options).slice(0,20).map(function(o){ return { v: o.value, t: norm(o.textContent).slice(0,60), s: o.selected?1:0 }; }); }
    else { f.val = el.type==='password' ? '-pw-' : String(el.value==null?'':el.value).slice(0,120); }
    if(el.type==='checkbox' || el.type==='radio'){ f.on = el.checked?1:0; }
    fields.push(f);
  }
  scope.querySelectorAll('input,textarea,select').forEach(function(el){ addF(el, false); });
  if(deep) __deepShadowQ(document,'input,textarea,select',null,0).forEach(function(el){ addF(el, true); });
  var cap = fields.slice(0,max);
  var groups=[]; var gmap={};
  cap.forEach(function(f){
    if(f.type!=='radio' && f.type!=='checkbox') return;
    var key = f.name ? ('n:' + f.name) : ('c:' + norm(f.ctx).slice(0,40));
    if(!gmap[key]){ gmap[key]={ key: key, type: f.type, name: f.name||'', ctx: f.ctx||'', req: f.req?1:0, single: true, options: [] }; groups.push(gmap[key]); }
    var g = gmap[key];
    g.options.push({ i: f.i, label: (f.label||f.ph||('field-'+f.i)).slice(0,60), on: f.on?1:0 });
    if(f.type==='checkbox') g.single=false;
  });
  if(id){ for(var i=0;i<fields.length;i++){ if(fields[i].id===id) return [fields[i]]; } return null; }
  if(lq){ var m2=[]; for(var j=0;j<fields.length;j++){ if(norm(fields[j].label).toLowerCase().indexOf(lq)>=0) m2.push(fields[j]); } return m2.slice(0,10); }
  if(only){ var m3=[]; for(var k=0;k<fields.length;k++){ if(fields[k].i===only) m3.push(fields[k]); } return m3; }
  return { f: cap, g: groups };
})(arguments[0], arguments[1], arguments[2], arguments[3], arguments[4], arguments[5]);
`;

// Locate one choice group by question text and pick an option. args: [question, choice, exact]
// Works across light + open shadow DOM (shadow controls get sh: markers).
// Returns: {ctx, option, kind, marker, labelMarker, state, options[]} or {error, ...}
const ANSWER_FIND_JS = DEEP_UTIL + `/*__answerfind__*/
return (function(){
  var Q=(arguments[0]||'').toLowerCase(), C=arguments[1]||'', exact=!!arguments[2];
  function norm(s){ return (s==null?'':String(s)).trim().replace(/\\s+/g,' '); }
  function vis(el){ var r=el.getBoundingClientRect(); return r.width>0 && r.height>0 && el.type!=='hidden' && (el.offsetParent!==null || el.getClientRects().length>0); }
  function ctxOf(el){ var t=el.parentElement, g=0; while(t && g<8){ var c=norm(t.textContent); if(c.length>=15 && c.length<=800) return c.slice(0,240); t=t.parentElement; g++; } return ''; }
  function labelOf(el){ var rt=el.getRootNode?el.getRootNode():document; if(el.id&&rt.querySelectorAll){ var l=rt.querySelectorAll('label[for="'+CSS.escape(el.id)+'"]')[0]; if(l && norm(l.textContent)) return norm(l.textContent); } var wl = el.closest ? el.closest('label') : null; if(wl){ var wt = norm(wl.textContent); if(wt) return wt; } var al=el.getAttribute('aria-label'); if(al) return norm(al); if(el.tagName==='BUTTON') return norm(el.textContent); if(el.type==='radio'||el.type==='checkbox'){ var w=el.parentElement, g=0; while(w && g<6){ var n=w.querySelectorAll?w.querySelectorAll('input[type=radio],input[type=checkbox]').length:99; var t=norm(w.textContent); if(n===1 && t.length>=2 && t.length<=160) return t; w=w.parentElement; g++; } } return ''; }
  function markerOf(el){ var dm=__deepMark(el); if(dm) return dm; if(el.id){ var m='#'+CSS.escape(el.id); try{ if(document.querySelector(m)===el) return m; }catch(e){} } return 'xpath:'+__xp(el); }
  function selState(el){ if(el.type==='checkbox'||el.type==='radio') return el.checked?'on':'off'; var ap=el.getAttribute('aria-pressed'); if(ap!=null) return ap==='true'?'on':'off'; return 'unknown'; }
  var cands=[];
  __allMatch(document,'input[type=radio],input[type=checkbox]').forEach(function(el){ if(!vis(el)) return; cands.push({ el: el, kind: 'input', label: labelOf(el), ctx: ctxOf(el) }); });
  __allMatch(document,'button,[role=radio],[role=switch]').forEach(function(el){ var t=norm(el.textContent); if(!t||t.length>14) return; if(!vis(el)) return; cands.push({ el: el, kind: el.tagName==='BUTTON'?'button':'role', label: t, ctx: ctxOf(el) }); });
  if(!cands.length) return { error: 'no-choice-controls' };
  var groups = new Map();
  cands.forEach(function(c){ var key = c.ctx || '__noctx__'; if(!groups.has(key)) groups.set(key, []); groups.get(key).push(c); });
  var matched=[];
  groups.forEach(function(arr, ctx){ if(ctx.toLowerCase().indexOf(Q)>=0) matched.push([ctx, arr]); });
  if(!matched.length) return { error: 'no-question', hint: 'question text not found near any choice group' };
  if(matched.length>1) return { error: 'ambiguous-question', groups: matched.map(function(p){ return p[0].slice(0,120); }) };
  var arr=matched[0][1]; var cl=C.toLowerCase();
  var picks=arr.filter(function(c){ return norm(c.label).toLowerCase()===cl; });
  if(!picks.length && !exact) picks=arr.filter(function(c){ return norm(c.label).toLowerCase().indexOf(cl)>=0; });
  if(!picks.length) return { error: 'no-option', options: arr.map(function(c){ return c.label; }).slice(0,12), ctx: matched[0][0].slice(0,200) };
  if(picks.length>1) return { error: 'ambiguous-option', options: picks.map(function(c){ return c.label; }), ctx: matched[0][0].slice(0,200) };
  var p=picks[0];
  var labelMarker=null;
  if(p.kind==='input'){ var rt2=p.el.getRootNode?p.el.getRootNode():document; var l2=p.el.id&&rt2.querySelectorAll?rt2.querySelectorAll('label[for="'+CSS.escape(p.el.id)+'"]')[0]:null; if(l2 && vis(l2)) labelMarker=markerOf(l2); }
  var single = arr.every(function(c){ return (c.kind==='button'||c.kind==='role') || (c.el && c.el.type==='radio'); });
  var alts = arr.filter(function(c){ return c.label!==p.label; }).slice(0,2).map(function(c){ return { label: c.label, kind: c.kind, marker: markerOf(c.el), state: selState(c.el) }; });
  return { ctx: matched[0][0].slice(0,240), option: p.label, kind: p.kind, marker: markerOf(p.el), labelMarker: labelMarker || null, state: selState(p.el), single: single, alts: alts, options: arr.map(function(c){ return c.label; }).slice(0,12) };
})(arguments[0], arguments[1], arguments[2]);
`;

// Fallback for fx_answer when the group's option LABELS are not readable by
// ANSWER_FIND_JS (unlabeled checkbox/radio rows rendered as plain li/label rows
// with no label association): find a VISIBLE wrapper (li/label/[role=option]/
// button) whose text matches the choice, scoped to the question's context, and
// return its marker so the caller can issue a real click on the wrapper.
const ANSWER_FALLBACK_JS = DEEP_UTIL + `/*__answerfallback__*/
return (function(){
  var Q=(arguments[0]||'').toLowerCase(), C=(arguments[1]||'').trim();
  function norm(s){ return (s==null?'':String(s)).trim().replace(/\\s+/g,' '); }
  function vis(el){ var r=el.getBoundingClientRect(); return r.width>0 && r.height>0 && (el.offsetParent!==null || el.getClientRects().length>0); }
  function ctxOf(el){ var t=el.parentElement, g=0; while(t && g<8){ var c=norm(t.textContent); if(c.length>=15 && c.length<=800) return c.slice(0,240); t=t.parentElement; g++; } return ''; }
  function markerOf(el){ var dm=__deepMark(el); if(dm) return dm; if(el.id){ var m='#'+CSS.escape(el.id); try{ if(document.querySelector(m)===el) return m; }catch(e){} } return 'xpath:'+__xp(el); }
  var cl=C.toLowerCase();
  var cands=[];
  __allMatch(document,'li,label,[role=option],button').forEach(function(w){
    if(!vis(w)) return;
    var t=norm(w.textContent);
    if(t.length<2 || t.length>160) return;
    var tl=t.toLowerCase();
    if(tl!==cl && tl.indexOf(cl)<0) return;
    var ctl = (w.tagName==='BUTTON' || w.hasAttribute('role')) ? w : w.querySelector('input[type=radio],input[type=checkbox],[role=radio],[role=checkbox]');
    if(!ctl) return;
    var ctx=ctxOf(w);
    if(Q && ctx.toLowerCase().indexOf(Q)<0) return;
    cands.push({ w: w, t: t });
  });
  if(!cands.length) return { error: 'no-fallback-option' };
  cands.sort(function(a,b){ var ae=a.t.toLowerCase()===cl?0:1, be=b.t.toLowerCase()===cl?0:1; if(ae!==be) return ae-be; return a.t.length-b.t.length; });
  if(cands.length>1 && cands[0].t.toLowerCase()!==cl && cands[1].t.toLowerCase()===cl) return { error: 'no-fallback-option' };
  if(cands.length>1 && cands[0].t.toLowerCase()!==cl) return { error: 'ambiguous-fallback', matches: cands.slice(0,4).map(function(c){ return c.t.slice(0,60); }) };
  var first=cands[0];
  return { marker: markerOf(first.w), text: first.t.slice(0,80), tag: first.w.tagName.toLowerCase() };
})(arguments[0], arguments[1]);
`;

// Re-read the selection state of a (fallback) wrapper after clicking it.
const ANSWER_REREAD_JS = DEEP_UTIL + `/*__answerreread__*/
return (function(m){
  var el = (m && m.indexOf('sh:')===0) ? __deepResolve(m) : (m && m.indexOf('xpath:')===0) ? document.evaluate(m.slice(6),document,null,9,null).singleNodeValue : document.querySelector(m);
  if(!el) return 'gone';
  var inp = el.tagName==='BUTTON' ? el : el.querySelector('input[type=radio],input[type=checkbox]');
  if(inp && (inp.type==='radio' || inp.type==='checkbox')) return inp.checked ? 'on' : 'off';
  var ap=el.getAttribute('aria-pressed'); if(ap!=null) return ap==='true'?'on':'off';
  var ac=el.getAttribute('aria-checked'); if(ac!=null) return ac==='true'?'on':'off';
  return 'unknown';
})(arguments[0]);
`;

// Consent/attestation gate audit (fx_gates): visible checkboxes with their
// nearby text, consent-pattern flags (certify/understand/agree/consent/attest/
// terms/privacy/acknowledge), disabled buttons (dead Submit/Apply), and visible
// alert-style banners. Read-only; built for the "submit click does nothing" case.
const GATES_JS = DEEP_UTIL + `/*__gates__*/
return (function(){
  function norm(s){ return (s==null?'':String(s)).trim().replace(/\\s+/g,' '); }
  function vis(el){ var r=el.getBoundingClientRect(); return r.width>0 && r.height>0 && el.type!=='hidden' && (el.offsetParent!==null || el.getClientRects().length>0); }
  function markerOf(el){ var dm=__deepMark(el); if(dm) return dm; if(el.id){ var m='#'+CSS.escape(el.id); try{ if(document.querySelector(m)===el) return m; }catch(e){} } return 'xpath:'+__xp(el); }
  var GATE=/certif|understand|agree|consent|attest|terms|privacy|acknowledge/i;
  function textOf(el){
    var lbl='';
    var rt=el.getRootNode?el.getRootNode():document;
    if(el.id&&rt.querySelectorAll){ var l=rt.querySelectorAll('label[for="'+CSS.escape(el.id)+'"]')[0]; if(l && norm(l.textContent)) lbl=norm(l.textContent); }
    if(!lbl){ var wl=el.closest?el.closest('label'):null; if(wl && norm(wl.textContent)) lbl=norm(wl.textContent); }
    if(!lbl){ var w=el.parentElement, g=0; while(w && g<5){ var n=w.querySelectorAll('input[type=checkbox]').length; var t=norm(w.textContent); if(n<=1 && t.length>=2 && t.length<=240) { lbl=t; break; } w=w.parentElement; g++; } }
    if(!lbl){ var al=el.getAttribute('aria-label'); if(al) lbl=norm(al); }
    return lbl;
  }
  var boxes=[];
  __allMatch(document,'input[type=checkbox]').forEach(function(el){
    if(!vis(el)) return;
    var t=textOf(el);
    boxes.push({ i: boxes.length+1, checked: el.checked===true, req: el.required?1:0, gate: GATE.test(t)?1:0, text: t.slice(0,200), m: markerOf(el) });
  });
  __allMatch(document,'[role=checkbox]').forEach(function(el){
    if(!vis(el)) return;
    var t=norm(el.textContent);
    boxes.push({ i: boxes.length+1, checked: el.getAttribute('aria-checked')==='true', req: 0, gate: GATE.test(t)?1:0, text: t.slice(0,200), m: markerOf(el), role: 1 });
  });
  if(boxes.length>25) boxes=boxes.slice(0,25);
  var dis=[];
  __allMatch(document,'button,[role=button]').forEach(function(el){
    if(!vis(el)) return;
    if(!(el.disabled===true || el.getAttribute('aria-disabled')==='true')) return;
    var t=norm(el.textContent);
    if(t.length<3) return;
    dis.push({ text: t.slice(0,60), m: markerOf(el) });
  });
  if(dis.length>10) dis=dis.slice(0,10);
  var banners=[];
  document.querySelectorAll('[role=alert],[class*=toast],[class*=banner],[class*=notification],[class*=snackbar]').forEach(function(el){
    if(!vis(el)) return;
    var t=norm(el.textContent);
    if(t.length<4 || t.length>300) return;
    if(!banners.some(function(b){ return b===t.slice(0,120); })) banners.push(t.slice(0,200));
  });
  if(banners.length>8) banners=banners.slice(0,8);
  return { boxes: boxes, disabledButtons: dis, banners: banners };
})()
`;

function markerRef(marker) {
  if (marker.startsWith('xpath:')) return { using: 'xpath', value: marker.slice(6) };
  return { using: 'css selector', value: marker };
}

// Real (driver) click on the element behind a marker ('#id' or 'xpath:…'). If
// the driver reports the element as NOT CLICKABLE (obscured) — the Material
// pattern of a visually-hidden input / transparent button under its own widget
// chrome — hit-test the obscuring topmost in-page; when it belongs to the same
// widget, click that instead. Non-obscuring errors rethrow unchanged.
async function clickVia(marker) {
  if (typeof marker === 'string' && marker.startsWith('sh:')) {
    const r = await execJs(DEEP_CLICK_JS, [marker]);
    if (String(r) === 'sh-gone') throw new Error('shadow element vanished before click — re-run fx_snapshot');
    return { el: 'shadow', mode: 'shadow' };
  }
  const el = await findEl(markerRef(marker));
  try {
    await M.cmd('WebDriver:ElementClick', { id: el });
    return { el, mode: 'direct' };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (!/obscures|not clickable/i.test(msg)) throw e;
    const top = await execJs(XP_JS + CLICK_TOP_JS, [marker]);
    if (top && (top.mode === 'ancestor' || top.mode === 'widget') && top.marker) {
      try {
        const tel = await findEl(markerRef(top.marker));
        await M.cmd('WebDriver:ElementClick', { id: tel });
        return { el: tel, mode: top.mode, top };
      } catch { /* fall through: report the original */ }
    }
    if (top && top.mode === 'blocked') {
      throw new Error(msg + ' · topmost: ' + (top.top || top.hint || 'unknown') + ' — fx_scroll it into view, or click the wrapper via an fx_eval marker');
    }
    throw e;
  }
}
function fmtField(f) {
  return { i: f.i, type: f.tag === 'select' ? 'select' : (f.type || f.tag), label: (f.label || f.ph || f.id || 'field-' + f.i).slice(0, 80) };
}

// ---------------- MCP tools ----------------
const T = (name, desc, schema, fn) => ({ name, description: desc, inputSchema: { type: 'object', properties: schema, additionalProperties: false }, fn });

const TOOLS = [
  T('fx_status', 'Health: connection, session, active + configured endpoint, current page, navigator.webdriver flag. When no Marionette Firefox is reachable it does NOT error — it reports connected:false with the probe result and the bootstrap options (start a new instance / connect an existing one).', {}, async () => {
    const launched = launchedInfo();
    try {
      await ensureConn();
    } catch (e) {
      const probe = classifyConnError(e);
      return {
        connected: false,
        endpoint: { host: M.host, port: M.port },
        configured: { host: HOST, port: PORT },
        probe,
        bootstrap: bootstrapOptions(probe),
        ...launched,
      };
    }
    const pi = await pageInfo();
    return {
      connected: true,
      endpoint: { host: M.host, port: M.port },
      configured: { host: HOST, port: PORT },
      protocol: M.hello && M.hello.marionetteProtocol,
      session: M.sessionId,
      ...pi,
      ...launched,
    };
  }),
  T('fx_launch', 'Bootstrap option 1 — start a NEW dedicated Firefox with Marionette: a fresh profile on a NEW port, with the port set through the profile user.js PREFERENCES (user_pref marionette.port / marionette.enabled — Firefox has no --marionette-port CLI flag, so this is the only way to move it off the default 2828), then `firefox --marionette --no-remote -profile <dir>`, and attach to it. The instance starts empty (no cookies/logins from your daily profile). Port defaults to the first free port above the configured one. Binary: FX_MCP_FIREFOX_BIN env (e.g. "node /path/standin.mjs") or firefox on PATH / common system paths. Returns the started pid, port, and profile, and leaves the MCP attached to the new instance.', { port: { type: 'number', description: 'marionette port; default = first free port above the configured one' }, profile: { type: 'string', description: 'profile directory; default <profile root>/marionette-mcp-<port>' } }, async (a) => {
    const l = await doLaunch(a || {});
    return {
      ok: true,
      ...l,
      endpoint: { host: '127.0.0.1', port: l.port },
      configured: { host: HOST, port: PORT },
      note: l.started === 'new-instance'
        ? 'fresh dedicated profile — starts with no cookies/logins; stop it later with fx_shutdown {port: ' + l.port + '}'
        : 're-attached to the instance this MCP started on this port',
    };
  }),
  T('fx_shutdown', 'Stop a Firefox that THIS server started via fx_launch (killed by the recorded pid — a user-launched browser is never touched). Omit {port} to stop the endpoint this MCP is attached to.', { port: { type: 'number', description: 'port of the fx_launch-managed instance to stop' } }, async (a) => {
    const ports = [];
    if (a && a.port != null) ports.push(Number(a.port));
    else if (M.host === '127.0.0.1') ports.push(M.port);
    if (!ports.length) ports.push(PORT);
    for (const p of ports) {
      let rec = LAUNCHED.get(p);
      if (!rec) {
        const f = path.join(PROFILE_ROOT, 'marionette-mcp-' + p, '.marionette-mcp-launched.json');
        if (fs.existsSync(f)) { try { rec = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { rec = null; } }
      }
      if (!rec) continue;
      const alive = pidAlive(rec.pid);
      if (alive) try { process.kill(rec.pid, 'SIGTERM'); } catch { /* ignore */ }
      if (M.host === '127.0.0.1' && M.port === p) {
        if (M.sock && !M.sock.destroyed) { try { M.sock.destroy(); } catch { /* ignore */ } }
        M.sock = null;
        M.sessionId = null;
        M.pending.clear();
        connected = false;
      }
      LAUNCHED.delete(p);
      return { ok: true, stopped: alive, pid: rec.pid, port: p, profile: rec.profile, note: alive ? 'SIGTERM sent' : 'already gone (stale record cleared)' };
    }
    throw new Error('no fx_launch-managed instance recorded for port ' + ports.join(',') + ' — only browsers started by this server can be stopped; a Firefox you start yourself stays yours');
  }),
  T('fx_connect', 'Point the MCP at a Firefox endpoint (host/port) and (re)attach. Marionette serves ONE client per browser, so use a dedicated instance per automation — the env-configured default (FX_MARIONETTE_HOST/PORT) is used when both args are omitted. Loopback only (by design). Returns the active endpoint + session after (re)attach.', { host: { type: 'string', description: 'loopback host, default 127.0.0.1' }, port: { type: 'number', description: 'marionette port, default = configured env port' } }, async (a) => {
    if (a.host !== undefined) {
      const h = String(a.host);
      if (!/^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|::1)$/.test(h)) throw new Error('host must be loopback (127.x / localhost / ::1)');
      M.host = h;
    }
    if (a.port !== undefined) {
      const p = Number(a.port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('port must be an integer 1..65535');
      M.port = p;
    }
    if (M.sock && !M.sock.destroyed) { try { M.sock.destroy(); } catch { /* ignore */ } }
    M.sock = null;
    M.sessionId = null;
    M.pending.clear();
    connected = false;
    await ensureConn();
    return { ok: true, endpoint: { host: M.host, port: M.port }, configured: { host: HOST, port: PORT }, session: M.sessionId, protocol: M.hello && M.hello.marionetteProtocol };
  }),
  T('fx_navigate', 'Navigate the active tab to a URL', { url: { type: 'string' } }, async (a) => {
    await M.cmd('WebDriver:Navigate', { url: a.url });
    return { ok: true };
  }),
  T('fx_page', 'Current URL and title', {}, async () => {
    const pi = await pageInfo();
    return { url: pi.url, title: pi.title };
  }),
  T('fx_snapshot', 'Interactive-element map with refs (use refs in fx_click/fx_type/...). Crosses OPEN shadow roots by default: web-component modals/dialogs (e.g. LinkedIn post-apply prompts) get their own refs, marked "SHADOW"; clicking a shadow ref fires a full pointer/mouse sequence in-page (the driver cannot target shadow elements). deep=false → light DOM only. Closed shadow roots are never visible to any tool.', { deep: { type: 'boolean', description: 'include controls inside open shadow roots (default true)' } }, async (a) => {
    return fmtSnapshot(await execJs(SNAPSHOT_JS, [a.deep !== false]));
  }),
  T('fx_click', 'Click element by ref (from fx_snapshot) or CSS selector. Digit-leading ids: use [id="…"] form (a bare #1abc is not valid CSS) — or pass it as-is and the tool will rewrite it for you. Unsupported CSS (e.g. :has()) is caught in-page with an actionable error before the driver call. If the element is obscured by an overlay of its own widget (Material button chrome, an li/label over a hidden input), the obscuring topmost element is clicked instead and reported as used:"overlay-top:…". Shadow-ref elements (marked SHADOW in fx_snapshot) are clicked in-page via the full pointer/mouse event sequence and reported via:"shadow".', { ref: { type: 'number' }, selector: { type: 'string' } }, async (a) => {
    const p = resolveElRef(a);
    if (p.shadow) {
      const r = await execJs(DEEP_CLICK_JS, [p.shadow]);
      if (String(r) === 'sh-gone') throw new Error('shadow element vanished before click — re-run fx_snapshot');
      return { ok: true, via: 'shadow' };
    }
    if (p.using === 'css selector') { p.value = hardenCss(p.value); await checkCss(p.value); }
    await findEl(p.using, p.value); // resolve early: actionable error for bad selectors
    const c = await clickVia(refMarker(a));
    const out = { ok: true, el: c.el };
    if (a.selector && p.value !== a.selector) out.used = p.value;
    if (c.mode !== 'direct') out.via = 'overlay-top:' + c.mode;
    return out;
  }),
  T('fx_type', 'Type text into element (clears first unless keep=true). Same selector rules as fx_click (digit-leading #ids auto-rewritten to [id="…"]; unsupported CSS caught in-page). Shadow-ref elements get the value set in-page (native value setter + input/change events) and report via:"shadow".', { ref: { type: 'number' }, selector: { type: 'string' }, text: { type: 'string' }, keep: { type: 'boolean', description: 'true = append instead of clearing' } }, async (a) => {
    const p = resolveElRef(a);
    if (p.shadow) {
      const r = await execJs(DEEP_TYPE_JS, [p.shadow, String(a.text ?? ''), a.keep === true]);
      if (String(r) === 'sh-gone') throw new Error('shadow element vanished before type — re-run fx_snapshot');
      return { ok: true, via: 'shadow', confirmed: String(r).slice(0, 120) };
    }
    if (p.using === 'css selector') { p.value = hardenCss(p.value); await checkCss(p.value); }
    const el = await findEl(p.using, p.value);
    if (!a.keep) await M.cmd('WebDriver:ElementClear', { id: el }).catch(() => {});
    await M.cmd('WebDriver:ElementSendKeys', { id: el, text: a.text });
    return { ok: true, used: a.selector && p.value !== a.selector ? p.value : undefined };
  }),
  T('fx_select', 'Set <select> by option value or visible label (light DOM; shadow selects: use fx_field by index/label)', { ref: { type: 'number' }, selector: { type: 'string' }, value: { type: 'string' }, label: { type: 'string' } }, async (a) => {
    const mk = refMarker(a);
    if (typeof mk === 'string' && mk.startsWith('sh:')) throw new Error('shadow-root element — the driver cannot target it; use fx_field (by index/label) or fx_click');
    const match = a.value != null
      ? `const m=[...el.options].find(o=>o.value===arguments[1]); if(!m) return 'no-option:'+arguments[1]; el.value=m.value; return 'ok:'+m.value;`
      : `const m=[...el.options].find(o=>o.textContent.trim()===arguments[1]); if(!m) return 'no-option:'+arguments[1]; el.value=m.value; return 'ok:'+m.textContent.trim();`;
    const r = await execJs(EL0 + ` if(!el) return 'el-gone'; if(el.tagName!=='SELECT') return 'not-a-select:'+(el.tagName||''); ${match} el.dispatchEvent(new Event('change',{bubbles:true})); el.dispatchEvent(new Event('input',{bubbles:true}));`, [mk, a.value != null ? a.value : a.label]);
    return { r };
  }),
  T('fx_toggle', 'Set checkbox/radio state (light DOM; shadow checkboxes: use fx_field by index/label or fx_click)', { ref: { type: 'number' }, selector: { type: 'string' }, on: { type: 'boolean', description: 'default true' } }, async (a) => {
    const mk = refMarker(a);
    if (typeof mk === 'string' && mk.startsWith('sh:')) throw new Error('shadow-root element — the driver cannot target it; use fx_field (by index/label) or fx_click');
    const want = a.on !== false;
    const r = await execJs(EL0 + ` if(!el) return 'el-gone'; if(el.type!=='checkbox'&&el.type!=='radio') return 'not-togglable:'+String(el.type); if(el.checked!==arguments[1]){el.checked=arguments[1]; el.dispatchEvent(new Event('change',{bubbles:true})); el.dispatchEvent(new Event('click',{bubbles:true}));} return 'ok:'+(el.checked?'on':'off');`, [mk, want]);
    return { r };
  }),
  T('fx_upload', 'Set a file input value (raw-path sendKeys; light DOM — for shadow-root file inputs, set files in-page via fx_eval); path must be under FX_MCP_FILE_ROOTS', { ref: { type: 'number' }, selector: { type: 'string' }, path: { type: 'string' } }, async (a) => {
    const abs = path.resolve(a.path);
    if (!allowedPath(abs)) throw new Error('path outside allowed roots: ' + FILE_ROOTS.join(','));
    if (!fs.existsSync(abs)) throw new Error('file not found: ' + abs);
    const p = resolveElRef(a);
    if (p.shadow) throw new Error('shadow-root file input — the driver cannot target it; set files in-page via fx_eval (DataTransfer) or restructure the form in light DOM');
    const el = await findEl(p.using, p.value);
    await M.cmd('WebDriver:ElementSendKeys', { id: el, text: abs });
    await new Promise((r) => setTimeout(r, 700));
    const got = await execJs(EL0 + ` return el&&el.files&&el.files[0] ? el.files[0].name : 'no-file-set';`, [refMarker(a)]);
    return { uploaded: got, path: abs };
  }),
  T('fx_form', 'Structured dump of all visible form fields on the page: index, type, label, context, value, options, files, plus aggregated choice groups (radio/checkbox sets with their question context and per-option state) — audit every required group, not just individually labeled fields. Crosses OPEN shadow roots by default: web-component dialogs render their fields inside shadow trees and are included (flagged sh:true). Form workflow: run fx_form first to learn the fields/groups, then set values with fx_field (by index/id/label) and answer radio/checkbox/button questions with fx_answer. Prefer these over hand-written fx_eval form scripts. Optional CSS root scopes the light-DOM dump.', { root: { type: 'string', description: 'CSS selector to scope the dump (default: whole page)' }, max: { type: 'number', description: 'max fields (default 80)' }, deep: { type: 'boolean', description: 'include fields inside open shadow roots (default true)' } }, async (a) => {
    const recs = await execJs(FIELD_JS, [Math.min(300, Math.max(1, Number(a.max) || 80)), 0, '', '', a.root || '', a.deep !== false]);
    let arr, groups;
    if (recs && typeof recs === 'object' && Array.isArray(recs.f)) { arr = recs.f; groups = recs.g || []; }
    else if (Array.isArray(recs)) { arr = recs; groups = []; }
    else throw new Error('form dump returned ' + typeof recs);
    return {
      count: arr.length,
      fields: arr.map((f) => {
        const o = { i: f.i, type: f.tag === 'select' ? 'select' : (f.type || f.tag) };
        o.label = (f.label || f.ph || (f.id ? f.id : 'field-' + f.i)).slice(0, 80);
        if (f.name) o.name = f.name;
        if (f.ctx) o.ctx = f.ctx;
        if (f.val !== undefined) o.value = f.val;
        if (f.on !== undefined) o.on = !!f.on;
        if (f.files) o.files = f.files.slice(0, 10);
        if (f.options) o.options = f.options;
        if (f.dis) o.disabled = true;
        if (f.req) o.required = true;
        if (f.sh) o.sh = true;
        return o;
      }),
      ...(groups.length ? { groups: groups.map((g) => ({ type: g.type, name: g.name, ctx: (g.ctx || '').slice(0, 140), required: !!g.req, single: !!g.single, options: g.options.map((o) => ({ i: o.i, label: o.label, on: !!o.on })) })) } : {}),
    };
  }),
  T('fx_field', 'Set a form field by index (from fx_form), by id, or by label substring. Text/textarea = real keystrokes (framework-safe); checkbox/radio = real click that reaches the wanted state (pass value "on"/"off", default on) with verify + label-click + event fallbacks; select = option match by value or label. Scrolls the field into view automatically. File inputs: use fx_upload.', { index: { type: 'number', description: 'field index from fx_form' }, id: { type: 'string', description: 'field id attribute' }, label: { type: 'string', description: 'field label (substring match)' }, value: { type: 'string', description: 'text to type / option value / "on"|"off" for checkbox-radio' } }, async (a) => {
    if (a.index == null && !a.id && !a.label) throw new Error('need index (from fx_form), id, or label');
    const recs = await execJs(FIELD_JS, [80, Number(a.index) || 0, a.id || '', (a.label || '').trim().toLowerCase(), '', true]);
    let field;
    if (a.index != null || a.id) {
      if (!Array.isArray(recs) || !recs.length) throw new Error(a.index != null ? 'field index not found (page changed?) — run fx_form again' : 'field id not found: ' + a.id);
      field = recs[0];
    } else {
      if (!Array.isArray(recs) || !recs.length) throw new Error('no visible field with label containing "' + a.label + '"');
      if (recs.length > 1) throw new Error('ambiguous label "' + a.label + '" -> ' + recs.slice(0, 5).map((f) => f.label + ' (index ' + f.i + ')').join(' | '));
      field = recs[0];
    }
    if (!field || !field.m) throw new Error('field not resolved');
    if (String(field.m).startsWith('sh:')) {
      // shadow-root field: set state in-page (native setter + events); the driver cannot target it
      if (field.type === 'file') throw new Error('shadow-root file input — set files in-page via fx_eval (the driver cannot target shadow)');
      if (field.type === 'checkbox' || field.type === 'radio') {
        let want = true;
        if (a.value != null) {
          if (typeof a.value === 'boolean') want = a.value;
          else {
            const s = String(a.value).trim().toLowerCase();
            if (/^(off|false|no|0)$/.test(s)) want = false;
            else if (!/^(on|true|yes|1)$/.test(s)) throw new Error('checkbox/radio: value must be on or off (got "' + a.value + '")');
          }
        }
        const curR = await execJs(DEEP_UTIL + `return (function(m){ var el=__deepResolve(arguments[0]); if(!el) return 'gone'; return String(el.checked===true); })(arguments[0]);`, [field.m]);
        if (curR === 'gone') throw new Error('shadow field vanished before state read');
        if ((curR === 'true') === want) return { ok: true, unchanged: true, field: fmtField(field), state: want ? 'on' : 'off', via: 'shadow' };
        const r = await execJs(DEEP_TYPE_JS, [field.m, '', false]);
        if (String(r) === 'sh-gone') throw new Error('shadow field vanished before click');
        const now = String(r);
        return { ok: want ? now === 'on' : now === 'off', field: fmtField(field), wanted: want ? 'on' : 'off', state: now, via: 'shadow' };
      }
      if (field.tag === 'select') {
        if (a.value == null) throw new Error('select field: pass value (option value or visible label)');
        const r = await execJs(DEEP_TYPE_JS, [field.m, String(a.value), false]);
        if (String(r) === 'sh-gone') throw new Error('shadow field vanished');
        if (String(r).startsWith('no-option:')) throw new Error('select: ' + r);
        return { ok: true, field: fmtField(field), wanted: String(a.value), confirmed: String(r), via: 'shadow' };
      }
      const r = await execJs(DEEP_TYPE_JS, [field.m, a.value != null ? String(a.value) : '', false]);
      if (String(r) === 'sh-gone') throw new Error('shadow field vanished before type');
      const conf = String(r);
      return { ok: a.value == null || conf === String(a.value), field: fmtField(field), confirmed: conf.slice(0, 120), via: 'shadow' };
    }
    await execJs(EL0 + ` if(el) el.scrollIntoView({block:'center',behavior:'instant'}); return 'ok';`, [field.m]);
    await new Promise((r) => setTimeout(r, 150));
    const ref = markerRef(field.m);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (field.type === 'file') throw new Error('file input — use fx_upload with a path under the allowed roots');
    if (field.tag === 'select') {
      if (a.value == null) throw new Error('select field: pass value (option value or visible label)');
      const X = String(a.value);
      const r = await execJs(EL0 + ` if(!el) return 'el-gone'; const opts=Array.prototype.slice.call(el.options); const X=String(arguments[1]); let m=opts.find(o=>o.value===X); if(!m) m=opts.find(o=>o.textContent.trim()===X); if(!m){ const c=opts.filter(o=>o.textContent.trim().toLowerCase().indexOf(X.toLowerCase())>=0); if(c.length===1) m=c[0]; } if(!m) return 'no-option:'+X.slice(0,40); el.selectedIndex=m.index; el.dispatchEvent(new Event('change',{bubbles:true})); el.dispatchEvent(new Event('input',{bubbles:true})); return 'ok:'+String(m.value);`, [field.m, X]);
      if (r === 'el-gone') throw new Error('field vanished before select');
      if (String(r).slice(0, 3) !== 'ok:') throw new Error('select: ' + r);
      await sleep(150);
      const conf = await execJs(EL0 + ` return el?String(el.value):null;`, [field.m]);
      return { ok: true, field: fmtField(field), wanted: X, confirmed: conf };
    }
    if (field.type === 'checkbox' || field.type === 'radio') {
      let want = true;
      if (a.value != null) {
        if (typeof a.value === 'boolean') want = a.value;
        else {
          const s = String(a.value).trim().toLowerCase();
          if (/^(off|false|no|0)$/.test(s)) want = false;
          else if (!/^(on|true|yes|1)$/.test(s)) throw new Error('checkbox/radio: value must be on or off (got "' + a.value + '")');
        }
      }
      const cur = await execJs(EL0 + ` return el?String(el.checked===true):'gone';`, [field.m]);
      if (cur === 'gone') throw new Error('field vanished before state read');
      if ((cur === 'true') === want) return { ok: true, unchanged: true, field: fmtField(field), state: want ? 'on' : 'off' };
      let via = 'none';
      try {
        const c = await clickVia(field.m);
        via = c.mode === 'direct' ? 'element' : 'overlay-top:' + c.mode;
      } catch {
        const lm = await execJs(EL0 + ` if(!el||!el.id) return null; const l=document.querySelector('label[for="'+CSS.escape(el.id)+'"]'); if(!l) return null; if(l.id){ try{ const m='#'+CSS.escape(l.id); if(document.querySelector(m)===l) return m; }catch(e){} } return 'xpath:'+__xp(l);`, [field.m]);
        if (lm && lm !== 'null') {
          try { const lel = await findEl(markerRef(lm)); await M.cmd('WebDriver:ElementClick', { id: lel }); via = 'label'; } catch { /* event fallback below */ }
        }
      }
      await sleep(250);
      let now = await execJs(EL0 + ` return el?String(el.checked===true):'gone';`, [field.m]);
      const goodNow = (want ? now === 'true' : now === 'false');
      if (!goodNow) {
        await execJs(EL0 + ` if(el){ el.checked=arguments[1]; el.dispatchEvent(new Event('change',{bubbles:true})); el.dispatchEvent(new Event('click',{bubbles:true})); } return 'done';`, [field.m, want]);
        await sleep(200);
        now = await execJs(EL0 + ` return el?String(el.checked===true):'gone';`, [field.m]);
        via += ' +events-fallback';
      }
      const okNow = want ? now === 'true' : now === 'false';
      return { ok: okNow, field: fmtField(field), wanted: want ? 'on' : 'off', state: now, via };
    }
    const el = await findEl(ref).catch(() => null);
    if (!el) throw new Error('field vanished before type');
    if (a.value != null) {
      await M.cmd('WebDriver:ElementClear', { id: el }).catch(() => {});
      if (String(a.value) !== '') await M.cmd('WebDriver:ElementSendKeys', { id: el, text: String(a.value) });
    } else {
      await M.cmd('WebDriver:ElementClear', { id: el }).catch(() => {});
    }
    await sleep(150);
    const conf = await execJs(EL0 + ` return el?String(el.value):'gone';`, [field.m]);
    return { ok: conf !== 'gone' && (a.value == null || conf === String(a.value)), field: fmtField(field), confirmed: conf.slice(0, 120) };
  }),
  T('fx_answer', 'Answer a grouped choice question (Yes/No button groups, radio or checkbox option groups): locate the group by matching the question text, pick the option by its label, perform a real click, then re-read and report the resulting selection state. If the target was already selected (or is still not selected) after the click — a no-op click that frameworks often do not register — performs a toggle cycle (click another option, then the target) on exclusive groups and re-verifies. If the option labels are unreadable (label-less li/label rows), it self-heals by clicking the visible wrapper whose text matches the choice. Searches light + open shadow DOM (shadow options are clicked in-page via the full pointer sequence). Use this instead of clicking raw button refs — option order/refs can shift on re-render, and matching by question text prevents picking the wrong option of a neighbouring question.', { question: { type: 'string', description: 'text that must appear in the question context' }, choice: { type: 'string', description: 'option label to select, e.g. "Yes" or "New York City"' }, exact: { type: 'boolean', description: 'require exact label match (default false: case-insensitive substring allowed)' } }, async (a) => {
    if (!a.question || !a.choice) throw new Error('need question + choice');
    let found0 = await execJs(ANSWER_FIND_JS, [a.question, a.choice, a.exact !== true]);
    if (!found0 || typeof found0 !== 'object' || !found0.marker) {
      // Self-heal: option label unreadable (unassociated li/label rows) — click the
      // visible wrapper whose text matches the choice, scoped to the question context.
      const err = found0 && found0.error;
      if (err !== 'no-option') throw new Error('fx_answer: ' + JSON.stringify(found0));
      const fb = await execJs(ANSWER_FALLBACK_JS, [a.question, a.choice]);
      if (!fb || !fb.marker) throw new Error('fx_answer: ' + JSON.stringify(found0) + ' fallback: ' + JSON.stringify(fb));
      await execJs(EL0 + ` if(el) el.scrollIntoView({block:'center',behavior:'instant'}); return 'ok';`, [fb.marker]);
      await new Promise((r) => setTimeout(r, 150));
      await clickVia(fb.marker);
      await new Promise((r) => setTimeout(r, 400));
      let st = await execJs(ANSWER_REREAD_JS, [fb.marker]);
      if (st === 'gone') st = 'unknown';
      const verified = st === 'on' ? 'selected (wrapper fallback)' : st === 'off' ? 'NOT-SELECTED — verify' : 'no selection signal on this control — verify (e.g. re-run fx_form)';
      return { ok: st !== 'off', question: (found0.ctx || a.question), answer: fb.text, pre: null, via: 'fallback:' + fb.tag, state: st, verified, fallback: true };
    }
    const pre = found0.state;
    await execJs(EL0 + ` if(el) el.scrollIntoView({block:'center',behavior:'instant'}); return 'ok';`, [found0.marker]);
    await new Promise((r) => setTimeout(r, 150));
    let via;
    const primary = found0.labelMarker || found0.marker;
    function viaOf(c, base) { return base + (c.mode !== 'direct' ? '+overlay' : ''); }
    async function clickPrimary(fallbackNote) {
      const base = fallbackNote ? 'element(' + fallbackNote + ')' : (found0.labelMarker ? 'label' : 'element');
      try {
        const c = await clickVia(primary);
        via = viaOf(c, base);
      } catch (e) {
        if (!found0.labelMarker) throw e;
        const c = await clickVia(found0.marker);
        via = viaOf(c, 'element( fallback )');
      }
    }
    await clickPrimary();
    await new Promise((r) => setTimeout(r, 300));
    let after = await execJs(ANSWER_FIND_JS, [a.question, a.choice, true]);
    let state = after && after.option === found0.option ? after.state : 'unreadable';
    // A click on an already-selected radio is a no-op in the DOM AND often
    // unregistered by the framework; a fresh change cycle (other option, then
    // target) is the only reliable way to (re)set the answer.
    if (found0.single && (pre === 'on' || state === 'off' || state === 'unreadable')) {
      let toggled = false;
      for (const alt of found0.alts || []) {
        try {
          await clickVia(alt.marker);
          await new Promise((r) => setTimeout(r, 300));
          const mid = await execJs(ANSWER_FIND_JS, [a.question, a.choice, true]);
          if (mid && (mid.state !== pre || pre === 'unknown')) { toggled = true; break; }
        } catch { /* try next alt */ }
      }
      if (toggled) {
        await clickPrimary('toggle-cycle');
        await new Promise((r) => setTimeout(r, 300));
        after = await execJs(ANSWER_FIND_JS, [a.question, a.choice, true]);
        if (after && after.option === found0.option) state = after.state;
      }
    }
    let verified;
    if (state === 'on') verified = 'selected';
    else if (state === 'off') verified = 'NOT-SELECTED — click may have toggled it off; verify';
    else verified = 'no selection signal on this control type — verify (e.g. re-run fx_form)';
    return { ok: state !== 'off', question: found0.ctx, answer: found0.option, pre, via, state: state === 'unreadable' ? 'unknown' : state, verified };
  }),
  T('fx_scroll', 'Scroll an element (ref from fx_snapshot, or selector) into view so it is not obscured (e.g. by a fixed header/cookie bar), wait, and return its top coordinate. Use before clicking elements that failed as "not clickable because another element obscures it". Shadow refs are scrolled in-page (reported r:"sh:ok:<top>").', { ref: { type: 'number' }, selector: { type: 'string' }, pos: { type: 'string', description: 'start | center | end (default center)' }, wait_ms: { type: 'number', description: 'wait after scroll (default 400, max 2000)' } }, async (a) => {
    const mk = refMarker(a);
    if (typeof mk === 'string' && mk.startsWith('sh:')) {
      const r = await execJs(DEEP_SCROLL_JS, [mk]);
      if (r === 'sh-gone') throw new Error('shadow element not found — re-run fx_snapshot');
      await new Promise((r3) => setTimeout(r3, Math.min(2000, Math.max(0, Number(a.wait_ms) || 400))));
      return { r: 'sh:' + String(r) };
    }
    const pos = a.pos === 'start' || a.pos === 'end' ? a.pos : 'center';
    const r = await execJs(EL0 + ` if(!el) return 'el-gone'; el.scrollIntoView({block:arguments[1],behavior:'instant'}); return 'ok:'+Math.round(el.getBoundingClientRect().top);`, [mk, pos]);
    if (r === 'el-gone') throw new Error('element not found');
    await new Promise((r2) => setTimeout(r2, Math.min(2000, Math.max(0, Number(a.wait_ms) || 400))));
    return { r };
  }),
  T('fx_gates', 'Consent/attestation gate audit: lists visible checkboxes with their nearby text (flags certify/understand/agree/consent/attest/terms/privacy wording — the hidden gates of long application forms), disabled buttons (a dead Submit/Apply), and visible alert-style banners. Includes open shadow-root checkboxes/buttons. Read-only; run it whenever a submit click does nothing or a submit button is disabled — the fix is usually an unchecked consent checkbox, not bot protection.', {}, async () => {
    const r = await execJs(GATES_JS, []);
    if (!r || typeof r !== 'object' || !Array.isArray(r.boxes)) throw new Error('fx_gates: unexpected page result ' + typeof r);
    const mk = (b) => ({ i: b.i, checked: !!b.checked, required: !!b.req, text: b.text, marker: b.m });
    return {
      uncheckedConsent: r.boxes.filter((b) => b.gate && !b.checked).map(mk),
      checkedConsent: r.boxes.filter((b) => b.gate && b.checked).map(mk),
      otherUnchecked: r.boxes.filter((b) => !b.gate && !b.checked).map(mk).slice(0, 15),
      disabledButtons: (r.disabledButtons || []).map((b) => ({ text: b.text, marker: b.m })),
      banners: r.banners || [],
    };
  }),
  T('fx_links', 'Hyperlinks of the current page: text + absolute href (ready to navigate). Generic — any site. Use selector to scope which anchors to list (e.g. a[href^="/url"]); deep=false for light DOM only. For redirect-wrapped destinations (e.g. Google /goto), the in-DOM href is the wrapper — use fx_search {resolve:true} or navigate and fx_page to learn the real URL.', { selector: { type: 'string', description: 'CSS filter on which anchors to list (default: all <a>)' }, deep: { type: 'boolean', description: 'include anchors inside open shadow roots (default true)' }, max: { type: 'number', description: 'max links (default 100)' } }, async (a) => {
    if (a.selector) await checkCss(a.selector);
    const r = await execJs(`/*__fxlinks__*/
  function all(rt, out) { out = out || []; out.push(rt); var els; try { els = rt.querySelectorAll('*'); } catch (e) { return out; } for (var i = 0; i < els.length; i++) { if (els[i].shadowRoot) all(els[i].shadowRoot, out); } return out; }
  var sel = arguments[0], deep = arguments[1], max = arguments[2];
  var roots = deep ? all(document) : [document];
  var seen = {}; var out = [];
  for (var i = 0; i < roots.length && out.length < max; i++) {
    var as;
    try { as = sel ? roots[i].querySelectorAll(sel) : roots[i].querySelectorAll('a'); } catch (e) { continue; }
    for (var j = 0; j < as.length && out.length < max; j++) {
      var el = as[j];
      var href = el.href || el.getAttribute('href') || '';
      if (!href) continue;
      var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
      var key = el.tagName.toLowerCase() + '|' + href + '|' + text;
      if (seen[key]) continue;
      seen[key] = 1;
      out.push({ i: out.length, text: text, href: href });
    }
  }
  return out;
  `, [typeof a.selector === 'string' ? a.selector : '', a.deep !== false, a.max != null ? Math.max(1, Number(a.max)) : 100]);
    if (!Array.isArray(r)) throw new Error('fx_links: unexpected page result ' + typeof r);
    return { count: r.length, links: r };
  }),
  T('fx_extract', 'Structured page read ("scrape" without writing fx_eval JS): one row per container matching the selector. Without fields each row is {i, text} (the container own innerText); with fields {name: "css"|"text"} each row gets one entry per field — the text of the first in-container element matching the field CSS ("text" = the container own innerText). Generic — any site; the selectors are yours (agent-supplied), not hard-coded.', { selector: { type: 'string', description: 'container selector (default body → single row)' }, fields: { type: 'object', description: '{fieldName: cssSelector | "text"}' }, deep: { type: 'boolean', description: 'include containers inside open shadow roots (default true)' }, limit: { type: 'number', description: 'max rows (default 25)' }, textLen: { type: 'number', description: 'max chars per text field (default 300)' } }, async (a) => {
    if (a.selector) await checkCss(a.selector);
    const fields = a.fields && typeof a.fields === 'object' && !Array.isArray(a.fields) ? a.fields : null;
    if (fields) for (const v of Object.values(fields)) if (typeof v !== 'string') throw new Error('fx_extract: field values must be strings (a CSS selector, or "text")');
    const r = await execJs(`/*__fxextract__*/
  function all(rt, out) { out = out || []; out.push(rt); var els; try { els = rt.querySelectorAll('*'); } catch (e) { return out; } for (var i = 0; i < els.length; i++) { if (els[i].shadowRoot) all(els[i].shadowRoot, out); } return out; }
  var sel = arguments[0], fields = arguments[1], deep = arguments[2], limit = arguments[3], textLen = arguments[4];
  function clean(v) { return String(v == null ? '' : v).replace(/\\s+/g, ' ').trim().slice(0, textLen); }
  var roots = deep ? all(document) : [document];
  var out = [];
  for (var i = 0; i < roots.length; i++) {
    var cs;
    try { cs = roots[i].querySelectorAll(sel); } catch (e) { continue; }
    for (var j = 0; j < cs.length && out.length < limit; j++) {
      var c = cs[j];
      var row = { i: out.length };
      if (!fields) { row.text = clean(c.innerText || c.textContent); }
      else {
        for (var k in fields) {
          var spec = fields[k]; var v;
          if (spec === 'text') v = c.innerText || c.textContent;
          else { try { var e2 = c.querySelector(spec); v = e2 ? (e2.innerText || e2.textContent) : ''; } catch (ex) { v = ''; } }
          row[k] = clean(v);
        }
      }
      out.push(row);
    }
  }
  return out;
  `, [a.selector || 'body', fields, a.deep !== false, a.limit != null ? Math.max(1, Number(a.limit)) : 25, a.textLen != null ? Math.max(10, Number(a.textLen)) : 300]);
    if (!Array.isArray(r)) throw new Error('fx_extract: unexpected page result ' + typeof r);
    return { count: r.length, rows: r };
  }),
  T('fx_search', 'Search without writing fx_eval scripts: navigates to the engine results page, waits for the results container, and returns structured rows {title, link, snippet} — the in-DOM href, which for some engines (Google /goto) is a redirect wrapper hiding the real URL. Engine presets: google (default), bing, duckduckgo — their selectors are swappable data: override with container/title/snippet for other engines or when an engine changes its DOM. With resolve:true each result is followed in the real browser (no CORS issue) and reports the genuine final URL + page title; the browser is left on the results page.', { query: { type: 'string' }, engine: { type: 'string', description: 'google | bing | duckduckgo (default google)' }, max: { type: 'number', description: 'max results (default 8, cap 25)' }, resolve: { type: 'boolean', description: 'follow each link and report the real final URL + title (default false)' }, container: { type: 'string', description: 'override results-container selector' }, title: { type: 'string', description: 'override title selector' }, snippet: { type: 'string', description: 'override snippet selector' }, wait_ms: { type: 'number', description: 'how long to wait for the results container (default 10000, max 30000)' } }, async (a) => {
    const q = String(a.query || '').trim();
    if (!q) throw new Error('fx_search: query required');
    const eng = SEARCH_ENGINES[a.engine || 'google'];
    if (!eng) throw new Error('fx_search: unknown engine "' + (a.engine || 'google') + '" — use google|bing|duckduckgo, or pass container/title/snippet for a custom one');
    const container = a.container || eng.container;
    const titleSel = a.title || eng.title;
    const snippetSel = a.snippet || eng.snippet;
    if (a.container) await checkCss(a.container);
    const url = eng.url(q);
    await M.cmd('WebDriver:Navigate', { url });
    const waitMs = Math.min(30000, Math.max(500, Number(a.wait_ms) || 10000));
    const t0 = Date.now();
    let ready = false;
    for (;;) {
      try { ready = !!(await execJs('return !!document.querySelector(arguments[0]);', [container])); } catch { ready = false; }
      if (ready || Date.now() - t0 > waitMs) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    const n = Math.max(1, Math.min(25, a.max != null ? Number(a.max) : 8));
    const rows = await execJs(`/*__fxsearch__*/
  function firstText(el, spec, len) {
    try {
      var parts = String(spec).split(',');
      for (var i = 0; i < parts.length; i++) {
        var e = el.querySelector(parts[i].trim());
        if (e) { var t = String(e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim(); if (t) return t.slice(0, len); }
      }
    } catch (x) {}
    return '';
  }
  var sel = arguments[0], title = arguments[1], snip = arguments[2], max = arguments[3];
  var out = []; var seen = {};
  var cs;
  try { cs = document.querySelectorAll(sel); } catch (e) { return out; }
  for (var i = 0; i < cs.length && out.length < max; i++) {
    var c = cs[i];
    var t = firstText(c, title, 200);
    if (!t) continue;
    var link = '';
    try {
      var as = c.querySelectorAll('a[href]');
      for (var j = 0; j < as.length; j++) { if (as[j].href) { link = as[j].href; break; } }
    } catch (x) {}
    var key = link || t;
    if (seen[key]) continue;
    seen[key] = 1;
    out.push({ i: out.length, title: t, link: link, snippet: firstText(c, snip, 300) });
  }
  return out;
  `, [container, titleSel, snippetSel, n]);
    if (!Array.isArray(rows)) throw new Error('fx_search: unexpected page result ' + typeof rows);
    const serp = (await pageInfo()).url;
    if (a.resolve === true) {
      for (const r of rows) {
        if (!r.link) continue;
        try {
          await M.cmd('WebDriver:Navigate', { url: r.link });
          await waitForComplete(15000);
          const pi = await pageInfo();
          r.resolvedUrl = pi.url;
          r.resolvedTitle = pi.title;
        } catch (e) { r.resolveError = String((e && e.message) || e).slice(0, 200); }
        await M.cmd('WebDriver:Navigate', { url: serp }).catch(() => {});
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return { engine: a.engine || 'google', query: q, url: serp, ready, count: rows.length, results: rows };
  }),
  T('fx_eval', 'Execute JS in the page. `js` is tried as an EXPRESSION first — its completion value is returned, so `1 + 1`, `document.title`, `var x = 1; x`, `(async () => { … })()` and `fetch(u).then(r => r.json())` all work without `return`. If that fails with a SyntaxError (classic function-body style with a top-level `return`), it is re-run as a function body — so `return value` scripts work too. A rejected or Promise value is awaited (default max 30s, wait_ms to tune) and returned as {r: value, awaited: true}; a rejected or long-unsettled Promise is an error.', { js: { type: 'string' }, wait_ms: { type: 'number', description: 'max wait for a Promise-returning body (default 30000, max 120000)' } }, async (a) => {
    const w = await execJs(EVAL_WRAP, [String(a.js)]);
    if (!w || typeof w !== 'object' || typeof w.__fx !== 'string') {
      throw new Error('fx_eval: unexpected driver response (no eval wrapper tag)');
    }
    if (w.__fx === 'err') throw new Error('fx_eval page error: ' + (w.m || 'unknown'));
    if (w.__fx === 'ok') return { r: w.v };
    const ms = Math.min(120000, Math.max(0, Number(a.wait_ms) || 30000));
    const t0 = Date.now();
    for (;;) {
      const p = await execJs(EVAL_POLL, []);
      if (p && typeof p === 'object' && typeof p.__fx === 'string') {
        if (p.__fx === 'err') throw new Error('fx_eval: Promise rejected: ' + (p.m || 'unknown'));
        return { r: p.v, awaited: true };
      }
      if (Date.now() - t0 > ms) throw new Error('fx_eval: Promise did not settle within ' + ms + ' ms');
      await new Promise((r) => setTimeout(r, 150));
    }
  }),
  T('fx_wait', 'Wait until visible text (or CSS selector exists). Text search looks inside open shadow roots too. Default 10s, max 30s', { text: { type: 'string' }, selector: { type: 'string' }, timeout_ms: { type: 'number' } }, async (a) => {
    const ms = Math.min(30000, a.timeout_ms || 10000);
    const t0 = Date.now();
    for (;;) {
      let hit = false;
      try {
        hit = a.selector
          ? await execJs(`return !!document.querySelector(arguments[0]);`, [a.selector])
          : await execJs(`return (function(t){ function all(rt,out){ out=out||[]; out.push(rt); var els; try{els=rt.querySelectorAll('*');}catch(e){return out;} for(var i=0;i<els.length;i++){ if(els[i].shadowRoot) all(els[i].shadowRoot,out); } return out; } var roots=all(document); for(var i=0;i<roots.length;i++){ var tx=roots[i].textContent||''; if(tx.indexOf(t)>=0) return 1; } return 0; })(arguments[0]);`, [a.text || '']);
      } catch { /* keep polling */ }
      if (hit) return { ok: true, ms: Date.now() - t0 };
      if (Date.now() - t0 > ms) return { ok: false, ms: Date.now() - t0 };
      await new Promise((r) => setTimeout(r, 500));
    }
  }),
  T('fx_screenshot', 'Full-page PNG (Marionette captures the entire scrollable document, not just the viewport) to a file under an allowed root (or explicit allowed path)', { path: { type: 'string' } }, async (a) => {
    const dest = a.path || '/tmp/marionette-mcp/shot_' + Date.now() + '.png';
    const abs = path.resolve(dest);
    if (!allowedPath(abs)) throw new Error('path outside allowed roots');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const r = await M.cmd('WebDriver:TakeScreenshot', {});
    fs.writeFileSync(abs, Buffer.from(String(r.value), 'base64'));
    return { path: abs };
  }),
  T('fx_windows', 'List windows (focused marked)', {}, async () => {
    const r = await M.cmd('WebDriver:GetWindowHandles');
    const cur = await M.cmd('WebDriver:GetWindowHandle');
    return { windows: (r.value || []).map((h) => ({ handle: h, focused: h === cur.value })), current: cur.value };
  }),
  T('fx_window', 'Switch active window by handle', { handle: { type: 'string' } }, async (a) => {
    await M.cmd('WebDriver:SwitchToWindow', { handle: a.handle, focus: true });
    return { ok: true };
  }),
  T('fx_alert_state', 'Text of an open native dialog', {}, async () => {
    const r = await M.cmd('WebDriver:GetAlertText');
    return { text: r.value };
  }),
  T('fx_alert_accept', 'Accept (OK) the open native dialog', {}, async () => {
    await M.cmd('WebDriver:AcceptAlert');
    return { ok: true };
  }),
  T('fx_alert_dismiss', 'Dismiss (Cancel) the open native dialog', {}, async () => {
    await M.cmd('WebDriver:DismissAlert');
    return { ok: true };
  }),
  T('fx_cookies', 'Cookies of the current origin (names/domains only)', {}, async () => {
    const r = await M.cmd('WebDriver:GetCookies', {});
    return { cookies: (r.value || []).slice(0, 50).map((c) => ({ name: c.name, domain: c.domain, path: c.path })) };
  }),
];

// ---------------- MCP stdio plumbing ----------------
let connected = false;
async function ensureConn() {
  if (connected && M.sock && !M.sock.destroyed) return;
  await M.connect();
  if (!M.sessionId) await M.init();
  connected = true;
}

function toolResult(payload, opts) {
  const isError = !!(opts && opts.isError);
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.text !== 'string') {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 1) }], isError };
  }
  // A pure {text: <string>} wrapper (e.g. fx_alert_state) carries its content in
  // `text` — String(payload) would render "[object Object]" and lose it.
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.text === 'string' && Object.keys(payload).length === 1) {
    return { content: [{ type: 'text', text: payload.text }], isError };
  }
  return { content: [{ type: 'text', text: String(payload ?? '') }], isError };
}

// ---------------- bootstrap: no reachable Firefox yet ----------------
// The stdio server process lives with one automation session (e.g. one opencode
// session). Its first browser call probes the configured endpoint; when no
// Marionette Firefox is reachable, the tool does not fail with a raw error — it
// returns a structured DECISION payload (isError) with three options, and the
// agent asks the user which one: start a NEW dedicated instance (fx_launch,
// port set via profile user.js PREFERENCES — there is no --marionette-port
// flag), attach to an ALREADY-RUNNING instance (fx_connect with host/port the
// user provides), or do something else (user-directed). fx_status is exempt
// and always reports state; fx_launch/fx_shutdown/fx_connect act on it.
const BOOTSTRAP_EXEMPT = new Set(['fx_status', 'fx_connect', 'fx_launch', 'fx_shutdown']);

function classifyConnError(e) {
  const m = String((e && e.message) || e);
  if (/nothing is listening|econnrefused|refused/i.test(m)) return 'nothing-listening';
  if (/econnreset|reset/i.test(m)) return 'busy-other-client';
  if (/timeout|err_socket/i.test(m)) return 'timeout';
  return 'error';
}

function bootstrapOptions(probe) {
  const where = M.host + ':' + M.port;
  let question;
  let option2;
  if (probe === 'busy-other-client') {
    question = 'Something answers on ' + where + ' but drops the connection — a Marionette browser there likely already holds another active client (Marionette serves ONE client per browser). What should I do?';
    option2 = { id: 2, tool: 'fx_connect', do: 'Free the other client (or ask the user to close it / point at the right port), then re-attach: fx_connect {host, port}.' };
  } else {
    question = probe === 'timeout'
      ? 'Could not complete a connection to ' + where + ' in time — nothing usable is listening there. What should I do?'
      : 'No Marionette-enabled Firefox is reachable on ' + where + ' — this session has no browser yet. What should I do?';
    option2 = { id: 2, tool: 'fx_connect', do: 'Connect to an ALREADY-RUNNING Firefox: ask the user for its loopback {host, port} (port 2828 → plain `firefox --marionette`; custom port → that port must be set in the profile user.js, as user_pref("marionette.port", N)) and call fx_connect {host, port}.' };
  }
  return {
    question,
    options: [
      { id: 1, tool: 'fx_launch', do: 'Start a NEW dedicated Firefox: fresh profile on a NEW port, the port written to the profile user.js pref marionette.port (no CLI flag exists for it). fx_launch {} auto-picks a free port; fx_launch {port} picks a specific one. It will start empty — no cookies/logins from your daily profile.' },
      option2,
      { id: 3, tool: null, do: 'Something else: follow the user’s direction — e.g. they launch Firefox themselves (their profile, their port) and give us the endpoint, or we reconfigure FX_MARIONETTE_HOST/PORT and retry later.' },
    ],
  };
}

// ---------------- launching a dedicated Firefox (bootstrap option 1) ----------------
// The port is NEVER a launch flag — Firefox has no --marionette-port. A fresh
// profile gets the port via user.js PREFERENCES (user_pref marionette.port /
// marionette.enabled), then we run `firefox --marionette --no-remote -profile
// <dir>` detached, wait for its listener, and re-point this server at it.
const LAUNCHED = new Map(); // port -> { pid, profile, ts }

function launchedInfo() {
  const recs = [];
  for (const [p, r] of LAUNCHED) recs.push({ port: p, pid: r.pid, profile: r.profile });
  return { launched: recs, launchedCurrent: LAUNCHED.has(M.port) && M.host === '127.0.0.1' };
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function portOpen(host, port) {
  return new Promise((res) => {
    const s = net.connect(port, host);
    s.setTimeout(800, () => { s.destroy(); res(false); });
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
  });
}

function portFree(host, port) {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', () => res(false));
    srv.listen(port, host, () => srv.close(() => res(true)));
  });
}

async function pickFreePort(span = 50) {
  for (let p = PORT + 1; p < PORT + 1 + span && p < 65535; p++) {
    if (await portFree('127.0.0.1', p)) return p;
  }
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const p = srv.address().port;
  srv.close();
  return p;
}

function resolveLaunchCommand() {
  if (FIREFOX_BIN) {
    const parts = FIREFOX_BIN.trim().split(/\s+/);
    return { bin: parts[0], preArgs: parts.slice(1) };
  }
  const cands = [];
  try {
    const w = spawnSync('which', ['firefox', 'firefox-esr'], { encoding: 'utf8' });
    for (const line of String(w.stdout || '').split('\n')) { const b = line.trim(); if (b) cands.push(b); }
  } catch { /* no which */ }
  cands.push('/usr/bin/firefox', '/usr/local/bin/firefox', '/snap/bin/firefox', '/usr/lib/firefox/firefox', '/opt/homebrew/bin/firefox', '/usr/bin/firefox-esr');
  for (const b of cands) if (fs.existsSync(b)) return { bin: b, preArgs: [] };
  return { bin: 'firefox', preArgs: [] }; // let spawn fail with a named-binary error
}

// Idempotent: writes the two Marionette prefs into the profile user.js only if
// they are not already present (a later user_pref line overrides an earlier one).
function ensureUserJs(profile, port) {
  fs.mkdirSync(profile, { recursive: true });
  const f = path.join(profile, 'user.js');
  let cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace(/\s+$/, '') : '';
  const add = [];
  for (const pref of ['user_pref("marionette.enabled", true);', 'user_pref("marionette.port", ' + port + ');']) {
    if (!cur.includes(pref)) add.push(pref);
  }
  if (add.length) cur = (cur ? cur + '\n' : '') + add.join('\n') + '\n';
  fs.writeFileSync(f, cur);
}

async function launchInstance({ port, profile }) {
  const { bin, preArgs } = resolveLaunchCommand();
  ensureUserJs(profile, port);
  const child = spawn(bin, [...preArgs, '--marionette', '--no-remote', '-profile', profile], { detached: true, stdio: 'ignore' });
  child.unref();
  const rec = { pid: child.pid, profile, ts: new Date().toISOString() };
  LAUNCHED.set(port, rec);
  try { fs.writeFileSync(path.join(profile, '.marionette-mcp-launched.json'), JSON.stringify(rec, null, 1) + '\n'); } catch { /* best effort */ }
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 30000 && !up) {
    up = await portOpen('127.0.0.1', port);
    if (!up) await new Promise((r) => setTimeout(r, 400));
  }
  if (!up) {
    try { process.kill(rec.pid, 'SIGKILL'); } catch { /* already gone */ }
    LAUNCHED.delete(port);
    throw new Error('Firefox (binary: ' + bin + ') did not open a Marionette listener on 127.0.0.1:' + port + ' within 30 s — launch aborted, process killed');
  }
  M.host = '127.0.0.1';
  M.port = port;
  if (M.sock && !M.sock.destroyed) { try { M.sock.destroy(); } catch { /* ignore */ } }
  M.sock = null;
  M.sessionId = null;
  M.pending.clear();
  connected = false;
  await ensureConn();
  return rec;
}

async function doLaunch(args) {
  let port = args.port != null ? Number(args.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('port must be an integer 1..65535');
  if (port === undefined) port = await pickFreePort();
  const profile = args.profile != null ? path.resolve(String(args.profile)) : path.join(PROFILE_ROOT, 'marionette-mcp-' + port);
  const ours = LAUNCHED.get(port);
  if (ours && pidAlive(ours.pid) && await portOpen('127.0.0.1', port)) {
    M.host = '127.0.0.1';
    M.port = port;
    if (M.sock && !M.sock.destroyed) { try { M.sock.destroy(); } catch { /* ignore */ } }
    M.sock = null;
    M.sessionId = null;
    M.pending.clear();
    connected = false;
    await ensureConn();
    return { started: 'reused-launched', pid: ours.pid, port, profile: ours.profile };
  }
  if (await portOpen('127.0.0.1', port)) {
    throw new Error('port ' + port + ' is already in use by something else — pick another port, or use fx_connect {host: "127.0.0.1", port: ' + port + '} to attach to it');
  }
  const rec = await launchInstance({ port, profile });
  return { started: 'new-instance', pid: rec.pid, port, profile };
}

async function handle(obj) {
  if (!obj || obj.jsonrpc !== '2.0') return null;
  const { id, method, params } = obj;
  let result;
  let isError = false;
  try {
    if (method === 'initialize') {
      result = {
        protocolVersion: (params && params.protocolVersion) || '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'marionette-mcp', version: VERSION },
      };
    } else if (method === 'ping') {
      result = {};
    } else if (method === 'tools/list') {
      result = { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
    } else if (method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) throw new Error('unknown tool: ' + params.name);
      let payload;
      let autoStarted = null;
      if (!BOOTSTRAP_EXEMPT.has(tool.name)) {
        try {
          await ensureConn();
        } catch (e) {
          const probe = classifyConnError(e);
          if (probe === 'error') throw e;
          if (AUTO_LAUNCH && probe === 'nothing-listening') {
            const l = await doLaunch({});
            autoStarted = { started: l.started, pid: l.pid, port: l.port, profile: l.profile };
            // fall through: the tool now runs against the freshly started instance
          } else {
            payload = { ok: false, need_bootstrap: true, probe, endpoint: { host: M.host, port: M.port }, ...bootstrapOptions(probe) };
          }
        }
      }
      if (payload === undefined) payload = await tool.fn(params.arguments || {});
      if (autoStarted && payload !== undefined) {
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) payload = Object.assign({}, payload, { auto_started: autoStarted });
        else payload = JSON.stringify({ auto_started: autoStarted, result: payload });
      }
      result = toolResult(payload, { isError: payload !== undefined && payload.ok === false && payload.need_bootstrap === true });
      isError = result.isError;
    } else if (typeof method === 'string' && method.startsWith('notifications/')) {
      result = null; // client notification (e.g. notifications/initialized) — acknowledge, no response
    } else {
      throw new Error('unsupported method: ' + method);
    }
  } catch (e) {
    result = { content: [{ type: 'text', text: 'ERROR: ' + ((e && e.message) || e) }], isError: true };
    isError = true;
  }
  log(method, isError ? 'IS_ERR' : 'ok');
  if (id === undefined) return null; // notification
  return { jsonrpc: '2.0', id, result };
}

let stdinBuf = '';
let stdinEof = false;
let draining = false;
const queue = [];
process.stdin.setEncoding('utf8');
process.on('SIGINT', () => process.exit(130));

async function drain() {
  if (draining) return;
  draining = true;
  for (const obj of queue.splice(0)) {
    try {
      const resp = await handle(obj);
      if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
    } catch (e) {
      log('FATAL', e.message);
    }
  }
  draining = false;
  if (stdinEof) {
    if (M.sock && !M.sock.destroyed) M.sock.destroy();
    process.exit(0);
  }
}

function enqueue(chunk) {
  stdinBuf += chunk;
  let nl;
  while ((nl = stdinBuf.indexOf('\n')) >= 0) {
    const line = stdinBuf.slice(0, nl).trim();
    stdinBuf = stdinBuf.slice(nl + 1);
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    queue.push(obj);
  }
  drain();
}

process.stdin.on('data', enqueue);
process.stdin.on('end', () => { stdinEof = true; drain(); });
log('marionette-mcp ready on', HOST + ':' + PORT, 'file roots:', FILE_ROOTS.join(' '), 'autoLaunch:', AUTO_LAUNCH, 'profileRoot:', PROFILE_ROOT);
