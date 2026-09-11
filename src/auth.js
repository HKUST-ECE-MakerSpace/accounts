// Auth core: PIN hashing, sessions, magic tokens, attempt counters.
// Everything here operates on the open database handle and explicit
// timestamps — no HTTP, no environment — so it stays unit-testable.
//
// Secrets (session tokens, magic-link tokens) are 32 random bytes, shown to
// the client once; only their sha256 ever touches the database.

import crypto from 'node:crypto';

// scrypt cost (spec default: N=16384).
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

export const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days
export const MAGIC_TTL = 30 * 60;             // 30 minutes
export const ATTEMPT_WINDOW = 15 * 60;        // 15 minutes
export const MAX_ATTEMPTS = 5;

export const nowSec = () => Math.floor(Date.now() / 1000);

// ---- PIN hashing -----------------------------------------------------------

export function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(pin), salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), dk.toString('base64url')].join('$');
}

export function verifyPin(pin, stored) {
  try {
    const [scheme, n, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const want = Buffer.from(hashB64, 'base64url');
    const got = crypto.scryptSync(String(pin), Buffer.from(saltB64, 'base64url'), want.length,
      { N: Number(n), r: Number(r), p: Number(p) });
    return crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

// Equalize login timing when the account does not exist (or has no PIN yet):
// burn one scrypt anyway so response time does not leak account existence.
export function burnScrypt() {
  crypto.scryptSync('x', Buffer.alloc(16), KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

export const validPin = (pin) => /^\d{4,8}$/.test(String(pin ?? ''));

// Optional HKUST student ID (SID): 8 digits in practice, accepted loosely up
// to 10. Returns the trimmed digits, '' when blank (treated as absent), or
// null when present but malformed.
export const normalizeStudentId = (s) => {
  const sid = String(s ?? '').trim();
  return !sid || /^\d{8,10}$/.test(sid) ? sid : null;
};

// ITSC logins arrive as "wli", "WLI", or "wli@connect.ust.hk"; normalize and
// sanity-check. Returns the lowercase login or null.
export function normalizeItsc(s) {
  const itsc = String(s ?? '').trim().toLowerCase().split('@')[0];
  return /^[a-z0-9][a-z0-9._-]{0,31}$/.test(itsc) ? itsc : null;
}

export const emailForItsc = (itsc) => `${itsc}@connect.ust.hk`;

// ---- opaque tokens ---------------------------------------------------------

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const tokenHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// ---- users -----------------------------------------------------------------

export function getUserByItsc(db, itsc) {
  return db.prepare('SELECT * FROM users WHERE itsc = ?').get(itsc) ?? null;
}

export function getUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null;
}

export function createUser(db, { itsc, displayName = '', pinHash = null, now = nowSec(), adminItsces = [] }) {
  const isAdmin = adminItsces.includes(itsc) ? 1 : 0;
  const r = db.prepare(
    'INSERT INTO users (itsc, display_name, pin_hash, created_at, is_admin) VALUES (?, ?, ?, ?, ?)'
  ).run(itsc, String(displayName ?? '') || itsc, pinHash, now, isAdmin);
  return getUserById(db, r.lastInsertRowid);
}

// Admin bootstrap: ADMIN_ITSCS members get is_admin on first login.
export function ensureAdminFlag(db, user, adminItsces = []) {
  if (!user || user.is_admin || !adminItsces.includes(user.itsc)) return user;
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
  return { ...user, is_admin: 1 };
}

// ---- sessions --------------------------------------------------------------

export function createSession(db, userId, now = nowSec()) {
  const token = newToken();
  const expiresAt = now + SESSION_TTL;
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(tokenHash(token), userId, now, expiresAt);
  return { token, expiresAt };
}

// Returns the joined user + session row, or null for unknown/expired tokens
// and for sessions of deactivated accounts.
export function validateSession(db, token, now = nowSec()) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT s.user_id, s.created_at AS session_created_at, s.expires_at,
           u.id, u.itsc, u.display_name, u.created_at, u.is_admin,
           u.pin_hash, u.must_set_pin, u.active
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`).get(tokenHash(token));
  if (!row || row.expires_at <= now || !row.active) return null;
  return row;
}

export function destroySession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

export function destroyUserSessions(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// ---- login attempt lockout -------------------------------------------------

export function isLocked(db, itsc, now = nowSec()) {
  const row = db.prepare('SELECT fails, window_start FROM login_attempts WHERE itsc = ?').get(itsc);
  if (!row) return false;
  if (now - row.window_start >= ATTEMPT_WINDOW) return false; // window lapsed
  return row.fails >= MAX_ATTEMPTS;
}

export function recordFailure(db, itsc, now = nowSec()) {
  db.prepare(`
    INSERT INTO login_attempts (itsc, fails, window_start) VALUES (?, 1, ?)
    ON CONFLICT(itsc) DO UPDATE SET
      fails = CASE WHEN ? - login_attempts.window_start >= ${ATTEMPT_WINDOW}
                   THEN 1 ELSE login_attempts.fails + 1 END,
      window_start = CASE WHEN ? - login_attempts.window_start >= ${ATTEMPT_WINDOW}
                          THEN ? ELSE login_attempts.window_start END
  `).run(itsc, now, now, now, now);
}

export function clearFailures(db, itsc) {
  db.prepare('DELETE FROM login_attempts WHERE itsc = ?').run(itsc);
}

// ---- magic tokens ----------------------------------------------------------

export function createMagicToken(db, { userId = null, email, purpose, now = nowSec() }) {
  const token = newToken();
  db.prepare('INSERT INTO magic_tokens (token_hash, user_id, email, purpose, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(tokenHash(token), userId, String(email).toLowerCase(), purpose, now + MAGIC_TTL);
  return token;
}

// Visible (unused + unexpired) token row — for rendering the reset form.
export function getMagicToken(db, token, now = nowSec()) {
  const row = db.prepare('SELECT * FROM magic_tokens WHERE token_hash = ?').get(tokenHash(token));
  if (!row || row.used_at != null || row.expires_at <= now) return null;
  return row;
}

// Single-use consumption, race-safe: the UPDATE only lands while the token is
// still unused and unexpired.
export function consumeMagicToken(db, token, now = nowSec()) {
  const h = tokenHash(token);
  const r = db.prepare(
    'UPDATE magic_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?'
  ).run(now, h, now);
  if (r.changes !== 1) return null;
  return db.prepare('SELECT * FROM magic_tokens WHERE token_hash = ?').get(h);
}

// ---- rate limiting (fixed sliding windows) ---------------------------------

// Bumps the counter and returns the count within the current window; callers
// act only while count <= max.
export function bumpRate(db, key, max, windowSec, now = nowSec()) {
  db.prepare(`
    INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN ? - rate_limits.window_start >= ${windowSec}
                   THEN 1 ELSE rate_limits.count + 1 END,
      window_start = CASE WHEN ? - rate_limits.window_start >= ${windowSec}
                          THEN ? ELSE rate_limits.window_start END
  `).run(key, now, now, now, now);
  const row = db.prepare('SELECT count, window_start FROM rate_limits WHERE key = ?').get(key);
  if (now - row.window_start >= windowSec) return 1; // window rolled over since
  return Math.min(row.count, max + 1);
}

// ---- housekeeping ----------------------------------------------------------

export function purgeExpired(db, now = nowSec()) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM magic_tokens WHERE expires_at <= ?').run(now);
}
