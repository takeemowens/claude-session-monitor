// ─── State ────────────────────────────────────────────────────────────────────
let lastUpdatedISO = null
let isDark = false
let isExpanded = false

// ─── Theme ────────────────────────────────────────────────────────────────────
function applyTheme(dark, { persist = true } = {}) {
  isDark = dark
  if (persist) { try { localStorage.setItem('theme', dark ? 'dark' : 'light') } catch (e) {} }
  document.getElementById('app').classList.toggle('dark', dark)
  document.getElementById('icon-moon').style.display = dark ? 'none'  : 'block'
  document.getElementById('icon-sun').style.display  = dark ? 'block' : 'none'
}

// System appearance is the default; an explicit toggle wins and is remembered.
// Storage reads are guarded: it can be unavailable in some contexts.
const _mq = window.matchMedia('(prefers-color-scheme: dark)')
function storedTheme() { try { return localStorage.getItem('theme') } catch (e) { return null } }
applyTheme(storedTheme() ? storedTheme() === 'dark' : _mq.matches, { persist: false })
_mq.addEventListener('change', e => { if (!storedTheme()) applyTheme(e.matches, { persist: false }) })

// ─── Dynamic height measurement ──────────────────────────────────────────────
function measureDashboardHeight() {
  const dashboard = document.getElementById('dashboard-view')
  if (!dashboard) return 200
  // Use last child's bottom edge — accurate regardless of flex layout
  const last = dashboard.lastElementChild
  return last.offsetTop + last.offsetHeight
}

// Measure the auth column, not #auth-view. The view is position:absolute with
// inset:0, so it is stretched to whatever the window already is — reading its
// height to then set the window height is circular and just returns the
// current value. Measuring the content and adding the view's own padding is
// what makes the top and bottom padding fixed: the window is always exactly
// content plus padding, whatever the content happens to be.
function measureAuthHeight() {
  const view = document.getElementById('auth-view')
  const col  = view && view.querySelector('.auth-col')
  if (!col) return 198
  const cs = getComputedStyle(view)
  return Math.ceil(
    col.getBoundingClientRect().height +
    parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
  )
}


// The display face is font-display:block, so the first paint is invisible text
// at fallback metrics. Measuring then locks in the wrong height.
// Height is measured, width is not: null keeps the default popover width so
// the auth view and the dashboard stay the same size as each other.
function sizeAuthWindow() {
  const apply = () => requestAnimationFrame(
    () => window.electronAPI.setWindowSize(null, measureAuthHeight())
  )
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(apply)
  else apply()
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Show app version in footer
  window.electronAPI.getVersion().then(v => {
    const el = document.getElementById('app-version')
    if (el) el.textContent = `v${v}`
  }).catch(() => {})

  const authState = await window.electronAPI.getAuthState()

  if (authState.authenticated) {
    showDashboard()
    await loadAndRender()
    // Start collapsed — measure actual content
    requestAnimationFrame(() => window.electronAPI.setWindowHeight(measureDashboardHeight()))
  } else {
    showAuth()
  }

  window.electronAPI.onConfigUpdated((data) => {
    lastUpdatedISO = data.last_updated
    // getAuthState() is a one-shot check at load. If it resolved before the
    // main process's own async cookie check/import finished, showAuth() ran
    // on a stale answer -- this is the correction: whenever real session
    // data arrives, authenticated is true by definition, so the view should
    // reflect that now, not stay stuck on whatever was decided earlier.
    if (data.session && document.getElementById('auth-view').classList.contains('active')) {
      showDashboard()
    }
    renderDashboard(data)
  })

  window.electronAPI.onManualRefresh(async () => {
    const data = await window.electronAPI.refreshLive()
    if (data) { lastUpdatedISO = data.last_updated; renderDashboard(data) }
  })

  window.electronAPI.onShowAuthView(() => {
    clearAuthError()
    setConnecting(false)
    isExpanded = false
    document.getElementById('details-panel').classList.remove('open')
    document.getElementById('btn-expand').classList.remove('open')
    document.getElementById('expand-label').textContent = 'Show more'
    showAuth()
  })

  startTimestampTicker()
  bindAuthControls()
  bindDashboardControls()
  bindAnimations()
})

