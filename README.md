# Claude Usage Widget

A minimal macOS desktop widget for monitoring your Anthropic/Claude usage — session limits, weekly quota, extra spend, and account balance. Always-on-top, collapsible, and live-updates via a local JSON file.

![Claude Usage Widget](https://placeholder)

---

## Requirements

- macOS 12+
- Node.js 18+ (for development)
- An Anthropic API key (for auth — usage data is manual/JSON-driven in v1)

---

## Quick Start

```bash
git clone https://github.com/yourusername/claude-usage-widget
cd claude-usage-widget
npm install
cp usage_config.example.json usage_config.json
npm start
```

On first launch you'll be prompted for your Anthropic API key. It's validated once and stored encrypted on your machine at `~/.claude-widget/auth.json` — it is never transmitted anywhere else and never committed to this repo.

---

## Updating Usage Data

Edit `usage_config.json` in the project root. The widget watches the file and updates live — no restart needed.

```json
{
  "session": { "used_percent": 68, "resets_in_hours": 3, "resets_in_minutes": 24 },
  "weekly":  { "used_percent": 42, "reset_day": "Fri", "reset_time": "12:00 PM" },
  "extra_usage": { "total_spent": 10.62, "monthly_limit": 10.00 },
  "balance": { "current": 0.58, "auto_reload": false, "reload_amount": 10.00, "reload_threshold": 5.00 },
  "last_updated": "2026-03-21T20:00:00Z"
}
```

---

## Build for Distribution

Install dev dependencies first:
```bash
npm install
```

Build a universal `.dmg` (Apple Silicon + Intel):
```bash
npm run build:universal
```

Output is in `dist/`. For a signed + notarized build (required for Gatekeeper-free distribution), configure your Apple Developer credentials in `electron-builder`:

```bash
export CSC_LINK="path/to/cert.p12"
export CSC_KEY_PASSWORD="your-cert-password"
export APPLE_ID="your@apple.id"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
npm run build:universal
```

For beta/internal testers on trusted machines, unsigned builds work fine — right-click the app → Open to bypass Gatekeeper on first launch.

---

## Security

- **API key** — encrypted via Electron's `safeStorage` (OS keychain-backed), stored at `~/.claude-widget/auth.json` outside the project directory. Never committed, never sent to any third party.
- **Renderer isolation** — `contextIsolation: true`, `nodeIntegration: false`, CSP headers block all external connections from the renderer.
- **External URLs** — `shell.openExternal` is allowlisted to `anthropic.com` and `console.anthropic.com` only.
- **No telemetry** — the widget makes zero outbound network requests after the initial one-time API key validation.

---

## License

MIT
