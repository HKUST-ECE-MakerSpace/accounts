// Unit tests: npm test (node --test test/)
//
// Covers: PIN hash/verify roundtrip + wrong PIN, lockout counting, session
// create/validate/expiry/destroy, magic-token single-use + expiry, the
// forgot-PIN rate-limit window, HTML escaping, and the Power Automate mailer
// (stubbed fetch, asserting the exact payload shape).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import * as A from '../src/auth.js';
import { esc } from '../src/pages.js';

// Fresh throwaway database per test — WAL files and all live in a tmpdir.
const newDb = () => openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-test-')));

// ---- mailer (env must be set before the dynamic import below) --------------

process.env.PA_MAIL_URL = 'https://mailer.test/flow';
process.env.PA_MAIL_TOKEN = 'test-token';
process.env.MAIL_DEV = '1';
process.env.MAIL_DEV_EMAIL = 'dev@connect.ust.hk';
const { sendEmail } = await import('../src/mailer.js');

const stubFetch = (respond) => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls.push(args);
    if (!respond) return new Response('{"ok":true}', { status: 200 });
    return respond(...args);
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
};

// ---- PIN hashing -----------------------------------------------------------

test('pin hash/verify roundtrip + wrong pin', () => {
  const h = A.hashPin('123456');
  assert.equal(A.verifyPin('123456', h), true);
  assert.equal(A.verifyPin('123457', h), false);
  assert.equal(A.verifyPin('', h), false);
  assert.equal(A.verifyPin('123456', 'garbage'), false);
  assert.equal(A.verifyPin('123456', ''), false);
  assert.notEqual(A.hashPin('123456'), h); // salted: same pin, different hash
  assert.match(h, /^scrypt\$16384\$8\$1\$/);
});

test('pin shape and itsc normalization', () => {
  assert.ok(A.validPin('1234') && A.validPin('12345678'));
  assert.ok(!A.validPin('123') && !A.validPin('123456789'));
  assert.ok(!A.validPin('12a4') && !A.validPin('') && !A.validPin(null));
  assert.equal(A.normalizeItsc(' WLI@Connect.ust.hk '), 'wli');
  assert.equal(A.normalizeItsc('wli'), 'wli');
  assert.equal(A.normalizeItsc('bad it!sc'), null);
  assert.equal(A.normalizeItsc(''), null);
  assert.equal(A.emailForItsc('wli'), 'wli@connect.ust.hk');
});

// ---- login attempt lockout -------------------------------------------------

test('login lockout: 5th failure locks, per-account, window lapse resets', () => {
  const db = newDb();
  const t0 = 1_000_000;

  // 4 failures: not locked yet; 5th crosses the line.
  for (let i = 0; i < 4; i++) A.recordFailure(db, 'wli', t0);
  assert.equal(A.isLocked(db, 'wli', t0 + 1), false);
  A.recordFailure(db, 'wli', t0 + 1);
  assert.equal(A.isLocked(db, 'wli', t0 + 2), true);

  // Other accounts are untouched.
  assert.equal(A.isLocked(db, 'mary', t0 + 2), false);

  // Once the 15-minute window lapses, the counter restarts.
  assert.equal(A.isLocked(db, 'wli', t0 + A.ATTEMPT_WINDOW), false);
  A.recordFailure(db, 'wli', t0 + A.ATTEMPT_WINDOW + 1);
  assert.equal(A.isLocked(db, 'wli', t0 + A.ATTEMPT_WINDOW + 2), false);

  // Successful sign-in clears the counter (simulated via clearFailures).
  A.clearFailures(db, 'wli');
  assert.equal(A.isLocked(db, 'wli', t0 + A.ATTEMPT_WINDOW + 2), false);
});

// ---- sessions --------------------------------------------------------------

test('session create/validate/expiry/destroy; deactivated users cut off', () => {
  const db = newDb();
  const u = A.createUser(db, { itsc: 'wli', displayName: 'W' });
  const t0 = 1_000_000;

  const s = A.createSession(db, u.id, t0);
  const v = A.validateSession(db, s.token, t0 + 60);
  assert.equal(v.itsc, 'wli');
  assert.equal(v.expires_at, t0 + A.SESSION_TTL);
  assert.equal(v.session_created_at, t0);

  assert.equal(A.validateSession(db, s.token, t0 + A.SESSION_TTL + 1), null); // expired
  assert.equal(A.validateSession(db, 'not-a-real-token', t0 + 60), null);
  assert.equal(A.validateSession(db, '', t0 + 60), null);

  // Only the sha256 of the token is persisted — never the token itself.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 1);
  assert.ok(!JSON.stringify(db.prepare('SELECT token_hash FROM sessions').all()).includes(s.token));

  A.destroySession(db, s.token);
  assert.equal(A.validateSession(db, s.token, t0 + 60), null);

  // Deactivation invalidates live sessions.
  const bob = A.createUser(db, { itsc: 'bob' });
  const sb = A.createSession(db, bob.id, t0);
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(bob.id);
  assert.equal(A.validateSession(db, sb.token, t0 + 60), null);
});

test('admin bootstrap via ADMIN_ITSCS list', () => {
  const db = newDb();
  const u = A.createUser(db, { itsc: 'wli', adminItsces: ['wli', 'mary'] });
  assert.equal(u.is_admin, 1);
  const v = A.createUser(db, { itsc: 'steve', adminItsces: ['wli', 'mary'] });
  assert.equal(v.is_admin, 0);
  const promoted = A.ensureAdminFlag(db, v, ['wli', 'mary', 'steve']);
  assert.equal(promoted.is_admin, 1);
  assert.equal(A.getUserByItsc(db, 'steve').is_admin, 1); // persisted
});

