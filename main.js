const { app, BrowserWindow, ipcMain, screen, safeStorage, shell, Tray, Menu, nativeImage, globalShortcut, session, Notification } = require('electron')
const path = require('path')
const fs = require('fs')

// Set app name BEFORE app.ready so safeStorage uses the same identity
// in both dev (npm start) and production (built .app). Must match productName
// in package.json — this is what macOS Keychain keys the encryption against.
app.setName('Claude Usage Widget')

// ─── Single instance lock ─────────────────────────────────────────────────────
// If a second copy tries to launch, focus the existing window and quit the new one.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  console.log('[single-instance] Another instance is already running — quitting.')
  app.quit()
  process.exit(0)
}
app.on('second-instance', () => {
  // Someone tried to open a second instance — bring the existing window to front
  if (typeof win !== 'undefined' && win && !win.isDestroyed()) {
    if (!win.isVisible()) win.show()
    win.focus()
  }
})

process.on('unhandledRejection', (reason) => {
  console.error('[unhandled rejection]', reason)
})
const https         = require('https')
const os            = require('os')
const sandboxBridge = !app.isPackaged ? require('./sandbox-bridge') : null

// ─── Auth paths ───────────────────────────────────────────────────────────────
const AUTH_DIR  = path.join(os.homedir(), '.claude-widget')
const AUTH_PATH = path.join(AUTH_DIR, 'auth.json')

// In dev mode (unsigned Electron), safeStorage generates a new OS key each launch,
// so encrypt-on-save / decrypt-on-next-launch always fails. Fall back to plain file
// storage (protected by 0o600 permissions) when not packaged.
const USE_SAFE_STORAGE = app.isPackaged && safeStorage.isEncryptionAvailable()

function getStoredKey() {
  try {
    if (!fs.existsSync(AUTH_PATH)) return null
    const stored = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'))
    if (USE_SAFE_STORAGE) {
      const raw = Buffer.from(stored.key, 'base64')
      return safeStorage.decryptString(raw)
    } else {
      // Dev mode: key stored as plain base64
      return Buffer.from(stored.key, 'base64').toString('utf8')
    }
  } catch (e) {
    console.error('[auth] Failed to read stored key:', e.message)
    return null
  }
}

function storeKey(apiKey) {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 })
  let keyData
  if (USE_SAFE_STORAGE) {
    keyData = safeStorage.encryptString(apiKey).toString('base64')
  } else {
    // Dev mode: plain base64 (file is 0o600 — only readable by owner)
    keyData = Buffer.from(apiKey, 'utf8').toString('base64')
  }
  fs.writeFileSync(AUTH_PATH, JSON.stringify({ key: keyData, dev: !USE_SAFE_STORAGE }), { mode: 0o600 })
}

function clearKey() {
  try {
    if (fs.existsSync(AUTH_PATH)) fs.unlinkSync(AUTH_PATH)
  } catch (e) { console.error('[auth] Failed to clear key:', e.message) }
}

// ─── API key validation ───────────────────────────────────────────────────────
function validateApiKey(apiKey) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/models',
        method: 'GET',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      },
      (res) => {
        res.resume()
        resolve({ valid: res.statusCode === 200, statusCode: res.statusCode })
      }
    )
    req.on('error', (err) => resolve({ valid: false, error: err.message }))
    req.setTimeout(12000, () => { req.destroy(); resolve({ valid: false, error: 'Request timed out' }) })
    req.end()
  })
}

// ─── Console scraper (Claude.ai usage via hidden browser) ─────────────────────
let scrapeWin = null
let isLoggedInToConsole = false
let latestData = null
let showPctInMenuBar = true
let firedNotifications = new Set()
let muteNotifications = false
let prevSessionPct = null
let CONSOLE_SESSION = null

const CONSOLE_USAGE_URL = 'https://claude.ai/settings/usage'

function getConsoleSession() {
  if (!CONSOLE_SESSION) {
    CONSOLE_SESSION = session.fromPartition('persist:claude-console')
    CONSOLE_SESSION.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36')
  }
  return CONSOLE_SESSION
}

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function createScrapeWindow(visible = false) {
  if (scrapeWin && !scrapeWin.isDestroyed()) scrapeWin.close()
  scrapeWin = new BrowserWindow({
    width: 1280,
    height: 800,
    show: visible,
    title: 'Sign in to Claude',
    webPreferences: {
      session: getConsoleSession(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false   // prevent JS timer throttling in hidden windows
    }
  })
  scrapeWin.webContents.setUserAgent(CHROME_UA)
  // Focus the webContents so React renders the full page (not just sidebar shell)
  scrapeWin.webContents.focus()
  return scrapeWin
}

// ─── Chrome cookie decryption (macOS) ────────────────────────────────────────
const crypto = require('crypto')
const { execFileSync } = require('child_process')

function getChromeSessionKey() {
  try {
    // 1. Get Chrome Safe Storage password from macOS Keychain
    //    Triggers a one-time macOS permission dialog
    const chromePass = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Chrome Safe Storage', '-w'],
      { encoding: 'utf8' }
    ).trim()

    // 2. Derive decryption key (Chrome uses PBKDF2 on macOS)
    const derivedKey = crypto.pbkdf2Sync(chromePass, 'saltysalt', 1003, 16, 'sha1')

    // 3. Read encrypted sessionKey from Chrome's cookie DB
    const cookieDbPath = path.join(
      os.homedir(),
      'Library/Application Support/Google/Chrome/Default/Cookies'
    )
    if (!fs.existsSync(cookieDbPath)) return null

    const raw = execFileSync(
      'sqlite3',
      [cookieDbPath, "SELECT hex(encrypted_value) FROM cookies WHERE host_key LIKE '%claude.ai%' AND name='sessionKey' LIMIT 1;"],
      { encoding: 'utf8' }
    ).trim()
    if (!raw) return null

    // 4. Convert hex to buffer and strip 'v10' prefix (3 bytes)
    const encBuf = Buffer.from(raw, 'hex')
    const payload = encBuf.subarray(3)

    // 5. AES-128-CBC decrypt with IV of 16 spaces (0x20)
    const iv = Buffer.alloc(16, 0x20)
    const decipher = crypto.createDecipheriv('aes-128-cbc', derivedKey, iv)
    let decrypted = decipher.update(payload)
    decrypted = Buffer.concat([decrypted, decipher.final()])

    // Extract the sk-ant-* session token from decrypted bytes
    // (decryption produces leading binary padding before the actual token)
    const fullStr = decrypted.toString('latin1')
    const match = fullStr.match(/sk-ant-[A-Za-z0-9_-]+/)
    return match ? match[0] : null
  } catch (e) {
    console.error('Chrome cookie import failed:', e.message)
    return null
  }
}

