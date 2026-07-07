# Security

This document explains exactly what the app accesses on your machine, what
leaves your machine, and how to report a problem. It exists so you can trust
the app before you run it.

## What the app accesses locally

- **macOS Keychain** — via Electron's `safeStorage`, to encrypt and decrypt
  your Anthropic API key at rest. The app reads only the key it wrote itself.
- **Your Anthropic API key** — stored encrypted at `~/.claude-widget/auth.json`
  with `0600` file permissions (owner read/write only), outside the project
  directory. It is never written to this repository.
- **Google Chrome cookie database (optional)** — only if you explicitly choose
  "Import from Chrome" during sign-in. The app reads a single `sessionKey`
  cookie for `claude.ai` so you can authenticate without re-entering your
  password. This read happens entirely on your machine. If you sign in through
  the in-app login window instead, Chrome is never touched.

## What leaves your machine

- **Anthropic API only.** After you provide an API key, the app makes HTTPS
  requests to `api.anthropic.com` (usage and account data) and, if you sign
  in through the browser flow, to `claude.ai`. Nothing else.
- **No telemetry, analytics, or third-party endpoints.** There is no crash
  reporting, no usage tracking, and no server operated by the author. Your key
  and your usage data never pass through any machine other than your own and
  Anthropic's.

## How the app is hardened

- Every renderer window runs with `nodeIntegration: false`,
  `contextIsolation: true`, and `sandbox: true`. Renderer code cannot reach
  Node or the OS except through a narrow, explicit `contextBridge` API.
- `shell.openExternal` is allowlisted to `anthropic.com` and
  `console.anthropic.com` over HTTPS only, so the app cannot be induced to
  open arbitrary links.
- The local control server used during development binds to `127.0.0.1` and is
  never included in packaged builds (it loads only when the app is unpackaged).

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

Any `.dmg` produced by `npm run build` is **unsigned** unless you supply your
own Apple Developer credentials. An unsigned app cannot be verified by macOS
Gatekeeper, and a downloaded unsigned binary cannot be proven to be untampered.
For that reason, no prebuilt binary is published here. Build from source, or
sign and notarize your own build with an Apple Developer ID before
distributing it to others.

## Reporting a vulnerability

Email **ux@takeemowens.com** with details and steps to reproduce. Please do not
open a public issue for a security problem until it has been addressed.
