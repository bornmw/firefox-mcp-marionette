// marionette.mjs — async Marionette TCP client (one session, one socket)
import net from 'node:net';
import { encodeFrame, createFrameParser, frameKind } from './protocol.mjs';

const noop = () => {};

export class Marionette {
  constructor({ host = '127.0.0.1', port = 2828, helloWaitMs = 1200, connectTimeoutMs = 60000, commandTimeoutMs = 120000, initialPage = 'blank', log = noop } = {}) {
    this.host = host;
    this.port = port;
    this.helloWaitMs = helloWaitMs;
    this.connectTimeoutMs = connectTimeoutMs;
    // Bound every in-flight command: the browser may not answer (modal dialog,
    // mid-navigation, hung page). Without this a single never-settling command
    // wedges the whole MCP server (commands are serialized upstream).
    this.commandTimeoutMs = commandTimeoutMs;
    // 'blank' (default): after session start, redirect a non-web initial tab
    // (chrome://…/blanktab.html on fresh profiles, any chrome:// / about: page)
    // to about:blank so content-scope commands work immediately. 'newtab': leave
    // the initial tab untouched. Web/file pages are never redirected.
    this.initialPage = initialPage;
    this.log = log;
    this.sock = null;
    this.parser = null;
    this.nextId = 1;
    this.pending = new Map();
    this.hello = null;
    this.sessionId = null;
  }

  connect() {
    if (this.sock && !this.sock.destroyed) return Promise.resolve();
    this.pending.clear();
    this.sessionId = null;
    return new Promise((resolve, reject) => {
      const s = net.connect(this.port, this.host);
      s.setTimeout(this.connectTimeoutMs);
      s.on('timeout', () => s.destroy(new Error('connect timeout')));
      s.once('error', (e) => reject(new Error('connect: ' + ((e && e.message) || e) + this._hint(e))));
      s.on('connect', () => {
        s.setTimeout(0); // cancel: no idle timeout once connected
        this.sock = s;
        this.parser = createFrameParser({
          onFrame: (msg) => this._onFrame(msg),
          onDrop: (reason, head) => this.log('frame dropped:', reason, head && head.toString().slice(0, 80)),
        });
        // Only react to events from the socket that is CURRENTLY active. A
        // superseded socket (e.g. one we just dropped on a command-timeout
        // poison) can emit late error/close events after we've reconnected;
        // acting on those would destroy the fresh, healthy socket.
        s.on('error', (e) => { if (this.sock === s) this._fail('browser connection lost: ' + e.message); });
        s.on('close', () => { if (this.sock === s) this._fail('browser connection lost: socket closed'); });
        s.on('data', (d) => this.parser.push(d));
        resolve();
      });
    });
  }

  // Actionable guidance appended to connect errors, so a port mismatch is
  // self-explanatory: this MCP only ATTACHES to a Firefox you launched — it does
  // not start one. Note there is NO --marionette-port CLI flag; non-default ports
  // are set via the profile preference `marionette.port`.
  _hint(e) {
    const what = String((e && e.code) || (e && e.message) || e);
    const where = this.host + ':' + this.port;
    if (/econnrefused|refused/i.test(what)) {
      return ' — nothing is listening on ' + where + '. Launch a dedicated Firefox with Marionette on THAT port: default port → `firefox --marionette`. Custom port → create a profile and set marionette.port=' + this.port + ' and marionette.enabled=true in its user.js (there is no --marionette-port CLI flag), then run: `firefox --marionette --no-remote -profile <that-profile>`. You can also point this MCP at an instance that is already running via fx_connect {host, port}.';
    }
    if (/econnreset|reset/i.test(what)) {
      return ' — the connection to ' + where + ' dropped. The port may be busy (Marionette serves ONE active client at a time — another automation may be attached) or the browser may have restarted. Free it, or re-attach with fx_connect {host, port}.';
    }
    if (/timeout|ERR_SOCKET/i.test(what)) {
      return ' — could not complete a connection to ' + where + ' in time. Check that a Marionette-enabled Firefox is actually listening on that port (see fx_status for the active endpoint).';
    }
    return '';
  }

  _fail(msg) {
    if (!this.sock) return;
    const s = this.sock;
    this.sock = null;
    this.sessionId = null;
    const pend = [...this.pending.values()];
    this.pending.clear();
    this.log('socket fail:', msg);
    try { s.destroy(); } catch { /* ignore */ }
    pend.forEach((p) => p.reject(new Error(msg)));
  }