async function importChromeSession() {
  const sessionKey = getChromeSessionKey()
  if (!sessionKey) return false

  // Inject the sessionKey cookie into Electron's persistent session
  const ses = getConsoleSession()
  await ses.cookies.set({
    url: 'https://claude.ai',
    name: 'sessionKey',
    value: sessionKey,
    domain: '.claude.ai',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax'
  })

  // Verify the session works
  return new Promise((resolve) => {
    const testWin = new BrowserWindow({
      width: 1, height: 1, show: false,
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    })
    testWin.webContents.setUserAgent(CHROME_UA)

    testWin.webContents.on('did-navigate', (_, url) => {
      const ok = url.includes('claude.ai') && !url.includes('login') && !url.includes('oauth')
      testWin.close()
      resolve(ok)
    })

    testWin.loadURL('https://claude.ai/')
    setTimeout(() => { if (!testWin.isDestroyed()) { testWin.close(); resolve(false) } }, 10000)
  })
}

// ─── Console login window ────────────────────────────────────────────────────
function openConsoleLogin() {
  const loginWin = createScrapeWindow(true)

  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  loginWin.setPosition(Math.round((sw - 460) / 2), Math.round((sh - 650) / 2))

  // Block Google OAuth popups — can't work in Electron
  loginWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('accounts.google.com') || url.includes('google.com/o/oauth')) {
      return { action: 'deny' }
    }
    loginWin.loadURL(url)
    return { action: 'deny' }
  })

  loginWin.webContents.on('will-navigate', (event, url) => {
    if (url.includes('accounts.google.com') || url.includes('google.com/o/oauth')) {
      event.preventDefault()
    }
    // Intercept Chrome import trigger
    if (url.startsWith('claude-widget://import-chrome')) {
      event.preventDefault()
      handleChromeImportFromLogin(loginWin)
    }
  })

  // After page loads, replace Google SSO with Chrome import button
  loginWin.webContents.on('did-finish-load', () => {
    loginWin.webContents.executeJavaScript(`
      (function replaceGoogle() {
        document.querySelectorAll('button').forEach(btn => {
          if (btn.textContent.toLowerCase().includes('google') && !btn.dataset.replaced) {
            btn.dataset.replaced = 'true';
            btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" style="margin-right:8px"><circle cx="12" cy="12" r="10" fill="#4285F4"/><circle cx="12" cy="12" r="4" fill="white"/></svg>Sign in with Chrome';
            btn.style.cssText = btn.style.cssText + ';display:flex;align-items:center;justify-content:center;';
            btn.onclick = (e) => {
              e.preventDefault();
              e.stopPropagation();
              btn.innerHTML = '<span style="margin-right:8px">⏳</span>Importing session...';
              btn.disabled = true;
              window.location.href = 'claude-widget://import-chrome';
            };
          }
        });
        setTimeout(replaceGoogle, 1500);
        setTimeout(replaceGoogle, 4000);
      })();
    `).catch(() => {})
  })

  // Load Claude login page — email sign-in works directly
  loginWin.loadURL('https://claude.ai/login')

  // Watch for successful login
  loginWin.webContents.on('did-navigate', (_, url) => {
    if (url.includes('claude.ai') && !url.includes('login') && !url.includes('oauth') && !url.includes('accounts.google')) {
      onLoginSuccess(loginWin)
    }
  })

  loginWin.on('closed', () => { scrapeWin = null })
  return loginWin
}

async function handleChromeImportFromLogin(loginWin) {
  try {
    const ok = await importChromeSession()
    if (ok) {
      onLoginSuccess(loginWin)
    } else {
      // Import failed — show error in the login window
      loginWin.webContents.executeJavaScript(`
        (function() {
          const existing = document.getElementById('chrome-error');
          if (existing) existing.remove();
          const err = document.createElement('p');
          err.id = 'chrome-error';
          err.textContent = 'Could not import session. Make sure you are signed into claude.ai in Chrome.';
          err.style.cssText = 'margin-top:12px;font-size:12px;color:#D94040;text-align:center;line-height:1.4;';
          const form = document.querySelector('form') || document.querySelector('main') || document.body;
          form.appendChild(err);
          // Re-enable the button
          document.querySelectorAll('button').forEach(btn => {
            if (btn.dataset.replaced) { btn.disabled = false; btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" style="margin-right:8px"><circle cx="12" cy="12" r="10" fill="#4285F4"/><circle cx="12" cy="12" r="4" fill="white"/></svg>Sign in with Chrome'; }
          });
        })()
      `).catch(() => {})
    }
  } catch (e) {
    console.error('[chrome-import] Failed:', e.message)
  }
}

function onLoginSuccess(loginWin) {
  isLoggedInToConsole = true
  rebuildTrayMenu()
  startRefreshTimer()
  setTimeout(async () => {
    if (loginWin && !loginWin.isDestroyed()) loginWin.hide()
    await refreshAndPush().catch(e => console.error('[login] Refresh error:', e.message))
  }, 2000)
}

