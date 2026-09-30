import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY,
      username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass_hash  TEXT NOT NULL,
      salt       TEXT NOT NULL,
      fav_team   TEXT,
      bio        TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Retrato do jogo no momento do primeiro registro. Assim diário e perfil
    -- não dependem da API da NHL para renderizar.
    CREATE TABLE IF NOT EXISTS games (
      id           INTEGER PRIMARY KEY,
      game_date    TEXT NOT NULL,
      season       INTEGER,
      game_type    INTEGER,
      away_abbrev  TEXT NOT NULL,
      home_abbrev  TEXT NOT NULL,
      away_score   INTEGER,
      home_score   INTEGER,
      last_period  TEXT,
      venue        TEXT,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS logs (
      id          INTEGER PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id     INTEGER NOT NULL REFERENCES games(id),
      watched_on  TEXT NOT NULL,
      rating      INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 10),
      review      TEXT,
      liked       INTEGER NOT NULL DEFAULT 0,
      spoilers    INTEGER NOT NULL DEFAULT 0,
      rewatch     INTEGER NOT NULL DEFAULT 0,
      how         TEXT CHECK (how IS NULL OR how IN ('live', 'tv', 'replay', 'arena')),
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS logs_game ON logs(game_id);
    CREATE INDEX IF NOT EXISTS logs_user ON logs(user_id, watched_on DESC);
    CREATE INDEX IF NOT EXISTS logs_created ON logs(created_at DESC);
  `);
  return db;
}
