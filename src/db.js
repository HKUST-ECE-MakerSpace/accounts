// SQLite persistence (node:sqlite — zero dependencies). One database file
// at $DATA_DIR/accounts.db, WAL mode, schema created idempotently on boot so
// restarts and first boots are the same code path.
//
// Tables: users, sessions, magic_tokens, login_attempts (+ rate_limits for
// the forgot-PIN throttle and schema_version for future migrations).

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'accounts.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      itsc         TEXT    NOT NULL UNIQUE,          -- lowercase login, e.g. "wli"
      display_name TEXT    NOT NULL DEFAULT '',
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      is_admin     INTEGER NOT NULL DEFAULT 0,
      pin_hash     TEXT,                             -- null until a PIN is set
      must_set_pin INTEGER NOT NULL DEFAULT 1,
      active       INTEGER NOT NULL DEFAULT 1
    );

    -- one row per issued session; only the sha256 of the token is stored
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    -- magic links; user_id is null for invites issued before a row exists
    -- (redemption creates the user from the token's email)
    CREATE TABLE IF NOT EXISTS magic_tokens (
      token_hash TEXT    PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id),
      email      TEXT    NOT NULL,
      purpose    TEXT    NOT NULL,                   -- 'invite' | 'reset'
      expires_at INTEGER NOT NULL,
      used_at    INTEGER
    );

    -- failed PIN attempts per account (lockout after MAX_ATTEMPTS)
    CREATE TABLE IF NOT EXISTS login_attempts (
      itsc         TEXT    PRIMARY KEY,
      fails        INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL
    );

    -- generic sliding-window counters (forgot-PIN: 3/hour per email)
    CREATE TABLE IF NOT EXISTS rate_limits (
      key          TEXT    PRIMARY KEY,
      count        INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL
    );
  `);

  const v = db.prepare('SELECT version FROM schema_version').get();
  if (!v) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  return db;
}