// ─── View transitions ─────────────────────────────────────────────────────────
function showAuth() {
  document.getElementById('auth-view').classList.add('active')
  document.getElementById('dashboard-view').classList.remove('active')
  sizeAuthWindow()
}

function setExpanded(open) {
  isExpanded = open
  try { localStorage.setItem('expanded', open ? '1' : '0') } catch (e) {}
  document.getElementById('details-panel').classList.toggle('open', open)
  document.getElementById('btn-expand').classList.toggle('open', open)
  document.getElementById('expand-label').textContent = open ? 'Show less' : 'Show more'
  document.getElementById('btn-expand').setAttribute('aria-expanded', String(open))
  window.electronAPI.setWindowHeight(measureDashboardHeight())
}

function showDashboard() {
  document.getElementById('dashboard-view').classList.add('active')
  document.getElementById('auth-view').classList.remove('active')
  // Restore the remembered expanded state rather than collapsing every time
  let open = false
  try { open = localStorage.getItem('expanded') === '1' } catch (e) {}
  isExpanded = open
  document.getElementById('details-panel').classList.toggle('open', open)
  document.getElementById('btn-expand').classList.toggle('open', open)
  document.getElementById('expand-label').textContent = open ? 'Show less' : 'Show more'
  document.getElementById('btn-expand').setAttribute('aria-expanded', String(open))
  // null width restores the default: the auth view narrows the window to its
  // own content, and the dashboard needs the full popover back.
  requestAnimationFrame(
    () => window.electronAPI.setWindowSize(null, measureDashboardHeight())
  )
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function bindAuthControls() {
  const btn = document.getElementById('connect-btn')

  btn.addEventListener('click', async () => {
    setConnecting(true)
    clearAuthError()

    // Reads the claude.ai sessionKey out of Chrome. No key to type.
    const ok = await window.electronAPI.importChromeSession()
    if (ok) {
      showDashboard()
      await loadAndRender()
    } else {
      setAuthError('No active claude.ai session found. Sign in to claude.ai in Chrome, then try again.')
      setConnecting(false)
    }
  })
}

function setConnecting(loading) {
  const btn     = document.getElementById('connect-btn')
  const label   = document.getElementById('connect-label')
  const spinner = document.getElementById('connect-spinner')
  const arrow   = document.getElementById('connect-arrow')
  btn.disabled          = loading
  label.textContent     = loading ? 'Connecting…' : 'Connect Claude.ai session'
  spinner.style.display = loading ? 'block' : 'none'
  arrow.style.display   = loading ? 'none'  : 'block'
}

// Both re-size: the error is part of the column, so showing or clearing it
// changes the content height the window is supposed to fit.
function setAuthError(msg) {
  document.getElementById('auth-error').textContent = msg
  sizeAuthWindow()
}
function clearAuthError() {
  document.getElementById('auth-error').textContent = ''
  sizeAuthWindow()
}

// ─── Dashboard data ───────────────────────────────────────────────────────────
async function loadAndRender() {
  const data = await window.electronAPI.getConfig()
  if (!data) return
  lastUpdatedISO = data.last_updated
  // Defer one frame so bars animate from 0%
  requestAnimationFrame(() => setTimeout(() => renderDashboard(data), 40))
}

function renderDashboard(data) {
  renderSession(data.session)
  renderWeekly(data.weekly)
  renderExtra(data.extra_usage)
  renderDailyTokens(data.daily_tokens)
  renderFooter(data.balance, data.last_updated)
  // Sections show or hide with the data, so the height measured at show time
  // can be stale by the time the first payload lands. Re-fit after each render.
  if (document.getElementById('dashboard-view').classList.contains('active')) {
    requestAnimationFrame(() => window.electronAPI.setWindowHeight(measureDashboardHeight()))
  }
}

// ─── Per-second countdown tick (free — no network) ───────────────────────────
let _tickIso = null
let _tickTimer = null

function startResetTick(isoStr) {
  _tickIso = isoStr
  if (_tickTimer) return   // already running; just updating _tickIso is enough
  _tickTimer = setInterval(() => {
    if (!_tickIso) return
    const target = new Date(_tickIso)
    const diffMs = Math.max(0, target - Date.now())
    if (diffMs === 0) { _tickIso = null; return }
    const h = Math.floor(diffMs / 3600000)
    const m = Math.floor((diffMs % 3600000) / 60000)
    const s = Math.floor((diffMs % 60000) / 1000)
    const exact = formatExactTime(target)
    const countdown = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`
    const el = document.getElementById('session-reset')
    if (el) el.textContent = exact ? `${countdown} · ${exact}` : countdown
  }, 1000)
}

function formatExactTime(target) {
  if (!target || isNaN(target)) return ''
  const dd   = String(target.getDate()).padStart(2, '0')
  const mm   = String(target.getMonth() + 1).padStart(2, '0')
  const yy   = String(target.getFullYear()).slice(2)
  const hrs  = target.getHours()
  const mins = String(target.getMinutes()).padStart(2, '0')
  const ampm = hrs >= 12 ? 'PM' : 'AM'
  const h12  = hrs % 12 || 12
  const isToday = new Date().toDateString() === target.toDateString()
  return isToday ? `${h12}:${mins} ${ampm}` : `${dd}/${mm}/${yy}, ${h12}:${mins} ${ampm}`
}

function nextWeekdayDate(dayStr, timeStr) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const idx = days.indexOf(dayStr)
  if (idx < 0) return null
  const parts = timeStr.split(' ')
  const [hh, mm] = parts[0].split(':').map(Number)
  const ampm = parts[1]
  let hour = hh
  if (ampm === 'PM' && hh !== 12) hour += 12
  if (ampm === 'AM' && hh === 12) hour = 0
  const now = new Date()
  const target = new Date(now)
  target.setHours(hour, mm, 0, 0)
  let diff = idx - now.getDay()
  if (diff < 0 || (diff === 0 && target <= now)) diff += 7
  target.setDate(target.getDate() + diff)
  return target
}

function renderSession(s) {
  const pct = s.used_percent ?? 0
  document.getElementById('bar-session').style.width = `${Math.min(pct, 100)}%`
  document.getElementById('bar-session').parentElement.setAttribute('aria-valuenow', String(Math.min(pct, 100)))
  document.getElementById('session-pct').textContent = `${pct}%`

  const h = s.resets_in_hours ?? 0
  const m = s.resets_in_minutes ?? 0
  let countdown = ''
  if (h > 0 && m > 0) countdown = `${h}h ${m}m`
  else if (h > 0)      countdown = `${h}h`
  else if (m > 0)      countdown = `${m}m`

  let target = null
  if (s.reset_iso) {
    target = new Date(s.reset_iso)
  } else if (h || m) {
    target = new Date(Date.now() + (h * 3600 + m * 60) * 1000)
  }
  const exact = formatExactTime(target)

  let label = '—'
  if (countdown && exact) label = `${countdown} · ${exact}`
  else if (countdown)     label = `Resets in ${countdown}`
  else if (exact)         label = exact
  document.getElementById('session-reset').textContent = label

  // Kick off per-second tick if we have an exact reset time
  if (s.reset_iso) startResetTick(s.reset_iso)
}

function renderWeekly(w) {
  if (!w) {
    document.getElementById('bar-weekly').style.width = '0%'
    document.getElementById('weekly-pct').textContent = '—'
    document.getElementById('weekly-reset').textContent = 'No data yet'
    return
  }
  const pct = w.used_percent ?? 0
  document.getElementById('bar-weekly').style.width  = `${Math.min(pct, 100)}%`
  document.getElementById('bar-weekly').parentElement.setAttribute('aria-valuenow', String(Math.min(pct, 100)))
  document.getElementById('weekly-pct').textContent  = pct > 0 ? `${pct}%` : '—'

  let resetLabel = '—'
  // Try to derive an exact date from the reset day/time
  const dayStr  = w.reset_day  || (w.reset_label && w.reset_label.match(/^Resets (\w{3})/)?.[1])
  const timeStr = w.reset_time || (w.reset_label && w.reset_label.match(/(\d+:\d+ [AP]M)$/)?.[1])
  if (dayStr && timeStr) {
    const target = nextWeekdayDate(dayStr, timeStr)
    if (target) {
      const exact = formatExactTime(target)
      const diffMs = target - Date.now()
      const dh = Math.floor(diffMs / 3600000)
      const dm = Math.floor((diffMs % 3600000) / 60000)
      if (dh < 24) {
        // Resetting today — show countdown + time
        const countdown = dh > 0 ? `${dh}h ${dm}m` : `${dm}m`
        resetLabel = `${countdown} · ${exact}`
      } else {
        // Future date — show day name + full date/time
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
        resetLabel = `${days[target.getDay()]} · ${exact}`
      }
    }
  } else if (w.total_tokens) {
    resetLabel = `${formatTokens(w.total_tokens)} tokens tracked`
  }
  document.getElementById('weekly-reset').textContent = resetLabel
}

function renderExtra(e) {
  // No live source for this unless the account enables extra usage; hide the
  // whole section rather than showing dashes that read like a zero balance.
  const section = document.getElementById('extra-section')
  const divider = document.getElementById('extra-divider')
  const absent = !e || e.total_spent == null || e.monthly_limit == null || e.monthly_limit === 0
  section.style.display = absent ? 'none' : ''
  divider.style.display = absent ? 'none' : ''
  if (absent) return
  document.getElementById('bar-extra').parentElement.setAttribute('aria-valuenow', String(Math.min(Math.round((e.total_spent / e.monthly_limit) * 100), 100)))

  const pct        = (e.total_spent / e.monthly_limit) * 100
  const isOverflow = pct > 100
  const overflowPct = Math.round(pct - 100)

  document.getElementById('extra-meta').textContent = `$${e.total_spent.toFixed(2)} / $${e.monthly_limit.toFixed(2)}`

  const pctEl = document.getElementById('extra-pct')
  pctEl.textContent  = `${Math.round(pct)}%`
  pctEl.style.color  = isOverflow ? 'var(--clay)' : ''
  pctEl.style.fontWeight = isOverflow ? '600' : ''

  const bar = document.getElementById('bar-extra')
  bar.style.width = isOverflow ? '100%' : `${pct}%`
  bar.classList.toggle('overflow', isOverflow)

  const badge = document.getElementById('overflow-badge')
  badge.classList.toggle('show', isOverflow)
  if (isOverflow) badge.textContent = `+${overflowPct}%`
}

function renderDailyTokens(dt) {
  const el = document.getElementById('daily-tokens-section')
  if (!el) return
  if (!dt || !dt.total) {
    el.style.display = 'none'
    return
  }
  el.style.display = 'block'
  document.getElementById('daily-meta').textContent = formatTokens(dt.total)
  if (dt.snapshots) {
    document.getElementById('daily-snapshots').textContent = `${dt.snapshots} snapshots`
  }
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return `${n}`
}

function renderFooter(b, updatedISO) {
  const balRow = document.getElementById('balance-row')
  const reload = document.getElementById('auto-reload-text')
  if (!b || b.current == null) {
    balRow.style.display = 'none'
    reload.style.display = 'none'
  } else {
    balRow.style.display = ''
    reload.style.display = ''
    document.getElementById('balance').textContent = `$${b.current.toFixed(2)}`
    document.getElementById('auto-reload-text').textContent = b.auto_reload
      ? `Auto-reload $${b.reload_amount} at $${b.reload_threshold.toFixed(2)}`
      : 'Auto-reload off'
  }
  lastUpdatedISO = updatedISO
  paintTimestamp()
}

// Five missed refresh cycles (REFRESH_INTERVAL is 60s) is unambiguous: the
// number on screen is old, and a live monitor has to say so.
const STALE_AFTER_MS = 5 * 60 * 1000
function paintTimestamp() {
  const el = document.getElementById('last-updated')
  if (!el) return
  el.textContent = formatRelativeTime(lastUpdatedISO)
  const age = lastUpdatedISO ? Date.now() - new Date(lastUpdatedISO).getTime() : 0
  el.classList.toggle('stale', age > STALE_AFTER_MS)
  el.title = lastUpdatedISO ? new Date(lastUpdatedISO).toLocaleString() : ''
}

// ─── Dashboard controls ───────────────────────────────────────────────────────
function bindDashboardControls() {
  // Theme toggle — manual override on top of system preference
  document.getElementById('btn-theme').addEventListener('click', () => applyTheme(!isDark))

  // Refresh — triggers real API call (debounced)
  const btnRefresh = document.getElementById('btn-refresh')
  btnRefresh.addEventListener('click', async () => {
    if (btnRefresh.disabled) return
    btnRefresh.disabled = true
    const svg = btnRefresh.querySelector('svg')
    svg.classList.add('spin')
    try {
      const data = await window.electronAPI.refreshLive()
      if (data) {
        lastUpdatedISO = data.last_updated
        renderDashboard(data)
      }
    } finally {
      setTimeout(() => { svg.classList.remove('spin'); btnRefresh.disabled = false }, 700)
    }
  })


  // Expand / collapse
  document.getElementById('btn-expand').addEventListener('click', () => setExpanded(!isExpanded))

  // Close
  document.getElementById('btn-close').addEventListener('click', () => {
    window.electronAPI.closeWindow()
  })

  // Sign out
  document.getElementById('btn-signout').addEventListener('click', async () => {
    await window.electronAPI.signOut()
    clearAuthError()
    setConnecting(false)
    isExpanded = false
    document.getElementById('details-panel').classList.remove('open')
    document.getElementById('btn-expand').classList.remove('open')
    document.getElementById('expand-label').textContent = 'Show more'
    showAuth()
  })
}

// ─── Animations ──────────────────────────────────────────────────────────────
function getActiveView() {
  return document.querySelector('.view.active')
}

function bindAnimations() {
  // Animate in on first load
  const initial = getActiveView()
  if (initial) {
    initial.classList.add('anim-in')
    initial.addEventListener('animationend', () => {
      initial.classList.remove('anim-in', 'anim-out')
    }, { once: true })
  }

  window.electronAPI.onAnimateIn(() => {
    const v = getActiveView()
    if (!v) return
    v.classList.remove('anim-out')
    v.classList.add('anim-in')
    v.addEventListener('animationend', () => v.classList.remove('anim-in'), { once: true })
  })

  window.electronAPI.onAnimateOut(() => {
    const v = getActiveView()
    if (!v) return
    v.classList.remove('anim-in')
    v.classList.add('anim-out')
  })
}

// ─── Timestamp ────────────────────────────────────────────────────────────────
function formatRelativeTime(isoString) {
  if (!isoString) return 'Not yet updated'
  const diffMs  = Date.now() - new Date(isoString).getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1)   return 'Updated just now'
  if (diffMin === 1) return 'Updated 1 min ago'
  if (diffMin < 60)  return `Updated ${diffMin} min ago`
  return `Updated ${Math.floor(diffMin / 60)}h ago`
}

function startTimestampTicker() {
  setInterval(() => { if (lastUpdatedISO) paintTimestamp() }, 60_000)
}