// Scrape usage data from the console page
async function scrapeConsoleUsage() {
  // Use session.fetch() with stored cookies — no hidden BrowserWindow needed.
  // The sessionKey cookie from Claude.ai authenticates these requests directly.
  const ses = getConsoleSession()
  const BASE = 'https://claude.ai'
  const HEADERS = {
    'accept': 'application/json',
    'content-type': 'application/json',
    'referer': 'https://claude.ai/',
  }

  try {
    // 1. Get the current user/org context
    const bootstrapRes = await ses.fetch(`${BASE}/api/bootstrap`, { headers: HEADERS })
    if (!bootstrapRes.ok) {
      if (bootstrapRes.status === 401 || bootstrapRes.status === 403) {
        // Session expired
        const wasLoggedIn = isLoggedInToConsole
        isLoggedInToConsole = false
        rebuildTrayMenu()
        if (!getStoredKey()) stopRefreshTimer()
        console.log('[scraper] Session expired (401/403)')
        if (wasLoggedIn && Notification.isSupported()) {
          new Notification({
            title: 'Claude session expired',
            body: 'Sign into claude.ai in Chrome, then use Account → Import from Chrome.',
            silent: false
          }).show()
        }
      } else {
        console.log('[scraper] Bootstrap failed:', bootstrapRes.status)
      }
      return null
    }

    const bootstrap = await bootstrapRes.json()
    const orgId = bootstrap?.account?.memberships?.[0]?.organization?.uuid
      || bootstrap?.organization?.uuid
      || bootstrap?.organizations?.[0]?.uuid

    if (!orgId) {
      console.log('[scraper] Could not find org ID in bootstrap:', JSON.stringify(bootstrap).slice(0, 200))
      return null
    }
    // Get the account org ID (may differ from bootstrap org ID)
    const accountRes = await ses.fetch(`${BASE}/api/account`, { headers: HEADERS })
    const accountData = accountRes.ok ? await accountRes.json() : null
    const accountOrgId = accountData?.memberships?.[0]?.organization?.uuid

    // Fetch usage data — /api/organizations/${accountOrgId}/usage returns session + weekly utilization
    let usageBody = null
    for (const oid of [...new Set([accountOrgId, orgId].filter(Boolean))]) {
      const r = await ses.fetch(`${BASE}/api/organizations/${oid}/usage`, { headers: HEADERS })
      if (r.ok) {
        usageBody = await r.json()
        console.log('[scraper] Usage data fetched successfully')
        break
      }
    }

    const result = {
      source: 'session_fetch',
      ts: new Date().toISOString(),
      orgId,
      usage: usageBody,
      raw: bootstrap
    }

    // Cache for debugging
    try {
      const cachePath = require('path').join(AUTH_DIR, 'console_cache.json')
      require('fs').writeFileSync(cachePath, JSON.stringify(result, null, 2), { mode: 0o600 })
    } catch (e) {}

    return result
  } catch (e) {
    console.log('[scraper] session.fetch error:', e.message)
    return null
  }
}

// Parse scraped data (from /api/organizations/{id}/usage) into widget format
function parseScrapedData(scraped) {
  if (!scraped) return {}
  const result = {}
  const u = scraped.usage   // the /usage JSON response
  const ts = scraped.ts

  if (u) {
    // Session (5-hour rolling window)
    if (u.five_hour) {
      const pct = Math.round(u.five_hour.utilization ?? 0)
      const resetISO = u.five_hour.resets_at || null
      const diffMs = resetISO ? Math.max(0, new Date(resetISO) - Date.now()) : 0
      result.session = {
        used_percent:      pct,
        resets_in_hours:   Math.floor(diffMs / 3600000),
        resets_in_minutes: Math.floor((diffMs % 3600000) / 60000),
        reset_iso:         resetISO
      }
    }

    // Weekly (7-day rolling window)
    if (u.seven_day) {
      const pct = Math.round(u.seven_day.utilization ?? 0)
      const resetISO = u.seven_day.resets_at || null
      // Derive reset day/time label from ISO for the renderer
      let reset_label = null
      if (resetISO) {
        const d = new Date(resetISO)
        const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
        const h = d.getHours(), m = String(d.getMinutes()).padStart(2,'0')
        const ampm = h >= 12 ? 'PM' : 'AM'
        const h12 = h % 12 || 12
        reset_label = `Resets ${days[d.getDay()]} ${h12}:${m} ${ampm}`
      }
      result.weekly = { used_percent: pct, reset_label }
    }

    // Extra usage (pay-as-you-go overage)
    if (u.extra_usage?.is_enabled) {
      result.extra_usage = {
        total_spent:   u.extra_usage.used_credits  ?? 0,
        monthly_limit: u.extra_usage.monthly_limit ?? 10.00
      }
    }
  }

  result.last_updated = ts
  return result
}

// ─── Live data fetching ───────────────────────────────────────────────────────
function anthropicGet(apiKey, apiPath) {
  return new Promise((resolve) => {
    let body = ''
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: apiPath,
        method: 'GET',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      },
      (res) => {
        res.on('data', (d) => { body += d })
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      }
    )
    req.on('error', () => resolve(null))
    req.setTimeout(12000, () => { req.destroy(); resolve(null) })
    req.end()
  })
}

// Cheapest possible Messages call to get rate-limit headers (~$0.00004 per call)
function anthropicPing(apiKey) {
  return new Promise((resolve) => {
    let body = ''
    const payload = JSON.stringify({
      model: 'claude-haiku-3-20240307',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'x' }]
    })
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        res.on('data', (d) => { body += d })
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      }
    )
    req.on('error', () => resolve(null))
    req.setTimeout(15000, () => { req.destroy(); resolve(null) })
    req.write(payload)
    req.end()
  })
}