  _onFrame(msg) {
    const kind = frameKind(msg);
    if (kind === 'hello') {
      this.hello = msg;
      return;
    }
    if (kind !== 'response' || !Array.isArray(msg)) return;
    const [, id, err, res] = msg;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (err) {
      let m = msg[2];
      if (m && typeof m === 'object') {
        m = m.stacktrace ? (m.message || m.error || JSON.stringify(m.error)) : (m.message || JSON.stringify(m));
      }
      p.reject(new Error(String(m).slice(0, 4000)));
    } else {
      p.resolve(res ?? {});
    }
  }

  // Raw protocol send (no recovery).
  _sendRaw(name, params) {
    if (!this.sock || this.sock.destroyed) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    this.sock.write(encodeFrame([0, id, name, params ?? {}]));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const t = setTimeout(() => {
        // Still pending after the bound: the command never settled. Poison the
        // connection (reject all in-flight, destroy socket) so the next command
        // reconnects fresh instead of continuing on a desynced stream.
        if (this.pending.has(id)) this._fail('command timeout after ' + this.commandTimeoutMs + ' ms: ' + name);
      }, this.commandTimeoutMs);
      if (typeof t.unref === 'function') t.unref();
    });
  }

  // Send with privileged-scope recovery. Recent Firefox (observed on 160)
  // refuses content-scope commands — ExecuteScript, FindElement, ElementClick,
  // ElementSendKeys, TakeScreenshot, alert commands, cookies and 27 more (35 of
  // 55 driver commands) — while the current tab is a non-web page (the
  // fresh-profile tab chrome://…/blanktab.html, any chrome:// or about: page)
  // with: "The command does not support browsing contexts in privileged scope".
  // Recovery: navigate the blank/internal tab to about:blank (privileged-safe)
  // and retry the command ONCE. NewSession is excluded (no session yet — nothing
  // to navigate); Navigate/GetCurrentURL cannot raise the error (they skip the
  // privilege check). A retried element command may fail with a fresh, accurate
  // error (stale element) — expected, and more useful than the scope error.
  async send(name, params) {
    try {
      return await this._sendRaw(name, params);
    } catch (e) {
      if (name === 'WebDriver:NewSession') throw e;
      if (!/does not support browsing contexts in privileged scope/i.test(String((e && e.message) || e))) throw e;
      this.log('privileged-scope failure on ' + name + ' — navigating to about:blank and retrying once');
      await this._sendRaw('WebDriver:Navigate', { url: 'about:blank' }).catch((ne) => this.log('recovery navigation failed:', ne.message));
      return this._sendRaw(name, params);
    }
  }

  // Wait for the on-connect hello, then open a session.
  // When initialPage === 'blank' (default), a non-web initial tab (the
  // fresh-profile chrome://…/blanktab.html, about:newtab, any chrome:// page) is
  // redirected to about:blank so content-scope commands work immediately.
  // 'newtab' leaves the initial tab untouched (the send() recovery above still
  // protects individual commands). Web/file pages are never redirected.
  async init() {
    await new Promise((r) => setTimeout(r, this.helloWaitMs));
    const r = await this.send('WebDriver:NewSession', { strictFileInteractability: true });
    this.sessionId = r.sessionId;
    if (this.initialPage === 'blank') {
      try {
        const cur = await this._sendRaw('WebDriver:GetCurrentURL', {});
        const url = String((cur && cur.value) || '');
        if (url && !/^(https?|file):/i.test(url)) {
          await this._sendRaw('WebDriver:Navigate', { url: 'about:blank' });
          this.log('initial tab "' + url + '" → about:blank');
        }
      } catch (e) {
        this.log('initial-page normalize skipped:', e.message);
      }
    }
    this.log('session', this.sessionId, 'protocol', this.hello && this.hello.marionetteProtocol);
    return this.sessionId;
  }

  // Auto-connects and auto-opens a session on first use (and after a loss).
  cmd(name, params) {
    if (!this.sessionId) {
      const ready = this.sock && !this.sock.destroyed ? Promise.resolve() : this.connect();
      return ready.then(() => this.init()).then(() => this.send(name, params));
    }
    return this.send(name, params);
  }
}
