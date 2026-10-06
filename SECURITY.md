# Security

This document explains exactly what the app accesses on your machine, what
leaves your machine, and how to report a problem. It exists so you can trust
the app before you run it.

## What the app accesses locally

- **Google Chrome's cookie store**, read once to pick up your existing
  claude.ai sign-in. The read is a single SQL query scoped to one row: the
  `sessionKey` cookie for `claude.ai`. Nothing else in the store is read.
  Decrypting that one value uses Chrome's own Safe Storage key from the macOS
  Keychain, which triggers a one-time system permission prompt. This happens
  entirely on your machine.
- **`~/.claude-widget/`**, where the app keeps a cache of the last usage
  response and a short log of recent percentages (for the "climbing fast"
  alert). Both files are written with `0600` permissions, owner read/write
  only, outside the project directory.
- **The process list** (`ps`), once per refresh, to count how many Claude Code
  sessions are running on this Mac. Only the count is used.

## What leaves your machine

- **`claude.ai` only.** The app makes HTTPS requests to `claude.ai` to read
  your session and weekly usage. Nothing else.
- **No telemetry, analytics, or third-party endpoints.** There is no crash
  reporting, no usage tracking, and no server operated by the author. Your
  session cookie and your usage data never pass through any machine other
  than your own and Anthropic's.

## How the app is hardened

- Every renderer window runs with `nodeIntegration: false`,
  `contextIsolation: true`, and `sandbox: true`. Renderer code cannot reach
  Node or the OS except through a narrow, explicit `contextBridge` API.
- The renderer's Content Security Policy sets `connect-src 'none'`: the UI
  itself cannot make network requests at all. All fetching happens in the
  main process.
- `shell.openExternal` is allowlisted to Anthropic domains over HTTPS only.
- The app declares `LSUIElement` and takes a single-instance lock: one copy,
  menu bar only, no Dock icon.
- The local control server used during development binds to `127.0.0.1` and
  is never included in packaged builds (it loads only when unpackaged).

## Signing out

Sign out (from the panel or the ring's right-click menu) removes the stored
session cookie from the app, deletes the local cache and log, and returns the
app to its connect screen. Your Chrome session is not touched.

## Verifying before you run

This project is distributed as source. The recommended path is to read the
code, then build it yourself:

```bash
git clone https://github.com/takeemowens/claude-session-monitor
cd claude-session-monitor
npm install
npm start
```

The files worth reading first are `main.js` (all privileged operations) and
`preload.js` (the entire renderer-to-main API surface, about 30 lines).

## A note on prebuilt binaries

Any build produced by `npm run build:arm64` is **unsigned** unless you supply
your own Apple Developer credentials. An unsigned app cannot be verified by
macOS Gatekeeper, and a downloaded unsigned binary cannot be proven to be
untampered. For that reason, no prebuilt binary is published here. Build from
source, or sign and notarize your own build with an Apple Developer ID before
distributing it to others.

## Reporting a vulnerability

Email **ux@takeemowens.com** with details and steps to reproduce. Please do not
open a public issue for a security problem until it has been addressed.
