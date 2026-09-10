// ECE MakerSpace account service: PIN-based auth with email magic-link reset.
// Zero dependencies — node:http, node:crypto, node:sqlite. Server-rendered
// pages for humans, JSON under /api for tools. Sits behind Caddy (TLS).
//
//   GET  /healthz                     liveness probe
//   GET  /                            redirect: /login or /me
//   GET/POST /login                   PIN sign-in (HTML)
//   POST /logout                      kill session, clear cookie
//   GET  /me                          your account page
//   GET/POST /forgot                  email a reset link (generic response)
//   GET/POST /reset?token=…           set/reset PIN via magic link
//   GET  /admin                       user list + actions (admin session)
//   POST /admin/users                 add user + send invite
//   POST /invite                      (re)send invite for a user
//   POST /admin/users/:id/reset       force-reset a user's PIN
//   POST /admin/users/:id/deactivate  block sign-ins, kill sessions
//   GET  /api/me                      session info (JSON)
//   POST /api/login                   {itsc, pin} (JSON)
//   POST /api/logout                  (JSON)
//   GET  /track/*                     reserved for the workshop tracker
//
// Bind defaults to 127.0.0.1:3100 (override with HOST / PORT).

import http from 'node:http';

import { openDb } from './db.js';
import * as A from './auth.js';
import { sendEmail } from './mailer.js';
import * as P from './pages.js';

function die(msg) { console.error('FATAL:', msg); process.exit(1); }

const cfg = {
  port: Number(process.env.PORT || 3100),
  host: process.env.HOST || '127.0.0.1',
  dataDir: process.env.DATA_DIR || './data',
  baseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3100}`).replace(/\/+$/, ''),
  adminItsces: (process.env.ADMIN_ITSCS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  maxBody: Number(process.env.MAX_BODY_BYTES || 1 << 20),
  // Cookie Domain attribute. Default ".ecemaker.space" so the session works
  // across maker-space subdomains; set COOKIE_DOMAIN="" for a host-only
  // cookie (needed when developing against localhost).
  cookieDomain: process.env.COOKIE_DOMAIN !== undefined
    ? process.env.COOKIE_DOMAIN
    : '.ecemaker.space',
};

const db = openDb(cfg.dataDir);
A.purgeExpired(db);

// ---- HTTP plumbing ---------------------------------------------------------

function applyHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}

function send(res, status, contentType, body, extra = {}) {
  applyHeaders(res);
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  const buf = Buffer.from(body);
  res.writeHead(status, { 'content-type': contentType, 'content-length': buf.length });
  res.end(buf);
}
const sendJson = (res, status, obj, extra = {}) => send(res, status, 'application/json', JSON.stringify(obj), extra);
const sendHtml = (res, status, html, extra = {}) => send(res, status, 'text/html; charset=utf-8', html, extra);
const sendRedirect = (res, location, extra = {}) => send(res, 303, 'text/plain; charset=utf-8', `redirecting to ${location}`, { location, ...extra });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Accepts JSON or form-encoded bodies; both arrive as a plain object.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let len = 0;
    const chunks = [];
    req.on('data', (c) => {
      len += c.length;
      if (len > cfg.maxBody) { reject(new HttpError(413, 'request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      const type = String(req.headers['content-type'] || '');
      if (type.includes('application/x-www-form-urlencoded')) {
        return resolve(Object.fromEntries(new URLSearchParams(raw)));
      }
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, 'invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const sessionCookie = (token) => {
  let c = `ms_session=${token}; Path=/; Max-Age=${A.SESSION_TTL}; HttpOnly; Secure; SameSite=Lax`;
  if (cfg.cookieDomain) c += `; Domain=${cfg.cookieDomain}`;
  return c;
};
const clearCookie = () => {
  let c = 'ms_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax';
  if (cfg.cookieDomain) c += `; Domain=${cfg.cookieDomain}`;
  return c;
};

const sessionFor = (req) => A.validateSession(db, parseCookies(req).ms_session);

const wantsJson = (req) => String(req.headers['content-type'] || '').includes('json');

// ---- flows -----------------------------------------------------------------

const magicLink = (token) => `${cfg.baseUrl}/reset?token=${token}`;

// Shared core for POST /login (HTML) and POST /api/login (JSON).
// Returns { status, user?, session? } — generic 401 for unknown account,
// wrong PIN and deactivated accounts; 423 once the lockout window is full.
function pinLogin(itscRaw, pinRaw) {
  const itsc = A.normalizeItsc(itscRaw);
  const pin = String(pinRaw ?? '');
  if (!itsc || !pin) return { status: 400, error: 'itsc and pin are required' };

  const now = A.nowSec();
  if (A.isLocked(db, itsc, now)) return { status: 423, error: 'too many failed attempts; try again later' };

  const user = A.getUserByItsc(db, itsc);
  const stored = user && user.active ? user.pin_hash : null;
  const ok = stored ? A.verifyPin(pin, stored) : (A.burnScrypt(), false);

  if (!ok) {
    A.recordFailure(db, itsc, now);
    return { status: 401, error: 'invalid itsc or pin' };
  }

  A.clearFailures(db, itsc);
  const admin = A.ensureAdminFlag(db, user, cfg.adminItsces);
  const session = A.createSession(db, admin.id, now);
  return { status: 200, user: admin, session };
}

// Creates the user if needed and emails the set-PIN (invite) link.
// Returns the plain token so the admin UI can show it; email carries the link.
async function sendInvite(user) {
  const email = A.emailForItsc(user.itsc);
  const token = A.createMagicToken(db, { userId: user.id, email, purpose: 'invite' });
  const name = user.display_name || user.itsc;
  await sendEmail({
    to: email,
    subject: 'Your MakerSpace account — set your PIN',
    body: `Hi ${name},

