// fake_marionette.mjs — an in-process TCP server that speaks the Marionette wire
// protocol well enough to exercise the real client:
//   * sends the on-connect hello
//   * verifies every incoming frame: pure ASCII, prefix length == body bytes, valid JSON
//   * records frames; replies with canned responses per command name
import net from 'node:net';
import { W3C_ELEMENT_KEY } from '../../src/protocol.mjs';

const SNAPSHOT_ROWS = [
  { k: 'h', t: 'Form' },
  { k: 'input:text', x: '/html/body/input[1]', t: '', css: '#name', id: 'name', ph: 'Full name', al: '', val: '', sel: '', dis: '' },
  { k: 'input:password', x: '/html/body/input[2]', t: '', css: '#pw', id: 'pw', ph: '', al: '', val: '-pw-', sel: '', dis: '' },
  { k: 'button:submit', x: '/html/body/button[1]', t: 'Go', css: '#go', id: 'go', ph: '', al: '', val: '', sel: '', dis: '' },
];

// port = 0 (default) → ephemeral; a fixed port is used by fake_firefox.mjs,
// which must honor the marionette.port preference written into its profile.
export function startFakeMarionette(port = 0) {
  const state = {
    frames: [],
    violations: [],
    sockets: new Set(),
  };
  const server = net.createServer((sock) => {
    state.sockets.add(sock);
    sock.on('close', () => state.sockets.delete(sock));
    const hello = JSON.stringify({ applicationType: 'gecko', marionetteProtocol: 3 });
    sock.write(Buffer.from(hello.length + ':' + hello, 'ascii'));

    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const c = buf.indexOf(':');
        if (c < 0) return;
        const prefix = buf.subarray(0, c).toString('ascii');
        const len = /^\d+$/.test(prefix) ? Number(prefix) : NaN;
        if (!Number.isSafeInteger(len) || len < 0) { state.violations.push('bad-prefix:' + prefix.slice(0, 16)); return; }
        if (buf.length < c + 1 + len) return;
        const body = buf.subarray(c + 1, c + 1 + len);
        buf = buf.subarray(c + 1 + len);
        let nonAscii = 0;
        for (let i = 0; i < body.length; i++) if (body[i] > 0x7f) { nonAscii++; break; }
        if (nonAscii) state.violations.push('non-ascii-body');
        let msg = null;
        try { msg = JSON.parse(body.toString('utf8')); } catch { state.violations.push('bad-json'); continue; }
        state.frames.push(msg);
        if (state.hang) return; // simulate a command the browser never answers (wedge test)
        const [, id, name, params] = msg;
        try {
          const reply = JSON.stringify(respond(id, name, params, state));
          for (const ch of reply) if (ch.charCodeAt(0) > 0x7f) throw new Error('fake reply not ascii');
          sock.write(Buffer.from(reply.length + ':' + reply, 'ascii'));
        } catch (e) {
          state.violations.push('reply-fail:' + e.message);
        }
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e));
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      resolve({
        port: p,
        state,
        closeAll: () => {
          for (const s of [...state.sockets]) s.destroy();
        },
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function respond(id, name, params, state) {
  switch (name) {
    case 'WebDriver:NewSession':
      return [1, id, null, { sessionId: 'fake-sess-1', capabilities: { browserName: 'firefox' } }];
    case 'WebDriver:GetTitle': return [1, id, null, { value: 'Fake Page' }];
    case 'WebDriver:GetCurrentURL': return [1, id, null, { value: 'https://fake.test/' }];
    case 'WebDriver:Navigate': return [1, id, null, {}];
    case 'WebDriver:FindElement': return [1, id, null, { value: { [W3C_ELEMENT_KEY]: 'el-uuid-1' } }];
    case 'WebDriver:ElementClick':
      if (state.clickErrorOnce) { const m = state.clickErrorOnce; state.clickErrorOnce = null; return [1, id, { error: 'invalid', message: m }, null]; }
      if (state.clickFailOnce) { state.clickFailOnce = null; return [1, id, { error: 'element click intercepted', message: 'Message: Element <button class="x"> is not clickable at point (1188,362) because another element <div class="y"> obscures it' }, null]; }
      return [1, id, null, {}];
    case 'WebDriver:ElementClear':
    case 'WebDriver:ElementSendKeys':
    case 'WebDriver:SwitchToWindow': return [1, id, null, {}];
    case 'WebDriver:TakeScreenshot': return [1, id, null, { value: Buffer.from('FAKEPNG').toString('base64') }];
    case 'WebDriver:GetWindowHandles': return [1, id, null, { value: ['w1'] }];
    case 'WebDriver:GetWindowHandle': return [1, id, null, { value: 'w1' }];
    case 'WebDriver:GetCookies': return [1, id, null, { value: [] }];
    case 'WebDriver:GetAlertText': return [1, id, null, { value: 'dialog?' }];
    case 'WebDriver:AcceptAlert':
    case 'WebDriver:DismissAlert': return [1, id, null, {}];
    case 'WebDriver:ExecuteScript': {
      const s = String(params && params.script || '');
      // fx_eval two-phase: the wrapper (sentinel __fxeval__) always reports the
      // body's Promise as pending; the poll (sentinel __fxpoll__) settles per
      // test mode: 'evalok' settles on the first poll, anything else never does.
      if (s.includes('__fxeval__')) return [1, id, null, { value: { __fx: 'pend' } }];
      if (s.includes('__fxpoll__')) {
        state.pollCount = (state.pollCount || 0) + 1;
        if (state.mode === 'evalok' && state.pollCount === 1) return [1, id, null, { value: { __fx: 'ok', v: 42 } }];
        return [1, id, null, { value: null }];
      }
      // in-page CSS validation (sentinel __csscheck__): reject :has()
      if (s.includes('__csscheck__')) {
        const sel = String((params && params.args && params.args[0]) || '');
        if (sel.includes(':has(')) return [1, id, null, { value: 'bad:SyntaxError: (fake) unsupported selector syntax' }];
        return [1, id, null, { value: 'ok' }];
      }
      // fx_answer main lookup (sentinel __answerfind__): scripted per-test via
      // state.answerFindSeq (array of payload objects, shifted per call).
      if (s.includes('__answerfind__')) {
        const seq = state.answerFindSeq;
        if (seq && seq.length) return [1, id, null, { value: seq.shift() }];
        return [1, id, null, { value: { error: 'no-choice-controls' } }];
      }
      // fx_answer wrapper fallback (sentinel __answerfallback__)
      if (s.includes('__answerfallback__')) {
        return [1, id, null, { value: state.answerFallback || { error: 'no-fallback-option' } }];
      }
      // fx_answer state re-read after fallback click (sentinel __answerreread__)
      if (s.includes('__answerreread__')) {
        return [1, id, null, { value: state.answerReread || 'unknown' }];
      }
      // fx_click obscuring hit-test (sentinel __clicktop__)
      if (s.includes('__clicktop__')) {
        return [1, id, null, { value: state.clickTop || { mode: 'clear' } }];
      }
      // fx_gates (sentinel __gates__)
      if (s.includes('__gates__')) {
        const g = state.gates || { boxes: [], disabledButtons: [], banners: [] };
        return [1, id, null, { value: g }];
      }
      // must precede the generic querySelectorAll branch (these scripts contain that string)
      if (s.includes('__fxlinks__')) {
        return [1, id, null, { value: [
          { i: 0, text: 'Example Domain', href: 'https://example.com/' },
          { i: 1, text: 'Wrapped destination', href: 'https://www.google.com/goto?url=TOKEN1' },
        ] }];
      }
      if (s.includes('__fxextract__')) {
        // mirror the real semantics: without fields → {i,text}; with fields {k: "text"|css} → per-field
        const fields = (params && params.args && params.args[1]) || null;
        const src = [{ title: 'Row one', text: 'Body text one' }, { title: 'Row two', text: 'Body text two' }];
        const rows = src.map((row, i) => {
          const out = { i };
          if (!fields) out.text = row.text;
          else for (const k of Object.keys(fields)) out[k] = fields[k] === 'text' ? row.text : (row[k] || '');
          return out;
        });
        return [1, id, null, { value: rows }];
      }
      if (s.includes('__fxsearch__')) {
        return [1, id, null, { value: [
          { i: 0, title: 'Result one', link: 'https://one.example/a', snippet: 'Snippet one' },
          { i: 1, title: 'Result two', link: 'https://two.example/b', snippet: 'Snippet two' },
        ] }];
      }
      // NOTE: the pageInfo script also contains "document.readyState", so this
      // generic branch must come AFTER the JSON.stringify({webdriver} check below.
      if (s.includes('JSON.stringify({webdriver')) {
        const v = JSON.stringify({ webdriver: false, url: 'https://fake.test/', title: 'Fake Page', ready: 'complete' });
        return [1, id, null, { value: v }];
      }
      if (s.includes('document.readyState')) return [1, id, null, { value: 'complete' }];
      if (s.includes('el.files')) return [1, id, null, { value: 'upload.csv' }];
      if (s.includes('querySelectorAll')) return [1, id, null, { value: SNAPSHOT_ROWS }];
      if (s.includes('innerText.indexOf')) return [1, id, null, { value: true }];
      if (s.includes('querySelector(arguments')) return [1, id, null, { value: true }];
      return [1, id, null, { value: 'script-ok' }];
    }
    case 'WebDriver:BoomError':
      return [1, id, { error: 'boom', message: 'something failed' }, null];
    default:
      return [1, id, { error: 'unknownCommand', message: name }, null];
  }
}
