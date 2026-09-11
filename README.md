# marionette-mcp

Zero-dependency [Model Context Protocol](https://modelcontextprotocol.io) server that drives a Firefox with Marionette enabled — the instance *you* launched with `--marionette` (attach-first), or a **dedicated instance the MCP starts for you** on request — via its native wire protocol.

AI agents get a precise DOM actuator: snapshot the interactive elements of a page, then click, type, select, toggle checkboxes, upload files, wait for conditions, run JS, and screenshot — all against the browser session you control (your profile, your logins, your kill switch).

## Why not Playwright/CDP?

Playwright's browser-automation channels (CDP, extension mode) target Chromium, or force *the library* to launch and own a pinned browser build. Marionette is different:

* **You own the browser.** Attach-first: the server connects over loopback TCP (default port 2828) to the Firefox *you* launched, in whatever profile you chose. When a session has no browser yet, the MCP asks instead of failing — and if you choose it, `fx_launch` starts a fresh, dedicated, loopback-only instance with a clean profile. Nothing in this repo downloads or upgrades a browser.
* **Zero dependencies.** No `npm install` of runtime deps, no browser downloads, no CDP shim. One Node runtime (>= 20) plus your existing Firefox.
* **Native protocol.** Frames are length-prefixed JSON over TCP — the same protocol Selenium's Firefox driver speaks. No protocol translation, no version drift.

## Architecture

```
 AI agent (e.g. opencode)
        │  stdio · newline-delimited JSON-RPC 2.0
        ▼
  marionette-mcp (src/server.mjs)          ── tools: fx_* (29)
        │  loopback TCP · <byteLen>:<json> frames
        ▼
 your Firefox (firefox --marionette)      ── your profile, your cookies
```

* `src/protocol.mjs` — pure wire codec (frame encode/parse, element-ref unwrap). No I/O, fully unit-tested.
* `src/marionette.mjs` — async Marionette client (one socket, one session, pending-command map).
* `src/server.mjs` — MCP stdio server + tool implementations.

### Design notes (bugs that cost real debugging time)

* **Frames are pure ASCII.** `JSON.stringify` does not escape `U+E000`/`U+E001` (W3C file markers) or any char ≥ `0x7F`; in UTF-8 those are multi-byte, while the length prefix is computed from string length. That desynchronizes the stream for the rest of the connection. Every frame is `\uXXXX`-escaped so declared length always equals actual bytes (regression-tested).
* **Element refs are unwrapped.** `FindElement` replies wrap the uuid (`{ "element-…": "uuid" }`); subsequent commands (`ElementClick`, `ElementSendKeys`, …) take the *bare* uuid.
* **File uploads use the raw absolute path** in `ElementSendKeys` — this protocol generation has no W3C base64 file encoding (those codepoints are the legacy Selenium `NULL`/`CANCEL` keys there).
* **Script bodies must `return`.** W3C `ExecuteScript` bodies are function *bodies*: a bare expression statement evaluates and is discarded.
* **Marionette never awaits returned Promises.** A `return (async () => { … })()` body would serialize to `null` immediately, so `fx_eval` runs the body through a synchronous wrapper and polls `window` until the Promise settles (two-phase protocol; `wait_ms` bounds it, default 30 s).
* **`#id` CSS selectors with digit-leading ids are invalid** (e.g. Ashby's UUID ids `#56d78818-…`). `fx_click`/`fx_type` auto-rewrite them to `[id="…"]` and report the rewrite (`used`); unsupported CSS (e.g. `:has()`) is caught in-page before the driver call with an actionable error.
* **DOM `checked` ≠ framework form state.** Frameworks (notably Ashby) register a choice only on a real *change*. `fx_answer` therefore detects a stale pre-selected option (or an ineffective click) and runs a toggle cycle — click another option, then the target — on exclusive (radio/button) groups, re-verifying afterwards; `fx_form` aggregates radio/checkbox inputs into choice groups (question context + per-option state) so required groups can be audited in one call.
 * Marionette keeps a **persistent session across reconnects**; a crashed automation client can leave stale session state — relaunch the browser if commands queue forever.
 * **A single command must always settle.** Commands are serialized and the browser's main thread can stall (modal dialog, hung navigation), so `send()` bounds every command via `FX_MCP_CMD_TIMEOUT_MS` (default 120 s). On expiry the connection is poisoned (socket destroyed, session cleared) and the next command reconnects fresh — without that, one unanswered command wedges the entire server forever.
  * **Socket events are per-socket.** The `error`/`close` handlers only act when `this.sock === s`. A superseded socket (dropped during a command-timeout poison) can emit *late* events after we've reconnected; reacting to them would destroy the fresh, healthy socket.
  * **Bootstrap is a decision, not an error.** The server process == one automation session. Its first browser call probes the configured endpoint; when nothing is listening, tools return a structured `need_bootstrap` payload (isError) with the three options (launch new / connect existing / user-directed) instead of a bare `ECONNREFUSED` — the agent asks the user and acts on the choice (`FX_MCP_AUTO_LAUNCH=1` collapses it to auto-launch). `fx_status` stays a pure status report either way.
  * **The launch port lives in prefs, never on the command line.** Firefox has no `--marionette-port` flag, so `fx_launch` creates a fresh profile and writes `user_pref("marionette.port", N)` + `user_pref("marionette.enabled", true)` to its `user.js` before `firefox --marionette --no-remote -profile <dir>`. The started pid is recorded (memory + `<profile>/.marionette-mcp-launched.json`) so `fx_shutdown` kills exactly that instance — a user-launched browser is never touched.

## Quick start

```bash
# 1. Launch Firefox with Marionette enabled (dedicated profile recommended)
firefox --marionette

# 2. Point the MCP client (opencode) at the server
node scripts/e2e-live.mjs        # optional: live smoke test
```

### First trigger in a session: the MCP probes, then asks

The stdio server lives with one automation session (one opencode session). On the **first browser call** it probes the configured endpoint (`FX_MARIONETTE_HOST:PORT`):

* **Something reachable** → it simply attaches. Nothing else happens.
* **Nothing reachable** → instead of a raw `ECONNREFUSED`, every browser tool returns a structured `need_bootstrap` decision with three options, and the agent asks **you**:
  1. **Start a new dedicated instance** — `fx_launch`: the server picks a free port, writes that port into a fresh profile's `user.js` **prefs** (`user_pref("marionette.port", N)` + `marionette.enabled` — there is no `--marionette-port` CLI flag), runs `firefox --marionette --no-remote -profile <dir>`, and attaches to it. The instance starts empty (no cookies/logins). Stop it later with `fx_shutdown`.
  2. **Connect to an already-running instance** — `fx_connect {host, port}` with details you provide.
  3. **Something else** — your direction (launch it yourself, reconfigure the endpoint, …).

`fx_status` always reports state (never errors on "no browser"): `connected`, `endpoint` vs `configured`, the probe result, and the options while unbootstrapped; plus `launched`/`launchedCurrent` when this server started the browser. `FX_MCP_AUTO_LAUNCH=1` skips the question and boots option 1 transparently (the tool runs in the same call, result tagged `auto_started`).

### Matching the port (attach-first; launch only when you decide it)

The server attaches over loopback TCP to a `firefox --marionette` instance on `FX_MARIONETTE_HOST:PORT` (you launched it, or `fx_launch` started it for this session). So the browser's Marionette port must equal the endpoint of the MCP:

* **Default port 2828** (both sides) → just `firefox --marionette`. No extra config needed.
* **Custom port** → there is **no `--marionette-port` CLI flag**. The port is always set through the profile's `user.js` prefs. Let `fx_launch {port: 2829}` do the whole procedure (fresh profile dir + prefs + launch + attach), or do it by hand:

  ```bash
  PROFILE=~/.mozilla/firefox/mcp-2829   # any dir
  mkdir -p "$PROFILE"
  printf 'user_pref("marionette.enabled", true);\nuser_pref("marionette.port", 2829);\n' > "$PROFILE/user.js"
  firefox --marionette --no-remote -profile "$PROFILE"
  ```

  Then point the MCP at it via `FX_MARIONETTE_PORT` (opencode config) — or, if the MCP is already running, re-point it at runtime with `fx_connect {host, port}` (no restart needed).

* **Verify / diagnose:** `fx_status` reports both the **active `endpoint`** and the **`configured`** endpoint. If it can't connect, the error names the port it tried and how to launch Firefox there (e.g. `ECONNREFUSED 127.0.0.1:2829` → nothing listening; launch as above). Remember Marionette serves **one active client per browser** — don't leave another marionette-mcp (or another automation) attached to the same instance.

opencode config (opencode.json):

```jsonc
{
  "mcp": {
    "marionette": {
      "type": "local",
      "command": ["node", "/absolute/path/to/marionette-mcp/src/server.mjs"],
      "environment": {
        "FX_MARIONETTE_PORT": "2828",
        "FX_MCP_FILE_ROOTS": "/tmp,/your/projects"
      },
      "enabled": true
    }
  }
}
```

Then the `fx_*` tools are available in-session. Typical flow:

1. `fx_navigate` to the page
2. `fx_snapshot` → numbered map of interactive elements (refs)
3. `fx_click` / `fx_type` / `fx_select` / `fx_toggle` / `fx_upload` by `ref` (or CSS `selector`)
4. Forms: `fx_form` → field map (index/label/context/value), then `fx_field` (set by index/id/label) and `fx_answer` (Yes/No or radio/checkbox questions by question text + option label); `fx_scroll` before clicking elements obscured by fixed headers
5. `fx_wait` for the next state; `fx_screenshot` + your own vision pass to verify what the DOM can't

Form-tool gotchas (from live ATS/portal forms): re-renders can silently drop checked boxes — re-verify all fields after any state change; a free-text location field is often separate from a city checkbox group; required radio groups are sometimes not wrapped in labeled field containers — audit `fx_form.groups` (and a final screenshot) instead of assuming the labeled fields are the whole form; DOM `checked` ≠ the framework's form state — trust the tools' `confirmed`/`verified` output (a stale pre-selected option is the classic failure: `fx_answer` handles it via the toggle cycle). Long application forms (e.g. Google) hide mandatory **consent/attestation checkboxes** ("…hereby certify that…", "I understand that the information I submit…") that gate the whole submit/apply: the button is left hard-disabled or the click silently no-ops until the box is ticked — that is client-side enablement, **not** bot protection; `fx_gates` surfaces these boxes (plus the disabled button and any alert banner) so you can find and check the actual gate. Material-style rows put the real `<input>` visually hidden under its own `li`/button chrome, so a direct input click can be reported "not clickable … obscured" — `fx_click`/`fx_field`/`fx_answer` recover by clicking the obscuring same-widget topmost and report it via `overlay-top:…`.

## Tools

| Tool | Purpose |
|---|---|
| `fx_status` | Connection, active **`endpoint`** vs `configured`, session, current page, `navigator.webdriver`. With no reachable browser it does NOT error — returns `connected:false`, the probe result, and the bootstrap options; reports `launched`/`launchedCurrent` when this server started the instance |
| `fx_launch` | Bootstrap option 1: start a NEW dedicated Firefox — fresh profile (`<root>/marionette-mcp-<port>`), port written into `user.js` **prefs** (`marionette.port`; no CLI flag exists), `firefox --marionette --no-remote -profile <dir>`, wait for the listener, attach. Optional `{port}` (default: first free above the configured one) and `{profile}` dir. Reuse: re-calling with the same live port re-attaches, no second process |
| `fx_shutdown` | Stop an instance this server started via `fx_launch` (killed by the recorded pid; a user-launched browser is never touched). Defaults to the current endpoint |
| `fx_connect` | Bootstrap option 2: (re-)point the MCP at an already-running loopback endpoint `{host, port}` and re-attach (env-configured default when omitted). Returns the active endpoint, the configured one, and the session |
| `fx_navigate` | Go to a URL |
| `fx_page` | Current URL + title |
| `fx_snapshot` | Interactive-element map with refs (incl. visible `label` text when present) |
| `fx_click` | Click (ref or selector; digit-leading `#id` auto-rewritten to `[id="…"]`, unsupported CSS caught in-page). If the element is not clickable because another element obscures it and the obscuring element belongs to the same widget (Material button chrome, an `li`/`label` over a hidden input), the obscuring topmost is clicked instead and reported as `via: "overlay-top:…"`; a foreign blocker is reported with its identity |
| `fx_type` | Type text (clears first unless `keep: true`; same selector hardening) |
| `fx_select` | Set `<select>` by option value or label |
| `fx_toggle` | Set checkbox/radio state |
| `fx_upload` | Set file input (raw path, must be under `FX_MCP_FILE_ROOTS`) |
| `fx_form` | Dump visible form fields: index, type, label, name, context, value, options, files + aggregated choice groups (question context, per-option state); scopes to a CSS `root` |
| `fx_field` | Set a field by index (from `fx_form`), id, or label substring: real keystrokes for text, verified real click (with fallbacks) for checkbox/radio, option match for select |
| `fx_answer` | Answer a grouped choice question (Yes/No buttons, radio/checkbox options) by question text + option label; re-reads and reports the selection state; runs a toggle cycle on exclusive groups when a stale pre-selection (or ineffective click) is detected; self-heals to clicking the visible text-matching wrapper when option labels are unreadable (`no-option`, e.g. label-less `li` rows) |
| `fx_scroll` | Scroll an element into view (e.g. under a fixed header), wait, return its top coordinate |
| `fx_gates` | Consent/attestation gate audit (read-only): visible checkboxes with nearby text — flagging certify/understand/agree/consent/attest/terms/privacy wording — plus disabled buttons (a dead Submit/Apply) and visible alert banners. Run it whenever a submit click does nothing or a submit button stays disabled; the fix is usually an unchecked consent checkbox, not bot protection |
| `fx_links` | All hyperlinks of the current page: text + absolute href (optional `selector` filter; reads open shadow roots). Generic read — no JS needed |
| `fx_extract` | Structured page read ("scrape" without JS): one row per container `selector`; per-row `fields {name: css\|"text"}` |
| `fx_search` | Search without JS: navigate to engine results (google/bing/duckduckgo presets; overridable `container`/`title`/`snippet`), return `{title, link, snippet}` rows; `resolve:true` follows each link in the browser and reports the real final URL/title (needed for redirect-wrapped hrefs, e.g. Google `/goto`) |
| `fx_eval` | Run JS in the page (function body; `return` your value — a returned Promise is awaited, default 30 s via `wait_ms`) |
| `fx_wait` | Wait for visible text or CSS selector (≤ 30 s) |
| `fx_screenshot` | Full-page PNG (not just the viewport) to a file under an allowed root |
| `fx_windows` / `fx_window` | List / switch windows |
| `fx_alert_state` / `fx_alert_accept` / `fx_alert_dismiss` | Native dialogs |
| `fx_cookies` | Current-origin cookies (names/domains only) |

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `FX_MARIONETTE_HOST` | `127.0.0.1` | Marionette endpoint (loopback only, by design) |
| `FX_MARIONETTE_PORT` | `2828` | Firefox's `--marionette` port (must match the browser you launch; `fx_status` shows the active endpoint). Override at runtime with `fx_connect {port}` |
| `FX_MCP_FILE_ROOTS` | `/tmp` | Comma-separated roots that `fx_upload`/`fx_screenshot` may touch |
| `FX_MCP_CMD_TIMEOUT_MS` | `120000` | Per-command bound. A command that never settles (modal dialog, hung page) poisons the connection and auto-reconnects on the next command, so one stuck page can't wedge the whole server |
| `FX_MCP_AUTO_LAUNCH` | off | When the first-call probe finds no reachable Firefox, `fx_launch` runs automatically instead of returning the bootstrap question |
| `FX_MCP_FIREFOX_BIN` | auto-detect | Firefox binary for `fx_launch` / auto-launch: a path or `"cmd args"` string (e.g. `node /path/standin.mjs`); default looks up `firefox`/`firefox-esr` on PATH + common system paths |
| `FX_MCP_PROFILE_DIR` | `~/.mozilla/firefox` | Base directory for the per-port profiles `fx_launch` creates (`marionette-mcp-<port>/`) |

## Security

* **Loopback only.** The client connects to `127.0.0.1` — there is deliberately no network path.
* **File access is rooted.** Uploads and screenshots reject paths outside `FX_MCP_FILE_ROOTS`.
* **Use a dedicated profile** for automation, and keep the browser visible: a human-in-the-loop is the expected model, not headless stealth. Native OS dialogs (e.g. the file picker) and CAPTCHAs are *not* automatable by design — stop and let the human handle them.
* **Launch is opt-in and self-contained.** `fx_launch`/auto-launch only create a NEW profile under `FX_MCP_PROFILE_DIR` (never touching your daily profile), bind to `127.0.0.1` only, and record the started pid so `fx_shutdown` can stop exactly that instance — it never kills a browser the user launched.

## Testing

Zero-dependency test suite (built-in `node:test`):

```bash
npm test            # or: node --test test/*.test.mjs
```

* `test/protocol.test.mjs` — frame codec, parser resilience, element-ref unwrapping (pure unit tests).
* `test/marionette.test.mjs` — the real client against an in-process fake Marionette server that verifies every frame's byte integrity (non-ASCII payloads included).
* `test/server.test.mjs` — spawns the real MCP server and drives it end-to-end (JSON-RPC plumbing, all tool paths, framing-safety under Unicode input, stdin-EOF shutdown).
* `test/bootstrap.test.mjs` — first-trigger behavior against a stand-in "firefox" binary (`test/helpers/fake_firefox.mjs`): the no-browser decision payload, the prefs-based launch (port flows only through `user.js`), attach/reuse, `fx_shutdown` pid lifecycle, and `FX_MCP_AUTO_LAUNCH` inline bootstrap.

Live-browser tests (start your own `firefox --marionette` first; note Marionette serves one active client at a time — no other marionette-mcp client may be attached):

* `npm run e2e:live` — connection, navigation, screenshot through the real wire protocol.
* `npm run e2e:forms` — the form primitives against a self-generated test page (labels, option/state round-trips, click fallbacks, negative cases).

CI: `.github/workflows/ci.yml` — syntax check + full test suite across Node 20/22/24.

## License

GPL-2.0 (see `LICENSE`).
