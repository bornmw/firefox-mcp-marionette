// fake_firefox.mjs — stand-in `firefox` binary for fx_launch tests.
// Mimics the parts of a real Marionette Firefox that marionette-mcp depends on:
//   * takes -profile <dir>
//   * reads the `marionette.port` PREFERENCE from <profile>/user.js — proving
//     the port must flow through prefs, not a launch flag
//   * opens a Marionette-wire listener on exactly that port (the fake protocol server)
// Exits non-zero without listening if the prefs are missing, exactly as a real
// Firefox would not listen on a port you never configured.
import fs from 'node:fs';
import { startFakeMarionette } from './fake_marionette.mjs';

const argv = process.argv.slice(2);
const pi = argv.indexOf('-profile');
if (pi < 0 || !argv[pi + 1]) {
  console.error('fake firefox: missing -profile argument');
  process.exit(2);
}
const profile = argv[pi + 1];
const userJsPath = profile + '/user.js';
if (!fs.existsSync(userJsPath)) {
  console.error('fake firefox: no user.js in profile ' + profile);
  process.exit(3);
}
const userJs = fs.readFileSync(userJsPath, 'utf8');
// real Firefox: the LAST matching user_pref wins
const portMatches = [...userJs.matchAll(/user_pref\(\s*"marionette\.port"\s*,\s*(\d+)\s*\)\s*;?/g)];
const enabledMatches = [...userJs.matchAll(/user_pref\(\s*"marionette\.enabled"\s*,\s*true\s*\)\s*;?/g)];
if (!enabledMatches.length) {
  console.error('fake firefox: marionette.enabled is not set -> no Marionette listener');
  process.exit(4);
}
if (!portMatches.length) {
  console.error('fake firefox: marionette.port preference missing -> default 2828 only');
  process.exit(5);
}
const port = Number(portMatches[portMatches.length - 1][1]);
startFakeMarionette(port)
  .then(({ port: p }) => console.error('fake firefox: marionette listening on 127.0.0.1:' + p + ' (pid ' + process.pid + ')'))
  .catch((e) => { console.error('fake firefox: listener failed: ' + e.message); process.exit(6); });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
