// Mahjong points tracker: data + route-handler layer.
// Handlers are pure functions of (db, ...) returning { status, json } or
// { status, html } — no node:http imports; the integrator mounts them.
//
// Mount contract (user = users row for the session cookie, or null):
//   initGames(db)                               once at boot, after users exists
//   GET  /track                    trackHome(db, user)                 public
//   GET  /track/new                trackNewPage(db, user)       login required
//   POST /track/new                trackNewSubmit(db, user, body)
//       form-encoded fields itsc1..itsc4, score1..score4, dealer (0-3), notes
//   GET  /api/leaderboard?since=   apiLeaderboard(db, query)           public
//   GET  /api/games?limit=         apiGamesList(db, query)             public
//   POST /api/games                apiGamesCreate(db, user, body)
//       JSON { itsc: [4], scores: [4], dealer?, notes? }
//   POST /track/games/:id/delete   trackGameDelete(db, user, id)   admin only
//
// Error responses are always { status, json: { error, issues? } }:
// 401 auth_required (user null), 400 invalid_input / invalid_since /
// invalid_limit / invalid_id, 403 forbidden (non-admin), 404 not_found.

import * as ui from './games-ui.js';

const ITS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function authRequired() {
  return { status: 401, json: { error: 'auth_required' } };
}

function invalid(issues) {
  return { status: 400, json: { error: 'invalid_input', issues } };
}

// Form fields and JSON numbers both arrive as strings/numbers; only accept
// values that unambiguously denote an integer.
function toInt(v) {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') { const t = v.trim(); return t === '' ? NaN : Number(t); }
  if (typeof v === 'number') return v;
  return NaN; // booleans, null, undefined, objects
}

// --- schema ----------------------------------------------------------------