// ─── Snapshot tracking ────────────────────────────────────────────────────────
const USAGE_LOG_PATH = path.join(AUTH_DIR, 'usage_log.json')
const SNAPSHOT_MAX_AGE = 7 * 24 * 60 * 60 * 1000  // 7 days

// Pricing per million tokens (input / output) — default to Sonnet 4 rates
const PRICING = {
  default: { input: 3.00, output: 15.00 }
}

function readUsageLog() {
  try {
    if (!fs.existsSync(USAGE_LOG_PATH)) return { snapshots: [] }
    return JSON.parse(fs.readFileSync(USAGE_LOG_PATH, 'utf8'))
  } catch (e) { console.error('[snapshots] Read failed:', e.message); return { snapshots: [] } }
}

function writeUsageLog(log) {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 })
  fs.writeFileSync(USAGE_LOG_PATH, JSON.stringify(log, null, 2), { mode: 0o600 })
}

function appendSnapshot(headerData) {
  const log = readUsageLog()
  const now = Date.now()

  log.snapshots.push({
    ts: new Date(now).toISOString(),
    tokens_limit:     headerData.tokens_limit,
    tokens_remaining: headerData.tokens_remaining,
    tokens_used:      headerData.tokens_limit - headerData.tokens_remaining,
    input_remaining:  headerData.input_remaining,
    output_remaining: headerData.output_remaining,
    reset:            headerData.reset
  })

  // Prune entries older than 7 days
  const cutoff = now - SNAPSHOT_MAX_AGE
  log.snapshots = log.snapshots.filter(s => new Date(s.ts).getTime() > cutoff)

  writeUsageLog(log)
  return log
}

function deriveDailyUsage(snapshots) {
  const todayStr = new Date().toISOString().split('T')[0]
  const today = snapshots.filter(s => s.ts.startsWith(todayStr))
  if (today.length === 0) return null

  // Each snapshot records tokens_used in its current 1-min window
  // Group by reset timestamp to avoid double-counting the same window
  const windows = new Map()
  for (const s of today) {
    const key = s.reset || s.ts
    const existing = windows.get(key)
    if (!existing || s.tokens_used > existing) {
      windows.set(key, s.tokens_used)
    }
  }

  let total = 0
  for (const v of windows.values()) total += v
  return { total, snapshots_today: today.length }
}

function deriveWeeklyUsage(snapshots, weeklyLimit) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  const week = snapshots.filter(s => new Date(s.ts).getTime() > cutoff)
  if (week.length === 0) return null

  // Group by day, then by reset window within each day
  const dayMap = new Map()
  for (const s of week) {
    const day = s.ts.split('T')[0]
    if (!dayMap.has(day)) dayMap.set(day, new Map())
    const windows = dayMap.get(day)
    const key = s.reset || s.ts
    const existing = windows.get(key)
    if (!existing || s.tokens_used > existing) {
      windows.set(key, s.tokens_used)
    }
  }

  let total = 0
  for (const windows of dayMap.values()) {
    for (const v of windows.values()) total += v
  }

  const pct = weeklyLimit > 0 ? Math.round((total / weeklyLimit) * 100) : 0
  return { total_tokens: total, used_percent: pct }
}

function estimateSpend(totalTokens) {
  // Conservative estimate: assume ~30% input, ~70% output (typical conversation ratio)
  const inputTokens  = totalTokens * 0.3
  const outputTokens = totalTokens * 0.7
  const p = PRICING.default
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output
}