An account for the HKUST ECE MakerSpace has been created for you (${email}).

Set your PIN (4-8 digits) to activate it:
${magicLink(token)}

The link works once and expires in 30 minutes. Missed the window? Ask an
admin to resend the invite, or use "forgot PIN" on the sign-in page.

— ECE MakerSpace accounts`,
  });
  return token;
}

// Emails a reset link for an existing account (also used to force-reset).
async function sendReset(user) {
  const email = A.emailForItsc(user.itsc);
  const token = A.createMagicToken(db, { userId: user.id, email, purpose: 'reset' });
  const name = user.display_name || user.itsc;
  await sendEmail({
    to: email,
    subject: 'Reset your MakerSpace PIN',
    body: `Hi ${name},

A PIN reset was requested for your MakerSpace account (${email}).

Set a new PIN here (works once, expires in 30 minutes):
${magicLink(token)}

Didn't ask for this? Ignore this email; your PIN is unchanged.

— ECE MakerSpace accounts`,
  });
  return token;
}

// Magic-link redemption shared by invite and reset: create the user for bare
// invites, set the PIN, and start a session (the link is the login).
function redeemMagicToken(row, pin) {
  let user = row.user_id != null ? A.getUserById(db, row.user_id) : null;
  if (!user) user = A.getUserByItsc(db, String(row.email).split('@')[0]);
  if (!user) user = A.createUser(db, { itsc: String(row.email).split('@')[0] });
  if (!user.active) return { status: 403, error: 'account deactivated; contact an admin' };

  db.prepare('UPDATE users SET pin_hash = ?, must_set_pin = 0 WHERE id = ?')
    .run(A.hashPin(pin), user.id);
  const admin = A.ensureAdminFlag(db, user, cfg.adminItsces);
  const session = A.createSession(db, admin.id, A.nowSec());
  return { status: 200, user: admin, session };
}

// ---- routing ---------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const method = req.method || 'GET';

  try {
    // ---- health ------------------------------------------------------------
    if (method === 'GET' && p === '/healthz') return sendJson(res, 200, { ok: true });

    // ---- JSON API ----------------------------------------------------------
    if (p === '/api/login' && method === 'POST') {
      const body = await readBody(req);
      const r = pinLogin(body.itsc, body.pin);
      if (r.status !== 200) return sendJson(res, r.status, { ok: false, error: r.error });
      return sendJson(res, 200, {
        ok: true,
        user: {
          itsc: r.user.itsc,
          display_name: r.user.display_name,
          is_admin: !!r.user.is_admin,
          must_set_pin: !!r.user.must_set_pin,
        },
      }, { 'set-cookie': sessionCookie(r.session.token) });
    }

    if (p === '/api/me' && method === 'GET') {
      const sess = sessionFor(req);
      if (!sess) return sendJson(res, 401, { ok: false, error: 'not signed in' });
      return sendJson(res, 200, {
        ok: true,
        user: {
          itsc: sess.itsc,
          display_name: sess.display_name,
          email: A.emailForItsc(sess.itsc),
          is_admin: !!sess.is_admin,
          must_set_pin: !!sess.must_set_pin,
          created_at: sess.created_at,
        },
        session: { created_at: sess.session_created_at, expires_at: sess.expires_at },
      });
    }

    if (p === '/api/logout' && method === 'POST') {
      A.destroySession(db, parseCookies(req).ms_session);
      return sendJson(res, 200, { ok: true }, { 'set-cookie': clearCookie() });
    }

    // Reserved for the workshop tracker (served later by this same service).
    if (p === '/track' || p.startsWith('/track/')) {
      return wantsJson(req) || p.startsWith('/api')
        ? sendJson(res, 404, { ok: false, error: 'reserved for the workshop tracker' })
        : sendHtml(res, 404, P.pageMessage('Coming soon', '<p>The workshop tracker will live here.</p>'));
    }

    // ---- admin actions (JSON or form) --------------------------------------
    const adminMatch = p.match(/^\/admin\/users\/(\d+)\/(reset|deactivate)$/);
    if (adminMatch && method === 'POST') {
      const sess = sessionFor(req);
      if (!sess) return sendRedirect(res, '/login');
      if (!sess.is_admin) return wantsJson(req) ? sendJson(res, 403, { ok: false, error: 'admin only' }) : sendHtml(res, 403, P.pageForbidden());

      const user = A.getUserById(db, Number(adminMatch[1]));
      if (!user) return wantsJson(req) ? sendJson(res, 404, { ok: false, error: 'unknown user' }) : sendHtml(res, 404, P.page404());

      if (adminMatch[2] === 'reset') {
        await sendReset(user);
        return wantsJson(req) ? sendJson(res, 200, { ok: true, message: `reset link emailed to ${user.itsc}` })
          : sendRedirect(res, '/admin');
      }
      // deactivate
      db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(user.id);
      A.destroyUserSessions(db, user.id);
      return wantsJson(req) ? sendJson(res, 200, { ok: true, message: `${user.itsc} deactivated` })
        : sendRedirect(res, '/admin');
    }

    if (p === '/admin/users' && method === 'POST') {
      const sess = sessionFor(req);
      if (!sess) return sendRedirect(res, '/login');
      if (!sess.is_admin) return wantsJson(req) ? sendJson(res, 403, { ok: false, error: 'admin only' }) : sendHtml(res, 403, P.pageForbidden());

      const body = await readBody(req);
      const itsc = A.normalizeItsc(body.itsc);
      if (!itsc) return sendJson(res, 400, { ok: false, error: 'invalid itsc login' });
      if (A.getUserByItsc(db, itsc)) return sendJson(res, 409, { ok: false, error: `${itsc} already exists` });

      const user = A.createUser(db, { itsc, displayName: String(body.display_name ?? ''), adminItsces: cfg.adminItsces });
      const token = await sendInvite(user);
      return sendJson(res, 200, { ok: true, id: user.id, link: magicLink(token) });
    }

    if (p === '/invite' && method === 'POST') {
      const sess = sessionFor(req);
      if (!sess) return sendRedirect(res, '/login');
      if (!sess.is_admin) return wantsJson(req) ? sendJson(res, 403, { ok: false, error: 'admin only' }) : sendHtml(res, 403, P.pageForbidden());

      const body = await readBody(req);
      const itsc = A.normalizeItsc(body.itsc);
      if (!itsc) return sendJson(res, 400, { ok: false, error: 'invalid itsc login' });
      let user = A.getUserByItsc(db, itsc);
      if (!user) user = A.createUser(db, { itsc, displayName: String(body.display_name ?? ''), adminItsces: cfg.adminItsces });
      if (!user.active) return sendJson(res, 409, { ok: false, error: 'account is deactivated' });

      const token = await sendInvite(user);
      return sendJson(res, 200, { ok: true, link: magicLink(token) });
    }

    // ---- pages -------------------------------------------------------------
    if (p === '/' && method === 'GET') {
      return sendRedirect(res, sessionFor(req) ? '/me' : '/login');
    }

    if (p === '/login') {
      if (method === 'GET') return sendHtml(res, 200, P.pageLogin());
      if (method === 'POST') {
        const body = await readBody(req);
        const r = pinLogin(body.itsc, body.pin);
        if (r.status === 200) return sendRedirect(res, '/me', { 'set-cookie': sessionCookie(r.session.token) });
        if (r.status === 423) return sendHtml(res, 423, P.pageLocked());
        return sendHtml(res, r.status, P.pageLogin({ error: r.error, itsc: String(body.itsc ?? '') }));
      }
    }

    if (p === '/logout' && method === 'POST') {
      A.destroySession(db, parseCookies(req).ms_session);
      return sendRedirect(res, '/login', { 'set-cookie': clearCookie() });
    }

    if (p === '/me' && method === 'GET') {
      const sess = sessionFor(req);
      if (!sess) return sendRedirect(res, '/login');
      return sendHtml(res, 200, P.pageMe(sess, sess));
    }

    if (p === '/forgot') {
      if (method === 'GET') return sendHtml(res, 200, P.pageForgot());
      if (method === 'POST') {
        const body = await readBody(req);
        const itsc = A.normalizeItsc(body.itsc);
        // Always the same generic page: no user enumeration, no rate-limit leak.
        if (itsc) {
          const user = A.getUserByItsc(db, itsc);
          if (user && user.active) {
            const email = A.emailForItsc(itsc);
            if (A.bumpRate(db, `forgot:${email}`, 3, 60 * 60) <= 3) await sendReset(user);
          }
        }
        return sendHtml(res, 200, P.pageForgotSent());
      }
    }

    if (p === '/reset') {
      if (method === 'GET') {
        const token = url.searchParams.get('token') || '';
        const row = A.getMagicToken(db, token);
        if (!row) return sendHtml(res, 400, P.pageResetInvalid());
        return sendHtml(res, 200, P.pageResetForm(token));
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const token = String(body.token ?? '');
        const pin = String(body.pin ?? '');
        if (!A.validPin(pin) || pin !== String(body.pin2 ?? '')) {
          const why = A.validPin(pin) ? 'PINs do not match.' : 'PIN must be 4-8 digits.';
          return sendHtml(res, 400, P.pageResetForm(token, { error: why }));
        }
        const row = A.consumeMagicToken(db, token);
        if (!row) return sendHtml(res, 400, P.pageResetInvalid());
        const r = redeemMagicToken(row, pin);
        if (r.status !== 200) return sendHtml(res, r.status, P.pageMessage('Account issue', `<p>${P.esc(r.error)}</p>`));
        return sendRedirect(res, '/me', { 'set-cookie': sessionCookie(r.session.token) });
      }
    }

    if (p === '/admin' && method === 'GET') {
      const sess = sessionFor(req);
      if (!sess) return sendRedirect(res, '/login');
      if (!sess.is_admin) return sendHtml(res, 403, P.pageForbidden());
      const users = db.prepare('SELECT * FROM users ORDER BY id').all();
      return sendHtml(res, 200, P.pageAdmin(users));
    }

    // ---- 404 ---------------------------------------------------------------
    return p.startsWith('/api')
      ? sendJson(res, 404, { ok: false, error: 'not found' })
      : sendHtml(res, 404, P.page404());
  } catch (e) {
    if (e instanceof HttpError) {
      return p.startsWith('/api') || wantsJson(req)
        ? sendJson(res, e.status, { ok: false, error: e.message })
        : sendHtml(res, e.status, P.pageMessage('Error', `<p>${P.esc(e.message)}</p>`));
    }
    console.error(`[error] ${method} ${p}:`, e);
    return p.startsWith('/api') || wantsJson(req)
      ? sendJson(res, 500, { ok: false, error: 'internal error' })
      : sendHtml(res, 500, P.pageMessage('Error', '<p>Something went wrong.</p>'));
  }
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`accounts listening on http://${cfg.host}:${cfg.port} | data ${cfg.dataDir} | base ${cfg.baseUrl} | admins: ${cfg.adminItsces.join(',') || 'none'}`);
});

// Opportunistic housekeeping + graceful shutdown (systemd SIGTERM).
const reaper = setInterval(() => A.purgeExpired(db), 60 * 60 * 1000);
reaper.unref();
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});
