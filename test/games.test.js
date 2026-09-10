// Tests for the mahjong points tracker (src/games.js + src/games-ui.js).
// Runs against an in-memory DB and calls handlers directly — no HTTP server.
// The users/sessions fixtures mirror the real schema shipped in src/db.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync as Database } from 'node:sqlite';

import {
  initGames, trackHome, trackNewPage, trackNewSubmit,
  apiLeaderboard, apiGamesList, apiGamesCreate, trackGameDelete,
} from '../src/games.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      itsc TEXT UNIQUE,
      display_name TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      pin_hash TEXT,
      must_set_pin INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER,
      expires_at TEXT
    );
  `);
  initGames(db);
  return db;
}

function mkUser(db, itsc, opts = {}) {
  db.prepare('INSERT INTO users (itsc, display_name, is_admin, active) VALUES (?, ?, ?, ?)')
    .run(itsc, opts.name ?? itsc, opts.admin ? 1 : 0, opts.deact ? 0 : 1);
  return { ...db.prepare('SELECT * FROM users WHERE itsc = ?').get(itsc) };
}

const G4 = ['amy', 'bob', 'cat', 'dan'];
const game = (db, user, itsc, scores, extra = {}) =>
  apiGamesCreate(db, user, { itsc, scores, dealer: extra.dealer ?? 0, notes: extra.notes ?? '' });
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;

test('initGames is idempotent and login-required handlers 401 without a user', () => {
  const db = freshDb();
  initGames(db); // CREATE IF NOT EXISTS must not throw

  const home = trackHome(db);
  assert.equal(home.status, 200);
  assert.ok(home.html.includes('No games recorded yet'));

  for (const [fn, args] of [
    [trackNewPage, [db, null]],
    [trackNewSubmit, [db, null, {}]],
    [apiGamesCreate, [db, null, {}]],
    [trackGameDelete, [db, null, 1]],
  ]) {
    const r = fn(...args);
    assert.deepEqual(r, { status: 401, json: { error: 'auth_required' } });
  }
});

test('new-game validation rejects duplicate itsc and non-integer scores', () => {
  const db = freshDb();
  const admin = mkUser(db, 'rec', { admin: true });
  const mk = (itsc, scores, extra = {}) => apiGamesCreate(db, admin, { itsc, scores, ...extra });

  let r = mk(['amy', 'amy', 'cat', 'dan'], [1, 2, 3, 4]);
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'invalid_input');
  assert.ok(r.json.issues.some((s) => /distinct/.test(s)), 'duplicate itsc reported');

  for (const bad of [
    mk(G4, [1.5, 2, 3, 4]),          // fractional
    mk(G4, ['x', 2, 3, 4]),           // not numeric
    mk(G4, ['', 2, 3, 4]),            // empty string is not 0
    mk(G4, [true, 2, 3, 4]),          // booleans do not count as 1
    mk(G4, [1, 2, 3]),                // wrong arity
    mk(['amy', 'bob', 'cat', ''], [1, 2, 3, 4]),   // empty itsc
    mk(['amy', 'bob', 'cat', 'a b'], [1, 2, 3, 4]),// not an itsc login
    mk(G4, [1, 2, 3, 4], { dealer: 7 }),           // dealer out of range
    mk(G4, [1, 2, 3, 4], { dealer: 'east' }),
  ]) {
    assert.equal(bad.status, 400);
  }

  assert.equal(count(db, 'games'), 0, 'rejected games leave no rows');

  // string values are fine when they denote integers (JSON clients, forms)
  r = mk(G4, ['1', '2', '3', '4'], { dealer: '1' });
  assert.equal(r.status, 200);
  assert.equal(count(db, 'games'), 1);
});

test('unknown itsc logins are auto-created as unclaimed users', () => {
  const db = freshDb();
  const admin = mkUser(db, 'rec', { admin: true });
  const r = game(db, admin, ['newbie', 'amy', 'zz9', 'kim.k'], [10, 20, 30, -60],
    { dealer: 2, notes: 'first!' });
  assert.equal(r.status, 200);
  const id = r.json.game_id;
  assert.equal(typeof id, 'number');

  for (const itsc of ['newbie', 'zz9', 'kim.k']) {
    const u = db.prepare('SELECT itsc, display_name, is_admin FROM users WHERE itsc = ?').get(itsc);
    assert.ok(u, `${itsc} was auto-created`);
    assert.equal(u.display_name, itsc, 'display_name defaults to itsc');
    assert.equal(u.is_admin, 0, 'auto-created users are not admins');
  }

  const gp = db.prepare(`
    SELECT u.itsc, gp.seat, gp.is_dealer, gp.score
    FROM game_players gp JOIN users u ON u.id = gp.user_id
    WHERE gp.game_id = ? ORDER BY gp.seat`).all(id);
  assert.deepEqual(gp.map((p) => p.itsc), ['newbie', 'amy', 'zz9', 'kim.k']);
  assert.deepEqual(gp.map((p) => p.score), [10, 20, 30, -60]);
  assert.equal(gp[2].is_dealer, 1, 'dealer recorded on seat 2 only');
  assert.equal(gp[0].is_dealer, 0);

  const g = db.prepare('SELECT recorded_by, notes FROM games WHERE id = ?').get(id);
  assert.equal(g.recorded_by, admin.id);
  assert.equal(g.notes, 'first!');
});

test('leaderboard math, since filter, deactivated users excluded', () => {
  const db = freshDb();
  const admin = mkUser(db, 'rec', { admin: true });
  assert.equal(game(db, admin, G4, [250, -80, -50, -120]).status, 200);
  const g2 = game(db, admin, G4, [100, 20, -30, -90]);
  assert.equal(g2.status, 200);
  db.prepare('UPDATE games SET played_at = ? WHERE id = ?')
    .run('2026-01-01 10:00:00', g2.json.game_id);

  const lb = apiLeaderboard(db, {});
  assert.equal(lb.status, 200);
  assert.deepEqual(lb.json.map((x) => [x.itsc, x.games, x.total, x.avg, x.best]), [
    ['amy', 2, 350, 175, 250],
    ['bob', 2, -60, -30, 20],
    ['cat', 2, -80, -40, -30],
    ['dan', 2, -210, -105, -90],
  ]);

  const since = apiLeaderboard(db, { since: '2026-02-01' });
  assert.equal(since.status, 200);
  assert.deepEqual(since.json.map((x) => [x.itsc, x.games, x.total, x.avg, x.best]), [
    ['amy', 1, 250, 250, 250],
    ['cat', 1, -50, -50, -50],
    ['bob', 1, -80, -80, -80],
    ['dan', 1, -120, -120, -120],
  ]);

  assert.equal(apiLeaderboard(db, { since: '2025-01-01' }).json.length, 4, 'early since keeps all');
  assert.deepEqual(apiLeaderboard(db, { since: 'nah' }),
    { status: 400, json: { error: 'invalid_since' } });

  db.prepare('UPDATE users SET active = 0 WHERE itsc = ?').run('dan');
  assert.equal(apiLeaderboard(db, {}).json.length, 3, 'inactive users are excluded');
});

test('api/games returns recent games with seat-ordered players, limit validated', () => {
  const db = freshDb();
  const admin = mkUser(db, 'rec', { admin: true });
  game(db, admin, G4, [1, 2, 3, 4], { notes: 'older' });
  const g2 = game(db, admin, G4, [5, 6, 7, 8]);
  db.prepare('UPDATE games SET played_at = ? WHERE id = ?')
    .run('2026-01-01 00:00:00', g2.json.game_id); // force g1 (now) to be newest

  let r = apiGamesList(db, {});
  assert.equal(r.status, 200);
  assert.equal(r.json.games.length, 2);
  assert.equal(r.json.games[0].notes, 'older', 'newest first');
  assert.equal(r.json.games[0].recorded_by, 'rec');
  assert.deepEqual(r.json.games[0].players.map((p) => p.seat), [0, 1, 2, 3]);
  assert.deepEqual(r.json.games[0].players.map((p) => p.itsc), G4);

  r = apiGamesList(db, { limit: '1' });
  assert.equal(r.json.games.length, 1);
  assert.deepEqual(apiGamesList(db, { limit: 'junk' }),
    { status: 400, json: { error: 'invalid_limit' } });
});

test('delete is admin-only and removes game plus players', () => {
  const db = freshDb();
  const admin = mkUser(db, 'rec', { admin: true });
  const peon = mkUser(db, 'peon');
  const id = game(db, admin, G4, [1, 2, 3, 4]).json.game_id;

  assert.deepEqual(trackGameDelete(db, peon, id),
    { status: 403, json: { error: 'forbidden' } });
  assert.equal(count(db, 'games'), 1, 'non-admin delete is a no-op');

  assert.deepEqual(trackGameDelete(db, admin, id),
    { status: 200, json: { ok: true, deleted: id } });
  assert.equal(count(db, 'games'), 0);
  assert.equal(count(db, 'game_players'), 0);

  assert.deepEqual(trackGameDelete(db, admin, id),
    { status: 404, json: { error: 'not_found' } });
});

test('POST /track/new form flow: confirmation page, dealer, normalization', () => {
  const db = freshDb();
  const amy = mkUser(db, 'amy');
  const form = (over = {}) => trackNewSubmit(db, amy, {
    itsc1: 'amy', itsc2: 'bob', itsc3: 'cat', itsc4: 'dan',
    score1: '10', score2: '0', score3: '-5', score4: '-5',
    dealer: '2', notes: 'form post', ...over,
  });

  const ok = form();
  assert.equal(ok.status, 200);
  assert.ok(ok.html.includes('recorded'), 'confirmation page shown');
  const g = db.prepare('SELECT id FROM games').get();
  assert.equal(db.prepare('SELECT is_dealer FROM game_players WHERE game_id = ? AND seat = 2')
    .get(g.id).is_dealer, 1);

  const dup = form({ itsc3: 'AMY' }); // case-normalized to a duplicate
  assert.equal(dup.status, 400);

  const page = trackNewPage(db, amy);
  assert.equal(page.status, 200);
  assert.ok(page.html.includes('name="itsc1"'), 'form rendered for logged-in user');
});

test('display_name is HTML-escaped everywhere it renders', () => {
  const db = freshDb();
  const admin = mkUser(db, 'rec', { admin: true });
  mkUser(db, 'amy', { name: '<script>alert(1)</script>' }); // evil display_name plays
  game(db, admin, G4, [1, 2, 3, 4]);

  const home = trackHome(db, admin);
  assert.equal(home.status, 200);
  assert.ok(home.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'),
    'display_name appears escaped');
  assert.ok(!home.html.includes('<script>alert(1)'), 'raw display_name never appears');

  const anon = trackHome(db); // logged out: no delete buttons, same escaping
  assert.ok(anon.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!anon.html.includes('danger del'), 'anon sees no admin delete buttons');

  const list = apiGamesList(db, {}).json.games[0];
  assert.equal(list.players.find((p) => p.itsc === 'amy').display_name,
    '<script>alert(1)</script>', 'JSON API carries the raw name; HTML layer escapes');
});