// ─── Live data fetching ──────────────────────────────────────────────────────
async function fetchLiveData(apiKey) {
  const live = {}

  // ── Rate-limit headers from a minimal Messages call (Haiku, 1 token) ──
  const modelsRes = await anthropicPing(apiKey)
  console.log('[api] ping status:', modelsRes?.status, modelsRes?.body?.slice(0, 150))
  if (modelsRes && modelsRes.status === 200) {
    const h = modelsRes.headers

    // Token rate-limit window (per-minute bucket)
    const tokLimit  = parseInt(h['anthropic-ratelimit-tokens-limit'])
    const tokRemain = parseInt(h['anthropic-ratelimit-tokens-remaining'])
    const inputRemain  = parseInt(h['anthropic-ratelimit-input-tokens-remaining'])
    const outputRemain = parseInt(h['anthropic-ratelimit-output-tokens-remaining'])

    if (!isNaN(tokLimit) && tokLimit > 0 && !isNaN(tokRemain)) {
      const used = tokLimit - tokRemain
      live.session = {
        used_percent: Math.round((used / tokLimit) * 100),
        limit:        tokLimit,
        remaining:    tokRemain,
        input_remaining:  isNaN(inputRemain)  ? null : inputRemain,
        output_remaining: isNaN(outputRemain) ? null : outputRemain
      }
      const resetISO = h['anthropic-ratelimit-tokens-reset']
      if (resetISO) {
        const diffMs = Math.max(0, new Date(resetISO) - Date.now())
        live.session.resets_in_hours   = Math.floor(diffMs / 3600000)
        live.session.resets_in_minutes = Math.floor((diffMs % 3600000) / 60000)
        live.session.reset_iso = resetISO
      }

      // ── Log snapshot for local tracking ──
      const usageLog = appendSnapshot({
        tokens_limit:     tokLimit,
        tokens_remaining: tokRemain,
        input_remaining:  isNaN(inputRemain)  ? null : inputRemain,
        output_remaining: isNaN(outputRemain) ? null : outputRemain,
        reset:            resetISO || null
      })

      // ── Derive daily/weekly/monthly from accumulated snapshots ──
      const config = readConfigFile()
      const weeklyLimit = config.weekly?.limit || 1_000_000

      const daily = deriveDailyUsage(usageLog.snapshots)
      if (daily) {
        live.daily_tokens = { total: daily.total, snapshots: daily.snapshots_today }
      }

      const weekly = deriveWeeklyUsage(usageLog.snapshots, weeklyLimit)
      if (weekly) {
        live.weekly = { used_percent: weekly.used_percent, total_tokens: weekly.total_tokens }
      }

      // Estimate monthly spend from last 30 days of snapshots
      const monthCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
      const monthSnaps = usageLog.snapshots.filter(s => new Date(s.ts).getTime() > monthCutoff)
      if (monthSnaps.length > 0) {
        const monthDaily = new Map()
        for (const s of monthSnaps) {
          const day = s.ts.split('T')[0]
          if (!monthDaily.has(day)) monthDaily.set(day, new Map())
          const windows = monthDaily.get(day)
          const key = s.reset || s.ts
          const existing = windows.get(key)
          if (!existing || s.tokens_used > existing) windows.set(key, s.tokens_used)
        }
        let monthTotal = 0
        for (const windows of monthDaily.values()) {
          for (const v of windows.values()) monthTotal += v
        }
        const spend = estimateSpend(monthTotal)
        live.extra_usage = {
          total_spent: Math.round(spend * 100) / 100,
          monthly_limit: config.extra_usage?.monthly_limit || 10.00
        }
      }
    }

    // Request rate-limit window
    const reqLimit  = parseInt(h['anthropic-ratelimit-requests-limit'])
    const reqRemain = parseInt(h['anthropic-ratelimit-requests-remaining'])
    if (!isNaN(reqLimit) && reqLimit > 0 && !isNaN(reqRemain)) {
      live.rate_limits = {
        requests_limit:     reqLimit,
        requests_remaining: reqRemain,
        tokens_limit:       tokLimit  || null,
        tokens_remaining:   tokRemain || null
      }
    }
  }

  // ── Admin API probe (bonus — silently skip if no access) ──
  try {
    const orgRes = await anthropicGet(apiKey, '/v1/organizations')
    if (orgRes && orgRes.status === 200) {
      const orgs = JSON.parse(orgRes.body)
      const orgId = orgs.data?.[0]?.id
      if (orgId) {
        const today = new Date().toISOString().split('T')[0]
        const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0]
        const usageRes = await anthropicGet(apiKey,
          `/v1/organizations/${orgId}/usage?start_date=${weekAgo}&end_date=${today}`)
        if (usageRes && usageRes.status === 200) {
          const parsed = JSON.parse(usageRes.body)
          let totalIn = 0, totalOut = 0
          for (const row of (parsed.data ?? [])) {
            totalIn  += (row.input_tokens ?? 0)
            totalOut += (row.output_tokens ?? 0)
          }
          if (totalIn + totalOut > 0) {
            live.daily_tokens = { input: totalIn, output: totalOut, total: totalIn + totalOut }
          }
        }
      }
    }
  } catch (e) { console.log('[api] Admin usage endpoint unavailable:', e.message) }

  return live
}

function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'usage_config.json'), 'utf8'))
  } catch (e) { console.error('[config] Read failed:', e.message); return {} }
}

function mergeData(base, live) {
  const out = { ...base }

  // Live rate-limit data overrides manual session entry
  if (live.session) {
    out.session = { ...(base.session ?? {}), ...live.session }
  }
  // Live weekly tracking overrides manual, but keep reset_day/reset_time from config
  if (live.weekly) {
    out.weekly = { ...(base.weekly ?? {}), ...live.weekly }
  }
  // Live spend estimate overrides manual
  if (live.extra_usage) {
    out.extra_usage = { ...(base.extra_usage ?? {}), ...live.extra_usage }
  }
  if (live.rate_limits)  out.rate_limits  = live.rate_limits
  if (live.daily_tokens) out.daily_tokens = live.daily_tokens

  out.last_updated = new Date().toISOString()
  return out
}

// Build display data from cached snapshots — no API call
function getCachedData() {
  const base = readConfigFile()
  const log  = readUsageLog()
  const cached = {}

  if (log.snapshots.length > 0) {
    const last = log.snapshots[log.snapshots.length - 1]

    // Session from last snapshot
    if (last.tokens_limit > 0) {
      cached.session = {
        used_percent: Math.round((last.tokens_used / last.tokens_limit) * 100),
        limit:        last.tokens_limit,
        remaining:    last.tokens_remaining,
        input_remaining:  last.input_remaining,
        output_remaining: last.output_remaining,
        resets_in_hours:   0,
        resets_in_minutes: 0
      }
      if (last.reset) {
        const diffMs = Math.max(0, new Date(last.reset) - Date.now())
        cached.session.resets_in_hours   = Math.floor(diffMs / 3600000)
        cached.session.resets_in_minutes = Math.floor((diffMs % 3600000) / 60000)
      }
    }

    // Derive daily/weekly/spend from cached snapshots
    const weeklyLimit = base.weekly?.limit || 1_000_000
    const daily = deriveDailyUsage(log.snapshots)
    if (daily) cached.daily_tokens = { total: daily.total, snapshots: daily.snapshots_today }

    const weekly = deriveWeeklyUsage(log.snapshots, weeklyLimit)
    if (weekly) cached.weekly = { used_percent: weekly.used_percent, total_tokens: weekly.total_tokens }

    const monthCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    const monthSnaps = log.snapshots.filter(s => new Date(s.ts).getTime() > monthCutoff)
    if (monthSnaps.length > 0) {
      const monthDaily = new Map()
      for (const s of monthSnaps) {
        const day = s.ts.split('T')[0]
        if (!monthDaily.has(day)) monthDaily.set(day, new Map())
        const windows = monthDaily.get(day)
        const key = s.reset || s.ts
        const existing = windows.get(key)
        if (!existing || s.tokens_used > existing) windows.set(key, s.tokens_used)
      }
      let monthTotal = 0
      for (const windows of monthDaily.values()) {
        for (const v of windows.values()) monthTotal += v
      }
      cached.extra_usage = {
        total_spent: Math.round(estimateSpend(monthTotal) * 100) / 100,
        monthly_limit: base.extra_usage?.monthly_limit || 10.00
      }
    }

    cached.last_updated = last.ts
  }

  return mergeData(base, cached)
}