export function initGames(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      played_at TEXT DEFAULT (datetime('now')),
      recorded_by INTEGER REFERENCES users(id),
      notes TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS game_players (
      game_id INTEGER REFERENCES games(id),
      user_id INTEGER REFERENCES users(id),
      seat INTEGER NOT NULL CHECK (seat BETWEEN 0 AND 3),
      is_dealer INTEGER NOT NULL DEFAULT 0 CHECK (is_dealer IN (0, 1)),
      score INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_game_players_game ON game_players(game_id);
    CREATE INDEX IF NOT EXISTS idx_game_players_user ON game_players(user_id);
  `);
}

// --- shared core ------------------------------------------------------------

// input: { itsc: [4], scores: [4], dealer?, notes? } with form-string or
// number values. Returns { ok, gameId } or { ok: false, res }.
function createGame(db, user, input) {
  const issues = [];
  const itsc = [];
  const scores = [];

  if (!Array.isArray(input.itsc) || input.itsc.length !== 4) {
    issues.push('exactly 4 itsc logins are required');
  } else {
    for (let i = 0; i < 4; i++) {
      const v = String(input.itsc[i] ?? '').trim().toLowerCase();
      if (!v) issues.push(`player ${i + 1}: itsc login is empty`);
      else if (!ITS_RE.test(v)) issues.push(`player ${i + 1}: not a valid itsc login`);
      itsc.push(v);
    }
    if (itsc.every(Boolean) && new Set(itsc).size !== 4) {
      issues.push('itsc logins must be distinct');
    }
  }

  if (!Array.isArray(input.scores) || input.scores.length !== 4) {
    issues.push('exactly 4 scores are required');
  } else {
    for (let i = 0; i < 4; i++) {
      const n = toInt(input.scores[i]);
      if (!Number.isInteger(n)) issues.push(`player ${i + 1}: score must be an integer`);
      scores.push(n);
    }
  }

  let dealer = 0;
  const d = toInt(input.dealer ?? 0);
  if (!Number.isInteger(d) || d < 0 || d > 3) issues.push('dealer must be 0-3');
  else dealer = d;

  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  if (issues.length) return { ok: false, res: invalid(issues) };

  db.exec('BEGIN');
  try {
    const ids = itsc.map((name) => {
      const found = db.prepare('SELECT id FROM users WHERE itsc = ?').get(name);
      if (found) return found.id;
      // Unclaimed account: display_name starts as the itsc login.
      db.prepare('INSERT INTO users (itsc, display_name) VALUES (?, ?)').run(name, name);
      return db.prepare('SELECT id FROM users WHERE itsc = ?').get(name).id;
    });
    const gameId = Number(db
      .prepare('INSERT INTO games (recorded_by, notes) VALUES (?, ?)')
      .run(user.id, notes).lastInsertRowid);
    const ins = db.prepare(
      'INSERT INTO game_players (game_id, user_id, seat, is_dealer, score) VALUES (?, ?, ?, ?, ?)');
    ids.forEach((uid, seat) => ins.run(gameId, uid, seat, seat === dealer ? 1 : 0, scores[seat]));
    db.exec('COMMIT');
    return { ok: true, gameId };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const LB_SELECT = `
  SELECT u.itsc, u.display_name,
         COUNT(*) AS games,
         SUM(p.score) AS total,
         ROUND(SUM(p.score) * 1.0 / COUNT(*), 1) AS avg,
         MAX(p.score) AS best
  FROM game_players p
  JOIN games g ON g.id = p.game_id
  JOIN users u ON u.id = p.user_id`;
const LB_ORDER = `
  GROUP BY u.id
  ORDER BY total DESC, best DESC, u.itsc ASC`;

// since: 'YYYY-MM-DD' or null. played_at is UTC 'YYYY-MM-DD HH:MM:SS', so a
// plain string compare covers the whole since-day and everything after.
function leaderboardRows(db, since) {
  if (since) {
    return db.prepare(`${LB_SELECT} WHERE u.active = 1 AND g.played_at >= ? ${LB_ORDER}`).all(since);
  }
  return db.prepare(`${LB_SELECT} WHERE u.active = 1 ${LB_ORDER}`).all();
}

function recentGames(db, limit) {
  const games = db.prepare(`
    SELECT g.id, g.played_at, g.notes, r.itsc AS recorded_by
    FROM games g LEFT JOIN users r ON r.id = g.recorded_by
    ORDER BY g.played_at DESC, g.id DESC
    LIMIT ?`).all(limit);
  const players = db.prepare(`
    SELECT p.user_id, u.itsc, u.display_name, p.seat, p.is_dealer, p.score
    FROM game_players p JOIN users u ON u.id = p.user_id
    WHERE p.game_id = ?
    ORDER BY p.seat ASC`);
  for (const g of games) g.players = players.all(g.id);
  return games;
}

// --- handlers ---------------------------------------------------------------

export function apiLeaderboard(db, query = {}) {
  const since = query.since;
  if (since === undefined || since === null || since === '') {
    return { status: 200, json: leaderboardRows(db, null) };
  }
  const s = String(since);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { status: 400, json: { error: 'invalid_since' } };
  return { status: 200, json: leaderboardRows(db, s) };
}

export function apiGamesList(db, query = {}) {
  const raw = query.limit;
  const limit = raw === undefined || raw === null || raw === '' ? 50 : toInt(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return { status: 400, json: { error: 'invalid_limit' } };
  }
  return { status: 200, json: { games: recentGames(db, limit) } };
}

export function trackHome(db, user = null) {
  return {
    status: 200,
    html: ui.pageTrack(leaderboardRows(db, null), recentGames(db, 50),
      { isAdmin: !!user && user.is_admin === 1 }),
  };
}

export function trackNewPage(db, user) {
  if (!user) return authRequired();
  return { status: 200, html: ui.pageTrackNew(user) };
}

export function trackNewSubmit(db, user, body = {}) {
  if (!user) return authRequired();
  const r = createGame(db, user, {
    itsc: [1, 2, 3, 4].map((i) => body['itsc' + i]),
    scores: [1, 2, 3, 4].map((i) => body['score' + i]),
    dealer: body.dealer,
    notes: body.notes,
  });
  return r.ok ? { status: 200, html: ui.pageCreated(r.gameId) } : r.res;
}

export function apiGamesCreate(db, user, body = {}) {
  if (!user) return authRequired();
  const r = createGame(db, user, body);
  return r.ok ? { status: 200, json: { ok: true, game_id: r.gameId } } : r.res;
}

export function trackGameDelete(db, user, id) {
  if (!user) return authRequired();
  if (user.is_admin !== 1) return { status: 403, json: { error: 'forbidden' } };
  const gameId = toInt(id);
  if (!Number.isInteger(gameId)) return { status: 400, json: { error: 'invalid_id' } };
  if (!db.prepare('SELECT id FROM games WHERE id = ?').get(gameId)) {
    return { status: 404, json: { error: 'not_found' } };
  }
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM game_players WHERE game_id = ?').run(gameId);
    db.prepare('DELETE FROM games WHERE id = ?').run(gameId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { status: 200, json: { ok: true, deleted: gameId } };
}
