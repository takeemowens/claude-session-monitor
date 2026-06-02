# Tray Menu Redesign — Claude Session Monitor

**Date:** 2026-05-23  
**Status:** Approved  

---

## Goal

Slim the tray context menu from 13 items across 4 sections down to a clean, ultra-minimal structure. Expose live usage data at a glance without opening the widget. Move rare-use account actions into a submenu.

---

## Final Menu Structure

### Top-level
```
Session 73% · Resets 2h 15m        ← disabled label (live, updates on rebuildTrayMenu)
Weekly 45% · Resets Tue 11:00 AM   ← disabled label (live, updates on rebuildTrayMenu)
──────────────────────────────────
Show Widget  /  Hide Widget         ← toggles on click
Settings →                          ← submenu
Account →                           ← submenu
──────────────────────────────────
Quit Claude Session Monitor
```

### Settings submenu
```
✓ Always on Top         ← checkbox
✓ Launch at Login       ← checkbox
  Mute Notifications    ← checkbox
──────────────────────
  Refresh Now
  Claude.ai Connected ✓  (or: Sign in to Claude.ai…)
  Import from Chrome
  Open Config File
```

### Account submenu
```
  Change API Key…
  Sign Out              ← only shown when authed
```

---

## Data for Status Lines

Both status labels are built inside `rebuildTrayMenu()` from the last-known `liveData` snapshot.

**Session line:**
- Source: `liveData.session.used_percent` + `liveData.session.resets_in_hours` / `resets_in_minutes` (or `reset_iso` if present)
- Format: `Session {pct}% · Resets {Xh Ym}` — same logic as the existing `formatSessionReset()` renderer helper, replicated in main process
- Fallback (no data yet): `Session — · —`

**Weekly line:**
- Source: `liveData.weekly.used_percent` + `liveData.weekly.reset_day` / `reset_time` (or parsed from `reset_label`)
- Format: `Weekly {pct}% · Resets {Day HH:MM AM/PM}`
- Fallback: `Weekly — · —`

Both items have `enabled: false` so they are non-clickable display labels.

---

## Implementation Notes

### `rebuildTrayMenu()` changes (`main.js`)

Replace the current `Menu.buildFromTemplate([...])` call with the new structure:

```js
const sessionLabel = buildSessionStatusLabel(latestData)   // new helper
const weeklyLabel  = buildWeeklyStatusLabel(latestData)    // new helper

tray.setContextMenu(Menu.buildFromTemplate([
  { label: sessionLabel, enabled: false },
  { label: weeklyLabel,  enabled: false },
  { type: 'separator' },
  { label: win.isVisible() ? 'Hide Widget' : 'Show Widget', click: toggleVisibility },
  {
    label: 'Settings',
    submenu: [
      { label: 'Always on Top',    type: 'checkbox', checked: win.isAlwaysOnTop(),
        click: () => { win.setAlwaysOnTop(!win.isAlwaysOnTop()); rebuildTrayMenu() } },
      { label: 'Launch at Login',  type: 'checkbox', checked: loginItem.openAtLogin,
        click: () => { /* existing logic */ rebuildTrayMenu() } },
      { label: 'Mute Notifications', type: 'checkbox', checked: muteNotifications,
        click: () => { muteNotifications = !muteNotifications; rebuildTrayMenu() } },
      { type: 'separator' },
      { label: 'Refresh Now',      click: () => refreshAndPush() },
      // Note: enabled is NOT set to false here — the click guard handles the logged-in case.
      // This is a deliberate removal of the previous `enabled: !isLoggedInToConsole` flag.
      { label: isLoggedInToConsole ? 'Claude.ai Connected ✓' : 'Sign in to Claude.ai…',
        click: () => { if (!isLoggedInToConsole) openConsoleLogin() } },
      // Import is always visible in the submenu (previously hidden when logged in).
      // The click handler preserves the full success chain.
      { label: 'Import from Chrome',
        click: async () => {
          const ok = await importChromeSession()
          if (ok) {
            isLoggedInToConsole = true
            rebuildTrayMenu()
            startRefreshTimer()
            await refreshAndPush()
          }
        }
      },
      { label: 'Open Config File', click: () => shell.openPath(path.join(__dirname, 'usage_config.json')) },
    ]
  },
  {
    label: 'Account',
    submenu: [
      { label: 'Change API Key…', click: () => showAuthScreen() },
      ...(isAuthed ? [{ label: 'Sign Out', click: () => { stopRefreshTimer(); clearKey(); showAuthScreen() } }] : []),
    ]
  },
  { type: 'separator' },
  { label: 'Quit Claude Session Monitor', click: () => app.quit() },
]))
```

### New helpers in `main.js`

```js
function buildSessionStatusLabel(data) {
  const s = data?.session
  if (!s) return 'Session — · —'
  const pct = s.used_percent ?? '—'
  const h = s.resets_in_hours ?? 0
  const m = s.resets_in_minutes ?? 0
  const countdown = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : '—'
  return `Session ${pct}% · Resets ${countdown}`
}

function buildWeeklyStatusLabel(data) {
  const w = data?.weekly
  if (!w) return 'Weekly — · —'
  const pct = w.used_percent ?? '—'
  // reset_label comes from the console scrape (e.g. "Resets Tue 11:00 AM").
  // It may be absent when only the API path has run. Fall back to reset_day + reset_time
  // from the config, then to a bare dash.
  let resetPart = '—'
  if (w.reset_label) {
    resetPart = w.reset_label.replace(/^Resets\s+/, '')
  } else if (w.reset_day && w.reset_time) {
    resetPart = `${w.reset_day} ${w.reset_time}`
  }
  return `Weekly ${pct}% · Resets ${resetPart}`
}
```

`rebuildTrayMenu()` is already called after every `refreshAndPush()`, so the status lines update automatically on each data refresh.

---

## Files to Touch

| File | Change |
|------|--------|
| `main.js` | Replace `Menu.buildFromTemplate` in `rebuildTrayMenu()` + add 2 helper functions |

No renderer changes needed.

---

## Verification

1. `npm start` — right-click tray icon
2. Confirm two status lines at top (session % + weekly %)
3. Confirm Settings submenu contains all 8 items (3 checkboxes + separator + 4 actions)
4. Confirm Account submenu shows Change API Key and Sign Out (when authed)
5. Confirm top-level has exactly 6 named items (Session label, Weekly label, Show/Hide, Settings, Account, Quit) plus 2 separators (after the status labels, before Quit)
6. Trigger a data refresh — confirm status lines update
7. Rebuild with `npm run build:universal` — confirm same behavior in built app