// ─── Push notifications ──────────────────────────────────────────────────────
function checkAndNotify(data) {
  if (muteNotifications || !Notification.isSupported()) return

  const sPct = data?.session?.used_percent
  const wPct = data?.weekly?.used_percent

  // Detect session reset — pct dropped significantly
  if (prevSessionPct != null && prevSessionPct > 50 && sPct != null && sPct < 15) {
    firedNotifications.clear()
  }
  prevSessionPct = sPct

  const resetMin = data?.session?.resets_in_minutes ?? 0
  const resetHr = data?.session?.resets_in_hours ?? 0
  const resetLabel = resetHr > 0 ? `${resetHr}h ${resetMin}m` : `${resetMin} min`
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
  const today = dayNames[new Date().getDay()]
  const weeklyReset = data?.weekly?.reset_label || 'next week'

  const alerts = [
    { key: 's100', pct: sPct, threshold: 100,
      title: "You're cooked.",
      body: `Session limit hit. Resets in ${resetLabel}. Go touch grass.` },
    { key: 's90', pct: sPct, threshold: 90,
      title: 'Almost tapped out — 90%',
      body: "You've got maybe a few messages left. Make 'em count." },
    { key: 's80', pct: sPct, threshold: 80,
      title: 'Heads up — 80% used',
      body: "You're burning through this session. Might want to pace yourself." },
    { key: 'w95', pct: wPct, threshold: 95,
      title: "Weekly's almost done",
      body: `95% used. After this, you're waiting til ${weeklyReset}.` },
    { key: 'w80', pct: wPct, threshold: 80,
      title: 'Weekly limit creeping up',
      body: `80% of your weekly allowance is gone. It's only ${today}.` },
  ]

  for (const a of alerts) {
    if (a.pct != null && a.pct >= a.threshold && !firedNotifications.has(a.key)) {
      firedNotifications.add(a.key)
      new Notification({ title: a.title, body: a.body, silent: false }).show()
      break  // one notification per refresh cycle
    }
  }
}

// Full refresh — tries console scrape first, then API fallback
async function refreshAndPush() {
  if (refreshLock) return
  refreshLock = true
  try {
    const base = readConfigFile()
    let live = {}

    // Try console scrape for Claude Code/Chat usage
    const scraped = await scrapeConsoleUsage()
    if (scraped) {
      const consoleLive = parseScrapedData(scraped)
      live = { ...live, ...consoleLive }
      isLoggedInToConsole = true
      // Cache the raw scrape
      try {
        const cachePath = path.join(AUTH_DIR, 'console_cache.json')
        fs.writeFileSync(cachePath, JSON.stringify(scraped, null, 2), { mode: 0o600 })
      } catch (e) { console.error('[refresh] Cache write failed:', e.message) }
      console.log('[refresh] Console scrape successful')
    }

    // Also fetch API rate limits — throttled to every 5 min (costs real tokens)
    // Disabled by default: the console scrape above is free and covers the same
    // numbers. Flip API_PING_ENABLED to true only if you want the paid fallback.
    const apiKey = API_PING_ENABLED ? getStoredKey() : null
    if (apiKey && (Date.now() - lastApiPing >= API_PING_INTERVAL)) {
      console.log('[api] Pinging Anthropic API...')
      const apiLive = await fetchLiveData(apiKey)
      console.log('[api] Response keys:', Object.keys(apiLive), JSON.stringify(apiLive).slice(0, 300))
      lastApiPing = Date.now()
      // API data fills in what console didn't provide
      if (apiLive.session && !live.session) live.session = apiLive.session
      if (apiLive.rate_limits) live.rate_limits = apiLive.rate_limits
      if (apiLive.daily_tokens && !live.daily_tokens) live.daily_tokens = apiLive.daily_tokens
      if (apiLive.weekly && !live.weekly) live.weekly = apiLive.weekly
      if (apiLive.extra_usage && !live.extra_usage) live.extra_usage = apiLive.extra_usage
    }

    const merged = mergeData(base, live)
    latestData = merged
    if (win && !win.isDestroyed()) win.webContents.send('config-updated', merged)
    checkAndNotify(merged)
    updateTrayTitle()
    rebuildTrayMenu()
    return merged
  } finally {
    refreshLock = false
  }
}

// ─── Auto-refresh timer ───────────────────────────────────────────────────────
const REFRESH_INTERVAL  = 60 * 1000        // 1 min — console scrape cadence
const API_PING_INTERVAL = 5 * 60 * 1000    // 5 min — Anthropic API (costs tokens)
const API_PING_ENABLED  = false            // paid API fallback — off; scrape is free
let lastApiPing = 0
let refreshTimer = null
let refreshLock = false

function startRefreshTimer() {
  clearInterval(refreshTimer)
  refreshTimer = setInterval(refreshAndPush, REFRESH_INTERVAL)
}

function stopRefreshTimer() {
  clearInterval(refreshTimer)
  refreshTimer = null
}

// ─── Tray icon (Claude asterisk + percentage as one unit) ────────────────────

