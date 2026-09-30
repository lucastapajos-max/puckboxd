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

  // Migrações de bancos criados antes de cada coluna existir.
  const cols = new Set(db.prepare('PRAGMA table_info(logs)').all().map((c) => c.name));
  if (!cols.has('mvp_player_id')) {
    // Escolha do espectador: melhor jogador da partida na opinião de quem registrou.
    db.exec(`
      ALTER TABLE logs ADD COLUMN mvp_player_id INTEGER;
      ALTER TABLE logs ADD COLUMN mvp_name TEXT;
      ALTER TABLE logs ADD COLUMN mvp_team TEXT;
      ALTER TABLE logs ADD COLUMN mvp_position TEXT;
    `);
  }
  db.exec('CREATE INDEX IF NOT EXISTS logs_mvp ON logs(mvp_player_id) WHERE mvp_player_id IS NOT NULL');

  // Parte social: listas, seguidores, curtidas e comentários em reviews.
  db.exec(`
    CREATE TABLE IF NOT EXISTS lists (
      id          INTEGER PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      description TEXT,
      ranked      INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS lists_user ON lists(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS list_items (
      list_id   INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      game_id   INTEGER NOT NULL REFERENCES games(id),
      position  INTEGER NOT NULL,
      note      TEXT,
      PRIMARY KEY (list_id, game_id)
    );
    CREATE INDEX IF NOT EXISTS list_items_game ON list_items(game_id);

    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (follower_id, followee_id),
      CHECK (follower_id <> followee_id)
    );
    CREATE INDEX IF NOT EXISTS follows_followee ON follows(followee_id);

    CREATE TABLE IF NOT EXISTS review_likes (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      log_id     INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, log_id)
    );
    CREATE INDEX IF NOT EXISTS review_likes_log ON review_likes(log_id);

    CREATE TABLE IF NOT EXISTS comments (
      id         INTEGER PRIMARY KEY,
      log_id     INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS comments_log ON comments(log_id, id);
  `);
  return db;
}
