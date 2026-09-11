#!/usr/bin/env node
// Live smoke test — requires a user-launched `firefox --marionette`.
// Usage:
//   firefox --marionette &        # separate profile recommended
//   node scripts/e2e-live.mjs [port]
// Optional: E2E_URL=<url> to navigate somewhere specific.
import fs from 'node:fs';
import { Marionette } from '../src/marionette.mjs';

const port = Number(process.argv[2] || process.env.FX_MARIONETTE_PORT || 2828);
const m = new Marionette({ port, log: (...a) => console.error('[log]', ...a) });

try {
  await m.connect();
  const sid = await m.init();
  console.log('session:', sid, 'protocol:', m.hello && m.hello.marionetteProtocol);

  const page = await m.cmd('WebDriver:ExecuteScript', {
    script: 'return JSON.stringify({url: location.href, title: document.title, webdriver: navigator.webdriver});',
    args: [],
  });
  console.log('page:', page.value);

  await m.cmd('WebDriver:Navigate', { url: process.env.E2E_URL || 'https://example.com/' });
  const after = await m.cmd('WebDriver:GetCurrentURL');
  console.log('navigated to:', after.value);

  const shot = await m.cmd('WebDriver:TakeScreenshot', {});
  const out = '/tmp/firefox-mcp-marionette-live-shot.png';
  fs.mkdirSync('/tmp', { recursive: true });
  fs.writeFileSync(out, Buffer.from(String(shot.value), 'base64'));
  console.log('screenshot:', out);
  console.log('LIVE OK');
} catch (e) {
  console.error('LIVE FAIL:', e.message);
  process.exit(1);
} finally {
  if (m.sock && !m.sock.destroyed) m.sock.destroy();
}