// 5×7 bitmap font for digits and %
const GLYPH = {
  '0': [0x0e,0x11,0x13,0x15,0x19,0x11,0x0e],
  '1': [0x04,0x0c,0x04,0x04,0x04,0x04,0x0e],
  '2': [0x0e,0x11,0x01,0x06,0x08,0x10,0x1f],
  '3': [0x0e,0x11,0x01,0x06,0x01,0x11,0x0e],
  '4': [0x02,0x06,0x0a,0x12,0x1f,0x02,0x02],
  '5': [0x1f,0x10,0x1e,0x01,0x01,0x11,0x0e],
  '6': [0x06,0x08,0x10,0x1e,0x11,0x11,0x0e],
  '7': [0x1f,0x01,0x02,0x04,0x08,0x08,0x08],
  '8': [0x0e,0x11,0x11,0x0e,0x11,0x11,0x0e],
  '9': [0x0e,0x11,0x11,0x0f,0x01,0x02,0x0c],
  '%': [0x18,0x19,0x02,0x04,0x08,0x13,0x03],
}

function buildTrayIcon(pct) {
  const text = pct != null ? `${Math.round(pct)}%` : ''
  // Asterisk: 16px wide area. Text: 7px per char. Gap: 2px. Pad: 2px each side.
  const charW = 6, charH = 7, scale = 2
  const sCharW = charW * scale, sCharH = charH * scale
  const asteriskSize = 32  // 16pt @2x
  const gap = text ? 2 : 0
  const textW = text ? text.length * sCharW : 0
  const w = asteriskSize + gap + textW + 2
  const h = 32  // 16pt @2x
  const buf = Buffer.alloc(w * h * 4, 0)

  const setPixel = (x, y, alpha) => {
    const ix = Math.floor(x), iy = Math.floor(y)
    if (ix < 0 || ix >= w || iy < 0 || iy >= h) return
    const i = (iy * w + ix) * 4
    buf[i + 3] = Math.max(buf[i + 3], Math.round(alpha * 255))
  }

  // Draw 6-arm asterisk on the left
  const cx = asteriskSize / 2, cy = h / 2
  const r = asteriskSize * 0.38, armW = 1.8
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < asteriskSize; x++) {
      const dx = x - cx + 0.5, dy = y - cy + 0.5
      let alpha = 0
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3
        const along = dx * Math.cos(a) + dy * Math.sin(a)
        const perp = Math.abs(-dx * Math.sin(a) + dy * Math.cos(a))
        if (Math.abs(along) < r && perp < armW)
          alpha = Math.max(alpha, Math.min(1, armW - perp))
      }
      if (alpha > 0) setPixel(x, y, alpha)
    }
  }

  // Draw percentage text to the right of the asterisk
  if (text) {
    const textX = asteriskSize + gap
    const textY = Math.floor((h - sCharH) / 2)
    for (let ci = 0; ci < text.length; ci++) {
      const glyph = GLYPH[text[ci]]
      if (!glyph) continue
      for (let row = 0; row < charH; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row] & (1 << (4 - col))) {
            // Draw scaled pixel block
            for (let sy = 0; sy < scale; sy++) {
              for (let sx = 0; sx < scale; sx++) {
                setPixel(textX + ci * sCharW + col * scale + sx, textY + row * scale + sy, 1.0)
              }
            }
          }
        }
      }
    }
  }

  const img = nativeImage.createFromBuffer(buf, { width: w, height: h, scaleFactor: 2.0 })
  img.setTemplateImage(true)
  return img
}

// ─── Tray ─────────────────────────────────────────────────────────────────────
let tray = null

function toggleVisibility() {
  if (!win) return
  if (win.isVisible()) {
    // Tell renderer to animate out, then hide window after animation
    win.webContents.send('animate-out')
    setTimeout(() => { if (win && !win.isDestroyed()) { win.hide(); rebuildTrayMenu() } }, 220)
  } else {
    win.show()
    win.focus()
    win.webContents.send('animate-in')
    rebuildTrayMenu()
  }
}

function showAuthScreen() {
  if (!win) return
  win.show()
  win.focus()
  win.webContents.send('show-auth-view')
  rebuildTrayMenu()
}

function updateTrayTitle() {
  if (!tray) return
  const pct = latestData?.session?.used_percent
  const ver = `v${app.getVersion()}`
  tray.setImage(buildTrayIcon(pct))
  tray.setTitle('')
  if (pct != null) {
    tray.setToolTip(`Claude Session Monitor ${ver} · Session ${pct}%`)
  } else {
    tray.setToolTip(`Claude Session Monitor ${ver}`)
  }
}

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
  let resetPart = '—'
  if (w.reset_label) {
    resetPart = w.reset_label.replace(/^Resets\s+/, '')
  } else if (w.reset_day && w.reset_time) {
    resetPart = `${w.reset_day} ${w.reset_time}`
  }
  return `Weekly ${pct}% · Resets ${resetPart}`
}

function rebuildTrayMenu() {
  if (!tray || !win) return
  const loginItem = app.getLoginItemSettings()
  const isAuthed  = !!getStoredKey()
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: buildSessionStatusLabel(latestData), click: () => {} },
    { label: buildWeeklyStatusLabel(latestData),  click: () => {} },
    { type: 'separator' },
    { label: win.isVisible() ? 'Hide Widget' : 'Show Widget', click: toggleVisibility },
    {
      label: 'Settings',
      submenu: [
        { label: 'Always on Top', type: 'checkbox', checked: win.isAlwaysOnTop(),
          click: () => { win.setAlwaysOnTop(!win.isAlwaysOnTop()); rebuildTrayMenu() } },
        { label: 'Launch at Login', type: 'checkbox', checked: loginItem.openAtLogin,
          click: () => {
            app.setLoginItemSettings({ openAtLogin: !loginItem.openAtLogin, openAsHidden: true })
            rebuildTrayMenu()
          }
        },
        { label: 'Mute Notifications', type: 'checkbox', checked: muteNotifications,
          click: () => { muteNotifications = !muteNotifications; rebuildTrayMenu() }
        },
        { type: 'separator' },
        { label: 'Refresh Now', click: () => refreshAndPush() },
        { label: isLoggedInToConsole ? 'Claude.ai Connected ✓' : 'Sign in to Claude.ai…',
          click: () => { if (!isLoggedInToConsole) openConsoleLogin() } },
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
    { label: 'Quit Claude Session Monitor', click: () => app.quit() }
  ]))
}

