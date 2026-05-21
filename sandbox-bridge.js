/**
 * sandbox-bridge.js
 * Lightweight HTTP server that lets the portfolio case-study page control
 * the live Claude Widget app from the browser (localhost:3433).
 *
 * Routes
 *   GET /status           → { running, app, port }
 *   GET /notify?type=X    → fire a real macOS notification (types below)
 *   GET /toggle           → show/hide the widget window
 *   GET /show             → show the widget window
 *   GET /hide             → hide the widget window
 *
 * Remove this file (and its require in main.js) for a clean production build.
 */

const http         = require('http')
const { Notification } = require('electron')

const PORT = 3433

const NOTIFS = {
  'session-80':    { title: '⚡ Session at 80%',       body: "You're at 80%. Wrap up the heavy lifting." },
  'session-limit': { title: '🔥 Session limit hit',    body: 'Session limit hit. Go touch grass.' },
  'weekly-cap':    { title: '📅 Weekly cap hit',        body: "Weekly cap hit. You're done until Monday." },
  'billing':       { title: '💰 Extra credits active',  body: "The meter's running — Anthropic billing per-token now." },
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
}

/**
 * @param {object} deps
 * @param {Function} deps.toggleVisibility  - fn from main.js that shows/hides win
 * @param {Function} deps.isVisible         - fn returning whether win is currently shown
 * @param {Function} deps.getMute           - fn returning current muteNotifications flag
 */
function start({ toggleVisibility, isVisible, getMute }) {
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return }

    const u    = new URL(req.url, `http://localhost:${PORT}`)
    const type = u.searchParams.get('type')

    if (u.pathname === '/status') {
      res.writeHead(200, CORS)
      res.end(JSON.stringify({ running: true, app: 'claude-widget', port: PORT }))
      return
    }

    if (u.pathname === '/notify' && NOTIFS[type]) {
      if (Notification.isSupported() && !getMute()) {
        new Notification({ title: NOTIFS[type].title, body: NOTIFS[type].body, silent: false }).show()
      }
      res.writeHead(200, CORS)
      res.end(JSON.stringify({ ok: true, fired: type }))
      return
    }

    if (u.pathname === '/toggle') {
      toggleVisibility()
      res.writeHead(200, CORS)
      res.end(JSON.stringify({ ok: true, visible: isVisible() }))
      return
    }

    if (u.pathname === '/show') {
      if (!isVisible()) toggleVisibility()
      res.writeHead(200, CORS)
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (u.pathname === '/hide') {
      if (isVisible()) toggleVisibility()
      res.writeHead(200, CORS)
      res.end(JSON.stringify({ ok: true }))
      return
    }

    res.writeHead(404, CORS)
    res.end(JSON.stringify({ error: 'unknown route' }))
  })

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[sandbox-bridge] ready → http://localhost:${PORT}`)
  })
  server.on('error', e => console.warn('[sandbox-bridge] error:', e.message))
}

module.exports = { start }