// ---- magic tokens ----------------------------------------------------------

test('magic token: single-use consumption + expiry', () => {
  const db = newDb();
  const u = A.createUser(db, { itsc: 'wli' });
  const t0 = 5_000_000;

  const tok = A.createMagicToken(db, { userId: u.id, email: 'wli@connect.ust.hk', purpose: 'reset', now: t0 });
  assert.ok(tok.length >= 40); // 32 random bytes, base64url
  const row = A.getMagicToken(db, tok, t0 + 10);
  assert.equal(row.purpose, 'reset');
  assert.equal(row.user_id, u.id);

  const used = A.consumeMagicToken(db, tok, t0 + 10);
  assert.equal(used.purpose, 'reset');
  assert.equal(A.consumeMagicToken(db, tok, t0 + 11), null); // second use rejected
  assert.equal(A.getMagicToken(db, tok, t0 + 12), null);     // no longer visible

  // Expired tokens are invisible and unconsumable.
  const old = A.createMagicToken(db, { userId: null, email: 'x@connect.ust.hk', purpose: 'invite', now: t0 - A.MAGIC_TTL - 1 });
  assert.equal(A.getMagicToken(db, old, t0), null);
  assert.equal(A.consumeMagicToken(db, old, t0), null);

  // Unknown tokens too.
  assert.equal(A.getMagicToken(db, 'nonsense', t0), null);
});

test('purgeExpired sweeps stale sessions and tokens, keeps live ones', () => {
  const db = newDb();
  const u = A.createUser(db, { itsc: 'wli' });
  const t0 = 5_000_000;
  const dead = A.createSession(db, u.id, t0 - A.SESSION_TTL - 10);
  const live = A.createSession(db, u.id, t0);
  const deadTok = A.createMagicToken(db, { userId: u.id, email: 'wli@connect.ust.hk', purpose: 'reset', now: t0 - A.MAGIC_TTL - 10 });
  const liveTok = A.createMagicToken(db, { userId: u.id, email: 'wli@connect.ust.hk', purpose: 'reset', now: t0 });

  A.purgeExpired(db, t0);
  assert.equal(A.validateSession(db, dead.token, t0), null);
  assert.ok(A.validateSession(db, live.token, t0));
  assert.equal(A.getMagicToken(db, deadTok, t0), null);
  assert.ok(A.getMagicToken(db, liveTok, t0));
});

// ---- forgot-PIN rate limit -------------------------------------------------

test('rate limit: 3/hour per email, window rolls over', () => {
  const db = newDb();
  const t0 = 1_000_000;
  const bump = (t) => A.bumpRate(db, 'forgot:wli@connect.ust.hk', 3, 60 * 60, t);

  assert.equal(bump(t0), 1);
  assert.equal(bump(t0 + 1), 2);
  assert.equal(bump(t0 + 2), 3); // caller still sends (count <= 3)
  assert.equal(bump(t0 + 3), 4); // over: caller must skip the send
  assert.equal(bump(t0 + 3601), 1); // new window
});

// ---- HTML escaping ---------------------------------------------------------

test('email escaping (esc)', () => {
  assert.equal(
    esc(`<script>alert("x&'y")</script>`),
    '&lt;script&gt;alert(&quot;x&amp;&#39;y&quot;)&lt;/script&gt;'
  );
  assert.equal(esc(null), '');
  assert.equal(esc(42), '42');
});

// ---- mailer (Power Automate flow, stubbed fetch) ---------------------------

test('mailer: sends the exact PA payload ({to, subject, body, token})', async () => {
  const s = stubFetch();
  const r = await sendEmail({ to: 'dev@connect.ust.hk', subject: 'Set your PIN', body: 'hello\nlink' });
  s.restore();

  assert.equal(r.ok, true);
  assert.equal(s.calls.length, 1);
  const [url, init] = s.calls[0];
  assert.equal(url, 'https://mailer.test/flow'); // PA_MAIL_URL env override
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), {
    to: 'dev@connect.ust.hk',
    subject: 'Set your PIN',
    body: 'hello\nlink',
    token: 'test-token', // PA_MAIL_TOKEN env override
  });
});

test('mailer: dev gate blocks recipients other than MAIL_DEV_EMAIL', async () => {
  const s = stubFetch();
  const r = await sendEmail({ to: 'someoneelse@connect.ust.hk', subject: 's', body: 'b' });
  s.restore();

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'dev_gate');
  assert.equal(s.calls.length, 0); // nothing left the machine
});

test('mailer: flow errors and network errors never throw', async () => {
  let s = stubFetch(() => new Response('boom', { status: 500 }));
  const r1 = await sendEmail({ to: 'dev@connect.ust.hk', subject: 's', body: 'b' });
  s.restore();
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'flow_status');
  assert.equal(r1.status, 500);

  s = stubFetch(() => { throw new Error('socket down'); });
  const r2 = await sendEmail({ to: 'dev@connect.ust.hk', subject: 's', body: 'b' });
  s.restore();
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'error');
  assert.match(r2.error, /socket down/);

  const s2 = stubFetch();
  const r3 = await sendEmail({ to: '  ', subject: 's', body: 'b' });
  s2.restore();
  assert.equal(r3.ok, false);
  assert.equal(r3.reason, 'no_recipient');
  assert.equal(s2.calls.length, 0);
});