function createTray() {
  tray = new Tray(buildTrayIcon(null))
  tray.setToolTip(`Claude Session Monitor v${app.getVersion()}`)
  rebuildTrayMenu()
  // tray click intentionally does nothing — use the right-click menu to show/hide
}

// ─── Global hotkey (Option+Space) ─────────────────────────────────────────────
function setupGlobalHotkey() {
  globalShortcut.register('Control+Space', () => {
    toggleVisibility()
  })
}

// ─── Window ───────────────────────────────────────────────────────────────────
let win = null
let watchDebounce = null

function createWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize

  const WIN_W = 460
  const WIN_H = 198

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: width - WIN_W - 16,
    y: 16,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    hasShadow: true,
    roundedCorners: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  win.loadFile('renderer/index.html')

  // ── Edge snapping ──
  const SNAP = 20
  let snapTimer = null

  win.on('moved', () => {
    clearTimeout(snapTimer)
    snapTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return
      const [x, y] = win.getPosition()
      const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
      const { width: ww, height: wh } = win.getBounds()
      let nx = x, ny = y

      if (x <= SNAP)              nx = 0
      else if (x + ww >= sw - SNAP) nx = sw - ww

      if (y <= SNAP)              ny = 0
      else if (y + wh >= sh - SNAP) ny = sh - wh

      if (nx !== x || ny !== y) win.setPosition(nx, ny, true)
    }, 80)
  })

  // ── File watcher for usage_config.json ──
  const configPath = path.join(__dirname, 'usage_config.json')
  try {
    fs.watch(configPath, { persistent: false }, () => {
      clearTimeout(watchDebounce)
      watchDebounce = setTimeout(() => refreshAndPush(), 150)
    })
  } catch (e) { console.log('[config] File watcher setup skipped:', e.message) }
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('get-version', () => app.getVersion())

ipcMain.handle('get-auth-state', () => {
  const key = getStoredKey()
  return { authenticated: !!key }
})

ipcMain.handle('validate-api-key', async (_, apiKey) => {
  if (typeof apiKey !== 'string' || !apiKey.startsWith('sk-ant-') || apiKey.length > 200) {
    return { valid: false, error: 'Invalid key format' }
  }
  return validateApiKey(apiKey)
})

ipcMain.handle('save-api-key', (_, apiKey) => {
  try {
    storeKey(apiKey)
    startRefreshTimer()
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

ipcMain.handle('sign-out', () => {
  stopRefreshTimer()
  clearKey()
})

ipcMain.handle('import-chrome-session', async () => {
  const ok = await importChromeSession()
  if (ok) {
    isLoggedInToConsole = true
    if (scrapeWin && !scrapeWin.isDestroyed()) scrapeWin.close()
    rebuildTrayMenu()
    startRefreshTimer()          // ← start auto-refresh
    await refreshAndPush()       // ← immediate first scrape + push to UI
  }
  return ok
})

ipcMain.handle('get-config', () => {
  // Startup: return cached data instantly, no API call
  return getCachedData()
})

ipcMain.handle('refresh-live', async () => {
  // Manual refresh: makes real API call + logs snapshot
  return refreshAndPush()
})

ipcMain.handle('toggle-always-on-top', () => {
  if (!win) return true
  const newState = !win.isAlwaysOnTop()
  win.setAlwaysOnTop(newState)
  return newState
})

ipcMain.handle('set-window-height', (_, h) => {
  if (!win) return
  const clamped = Math.max(100, Math.min(800, Number(h) || 198))
  const { x, y, width } = win.getBounds()
  win.setBounds({ x, y, width, height: clamped }, true)
})

ipcMain.handle('close-window', () => {
  if (win) {
    win.webContents.send('animate-out')
    setTimeout(() => { if (win && !win.isDestroyed()) { win.hide(); rebuildTrayMenu() } }, 220)
  }
})

ipcMain.handle('open-external', (_, url) => {
  try {
    const { protocol, hostname } = new URL(url)
    const allowed = ['console.anthropic.com', 'anthropic.com']
    if (protocol === 'https:' && allowed.includes(hostname)) {
      shell.openExternal(url)
    }
  } catch (e) { console.log('[open-external] Blocked URL:', e.message) }
})

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (app.dock) app.dock.hide()
  createWindow()
  createTray()
  setupGlobalHotkey()
  if (sandboxBridge) sandboxBridge.start({
    toggleVisibility,
    isVisible: () => win && win.isVisible(),
    getMute:   () => muteNotifications,
  })

  // Start auto-refresh if we have an API key
  if (getStoredKey()) startRefreshTimer()

  // Auto-detect existing console session from Chrome on startup
  // Check if the persistent Electron session already has a valid cookie
  const ses = getConsoleSession()
  const cookies = await ses.cookies.get({ url: 'https://claude.ai', name: 'sessionKey' })
  if (cookies.length > 0) {
    // We have a session from a previous Chrome import — verify it
    isLoggedInToConsole = true
    rebuildTrayMenu()
    startRefreshTimer()
    refreshAndPush().catch(e => console.error('[startup] Refresh error:', e.message))
    console.log('[startup] Existing Claude.ai session found — auto-refreshing')
  } else {
    // No existing session — try auto-importing from Chrome silently
    try {
      const ok = await importChromeSession()
      if (ok) {
        isLoggedInToConsole = true
        rebuildTrayMenu()
        startRefreshTimer()
        refreshAndPush().catch(e => console.error('[startup] Refresh error:', e.message))
        console.log('[startup] Auto-imported Chrome session — monitoring started')
      }
    } catch (e) {
      console.log('[startup] No Chrome session available:', e.message)
    }
  }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
